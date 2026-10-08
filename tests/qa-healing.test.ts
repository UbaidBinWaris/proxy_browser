import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { IPC } from '../src/shared/ipc'
import { MatrixInputSchema, QaStepSchema, ScenarioInputSchema, countHealedSteps } from '../src/shared/qa'
import type { QaBatch, QaExecution, QaFallback, QaScenario, QaStep } from '../src/shared/qa'
import { ProfileInputSchema } from '../src/shared/types'
import type { IpcResult } from '../src/shared/types'
import {
  acceptFallback,
  applyHealedSelector,
  effectiveFallbacks,
  fallbackSelector,
  healingFailureMessage,
  healingMissMessage,
  healingVerdict,
  isHealableStep,
  locateWithHealing,
  normalizeFallbacks,
  promoteFallback,
  roleFromAriaSnapshot,
  splitBudget,
} from '../src/main/qa/healing'
import type { HealableStep, HealingLocator } from '../src/main/qa/healing'
import { resolveScenario } from '../src/main/qa/variables'
import { exportBatch } from '../src/main/qa/reports'
import { createQaService } from '../src/main/qa/service'
import { openDatabase } from '../src/main/database'
import { createLogger } from '../src/main/logging/logger'
import { createProfileManager } from '../src/main/browser/profile-manager'
import { qaHandlers } from '../src/main/ipc/qa'
import { toInvokeHandler } from '../src/main/ipc/handle'
import type { IpcDeps } from '../src/main/ipc/deps'

const role: QaFallback = { kind: 'role', value: 'button', name: 'Send' }
const label: QaFallback = { kind: 'label', value: 'Email' }
const testid: QaFallback = { kind: 'testid', value: 'send' }
const css: QaFallback = { kind: 'css', value: 'form > button:nth-of-type(1)' }
const text: QaFallback = { kind: 'text', value: 'Send' }
const placeholder: QaFallback = { kind: 'placeholder', value: 'you@example.test' }
const base = {
  name: 'Healing',
  profileId: 'p',
  startUrl: 'https://qa.example.test/',
  allowedOrigins: ['https://qa.example.test'],
}

describe('Self-healing schema', () => {
  it('keeps legacy scenarios valid and defaults healing to warn', () => {
    const legacy = ScenarioInputSchema.parse({ ...base, steps: [{ action: 'click', selector: '#send' }] })
    expect(legacy.healing).toBe('warn')
    expect(legacy.steps[0]).toEqual({ action: 'click', selector: '#send' })
    // A stored scenario that predates the field still resolves to warn for execution.
    const { healing: _healing, ...stored } = legacy
    expect(resolveScenario(stored as typeof legacy).healing).toBe('warn')
  })
  it('accepts up to four valid fallbacks on action steps only', () => {
    const parsed = ScenarioInputSchema.parse({
      ...base,
      healing: 'fail',
      steps: [
        { action: 'click', selector: '#send', fallbacks: [testid, role, text, css] },
        { action: 'assertVisible', selector: '#done', fallbacks: [role] },
      ],
    })
    expect(parsed.healing).toBe('fail')
    expect(parsed.steps[0]).toMatchObject({ fallbacks: [testid, role, text, css] })
    // Assertion steps cannot carry fallbacks at all: the field is stripped.
    expect(parsed.steps[1]).toEqual({ action: 'assertVisible', selector: '#done' })
    const step = (fallbacks: unknown[]) => QaStepSchema.safeParse({ action: 'click', selector: '#a', fallbacks })
    expect(step([testid, role, text, css, label]).success).toBe(false)
    expect(step([{ kind: 'role', value: 'Not A Role', name: 'x' }]).success).toBe(false)
    expect(step([{ kind: 'label', value: 'Email', name: 'extra' }]).success).toBe(false)
    expect(step([{ kind: 'testid', value: 'x', name: 'data-other' }]).success).toBe(false)
    expect(step([{ kind: 'testid', value: 'x', name: 'data-qa' }]).success).toBe(true)
    expect(step([{ kind: 'text', value: 'two\nlines' }]).success).toBe(false)
    expect(step([{ kind: 'xpath', value: '//a' }]).success).toBe(false)
    expect(ScenarioInputSchema.safeParse({ ...base, healing: 'auto', steps: [{ action: 'assertStatus', value: 200 }] }).success).toBe(false)
  })
  it('substitutes variables in CSS fallbacks only', () => {
    const resolved = resolveScenario(
      ScenarioInputSchema.parse({
        ...base,
        variables: { row: '7' },
        steps: [
          {
            action: 'click',
            selector: '#row-{{row}}',
            fallbacks: [{ kind: 'text', value: 'Row {{row}}' }, { kind: 'css', value: 'tr:nth-of-type({{row}}) button' }],
          },
        ],
      }),
    )
    expect(resolved.steps[0]).toMatchObject({
      selector: '#row-7',
      fallbacks: [{ kind: 'text', value: 'Row {{row}}' }, { kind: 'css', value: 'tr:nth-of-type(7) button' }],
    })
  })
})

describe('Self-healing pure functions', () => {
  it('translates fallbacks to exact Playwright selectors with escaping', () => {
    expect(fallbackSelector(testid)).toBe('[data-testid="send"]')
    expect(fallbackSelector({ kind: 'testid', value: 'a"b', name: 'data-qa' })).toBe('[data-qa="a\\"b"]')
    expect(fallbackSelector(role)).toBe('internal:role=button[name="Send"s]')
    expect(fallbackSelector({ kind: 'role', value: 'button', name: 'Say "hi"' })).toBe('internal:role=button[name="Say \\"hi\\""s]')
    expect(fallbackSelector({ kind: 'role', value: 'main' })).toBe('internal:role=main')
    expect(fallbackSelector(label)).toBe('internal:label="Email"s')
    expect(fallbackSelector(placeholder)).toBe('[placeholder="you@example.test"]')
    expect(fallbackSelector(text)).toBe('internal:text="Send"s')
    expect(fallbackSelector(css)).toBe(css.value)
  })
  it('orders fallbacks most-stable first, drops invalid and duplicate ones and keeps four', () => {
    expect(
      normalizeFallbacks('#send', [
        css,
        text,
        { kind: 'bogus', value: 'x' },
        placeholder,
        label,
        role,
        { kind: 'css', value: '#send' },
        testid,
        { ...role },
      ]),
    ).toEqual([testid, role, label, placeholder])
    expect(normalizeFallbacks('[data-testid="send"]', [css, testid])).toEqual([css])
    expect(normalizeFallbacks('#a', 'not-an-array')).toEqual([])
    expect(normalizeFallbacks('#a', [{ kind: 'text', value: 'x'.repeat(2000) }])).toEqual([])
  })
  it('never heals assertion or navigation steps, or anything when healing is off', () => {
    const click: QaStep = { action: 'click', selector: '#a', fallbacks: [role] }
    expect(isHealableStep(click)).toBe(true)
    expect(effectiveFallbacks(click, 'warn')).toEqual([role])
    expect(effectiveFallbacks(click, 'fail')).toEqual([role])
    expect(effectiveFallbacks(click, 'off')).toEqual([])
    expect(effectiveFallbacks({ action: 'click', selector: '#a' }, 'warn')).toEqual([])
    // Even if an assertion object were given fallbacks outside the schema, they are ignored.
    for (const assertion of [
      { action: 'assertVisible', selector: '#a', fallbacks: [role] },
      { action: 'assertText', selector: '#a', value: 'x', fallbacks: [role] },
      { action: 'goto', value: 'https://qa.example.test/' },
    ] as unknown as QaStep[]) {
      expect(isHealableStep(assertion)).toBe(false)
      expect(effectiveFallbacks(assertion, 'warn')).toEqual([])
    }
  })
  it('splits one step budget without exceeding it', () => {
    for (const total of [1, 1000, 1001, 15000, 60000]) {
      const { primaryMs, fallbackMs } = splitBudget(total)
      expect(primaryMs).toBeGreaterThan(0)
      expect(primaryMs + fallbackMs).toBe(total)
      expect(primaryMs).toBeLessThan(total + 1)
    }
    expect(splitBudget(15000)).toEqual({ primaryMs: 9000, fallbackMs: 6000 })
  })
  it('accepts only a unique match, with a matching role for role fallbacks', () => {
    expect(acceptFallback(label, { count: 1 })).toBe(true)
    expect(acceptFallback(label, { count: 0 })).toBe(false)
    expect(acceptFallback(label, { count: 2 })).toBe(false)
    expect(acceptFallback(role, { count: 1, role: 'button' })).toBe(true)
    expect(acceptFallback(role, { count: 1, role: 'link' })).toBe(false)
    expect(acceptFallback(role, { count: 1, role: null })).toBe(false)
    expect(roleFromAriaSnapshot('- button "Send"')).toBe('button')
    expect(roleFromAriaSnapshot('- combobox "Pick":\n  - option "A"')).toBe('combobox')
    expect(roleFromAriaSnapshot('')).toBeNull()
  })
  it('passes healed steps in warn mode and fails them with the suggestion in fail mode', () => {
    expect(healingVerdict('warn')).toBe('passed')
    expect(healingVerdict('fail')).toBe('failed')
    const message = healingFailureMessage({
      originalSelector: '#send',
      usedFallback: role,
      fallbackIndex: 0,
      suggestedSelector: fallbackSelector(role),
    })
    expect(message).toContain('#send')
    expect(message).toContain('internal:role=button[name="Send"s]')
    expect(message).toMatch(/set to fail/)
  })
  it('promotes a fallback and keeps the old primary as the first CSS fallback', () => {
    const step: HealableStep = { action: 'click', selector: '#send', fallbacks: [testid, role, label, css] }
    expect(promoteFallback(step, 1)).toEqual({
      action: 'click',
      selector: 'internal:role=button[name="Send"s]',
      fallbacks: [testid, label, { kind: 'css', value: '#send' }, css],
    })
    expect(promoteFallback({ ...step, fallbacks: [role] }, 0).fallbacks).toEqual([{ kind: 'css', value: '#send' }])
    expect(() => promoteFallback(step, 9)).toThrow(/no longer exists/)
  })
})

/** A fake page: selector → count over time, plus a fake clock advanced by sleep and waits. */
function fakePage(counts: Record<string, number | ((now: number) => number)>, options: { roles?: Record<string, string>; failWaitWith?: Error } = {}) {
  let clock = 0
  const waits: number[] = []
  const counted: string[] = []
  const countAt = (selector: string): number => {
    const entry = counts[selector] ?? 0
    return typeof entry === 'function' ? entry(clock) : entry
  }
  const page = {
    locator: (selector: string): HealingLocator & { selector: string } => ({
      selector,
      waitFor: async ({ timeout }) => {
        waits.push(timeout)
        if (options.failWaitWith) throw options.failWaitWith
        if (countAt(selector) > 0) return
        clock += timeout
        throw Object.assign(new Error(`Timeout ${timeout}ms exceeded.`), { name: 'TimeoutError' })
      },
      count: async () => {
        counted.push(selector)
        if (selector.startsWith('!!')) throw new Error('Malformed selector')
        return countAt(selector)
      },
      ariaSnapshot: async () => `- ${options.roles?.[selector] ?? 'generic'} "x"`,
    }),
  }
  const now = () => clock
  const sleep = async (ms: number) => {
    clock += ms
  }
  return { page, now, sleep, waits, counted, elapsed: () => clock }
}

describe('Self-healing adapter', () => {
  const click = (fallbacks: QaFallback[]): HealableStep => ({ action: 'click', selector: '#send', fallbacks })
  it('uses the primary selector with the full budget when a step has no fallbacks', async () => {
    const fake = fakePage({})
    const found = await locateWithHealing(fake.page, { action: 'click', selector: '#send' }, 'warn', 1000, fake)
    expect(found).toMatchObject({ locator: { selector: '#send' }, remainingMs: 1000 })
    expect(found.healed).toBeUndefined()
    expect(fake.waits).toEqual([])
  })
  it('does not heal when the primary exists, even if it is not actionable', async () => {
    const fake = fakePage({ '#send': 1, [fallbackSelector(role)]: 1 }, { roles: { [fallbackSelector(role)]: 'button' } })
    const found = await locateWithHealing(fake.page, click([role]), 'warn', 1000, fake)
    expect(found.locator.selector).toBe('#send')
    expect(found.healed).toBeUndefined()
    expect(fake.waits).toEqual([600])
    expect(fake.counted).toEqual([])
  })
  it('heals only after the primary matched zero elements, skipping ambiguous and malformed fallbacks', async () => {
    const fake = fakePage(
      { [fallbackSelector(testid)]: 2, [fallbackSelector(role)]: 1 },
      { roles: { [fallbackSelector(role)]: 'button' } },
    )
    const step = click([{ kind: 'css', value: '!!bad' }, testid, role])
    const found = await locateWithHealing(fake.page, step, 'warn', 1000, fake)
    expect(found.healed).toEqual({
      originalSelector: '#send',
      usedFallback: role,
      fallbackIndex: 2,
      suggestedSelector: 'internal:role=button[name="Send"s]',
    })
    expect(found.locator.selector).toBe(fallbackSelector(role))
    // The primary waited 600 ms of the 1000 ms budget; the action gets what is left.
    expect(found.remainingMs).toBe(400)
  })
  it('rejects a role fallback whose element has another role', async () => {
    const fake = fakePage({ [fallbackSelector(role)]: 1 }, { roles: { [fallbackSelector(role)]: 'link' } })
    await expect(locateWithHealing(fake.page, click([role]), 'warn', 1000, fake)).rejects.toThrow(
      healingMissMessage(1000),
    )
  })
  it('fails within the original budget when no fallback is unique', async () => {
    const fake = fakePage({ [fallbackSelector(label)]: 2, [fallbackSelector(text)]: 0 })
    await expect(locateWithHealing(fake.page, click([label, text]), 'warn', 1000, fake)).rejects.toThrow(
      /no fallback matched exactly one element/,
    )
    expect(fake.elapsed()).toBe(1000)
  })
  it('uses a primary that appears late instead of healing', async () => {
    const fake = fakePage({ '#send': (now) => (now >= 700 ? 1 : 0), [fallbackSelector(label)]: 2 })
    const found = await locateWithHealing(fake.page, click([label]), 'warn', 1000, fake)
    expect(found.locator.selector).toBe('#send')
    expect(found.healed).toBeUndefined()
    expect(found.remainingMs).toBe(300)
  })
  it('rethrows non-timeout primary errors without trying fallbacks', async () => {
    const fake = fakePage({ [fallbackSelector(label)]: 1 }, { failWaitWith: new Error('Unexpected token in selector') })
    await expect(locateWithHealing(fake.page, click([label]), 'warn', 1000, fake)).rejects.toThrow(/Unexpected token/)
    expect(fake.counted).toEqual([])
  })
  it('ignores fallbacks when healing is off', async () => {
    const fake = fakePage({ [fallbackSelector(label)]: 1 })
    const found = await locateWithHealing(fake.page, click([label]), 'off', 1000, fake)
    expect(found).toMatchObject({ locator: { selector: '#send' }, remainingMs: 1000 })
    expect(fake.waits).toEqual([])
  })
})

const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
})
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'qa-healing-'))
  const db = openDatabase(':memory:', { defaultScreenshotDir: join(dir, 'screenshots'), env: {} })
  const logger = createLogger({ repo: db.logs, fileDir: join(dir, 'logs') })
  const profiles = createProfileManager({ repo: db.profiles, logger })
  const profile = profiles.create(
    ProfileInputSchema.parse({
      name: 'Base',
      engine: 'chromium',
      deviceType: 'desktop',
      devicePreset: 'linux-desktop',
      viewportWidth: 1280,
      viewportHeight: 800,
      userAgent: null,
      locale: 'en-US',
      timezone: 'UTC',
      proxyMode: 'none',
      stickySessionId: null,
      formUrlOverride: null,
      notes: '',
    }),
  )
  const store = db.qa!
  const scenario = store.saveScenario(
    ScenarioInputSchema.parse({
      ...base,
      profileId: profile.id,
      steps: [
        { action: 'fill', selector: '#email', value: 'synthetic@example.test', fallbacks: [label] },
        { action: 'click', selector: '#send', fallbacks: [testid, role] },
        { action: 'assertVisible', selector: '#done' },
      ],
    }),
  )
  const healedClick = {
    index: 1,
    action: 'click' as const,
    status: 'passed' as const,
    durationMs: 3,
    healed: { originalSelector: '#send', usedFallback: role, fallbackIndex: 1, suggestedSelector: fallbackSelector(role) },
  }
  const execution: QaExecution = {
    status: 'passed',
    steps: [{ index: 0, action: 'fill', status: 'passed', durationMs: 1 }, healedClick],
    errors: [],
    failedRequests: [],
    finalUrl: base.startUrl,
    durationMs: 5,
  }
  const service = createQaService({ store, profiles, artifactRoot: join(dir, 'artifacts'), execute: async () => execution })
  const handler = qaHandlers({ db: { qa: store } } as unknown as IpcDeps).find(
    (entry) => entry.channel === IPC.qa.updateHealedSelector,
  )!
  const invoke = toInvokeHandler(handler, { logger, sanitize: (value) => value })
  disposers.push(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { store, scenario, service, invoke, execution, healedClick }
}
type Invoke = ReturnType<typeof harness>['invoke']
const call = async (invoke: Invoke, ...args: unknown[]) => (await invoke(null, ...args)) as IpcResult<QaScenario>

describe('Healed batches, reports and the update-selector IPC call', () => {
  it('counts healed steps on the batch and keeps the case passing', async () => {
    const h = harness()
    const batch = h.service.start(MatrixInputSchema.parse({ scenarioId: h.scenario.id }))
    expect(batch.healedSteps).toBe(0)
    await h.service.idle()
    const saved = h.store.batch(batch.id)
    expect(saved.status).toBe('passed')
    expect(saved.healedSteps).toBe(1)
    expect(countHealedSteps(saved.cases)).toBe(1)
    await h.service.dispose()
  })
  it('rewrites only the healed action step from the saved scenario and audits it', async () => {
    const h = harness()
    const batch = h.service.start(MatrixInputSchema.parse({ scenarioId: h.scenario.id }))
    await h.service.idle()
    const result = await call(h.invoke, batch.id, '1', 1)
    expect(result.ok).toBe(true)
    const updated = h.store.scenario(h.scenario.id)
    expect(updated.steps[1]).toEqual({
      action: 'click',
      selector: 'internal:role=button[name="Send"s]',
      fallbacks: [testid, { kind: 'css', value: '#send' }],
    })
    expect(updated.steps[0]).toEqual(h.scenario.steps[0])
    expect(updated.steps[2]).toEqual(h.scenario.steps[2])
    expect(h.store.audit().some((entry) => entry.action === 'scenario.selector-healed')).toBe(true)
    // The scenario has changed since that run, so a second update is refused.
    expect(await call(h.invoke, batch.id, '1', 1)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    await h.service.dispose()
  })
  it('rejects unknown identifiers, unhealed steps, assertion steps, running batches and selector strings', async () => {
    const h = harness()
    const batch = h.service.start(MatrixInputSchema.parse({ scenarioId: h.scenario.id }))
    await h.service.idle()
    expect(await call(h.invoke, 'missing-batch', '1', 1)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await call(h.invoke, batch.id, '9', 1)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await call(h.invoke, batch.id, '1', 0)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await call(h.invoke, batch.id, 'x', 1)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(await call(h.invoke, batch.id, '1', -1)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(await call(h.invoke, batch.id, '1', 1, '#injected')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    // A healed record pointing at an assertion step never updates it.
    const tampered: QaBatch = h.store.batch(batch.id)
    tampered.cases[0]!.steps.push({ ...h.healedClick, index: 2, action: 'assertVisible' })
    h.store.saveBatch(tampered)
    expect(await call(h.invoke, batch.id, '1', 2)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    h.store.saveBatch({ ...tampered, endedAt: null, status: 'running' })
    expect(() => applyHealedSelector(h.store, batch.id, '1', 1)).toThrow(/finish/)
    expect(h.store.scenario(h.scenario.id).steps).toEqual(h.scenario.steps)
    await h.service.dispose()
  })
  it('includes healed details in JSON, JUnit and HTML reports', async () => {
    const h = harness()
    const batch = h.service.start(MatrixInputSchema.parse({ scenarioId: h.scenario.id }))
    await h.service.idle()
    const saved = h.store.batch(batch.id)
    const json = JSON.parse(exportBatch(saved, 'json').content) as QaBatch
    expect(json.healedSteps).toBe(1)
    expect(json.cases[0]!.steps[1]!.healed).toMatchObject({ originalSelector: '#send', usedFallback: role })
    const junit = exportBatch(saved, 'junit').content
    expect(junit).toContain('<property name="healedSteps" value="1"/>')
    expect(junit).toContain('<property name="healed" value="step 2 (click): #send → internal:role=button[name=&quot;Send&quot;s]"/>')
    expect(junit).toContain('<system-out>Healed step 2 (click)')
    const blocked = structuredClone(saved)
    blocked.cases[0]!.steps[1]!.healed!.blocked = true
    expect(exportBatch(blocked, 'junit').content).toContain('step 2 (click, healing set to fail)')
    const html = exportBatch(saved, 'html').content
    expect(html).toContain('&#x21bb; Healed</span>')
    expect(html).toContain('1 healed step')
    expect(html).not.toContain('name="Send"s]') // Escaped, never raw markup.
    // Legacy batches without healedSteps still report a computed count of zero.
    const { healedSteps: _healedSteps, ...legacy } = saved
    expect(exportBatch({ ...legacy, cases: [] }, 'junit').content).toContain('value="0"')
    await h.service.dispose()
  })
})

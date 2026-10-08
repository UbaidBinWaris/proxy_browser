import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import type { Browser } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ScenarioInputSchema } from '../src/shared/qa'
import { executeScenario } from '../src/main/qa/executor'
import { attachRecorder, createRecorderManager } from '../src/main/qa/recorder'
import { openDatabase } from '../src/main/database'
import { createProfileManager } from '../src/main/browser/profile-manager'
import { createLogger } from '../src/main/logging/logger'
import { ProfileInputSchema } from '../src/shared/types'
import { createVisualStore } from '../src/main/qa/visual'
import type { QaRecording } from '../src/shared/qa'

const available = existsSync(chromium.executablePath())
if (!available && process.env.QA_REQUIRE_BROWSER_TESTS === '1')
  throw new Error('Chromium is required for QA integration tests. Install it before running CI.')
describe.skipIf(!available)('QA execution against a real local form', () => {
  let browser: Browser, url: string, dir: string
  let redirectHits = 0
  const foreign = createServer((_req, res) => {
    redirectHits++
    res.end('Foreign origin')
  })
  const server = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: foreignUrl })
      res.end()
      return
    }
    if (req.url === '/failed') {
      res.writeHead(503)
      res.end('<h1>Unavailable</h1>')
      return
    }
    res.setHeader('Content-Type', 'text/html')
    res.end(
      `<!doctype html><html><body style="background:${req.url === '/changed' ? 'black' : 'white'}"><h1>QA form</h1><label>Email<input id="email" type="email"></label><input id="password" type="password"><input id="private" data-qa-sensitive><input id="agree" type="checkbox"><select id="choice"><option value="a">A</option><option value="b">B</option></select><button id="submit" onclick="setTimeout(()=>{document.querySelector('#result').textContent='Submitted'},100)">Submit</button><div id="result"></div><script>console.error("test diagnostic")</script></body></html>`,
    )
  })
  let foreignUrl: string
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'qa-browser-'))
    await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve))
    foreignUrl = `http://127.0.0.1:${(foreign.address() as { port: number }).port}/`
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    browser = await chromium.launch({ headless: true })
  })
  afterAll(async () => {
    await browser?.close()
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => foreign.close(() => resolve())),
    ])
    if (dir) rmSync(dir, { recursive: true, force: true })
  })
  const scenario = (overrides: Record<string, unknown> = {}) =>
    ScenarioInputSchema.parse({
      name: 'Integration',
      profileId: 'test',
      startUrl: `${url}/`,
      allowedOrigins: [url],
      timeoutMs: 1000,
      steps: [
        { action: 'fill', selector: '#email', value: 'synthetic@example.test' },
        { action: 'click', selector: '#submit' },
        { action: 'assertText', selector: '#result', value: 'Submitted' },
      ],
      ...overrides,
    })
  it('fills and submits a form, waits for the assertion, and saves masked step evidence', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    try {
      const result = await executeScenario(context, scenario(), join(dir, 'success'), new AbortController().signal)
      expect(result.status).toBe('passed')
      expect(result.steps).toHaveLength(3)
      expect(result.steps.every((step) => step.screenshot && existsSync(step.screenshot))).toBe(true)
      expect(result.errors).toContain('test diagnostic')
      expect(JSON.stringify(result)).not.toContain('synthetic@example.test')
    } finally {
      await context.close()
    }
  })
  it('captures assertion failures and honours cancellation', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    try {
      const result = await executeScenario(
        context,
        scenario({ steps: [{ action: 'assertStatus', value: 201 }] }),
        join(dir, 'failure'),
        new AbortController().signal,
      )
      expect(result.status).toBe('failed')
      expect(result.steps[0]?.error).toContain('Expected HTTP 201')
    } finally {
      await context.close()
    }
    const cancelled = await browser.newContext({ serviceWorkers: 'block' })
    const controller = new AbortController()
    controller.abort()
    try {
      expect((await executeScenario(cancelled, scenario(), join(dir, 'cancelled'), controller.signal)).status).toBe(
        'cancelled',
      )
    } finally {
      await cancelled.close().catch(() => undefined)
    }
  })
  it('blocks an unapproved redirect before the foreign server receives the request', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    try {
      const result = await executeScenario(
        context,
        scenario({ startUrl: `${url}/redirect` }),
        join(dir, 'redirect'),
        new AbortController().signal,
      )
      expect(result.status).toBe('failed')
      expect(redirectHits).toBe(0)
    } finally {
      await context.close()
    }
  })
  it('captures an opt-in trace for a failed scenario', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    try {
      const result = await executeScenario(
        context,
        scenario({ captureTrace: true, steps: [{ action: 'assertVisible', selector: '#missing' }] }),
        join(dir, 'trace'),
        new AbortController().signal,
      )
      expect(result.status).toBe('failed')
      expect(result.trace && existsSync(result.trace)).toBe(true)
    } finally {
      await context.close()
    }
  })
  it('records main-page input, selection and clicks, excludes sensitive fields, and replays the draft', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const recording: QaRecording = { id: 'integration', status: 'recording', steps: [], warnings: [] }
    try {
      await attachRecorder(context, [url], recording)
      const page = await context.newPage()
      await page.goto(url)
      await page.locator('#password').pressSequentially('never-record-password')
      await page.locator('#private').pressSequentially('never-record-private')
      await page.locator('#email').pressSequentially('synthetic@example.test')
      await page.locator('#agree').check()
      await page.locator('#agree').uncheck()
      await page.locator('#choice').focus()
      await page.locator('#choice').press('ArrowDown')
      await page.locator('#choice').press('Enter')
      await page.locator('#submit').click()
      await expect.poll(() => recording.steps.length).toBe(5)
      expect(recording.steps.map((step) => step.action)).toEqual(['fill', 'check', 'uncheck', 'select', 'click'])
      expect(JSON.stringify(recording)).not.toMatch(/never-record/)
      recording.status = 'stopped'
      await page.locator('#email').pressSequentially('ignored-after-stop')
      expect(recording.steps).toHaveLength(5)
      const replay = await browser.newContext({ serviceWorkers: 'block' })
      try {
        const result = await executeScenario(
          replay,
          scenario({ steps: [...recording.steps, { action: 'assertText', selector: '#result', value: 'Submitted' }] }),
          join(dir, 'recorded-replay'),
          new AbortController().signal,
        )
        expect(result.status).toBe('passed')
        expect(result.steps).toHaveLength(6)
      } finally {
        await replay.close()
      }
    } finally {
      await context.close()
    }
  })
  it('fails until a visual baseline is approved, then detects a real page change', async () => {
    const visuals = createVisualStore(join(dir, 'baselines'))
    const run = async (label: string, startUrl: string) => {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 640, height: 480 } })
      try {
        return await executeScenario(
          context,
          scenario({
            startUrl,
            visualKey: 'browser-test',
            steps: [{ action: 'assertScreenshot', name: 'page', maxDiffRatio: 0.01 }],
          }),
          join(dir, label),
          new AbortController().signal,
          undefined,
          { store: visuals, fingerprint: ['chromium', '640x480'] },
        )
      } finally {
        await context.close()
      }
    }
    const initial = await run('visual-initial', `${url}/`)
    expect(initial.status).toBe('failed')
    expect(initial.steps[0]!.visual?.status).toBe('missing')
    await visuals.approve(initial.steps[0]!.visual!.key, initial.steps[0]!.visual!.actual)
    expect((await run('visual-matched', `${url}/`)).status).toBe('passed')
    const changed = await run('visual-changed', `${url}/changed`)
    expect(changed.status).toBe('failed')
    expect(changed.steps[0]!.visual?.status).toBe('changed')
    expect(existsSync(changed.steps[0]!.visual!.diff!)).toBe(true)
  })
  it('does not record the initial navigation and cleans temporary profiles on stop and startup failure', async () => {
    const db = openDatabase(':memory:', { defaultScreenshotDir: dir, env: {} })
    const profiles = createProfileManager({
      repo: db.profiles,
      logger: createLogger({ repo: db.logs, fileDir: join(dir, 'recorder-logs') }),
    })
    const profile = profiles.create(
      ProfileInputSchema.parse({
        name: 'Recorder base',
        userAgent: null,
        stickySessionId: null,
        formUrlOverride: null,
        notes: '',
        engine: 'chromium',
        devicePreset: 'linux-desktop',
        deviceType: 'desktop',
        viewportWidth: 1280,
        viewportHeight: 800,
        proxyMode: 'none',
        locale: 'en-US',
        timezone: 'UTC',
      }),
    )
    const manager = createRecorderManager({
      profiles,
      open: async (_profile, _scenario, _signal, headless) => {
        expect(headless).toBe(false)
        const context = await browser.newContext({ serviceWorkers: 'block' })
        return { context, close: () => context.close() }
      },
    })
    try {
      const draft = scenario({ profileId: profile.id, startUrl: url }) // No trailing slash.
      expect((await manager.start(draft)).steps).toEqual([])
      expect(manager.isBusy()).toBe(true)
      expect(db.profiles.list({ includeEphemeral: true })).toHaveLength(2)
      await expect(manager.start(draft)).rejects.toThrow(/Stop the current/)
      expect((await manager.stop())?.status).toBe('stopped')
      expect(manager.isBusy()).toBe(false)
      expect(db.profiles.list({ includeEphemeral: true })).toHaveLength(1)
      await expect(manager.start({ ...draft, startUrl: `${url}/redirect` })).rejects.toThrow()
      expect(manager.isBusy()).toBe(false)
      expect(db.profiles.list({ includeEphemeral: true })).toHaveLength(1)
    } finally {
      await manager.dispose()
      db.close()
    }
  })
})

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import type { Browser } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ScenarioInputSchema } from '../src/shared/qa'
import type { QaFallback, QaRecording } from '../src/shared/qa'
import { executeScenario } from '../src/main/qa/executor'
import { attachRecorder } from '../src/main/qa/recorder'
import { fallbackSelector } from '../src/main/qa/healing'

const available = existsSync(chromium.executablePath())
if (!available && process.env.QA_REQUIRE_BROWSER_TESTS === '1')
  throw new Error('Chromium is required for QA integration tests. Install it before running CI.')

const form = (suffix: string, extra = ''): string =>
  `<!doctype html><html><body><h1>Healing form</h1><label>Email <input id="email${suffix}" placeholder="you@example.test"></label><button id="send${suffix}" type="button" onclick="document.querySelector('#result').textContent='Sent'">Send</button>${extra}<div id="result"></div></body></html>`
const PAGES: Record<string, string> = {
  '/original': form(''),
  '/renamed': form('-v2'),
  '/ambiguous': form('-v2', '<button type="button">Send</button>'),
  '/disabled': `<!doctype html><html><body><button id="send" type="button" disabled>Send</button><button id="other" type="button">Other</button></body></html>`,
}

describe.skipIf(!available)('Self-healing selectors against a real local page', () => {
  let browser: Browser, url: string, dir: string
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end(PAGES[req.url ?? ''] ?? '<h1>Not found</h1>')
  })
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'qa-healing-browser-'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    browser = await chromium.launch({ headless: true })
  })
  afterAll(async () => {
    await browser?.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (dir) rmSync(dir, { recursive: true, force: true })
  })
  const run = async (label: string, overrides: Record<string, unknown>) => {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    try {
      return await executeScenario(
        context,
        ScenarioInputSchema.parse({
          name: 'Healing',
          profileId: 'test',
          startUrl: `${url}/renamed`,
          allowedOrigins: [url],
          timeoutMs: 1000,
          steps: [
            {
              action: 'click',
              selector: '#send',
              fallbacks: [{ kind: 'role', value: 'button', name: 'Send' }],
            },
            { action: 'assertText', selector: '#result', value: 'Sent' },
          ],
          ...overrides,
        }),
        join(dir, label),
        new AbortController().signal,
      )
    } finally {
      await context.close()
    }
  }

  it('heals a renamed selector through its role and name, passes, and flags the step', async () => {
    const started = Date.now()
    const result = await run('healed', {})
    expect(result.status).toBe('passed')
    expect(result.steps[0]).toMatchObject({
      status: 'passed',
      healed: {
        originalSelector: '#send',
        usedFallback: { kind: 'role', value: 'button', name: 'Send' },
        fallbackIndex: 0,
        suggestedSelector: 'internal:role=button[name="Send"s]',
      },
    })
    expect(result.steps[0]?.healed?.blocked).toBeUndefined()
    expect(result.steps[1]?.healed).toBeUndefined()
    // Healing shares the step budget; it does not add a second timeout.
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('does not heal when the fallback matches two elements, and the step fails', async () => {
    const result = await run('ambiguous', { startUrl: `${url}/ambiguous` })
    expect(result.status).toBe('failed')
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]?.healed).toBeUndefined()
    expect(result.steps[0]?.error).toMatch(/no fallback matched exactly one element/)
  })

  it('fails without acting in fail mode and names the suggested selector', async () => {
    const result = await run('fail-mode', { healing: 'fail' })
    expect(result.status).toBe('failed')
    expect(result.steps[0]?.healed).toMatchObject({ suggestedSelector: 'internal:role=button[name="Send"s]', blocked: true })
    expect(result.steps[0]?.error).toContain('update the selector to internal:role=button[name="Send"s]')
  })

  it('never heals a primary that exists but is not actionable', async () => {
    const result = await run('disabled', {
      startUrl: `${url}/disabled`,
      steps: [{ action: 'click', selector: '#send', fallbacks: [{ kind: 'css', value: '#other' }] }],
    })
    expect(result.status).toBe('failed')
    expect(result.steps[0]?.healed).toBeUndefined()
  })

  it('records fallbacks without field values and replays them after the IDs change', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const recording: QaRecording = { id: 'healing', status: 'recording', steps: [], warnings: [] }
    try {
      await attachRecorder(context, [url], recording)
      const page = await context.newPage()
      await page.goto(`${url}/original`)
      await page.locator('#email').pressSequentially('synthetic-value')
      await page.locator('#send').click()
      await expect.poll(() => recording.steps.length).toBe(2)
    } finally {
      await context.close()
    }
    const [fill, click] = recording.steps
    expect(fill).toMatchObject({
      action: 'fill',
      selector: '#email',
      fallbacks: [
        { kind: 'role', value: 'textbox', name: 'Email' },
        { kind: 'label', value: 'Email' },
        { kind: 'placeholder', value: 'you@example.test' },
        { kind: 'css' },
      ],
    })
    expect(click).toMatchObject({
      action: 'click',
      selector: '#send',
      fallbacks: [
        { kind: 'role', value: 'button', name: 'Send' },
        { kind: 'text', value: 'Send' },
        { kind: 'css' },
      ],
    })
    expect(JSON.stringify(recording.steps.flatMap((step) => ('fallbacks' in step ? step.fallbacks : [])))).not.toContain(
      'synthetic-value',
    )
    const result = await run('recorded', {
      steps: [...recording.steps, { action: 'assertText', selector: '#result', value: 'Sent' }],
    })
    expect(result.status).toBe('passed')
    expect(result.steps.map((step) => step.healed?.usedFallback.kind)).toEqual(['role', 'role', undefined])
  })
})

// Guard for Playwright upgrades: suggested selectors use Playwright's `internal:` engines, which are not a
// stable public API. If an upgrade changes their syntax, this fails before saved scenarios break silently.
describe.skipIf(!available)('Suggested selector syntax resolves in the bundled Playwright', () => {
  it('every fallback kind resolves to exactly the intended element', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.setContent(
        '<label>Email <input placeholder="you@example.test" data-testid="email"></label>' +
          '<button type="button">Send</button><button type="button">Say "hi"</button><main>Body</main>',
      )
      const cases: [QaFallback, string][] = [
        [{ kind: 'role', value: 'button', name: 'Send' }, 'Send'],
        [{ kind: 'role', value: 'button', name: 'Say "hi"' }, 'Say "hi"'],
        [{ kind: 'role', value: 'main' }, 'Body'],
        [{ kind: 'label', value: 'Email' }, ''],
        [{ kind: 'text', value: 'Send' }, 'Send'],
        [{ kind: 'placeholder', value: 'you@example.test' }, ''],
        [{ kind: 'testid', value: 'email', name: 'data-testid' }, ''],
      ]
      for (const [fallback, text] of cases) {
        const locator = page.locator(fallbackSelector(fallback))
        expect(await locator.count(), fallbackSelector(fallback)).toBe(1)
        expect((await locator.textContent())?.trim() ?? '').toBe(text)
      }
    } finally {
      await browser.close()
    }
  })
})

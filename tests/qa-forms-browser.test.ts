/**
 * Real-browser checks for real-world forms (src/main/qa/executor.ts, frames.ts, pages.ts,
 * page-tracker.ts, fixtures.ts and the recorder), with local servers on different ports
 * (= different origins):
 *
 * - A: approved (pages, frames, pop-ups, uploads, redirects);
 * - B: approved, a different origin (cross-origin approved frame / pop-up);
 * - C: NOT approved — must never receive a request from a frame or pop-up.
 *
 * Each engine is skipped when its Playwright build is not installed or cannot launch on this host.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium, firefox, webkit } from 'playwright-core'
import type { Browser, BrowserType } from 'playwright-core'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { executeScenario } from '../src/main/qa/executor'
import { attachRecorder } from '../src/main/qa/recorder'
import { navigationGuard } from '../src/main/qa/navigation'
import { ScenarioInputSchema } from '../src/shared/qa'
import type { QaExecution, QaRecording } from '../src/shared/qa'

interface Hit {
  method: string
  path: string
  body: string
}
interface TestServer {
  origin: string
  hits: Hit[]
  close(): Promise<void>
}
type Handler = (req: IncomingMessage, res: ServerResponse, hit: Hit) => void

async function startServer(handler: Handler): Promise<TestServer> {
  const hits: Hit[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const hit: Hit = { method: req.method ?? '', path: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') }
      hits.push(hit)
      handler(req, res, hit)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

const html = (res: ServerResponse, body: string, status = 200): void => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>page</title></head><body>${body}</body></html>`)
}
const form = (label: string): string =>
  `<h1>${label}</h1><form method="post" action="/got"><label for="name">Name</label><input id="name" name="name" data-testid="name-field"><input id="pw" type="password" name="pw"><button id="send">Send</button></form>`

let a: TestServer
let b: TestServer
let c: TestServer

beforeAll(async () => {
  const shared = (res: ServerResponse, hit: Hit, origin: string): boolean => {
    if (hit.path === '/inner') return (html(res, form(`Inner ${origin}`)), true)
    if (hit.path === '/got') return (html(res, `<h1 id="done">Got ${hit.method} ${hit.body}</h1>`), true)
    if (hit.path === '/popup-form') return (html(res, form('Pop-up')), true)
    return false
  }
  c = await startServer((_req, res) => html(res, '<h1>Unapproved</h1>'))
  b = await startServer((_req, res, hit) => {
    if (!shared(res, hit, 'B')) html(res, '<h1>B</h1>')
  })
  a = await startServer((_req, res, hit) => {
    if (shared(res, hit, 'A')) return
    switch (hit.path) {
      case '/frames':
        return html(
          res,
          `<h1 id="title">Frames</h1><iframe id="same" src="/inner"></iframe><iframe id="cross" title="Payment" src="${b.origin}/inner"></iframe><iframe id="nested" srcdoc="<iframe id='deep' src='${a.origin}/inner'></iframe>"></iframe>`,
        )
      case '/bad-frame':
        return html(res, `<h1 id="title">Embedded</h1><iframe id="evil" src="${c.origin}/inner"></iframe>`)
      case '/popup':
        return html(
          res,
          `<h1 id="title">Main</h1><button id="open" onclick="window.open('/popup-form', 'w1', 'width=500,height=500')">Open</button><a id="tab" target="_blank" href="${b.origin}/popup-form">Tab</a><button id="evil" onclick="window.open('${c.origin}/x')">Evil</button><p id="status">idle</p><script>window.addEventListener('message', (e) => { document.getElementById('status').textContent = e.data })</script>`,
        )
      case '/upload':
        return html(
          res,
          '<h1>Upload</h1><form method="post" action="/upload-receive" enctype="multipart/form-data"><input type="file" id="file" name="file" data-testid="cv"><button id="send">Send</button></form>',
        )
      case '/upload-receive':
        return html(res, `<h1 id="done">Received ${hit.body.length} bytes</h1>`)
      case '/start-203':
        return html(
          res,
          '<h1>Start</h1><a id="go" href="/hop">Go</a><button id="later" onclick="setTimeout(() => { location.href = \'/hop\' }, 50)">Later</button>',
          203,
        )
      case '/hop':
        res.writeHead(302, { location: '/landing' })
        return res.end()
      case '/landing':
        return html(res, '<h1 id="landed">Landed</h1>')
      default:
        return html(res, `<h1>A ${hit.path}</h1>`)
    }
  })
})

afterAll(async () => {
  await Promise.all([a?.close(), b?.close(), c?.close()])
})

beforeEach(() => {
  for (const server of [a, b, c]) server.hits.length = 0
})

function installed(type: BrowserType): boolean {
  try {
    return existsSync(type.executablePath())
  } catch {
    return false
  }
}

const ENGINES: Array<[string, BrowserType]> = [
  ['chromium', chromium],
  ['firefox', firefox],
  ['webkit', webkit],
]

describe.each(ENGINES)('QA real-world forms in a real browser (%s)', (name, type) => {
  let browser: Browser | null = null
  let dir = ''

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'qa-forms-browser-'))
    if (!installed(type)) return
    try {
      browser = await type.launch({ headless: true })
    } catch {
      browser = null
    }
  })

  afterAll(async () => {
    await browser?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const run = async (scenario: Record<string, unknown>, artifactDir = mkdtempSync(join(dir, 'case-'))): Promise<QaExecution> => {
    const context = await browser!.newContext({ serviceWorkers: 'block' })
    try {
      return await executeScenario(
        context,
        ScenarioInputSchema.parse({ name: 'Forms', profileId: 'test', allowedOrigins: [a.origin, b.origin], timeoutMs: 10_000, ...scenario }),
        artifactDir,
        new AbortController().signal,
      )
    } finally {
      await context.close()
    }
  }
  const posts = (server: TestServer): string[] => server.hits.filter((hit) => hit.method === 'POST').map((hit) => `${hit.path} ${hit.body}`)

  it('acts inside a same-origin, an approved cross-origin and a nested iframe', async ({ skip }) => {
    if (!browser) return skip(`${name} is not installed or cannot launch here`)
    const result = await run({
      startUrl: `${a.origin}/frames`,
      steps: [
        { action: 'fill', selector: '#name', value: 'Cross', frame: ['#cross'] },
        { action: 'click', selector: '#send', frame: ['#cross'] },
        { action: 'fill', selector: '#name', value: 'Deep', frame: ['#nested', '#deep'] },
        { action: 'click', selector: '#send', frame: ['#nested', '#deep'] },
        { action: 'fill', selector: '#name', value: 'Same', frame: ['iframe#same'] },
        { action: 'click', selector: '#send', frame: ['iframe#same'] },
        { action: 'assertText', selector: '#title', value: 'Frames' },
      ],
    })
    expect(result.errors).toEqual([])
    expect(result.status).toBe('passed')
    expect(posts(b)).toEqual(['/got name=Cross&pw='])
    expect(posts(a)).toEqual(['/got name=Deep&pw=', '/got name=Same&pw='])
  })

  it('heals a broken selector inside a frame', async ({ skip }) => {
    if (!browser) return skip(`${name} is not installed or cannot launch here`)
    const result = await run({
      startUrl: `${a.origin}/frames`,
      timeoutMs: 4000,
      steps: [
        { action: 'fill', selector: '#renamed', value: 'Healed', frame: ['#cross'], fallbacks: [{ kind: 'testid', value: 'name-field' }] },
        { action: 'click', selector: '#send', frame: ['#cross'] },
      ],
    })
    expect(result.status).toBe('passed')
    expect(result.steps[0]?.healed).toMatchObject({ originalSelector: '#renamed', suggestedSelector: '[data-testid="name-field"]' })
    expect(posts(b)).toEqual(['/got name=Healed&pw='])
  })

  it('fails a step inside an unapproved-origin iframe with a clear message; that origin receives nothing', async ({ skip }) => {
    if (!browser) return skip(`${name} is not installed or cannot launch here`)
    const result = await run({
      startUrl: `${a.origin}/bad-frame`,
      timeoutMs: 4000,
      steps: [{ action: 'fill', selector: '#name', value: 'x', frame: ['#evil'] }],
    })
    expect(result.status).toBe('failed')
    expect(result.steps[0]?.error).toBe(
      `fill failed: The frame #evil is on an unapproved origin (${c.origin}), so steps cannot run inside it. Approve that origin only if it is your own test site.`,
    )
    expect(result.errors).toContain(`Navigation to an unapproved origin (${c.origin}) was blocked.`)
    expect(c.hits).toEqual([])
  })

  it('continues in a pop-up window and back on the main page', async ({ skip }) => {
    if (!browser) return skip(`${name} is not installed or cannot launch here`)
    const result = await run({
      startUrl: `${a.origin}/popup`,
      steps: [
        { action: 'click', selector: '#open' },
        { action: 'switchPage', page: 'popup:1' },
        { action: 'fill', selector: '#name', value: 'Popup' },
        { action: 'click', selector: '#send' },
        { action: 'assertText', selector: '#done', value: 'Got POST name=Popup' },
        { action: 'assertStatus', value: 200 },
        { action: 'switchPage', page: 'main' },
        { action: 'click', selector: '#tab' },
        { action: 'switchPage', page: 'popup:2' },
        { action: 'fill', selector: '#name', value: 'Tab' },
        { action: 'click', selector: '#send' },
        { action: 'assertUrl', value: `${b.origin}/got` },
        { action: 'switchPage', page: 'main' },
        { action: 'assertText', selector: '#title', value: 'Main' },
      ],
    })
    expect(result.errors).toEqual([])
    expect(result.status).toBe('passed')
    expect(posts(a)).toEqual(['/got name=Popup&pw='])
    expect(posts(b)).toEqual(['/got name=Tab&pw='])
    expect(result.finalUrl).toBe(`${a.origin}/popup`)
  })

  it('applies the approved-origin guard to pop-ups and fails a switch to a pop-up that never opened', async ({ skip }) => {
    if (!browser) return skip(`${name} is not installed or cannot launch here`)
    const blocked = await run({ startUrl: `${a.origin}/popup`, timeoutMs: 3000, steps: [{ action: 'click', selector: '#evil' }, { action: 'switchPage', page: 'popup:1' }] })
    expect(blocked.status).toBe('failed')
    expect(blocked.errors).toContain(`Navigation to an unapproved origin (${c.origin}) was blocked.`)
    expect(c.hits).toEqual([])

    const missing = await run({ startUrl: `${a.origin}/popup`, timeoutMs: 1500, steps: [{ action: 'switchPage', page: 'popup:1' }] })
    expect(missing.status).toBe('failed')
    expect(missing.steps[0]?.error).toBe('switchPage failed: Pop-up 1 did not open within 1500 ms.')
  })

  it('uploads a fixture stored in the scenario; the server receives the file and the temp copy is removed', async ({ skip }) => {
    if (!browser) return skip(`${name} is not installed or cannot launch here`)
    const content = 'Synthetic resume for QA - not a real person'
    const artifactDir = mkdtempSync(join(dir, 'upload-'))
    const result = await run(
      {
        startUrl: `${a.origin}/upload`,
        fixtures: [{ name: 'resume.txt', data: Buffer.from(content).toString('base64') }],
        steps: [
          { action: 'upload', selector: '#file', fixtures: ['resume.txt'] },
          { action: 'click', selector: '#send' },
          { action: 'assertText', selector: '#done', value: 'Received' },
        ],
      },
      artifactDir,
    )
    expect(result.errors).toEqual([])
    expect(result.status).toBe('passed')
    const received = a.hits.find((hit) => hit.path === '/upload-receive')
    expect(received?.method).toBe('POST')
    expect(received?.body).toContain('filename="resume.txt"')
    expect(received?.body).toContain(content)
    expect(readdirSync(artifactDir)).not.toContain('fixtures')
  })

  it('click → 302 → page: assertStatus sees the final 200, also when the click navigates from a timer', async ({ skip }) => {
    if (!browser) return skip(`${name} is not installed or cannot launch here`)
    for (const selector of ['#go', '#later']) {
      const result = await run({
        startUrl: `${a.origin}/start-203`,
        steps: [
          { action: 'click', selector },
          { action: 'assertStatus', value: 200 },
          { action: 'assertVisible', selector: '#landed' },
        ],
      })
      expect(result.errors, selector).toEqual([])
      expect(result.status, selector).toBe('passed')
      expect(result.redirects, selector).toEqual([{ status: 302, from: `${a.origin}/hop`, to: `${a.origin}/landing` }])
      expect(result.steps[0]?.redirects ?? result.steps[1]?.redirects, selector).toHaveLength(1)
    }
    // Without a navigation, assertStatus still checks the current document after the short grace period.
    const stay = await run({ startUrl: `${a.origin}/start-203`, steps: [{ action: 'assertStatus', value: 203 }] })
    expect(stay.status).toBe('passed')
  })

  it('records actions in frames and pop-ups, never password values or scripted file events', async ({ skip }) => {
    if (!browser) return skip(`${name} is not installed or cannot launch here`)
    const recording: QaRecording = { id: 'r', status: 'recording', steps: [], warnings: [] }
    const origins = [a.origin, b.origin]
    const context = await browser.newContext({ serviceWorkers: 'block' })
    try {
      await attachRecorder(context, origins, recording)
      await context.route('**/*', navigationGuard(origins, 10_000, (message) => recording.warnings.push(message)))
      const page = await context.newPage()
      const settle = async (count: number): Promise<void> => {
        for (let tries = 0; recording.steps.length < count && tries < 100; tries++) await page.waitForTimeout(50)
      }
      await page.goto(`${a.origin}/frames`)
      await page.frameLocator('#cross').locator('#name').fill('Ada')
      await page.frameLocator('#cross').locator('#pw').fill('hunter2-secret')
      await settle(1)
      await page.frameLocator('#nested').frameLocator('#deep').locator('#name').fill('Deep')
      await settle(2)
      await page.goto(`${a.origin}/upload`)
      await page.locator('#file').setInputFiles({ name: 'My CV.txt', mimeType: 'text/plain', buffer: Buffer.from('cv') })
      await page.waitForTimeout(200)
      await page.goto(`${a.origin}/popup`)
      const opened = page.waitForEvent('popup')
      await page.locator('#open').click()
      const popup = await opened
      await popup.waitForLoadState('domcontentloaded')
      await popup.locator('#name').fill('In popup')
      await settle(5)
      await page.locator('#tab').click()
      await settle(7)
      const steps = recording.steps.map((step) => {
        const { fallbacks: _fallbacks, ...rest } = step as typeof step & { fallbacks?: unknown }
        return rest
      })
      expect(steps.slice(0, 2)).toEqual([
        { action: 'fill', selector: '#name', value: 'Ada', frame: ['#cross'] },
        { action: 'fill', selector: '#name', value: 'Deep', frame: ['#nested', '#deep'] },
      ])
      // Playwright's setInputFiles dispatches untrusted events; like any scripted event they are not recorded
      // (a real file chooser fires trusted ones — the capture itself is covered in qa-forms.test.ts).
      expect(steps.some((step) => step.action === 'upload')).toBe(false)
      const popupAt = steps.findIndex((step) => step.action === 'switchPage')
      expect(steps.slice(popupAt - 1, popupAt + 2)).toEqual([
        { action: 'click', selector: '#open' },
        { action: 'switchPage', page: 'popup:1' },
        { action: 'fill', selector: '#name', value: 'In popup' },
      ])
      expect(steps.at(-1)).toEqual({ action: 'click', selector: '#tab' })
      expect(steps).toContainEqual({ action: 'switchPage', page: 'main' })
      expect(JSON.stringify(recording)).not.toContain('hunter2-secret')
    } finally {
      recording.status = 'stopped'
      await context.close()
    }
  })
})

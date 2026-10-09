/**
 * Real-browser checks for following document redirects in QA runs (src/main/qa/navigation.ts +
 * executor), per engine, with local servers on different ports (= different origins):
 *
 * - A: approved, and the only origin a site access token lists;
 * - B: approved, not token-listed;
 * - C: NOT approved — must never receive a request through a redirect.
 *
 * Each engine is skipped when its Playwright build is not installed or cannot launch on this host.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium, firefox, webkit } from 'playwright-core'
import type { Browser, BrowserType } from 'playwright-core'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { executeScenario } from '../src/main/qa/executor'
import { attachSiteAccessRules } from '../src/main/site-access/attach'
import { MAX_DOCUMENT_REDIRECTS } from '../src/main/security/redirects'
import { ScenarioInputSchema } from '../src/shared/qa'
import type { QaExecution } from '../src/shared/qa'

const HEADER = 'x-qa-access'
const SECRET = 'qa-allow-8c1d2e3f4a5b6c7d' // gitleaks:allow (synthetic test value)

interface Hit {
  method: string
  path: string
  header: string | null
  cookie: string | null
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
      const header = req.headers[HEADER]
      const hit: Hit = {
        method: req.method ?? '',
        path: req.url ?? '',
        header: typeof header === 'string' ? header : null,
        cookie: req.headers.cookie ?? null,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      hits.push(hit)
      handler(req, res, hit)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const html = (res: ServerResponse, body: string, status = 200): void => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>page</title></head><body>${body}</body></html>`)
}
const redirect = (res: ServerResponse, status: number, location: string, extra: Record<string, string> = {}): void => {
  res.writeHead(status, { location, ...extra })
  res.end()
}

let a: TestServer
let b: TestServer
let c: TestServer

beforeAll(async () => {
  c = await startServer((_req, res) => html(res, '<h1>Unapproved</h1>'))
  b = await startServer((_req, res, hit) => {
    if (hit.path === '/hop') redirect(res, 302, `${a.origin}/back`)
    else if (hit.path === '/to-c') redirect(res, 302, `${c.origin}/landed`)
    else html(res, `<h1>B ${hit.method} ${hit.path}</h1>`)
  })
  a = await startServer((_req, res, hit) => {
    switch (hit.path) {
      case '/start':
        return redirect(res, 302, 'form', { 'set-cookie': 'qa_session=1; Path=/' })
      case '/form':
        return html(res, '<h1>Form</h1><form method="post" action="/submit"><input id="email" name="email"><button id="send">Send</button></form>')
      case '/submit':
        return redirect(res, 303, '/thanks')
      case '/thanks':
        return html(res, `<h1 id="done">Thanks ${hit.method}</h1>`)
      case '/to-b':
        return redirect(res, 302, `${b.origin}/hop`)
      case '/back':
        return html(res, '<h1 id="done">Back</h1>')
      case '/to-c':
        return redirect(res, 302, `${c.origin}/landed`)
      case '/via-b-to-c':
        return redirect(res, 302, `${b.origin}/to-c`)
      case '/loop-1':
        return redirect(res, 302, '/loop-2')
      case '/loop-2':
        return redirect(res, 302, '/loop-1')
      case '/gone':
        return redirect(res, 301, '/missing')
      case '/missing':
        return html(res, '<h1>Not found</h1>', 404)
      case '/post-form-307':
        return html(res, '<h1>Form</h1><form method="post" action="/submit-307"><input id="email" name="email"><button id="send">Send</button></form>')
      case '/post-form-307-cross':
        return html(res, `<h1>Form</h1><form method="post" action="/submit-307-cross"><input id="email" name="email"><button id="send">Send</button></form>`)
      case '/submit-307':
        return redirect(res, 307, '/submit-307/')
      case '/submit-307/':
        return html(res, `<h1 id="done">Replayed ${hit.method} ${hit.body}</h1>`)
      case '/submit-307-cross':
        return redirect(res, 307, `${b.origin}/echo`)
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

const token = (): Parameters<typeof attachSiteAccessRules>[1] => [
  { id: 't1', name: 'Local staging', origins: [a.origin], headerName: 'X-QA-Access', headerValue: SECRET },
]

describe.each(ENGINES)('QA document redirects in a real browser (%s)', (name, type) => {
  let browser: Browser | null = null
  let dir = ''

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'qa-redirects-'))
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

  const run = async (
    scenario: Record<string, unknown>,
    options: { tokens?: boolean } = {},
  ): Promise<QaExecution> => {
    const context = await browser!.newContext({ serviceWorkers: 'block' })
    try {
      if (options.tokens) await attachSiteAccessRules(context, token())
      return await executeScenario(
        context,
        ScenarioInputSchema.parse({ name: 'Redirects', profileId: 'test', allowedOrigins: [a.origin, b.origin], timeoutMs: 10_000, ...scenario }),
        mkdtempSync(join(dir, 'case-')),
        new AbortController().signal,
      )
    } finally {
      await context.close()
    }
  }
  const pathsOf = (server: TestServer): string[] => server.hits.map((hit) => `${hit.method} ${hit.path}`)

  it('POST form → 303 → thank-you page passes, and the chain is recorded', async ({ skip }) => {
    if (!browser) return skip(`${name} is not installed or cannot launch here`)
    const result = await run({
      startUrl: `${a.origin}/form`,
      steps: [
        { action: 'fill', selector: '#email', value: 'lead@example.test' },
        { action: 'click', selector: '#send' },
        { action: 'assertText', selector: '#done', value: 'Thanks GET' },
        { action: 'assertUrl', value: '/thanks' },
        { action: 'assertStatus', value: 200 },
      ],
    })
    expect(result.errors).toEqual([])
    expect(result.status).toBe('passed')
    expect(result.finalUrl).toBe(`${a.origin}/thanks`)
    expect(pathsOf(a)).toEqual(['GET /form', 'POST /submit', 'GET /thanks'])
    expect(a.hits[1]?.body).toBe('email=lead%40example.test')
    expect(result.redirects).toEqual([{ status: 303, from: `${a.origin}/submit`, to: `${a.origin}/thanks` }])
  })

  it('/start → 302 → /form passes: the cookie of the 3xx is kept and assertStatus sees the final 200', async ({ skip }) => {
    if (!browser) return skip(`${name} is not installed or cannot launch here`)
    const result = await run({
      startUrl: `${a.origin}/start`,
      steps: [
        { action: 'assertStatus', value: 200 },
        { action: 'assertUrl', value: '/form' },
        { action: 'assertVisible', selector: '#email' },
      ],
    })
    expect(result.errors).toEqual([])
    expect(result.status).toBe('passed')
    expect(result.redirects).toEqual([{ status: 302, from: `${a.origin}/start`, to: `${a.origin}/form` }])
    expect(a.hits.find((hit) => hit.path === '/form')?.cookie).toContain('qa_session=1')
  })

  it('assertStatus checks the final document of a chain (301 → 404), and a goto step records its hops', async ({ skip }) => {
    if (!browser) return skip(`${name} is not installed or cannot launch here`)
    const result = await run({
      startUrl: `${a.origin}/home`,
      steps: [
        { action: 'goto', value: `${a.origin}/gone` },
        { action: 'assertStatus', value: 404 },
      ],
    })
    expect(result.status).toBe('passed')
    expect(result.steps[0]?.redirects).toEqual([{ status: 301, from: `${a.origin}/gone`, to: `${a.origin}/missing` }])
    expect(result.steps[1]?.redirects).toBeUndefined()
  })

  it('follows a chain across approved origins (A → B → A)', async ({ skip }) => {
    if (!browser) return skip(`${name} is not installed or cannot launch here`)
    const result = await run({ startUrl: `${a.origin}/to-b`, steps: [{ action: 'assertText', selector: '#done', value: 'Back' }, { action: 'assertStatus', value: 200 }] })
    expect(result.status).toBe('passed')
    expect(result.redirects?.map((hop) => [hop.status, hop.to])).toEqual([
      [302, `${b.origin}/hop`],
      [302, `${a.origin}/back`],
    ])
  })

  it('blocks a redirect to an unapproved origin before it receives anything', async ({ skip }) => {
    if (!browser) return skip(`${name} is not installed or cannot launch here`)
    const direct = await run({ startUrl: `${a.origin}/home`, steps: [{ action: 'goto', value: `${a.origin}/to-c` }] })
    expect(direct.status).toBe('failed')
    expect(direct.errors).toContain(`Navigation to an unapproved origin (${c.origin}) was blocked (HTTP 302 redirect).`)
    expect(direct.redirects).toEqual([{ status: 302, from: `${a.origin}/to-c`, to: `${c.origin}/landed`, blocked: true }])

    // The second hop leaves the approved origins: the first is followed, the second is blocked.
    const chained = await run({ startUrl: `${a.origin}/via-b-to-c`, steps: [{ action: 'assertVisible', selector: 'h1' }] })
    expect(chained.status).toBe('failed')
    expect(chained.redirects?.map((hop) => hop.blocked ?? false)).toEqual([false, true])
    expect(chained.errors).toEqual([`Navigation to an unapproved origin (${c.origin}) was blocked (HTTP 302 redirect).`])
    expect(pathsOf(b)).toEqual(['GET /to-c'])
    expect(c.hits).toEqual([])
  })

  it('stops a redirect loop at the hop limit', async ({ skip }) => {
    if (!browser) return skip(`${name} is not installed or cannot launch here`)
    const result = await run({ startUrl: `${a.origin}/loop-1`, steps: [{ action: 'assertVisible', selector: 'h1' }] })
    expect(result.status).toBe('failed')
    expect(result.errors.join('\n')).toContain(`Stopped after ${MAX_DOCUMENT_REDIRECTS} HTTP redirects`)
    expect(a.hits).toHaveLength(MAX_DOCUMENT_REDIRECTS + 1)
    expect(result.redirects).toHaveLength(MAX_DOCUMENT_REDIRECTS + 1)
    expect(result.redirects?.at(-1)?.blocked).toBe(true)
  })

  it('replays a same-origin 307 POST with its body, and blocks a cross-origin one', async ({ skip }) => {
    if (!browser) return skip(`${name} is not installed or cannot launch here`)
    const same = await run({
      startUrl: `${a.origin}/post-form-307`,
      steps: [
        { action: 'fill', selector: '#email', value: 'x' },
        { action: 'click', selector: '#send' },
        { action: 'assertText', selector: '#done', value: 'Replayed POST email=x' },
      ],
    })
    expect(same.status).toBe('passed')
    expect(same.redirects).toEqual([{ status: 307, from: `${a.origin}/submit-307`, to: `${a.origin}/submit-307/` }])

    const cross = await run({
      startUrl: `${a.origin}/post-form-307-cross`,
      steps: [
        { action: 'fill', selector: '#email', value: 'x' },
        { action: 'click', selector: '#send' },
        { action: 'assertVisible', selector: '#done' },
      ],
    })
    expect(cross.status).toBe('failed')
    expect(cross.errors.join('\n')).toContain('307 redirect of a POST request to another origin')
    expect(b.hits).toEqual([])
  })

  it('followRedirects: false restores strict blocking', async ({ skip }) => {
    if (!browser) return skip(`${name} is not installed or cannot launch here`)
    const result = await run({ startUrl: `${a.origin}/home`, followRedirects: false, steps: [{ action: 'goto', value: `${a.origin}/start` }] })
    expect(result.status).toBe('failed')
    expect(result.errors.join('\n')).toContain('follow redirects is off')
    expect(a.hits.some((hit) => hit.path === '/form')).toBe(false)
  })

  it('site access header: only token-listed origins along an approved chain, never the unapproved origin', async ({ skip }) => {
    if (!browser) return skip(`${name} is not installed or cannot launch here`)
    const followed = await run({ startUrl: `${a.origin}/to-b`, steps: [{ action: 'assertText', selector: '#done', value: 'Back' }] }, { tokens: true })
    expect(followed.status).toBe('passed')
    expect(a.hits.map((hit) => [hit.path, hit.header])).toEqual([
      ['/to-b', SECRET],
      ['/back', SECRET],
    ])
    // B is approved but not token-listed: it is visited without the header.
    expect(b.hits.map((hit) => [hit.path, hit.header])).toEqual([['/hop', null]])

    for (const server of [a, b, c]) server.hits.length = 0
    const blocked = await run({ startUrl: `${a.origin}/home`, steps: [{ action: 'goto', value: `${a.origin}/via-b-to-c` }, { action: 'goto', value: `${a.origin}/to-c` }] }, { tokens: true })
    expect(blocked.status).toBe('failed')
    expect(a.hits.find((hit) => hit.path === '/via-b-to-c')?.header).toBe(SECRET)
    expect(b.hits.filter((hit) => hit.header !== null)).toEqual([])
    expect(c.hits).toEqual([])
    expect(JSON.stringify(followed) + JSON.stringify(blocked)).not.toContain(SECRET)

    for (const server of [a, b, c]) server.hits.length = 0
    const post = await run(
      {
        startUrl: `${a.origin}/form`,
        steps: [
          { action: 'fill', selector: '#email', value: 'lead@example.test' },
          { action: 'click', selector: '#send' },
          { action: 'assertText', selector: '#done', value: 'Thanks GET' },
        ],
      },
      { tokens: true },
    )
    expect(post.status).toBe('passed')
    expect(a.hits.map((hit) => [hit.method, hit.path, hit.header])).toEqual([
      ['GET', '/form', SECRET],
      ['POST', '/submit', SECRET],
      ['GET', '/thanks', SECRET],
    ])
  })
})

/**
 * Real-browser checks for site access tokens (src/main/site-access/attach.ts), per engine.
 *
 * Two (or three) local HTTP servers on different ports are different origins. Only origin A is
 * allowlisted. The critical property: the secret header NEVER reaches another origin — not through a
 * 302 from A (documents and sub-resources), not as a third-party sub-resource of A's page.
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
import { attachSiteAccessRules } from '../src/main/site-access/attach'
import type { SiteAccessApplication } from '../src/main/site-access/matcher'
import { navigationGuard } from '../src/main/qa/navigation'
import { executeScenario } from '../src/main/qa/executor'
import { ScenarioInputSchema } from '../src/shared/qa'

const HEADER = 'x-qa-access'
const SECRET = 'qa-allow-3b7f0c2e9d41a6f8' // gitleaks:allow (synthetic test value)

interface Hit {
  path: string
  header: string | null
  cookie: string | null
}

interface TestServer {
  origin: string
  hits: Hit[]
  close(): Promise<void>
}

async function startServer(handler: (req: IncomingMessage, res: ServerResponse, self: { origin: string }) => void): Promise<TestServer> {
  const hits: Hit[] = []
  const self = { origin: '' }
  const server: Server = createServer((req, res) => {
    const header = req.headers[HEADER]
    hits.push({ path: req.url ?? '', header: typeof header === 'string' ? header : null, cookie: req.headers.cookie ?? null })
    handler(req, res, self)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  self.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    origin: self.origin,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const html = (res: ServerResponse, body: string): void => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'access-control-allow-origin': '*' })
  res.end(`<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`)
}

let a: TestServer
let b: TestServer
let c: TestServer

beforeAll(async () => {
  b = await startServer((_req, res) => html(res, 'B'))
  c = await startServer((_req, res) => html(res, 'C'))
  a = await startServer((req, res, self) => {
    const path = req.url ?? '/'
    if (path.startsWith('/to-b')) {
      res.writeHead(302, { location: `${b.origin}/landed${path.slice('/to-b'.length)}` })
      res.end()
    } else if (path === '/login') {
      res.writeHead(302, { location: '/form', 'set-cookie': 'qa_session=1; Path=/' })
      res.end()
    } else if (path === '/submit') {
      res.writeHead(303, { location: '/thanks' })
      res.end()
    } else if (path === '/page-with-redirecting-subresources') {
      html(
        res,
        `<img src="${self.origin}/to-b-img"><script>fetch('${self.origin}/to-b-fetch').catch(() => {}).finally(() => { document.title = 'done' })</script>`,
      )
    } else if (path === '/page-with-third-party') {
      html(
        res,
        `<img src="${c.origin}/pixel.png"><img src="${self.origin}/own.png"><script>Promise.allSettled([fetch('${c.origin}/api'), fetch('${self.origin}/api')]).finally(() => { document.title = 'done' })</script>`,
      )
    } else {
      html(res, `A ${path}`)
    }
  })
})

afterAll(async () => {
  await Promise.all([a?.close(), b?.close(), c?.close()])
})

beforeEach(() => {
  for (const server of [a, b, c]) server.hits.length = 0
})

const rule = (): Parameters<typeof attachSiteAccessRules>[1] => [
  { id: 't1', name: 'Local staging', origins: [a.origin], headerName: 'X-QA-Access', headerValue: SECRET },
]

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

describe.each(ENGINES)('site access tokens in a real browser (%s)', (name, type) => {
  let browser: Browser | null = null

  beforeAll(async () => {
    if (!installed(type)) return
    try {
      // A document fulfilled through interception has no network address, so Chromium's Local Network Access
      // checks treat it as public and deny its requests to another loopback port (here: the third-party
      // server C). Real staging sites are public; the switch only lets this loopback-only test observe C.
      browser = await type.launch({ headless: true, ...(name === 'chromium' ? { args: ['--disable-features=LocalNetworkAccessChecks'] } : {}) })
    } catch {
      browser = null
    }
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('control: a naive route.continue({ headers }) re-sends the header on the redirect hop (why attach.ts fetches)', async ({ skip }) => {
    if (!browser) return skip(`${name} is not installed or cannot launch here`)
    // Documents the engine behaviour the mitigation exists for (Playwright 1.63: Chromium, Firefox and WebKit all
    // leak) and proves this harness can observe a leak. If an upgrade makes this fail, the engine stopped leaking;
    // attach.ts stays correct either way.
    const context = await browser.newContext()
    try {
      await context.route(
        (url) => url.origin === a.origin,
        (route) => route.continue({ headers: { ...route.request().headers(), [HEADER]: SECRET } }),
      )
      const page = await context.newPage()
      await page.goto(`${a.origin}/to-b-naive`)
      await page.waitForURL(`${b.origin}/landed-naive`)
      expect(b.hits.find((hit) => hit.path === '/landed-naive')?.header).toBe(SECRET)
    } finally {
      await context.close()
    }
  })

  it('never sends the header across a cross-origin redirect (document and sub-resources)', async ({ skip }) => {
    if (!browser) return skip(`${name} is not installed or cannot launch here`)
    const context = await browser.newContext()
    try {
      const applied: SiteAccessApplication[] = []
      await attachSiteAccessRules(context, rule(), { onApplied: (event) => applied.push(event) })
      const page = await context.newPage()
      await page.goto(`${a.origin}/to-b-doc`)
      await page.waitForURL(`${b.origin}/landed-doc`)
      await page.goto(`${a.origin}/page-with-redirecting-subresources`)
      await page.waitForFunction(() => document.title === 'done')
      await page.waitForTimeout(300)

      expect(a.hits.find((hit) => hit.path === '/to-b-doc')?.header).toBe(SECRET)
      expect(a.hits.find((hit) => hit.path === '/to-b-img')?.header).toBe(SECRET)
      expect(a.hits.find((hit) => hit.path === '/to-b-fetch')?.header).toBe(SECRET)
      expect(b.hits.some((hit) => hit.path === '/landed-doc')).toBe(true)
      // The whole point: origin B never sees the secret, whatever the engine does with the redirect.
      expect(b.hits.filter((hit) => hit.header !== null)).toEqual([])
      expect(applied).toEqual([{ tokenId: 't1', tokenName: 'Local staging', origin: a.origin }])
    } finally {
      await context.close()
    }
  })

  it('keeps the header on same-origin redirects (they are re-routed as fresh navigations)', async ({ skip }) => {
    if (!browser) return skip(`${name} is not installed or cannot launch here`)
    const context = await browser.newContext()
    try {
      await attachSiteAccessRules(context, rule())
      const page = await context.newPage()
      await page.goto(`${a.origin}/login`)
      await page.waitForURL(`${a.origin}/form`)
      await page.setContent(`<form method="post" action="${a.origin}/submit"><button>Send</button></form>`)
      await page.click('button')
      await page.waitForURL(`${a.origin}/thanks`)

      const byPath = (path: string): Hit | undefined => a.hits.find((hit) => hit.path === path)
      expect(byPath('/login')?.header).toBe(SECRET)
      expect(byPath('/form')?.header).toBe(SECRET)
      // The cookie set on the redirect response reached the browser's jar.
      expect(byPath('/form')?.cookie).toContain('qa_session=1')
      expect(byPath('/submit')?.header).toBe(SECRET)
      expect(byPath('/thanks')?.header).toBe(SECRET)
    } finally {
      await context.close()
    }
  })

  it('does not send the header to a third-party origin on the same page, nor to another port', async ({ skip }) => {
    if (!browser) return skip(`${name} is not installed or cannot launch here`)
    const context = await browser.newContext()
    try {
      await attachSiteAccessRules(context, rule())
      const page = await context.newPage()
      await page.goto(`${a.origin}/page-with-third-party`)
      await page.waitForFunction(() => document.title === 'done')
      await page.waitForTimeout(300)

      expect(a.hits.find((hit) => hit.path === '/own.png')?.header).toBe(SECRET)
      expect(a.hits.find((hit) => hit.path === '/api')?.header).toBe(SECRET)
      expect(c.hits.map((hit) => hit.path).sort()).toEqual(['/api', '/pixel.png'])
      expect(c.hits.filter((hit) => hit.header !== null)).toEqual([])
    } finally {
      await context.close()
    }
  })

  it('composes with the QA navigation guard: documents get the header, redirects to unapproved origins stay blocked', async ({ skip }) => {
    if (!browser) return skip(`${name} is not installed or cannot launch here`)
    const context = await browser.newContext()
    const blocked: string[] = []
    try {
      // Same order as production: site access at context creation, the guard later (it runs first).
      await attachSiteAccessRules(context, rule())
      await context.route('**/*', navigationGuard([a.origin], 10_000, (message) => blocked.push(message)))
      const page = await context.newPage()
      await page.goto(`${a.origin}/page-with-third-party`)
      await page.waitForFunction(() => document.title === 'done')
      await page.goto(`${a.origin}/to-b-doc`).catch(() => undefined)
      await page.waitForTimeout(300)

      expect(a.hits.find((hit) => hit.path === '/page-with-third-party')?.header).toBe(SECRET)
      expect(a.hits.find((hit) => hit.path === '/own.png')?.header).toBe(SECRET)
      expect(a.hits.find((hit) => hit.path === '/to-b-doc')?.header).toBe(SECRET)
      expect(blocked.length).toBeGreaterThan(0)
      expect(b.hits).toEqual([])
      expect(c.hits.filter((hit) => hit.header !== null)).toEqual([])
    } finally {
      await context.close()
    }
  })

  it('a real QA scenario run (executeScenario + guard) sends the header to the allowlisted origin only', async ({ skip }) => {
    if (!browser) return skip(`${name} is not installed or cannot launch here`)
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const dir = mkdtempSync(join(tmpdir(), 'site-access-qa-'))
    try {
      const notes: string[] = []
      await attachSiteAccessRules(context, rule(), { onApplied: ({ tokenName, origin }) => notes.push(`${tokenName} → ${origin}`) })
      const result = await executeScenario(
        context,
        ScenarioInputSchema.parse({
          name: 'Site access',
          profileId: 'test',
          startUrl: `${a.origin}/page-with-third-party`,
          allowedOrigins: [a.origin],
          timeoutMs: 10_000,
          // The page sets its title once both fetch() calls (to A and to third-party C) have settled.
          steps: [{ action: 'assertText', selector: 'title', value: 'done' }],
        }),
        dir,
        new AbortController().signal,
      )
      expect(result.status).toBe('passed')
      expect(a.hits.find((hit) => hit.path === '/page-with-third-party')?.header).toBe(SECRET)
      expect(a.hits.find((hit) => hit.path === '/api')?.header).toBe(SECRET)
      expect(c.hits.some((hit) => hit.path === '/api')).toBe(true)
      expect(c.hits.filter((hit) => hit.header !== null)).toEqual([])
      expect(notes).toEqual([`Local staging → ${a.origin}`])
      expect(JSON.stringify(result)).not.toContain(SECRET)
    } finally {
      await context.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('registers nothing when no token applies', async ({ skip }) => {
    if (!browser) return skip(`${name} is not installed or cannot launch here`)
    const context = await browser.newContext()
    try {
      await attachSiteAccessRules(context, [])
      const page = await context.newPage()
      await page.goto(`${a.origin}/plain`)
      expect(a.hits.find((hit) => hit.path === '/plain')?.header).toBeNull()
    } finally {
      await context.close()
    }
  })
})

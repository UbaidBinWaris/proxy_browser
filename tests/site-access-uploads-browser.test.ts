/**
 * File uploads to site access origins: Chromium and WebKit leave chosen files' bytes out of the body
 * Playwright exposes, so the terminal route refills them from files the page handed over on pick
 * (src/main/site-access/file-capture.ts) or blocks the upload rather than sending empty files.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, firefox, webkit } from 'playwright-core'
import type { BrowserType, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { attachSiteAccessRules } from '../src/main/site-access/attach'
import { emptyFileParts } from '../src/main/security/multipart-files'

const SECRET = 'qa-upload-7f3a9c' // gitleaks:allow (synthetic test value)
const CONTENT = 'uploaded-file-content-0123456789'

interface Site { server: Server; origin: string; posts: { header?: string; body: string }[]; page: string }
async function site(page: string): Promise<Site> {
  const s = { posts: [], page } as unknown as Site
  s.server = createServer((req, res) => {
    if (req.method === 'POST') {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        s.posts.push({ header: req.headers['x-qa-access'] as string | undefined, body: Buffer.concat(chunks).toString('utf8') })
        res.setHeader('Content-Type', 'text/html')
        res.end('<p id="done">received</p>')
      })
      return
    }
    res.setHeader('Content-Type', 'text/html')
    res.end(s.page)
  })
  await new Promise<void>((resolve) => s.server.listen(0, '127.0.0.1', resolve))
  s.origin = `http://127.0.0.1:${(s.server.address() as AddressInfo).port}`
  return s
}
const form = (action = '/upload') =>
  `<form method="post" enctype="multipart/form-data" action="${action}"><input type="text" name="note" value="hello"><input type="file" name="doc"><button>Send</button></form>`

it('lists file parts whose content the browser left out', () => {
  const body = Buffer.from('--b\r\nContent-Disposition: form-data; name="doc"; filename="a.txt"\r\n\r\n\r\n--b\r\nContent-Disposition: form-data; name="n"\r\n\r\nx\r\n--b\r\nContent-Disposition: form-data; name="f"; filename="b.txt"\r\n\r\ndata\r\n--b--\r\n')
  expect(emptyFileParts('multipart/form-data; boundary=b', body)).toEqual(['a.txt'])
  expect(emptyFileParts('application/x-www-form-urlencoded', body)).toEqual([])
})

const engines: [string, BrowserType][] = [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]
const installed = (type: BrowserType): boolean => {
  try {
    return existsSync(type.executablePath())
  } catch {
    return false
  }
}

for (const [name, engine] of engines) {
  describe.skipIf(!installed(engine))(`site access uploads (${name})`, () => {
    let a: Site, b: Site, dir: string
    beforeAll(async () => {
      a = await site(form())
      b = await site('')
      dir = mkdtempSync(join(tmpdir(), 'site-access-uploads-'))
      writeFileSync(join(dir, 'doc.txt'), CONTENT)
      writeFileSync(join(dir, 'empty.txt'), '')
    })
    afterAll(async () => {
      for (const s of [a, b]) await new Promise<void>((resolve) => s.server.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    })
    const run = async (url: string, file: string, blocked: string[] = [], afterPick?: (page: Page) => Promise<void>) => {
      // Chromium's Local Network Access check blocks the other-port localhost frame on a page the app served.
      const browser = await engine.launch({ headless: true, ...(name === 'chromium' ? { args: ['--disable-features=LocalNetworkAccessChecks'] } : {}) })
      try {
        const context = await browser.newContext()
        await attachSiteAccessRules(context, [{ id: 't1', name: 'Staging', origins: [a.origin], headerName: 'X-QA-Access', headerValue: SECRET }], {
          onBlocked: (message) => blocked.push(message),
        })
        const page = await context.newPage()
        await page.goto(url)
        await page.setInputFiles('input[type=file]', join(dir, file))
        await afterPick?.(page)
        await page.click('button').catch(() => undefined)
        await page.waitForSelector('#done', { timeout: 8000 }).catch(() => undefined)
      } finally {
        await browser.close()
      }
    }

    it('forwards the chosen file with its bytes and the token header', async () => {
      a.posts.length = 0
      await run(`${a.origin}/`, 'doc.txt')
      expect(a.posts).toHaveLength(1)
      expect(a.posts[0]!.header).toBe(SECRET)
      expect(a.posts[0]!.body).toContain(CONTENT)
      expect(a.posts[0]!.body).toContain('hello')
    }, 60000)

    it('uploads a genuinely empty file', async () => {
      a.posts.length = 0
      await run(`${a.origin}/`, 'empty.txt')
      expect(a.posts).toHaveLength(1)
      expect(a.posts[0]!.body).toContain('filename="empty.txt"')
    }, 60000)

    it('blocks an upload whose bytes it cannot forward instead of sending an empty file', async () => {
      a.posts.length = 0
      b.page = form(`${a.origin}/upload`) // an unlisted page posting a file to the token-listed origin
      const blocked: string[] = []
      await run(`${b.origin}/`, 'doc.txt', blocked)
      if (name === 'firefox') {
        // Firefox exposes the bytes itself, so nothing needs restoring.
        expect(a.posts[0]?.body).toContain(CONTENT)
      } else {
        expect(a.posts).toHaveLength(0)
        expect(blocked.some((message) => message.includes('file upload'))).toBe(true)
      }
    }, 60000)

    it('ignores file bytes pushed by a frame from another origin', async () => {
      a.posts.length = 0
      a.page = `${form()}<iframe src="${b.origin}/frame"></iframe>`
      b.page = '<p>third-party frame</p>'
      await run(`${a.origin}/`, 'doc.txt', [], async (page) => {
        // After the real pick, the other-origin frame tries to replace the kept bytes.
        await page.waitForTimeout(300)
        const frame = page.frames().find((candidate) => candidate.url().startsWith(b.origin))!
        await frame.evaluate(async () => {
          const push = (window as unknown as Record<string, (...args: unknown[]) => Promise<void>>)['__proxyQaSiteAccessFile']!
          await push('announce', 'doc.txt', 6)
          await push('data', 'doc.txt', 6, btoa('PLANTD'))
        })
      })
      a.page = form()
      expect(a.posts[0]?.body ?? '').not.toContain('PLANTD')
      expect(a.posts[0]?.body).toContain(CONTENT)
    }, 60000)
  })
}

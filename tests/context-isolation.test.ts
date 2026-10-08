/**
 * Real-Playwright check that two BrowserContexts in one Browser share nothing.
 * Skipped when the host has no launchable Chromium in its Playwright cache.
 */
import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'
import type { Browser } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Profile } from '../src/shared/types'
import { buildContextOptions, getPreset } from '../src/main/browser/device-presets'

function chromiumAvailable(): boolean {
  try {
    return existsSync(chromium.executablePath())
  } catch {
    return false
  }
}

const available = chromiumAvailable()

const profile: Profile = {
  id: 'p-iso',
  name: 'Isolation',
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
  proxyPool: 'residential',
  providerId: 'dataimpulse',
  target: null,
  stickyTtlMinutes: null,
  ephemeral: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const PAGE_HTML = '<!doctype html><html><body><h1>QA</h1></body></html>'

describe.skipIf(!available)('browser context isolation (real Chromium)', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('cookies set in context A are invisible to context B', async () => {
    const options = buildContextOptions(profile, getPreset('linux-desktop'))
    const contextA = await browser.newContext(options)
    const contextB = await browser.newContext(options)
    try {
      await contextA.addCookies([
        { name: 'qa_session', value: 'alpha', url: 'https://qa.example.test/', secure: true, sameSite: 'Lax' },
      ])
      expect(await contextA.cookies('https://qa.example.test/')).toHaveLength(1)
      expect(await contextB.cookies('https://qa.example.test/')).toHaveLength(0)
      expect(await contextB.cookies()).toHaveLength(0)
    } finally {
      await contextA.close()
      await contextB.close()
    }
  })

  it('localStorage written in context A is absent in context B', async () => {
    const options = buildContextOptions(profile, getPreset('linux-desktop'))
    const contextA = await browser.newContext(options)
    const contextB = await browser.newContext(options)
    try {
      for (const ctx of [contextA, contextB]) {
        await ctx.route('https://qa.example.test/**', (route) =>
          route.fulfill({ status: 200, contentType: 'text/html', body: PAGE_HTML }),
        )
      }
      const pageA = await contextA.newPage()
      await pageA.goto('https://qa.example.test/', { waitUntil: 'domcontentloaded' })
      await pageA.evaluate(() => localStorage.setItem('lead', 'L-123'))
      expect(await pageA.evaluate(() => localStorage.getItem('lead'))).toBe('L-123')

      const pageB = await contextB.newPage()
      await pageB.goto('https://qa.example.test/', { waitUntil: 'domcontentloaded' })
      expect(await pageB.evaluate(() => localStorage.getItem('lead'))).toBeNull()
      expect(await pageB.evaluate(() => localStorage.length)).toBe(0)
    } finally {
      await contextA.close()
      await contextB.close()
    }
  })

  it('applies the preset emulation to the context', async () => {
    const context = await browser.newContext(buildContextOptions(profile, getPreset('linux-desktop')))
    try {
      const page = await context.newPage()
      // The node tsconfig has no DOM lib; `globalThis` here is the page's window.
      const info = await page.evaluate(() => {
        const win = globalThis as unknown as { innerWidth: number; innerHeight: number }
        return {
          ua: navigator.userAgent,
          width: win.innerWidth,
          height: win.innerHeight,
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
          lang: navigator.language,
        }
      })
      expect(info.ua).toContain('Linux x86_64')
      expect(info.width).toBe(1280)
      expect(info.height).toBe(800)
      expect(info.tz).toBe('UTC')
      expect(info.lang).toBe('en-US')
    } finally {
      await context.close()
    }
  })
})

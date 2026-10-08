import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ProfileSchema } from '../src/shared/types'
import { ScenarioInputSchema } from '../src/shared/qa'
import type { BrowserProvisioner, Logger, ProxyManager } from '../src/main/contracts'
import { createQaExecutor } from '../src/main/qa/runtime'
import { TRACE_SKIPPED_NOTE } from '../src/main/site-access'
import type { SiteAccessAttacher } from '../src/main/site-access'

const available = existsSync(chromium.executablePath())
if (!available && process.env.QA_REQUIRE_BROWSER_TESTS === '1')
  throw new Error('Chromium is required for QA integration tests. Install it before running CI.')

const silent = { debug() {}, info() {}, warn() {}, error() {}, registerSecret() {} } as unknown as Logger
const provisioner = {
  resolveEngine: async () => ({ family: 'chromium', kind: 'bundled', executablePath: null }),
} as unknown as BrowserProvisioner
const direct = { resolveForProfile: () => null } as unknown as ProxyManager

/** Like the real attacher: a note is produced only when a matching request is actually sent. */
const recordingAttacher = (active: boolean): SiteAccessAttacher => ({
  hasActiveRules: () => active,
  attach: async (context, onNote) => {
    let noted = false
    await context.route('**/*', (route) => {
      if (active && !noted) {
        noted = true
        onNote?.(`site access token "Staging" applied to ${new URL(route.request().url()).origin}`)
      }
      return route.fallback()
    })
  },
})

describe.skipIf(!available)('QA executor case notes', () => {
  let url: string, dir: string
  // The image is a sub-resource: it passes the navigation guard via route.fallback() into the attacher's route.
  const server = createServer((req, res) => {
    if (req.url === '/pixel.svg') {
      res.setHeader('Content-Type', 'image/svg+xml')
      return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')
    }
    res.setHeader('Content-Type', 'text/html')
    res.end('<!doctype html><h1>Ready</h1><img src="/pixel.svg" alt="">')
  })
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'qa-runtime-notes-'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const profile = () =>
    ProfileSchema.parse({
      id: 'p1',
      createdAt: '2026-10-09T00:00:00.000Z',
      updatedAt: '2026-10-09T00:00:00.000Z',
      name: 'Direct Chromium',
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
    })
  const scenario = (captureTrace: boolean) =>
    ScenarioInputSchema.parse({
      name: 'Notes',
      profileId: 'p1',
      startUrl: `${url}/`,
      allowedOrigins: [url],
      timeoutMs: 5000,
      captureTrace,
      steps: [
        { action: 'assertText', selector: 'h1', value: 'Ready' },
        { action: 'assertVisible', selector: 'img' },
      ],
    })

  it('keeps the token notes recorded while the scenario navigates, after the trace note', async () => {
    const execute = createQaExecutor(provisioner, direct, (t) => t, silent, undefined, undefined, recordingAttacher(true))
    const result = await execute(profile(), scenario(true), join(dir, 'a'), new AbortController().signal)
    expect(result.status).toBe('passed')
    expect(result.notes).toEqual([TRACE_SKIPPED_NOTE, `site access token "Staging" applied to ${url}`])
    expect(result.trace).toBeUndefined()
  })

  it('records no notes when no token is active', async () => {
    const execute = createQaExecutor(provisioner, direct, (t) => t, silent, undefined, undefined, recordingAttacher(false))
    const result = await execute(profile(), scenario(false), join(dir, 'b'), new AbortController().signal)
    expect(result.status).toBe('passed')
    expect(result.notes).toBeUndefined()
  })
})

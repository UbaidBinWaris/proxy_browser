import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Route } from 'playwright-core'
import { DEMO_ORIGIN, DEMO_URL, isDemoUrl } from '../src/shared/demo'
import { prepareDemo } from '../src/main/qa/demo'
import { fulfillDemoRequest } from '../src/main/qa/demo-page'
import { navigationGuard } from '../src/main/qa/navigation'
import { openDatabase } from '../src/main/database'
import { createLogger } from '../src/main/logging/logger'
import { createProfileManager } from '../src/main/browser/profile-manager'

const cleanup: Array<() => void> = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose() })
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'qa-demo-'))
  const db = openDatabase(':memory:', { defaultScreenshotDir: dir, env: {} })
  const profiles = createProfileManager({ repo: db.profiles, logger: createLogger({ repo: db.logs, fileDir: join(dir, 'logs') }) })
  cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  return { store: db.qa!, profiles }
}
function route(url: string, method = 'GET') {
  const fulfill = vi.fn(async () => {}), abort = vi.fn(async () => {}), fetch = vi.fn(), fallback = vi.fn(async () => {})
  const raw = { request: () => ({ url: () => url, method: () => method, isNavigationRequest: () => true }), fulfill, abort, fetch, fallback }
  return { raw: raw as unknown as Route, fulfill, abort, fetch }
}

describe('Bundled QA demo', () => {
  it('creates a direct profile and synthetic signup scenario, then reuses them without discarding edits', () => {
    const { store, profiles } = harness()
    const scenario = prepareDemo(store, profiles, 'default', 'chromium')
    expect(profiles.get(scenario.profileId)).toMatchObject({ proxyMode: 'none', target: null, ephemeral: false })
    expect(scenario).toMatchObject({ startUrl: DEMO_URL, allowedOrigins: [DEMO_ORIGIN], captureTrace: false })
    store.saveScenario({ ...scenario, timeoutMs: 2000 }, scenario.id)
    expect(prepareDemo(store, profiles, 'default', 'chromium')).toMatchObject({ id: scenario.id, timeoutMs: 2000 })
    expect(profiles.list()).toHaveLength(1)
    expect(store.scenarios()).toHaveLength(1)
  })
  it('isolates workspaces, preserves changed routing, and rejects an unknown workspace before creating a profile', () => {
    const { store, profiles } = harness()
    expect(() => prepareDemo(store, profiles, 'missing', 'chromium')).toThrow(/workspace/)
    expect(profiles.list()).toHaveLength(0)
    const first = prepareDemo(store, profiles, 'default', 'chromium')
    const workspace = store.createWorkspace('Second')
    const second = prepareDemo(store, profiles, workspace.id, 'chromium')
    expect(second.id).not.toBe(first.id)
    expect(profiles.list()).toHaveLength(1)
    profiles.update(first.profileId, { ...profiles.get(first.profileId), proxyMode: 'rotating' })
    const safe = prepareDemo(store, profiles, 'default', 'chromium')
    expect(safe.id).not.toBe(first.id)
    expect(profiles.get(safe.profileId).proxyMode).toBe('none')
  })
  it('matches only the reserved origin and returns local 404/405 responses instead of networking', async () => {
    for (const url of ['http://demo.proxyqa.test.evil/', 'https://demo.proxyqa.test/', 'http://demo.proxyqa.test:9000/', 'invalid'])
      expect(isDemoUrl(url)).toBe(false)
    const outside = route('https://example.test/')
    expect(await fulfillDemoRequest(outside.raw)).toBe(false)
    expect(outside.fulfill).not.toHaveBeenCalled()
    for (const [path, method, status] of [['/', 'GET', 200], ['/unknown', 'GET', 404], ['/', 'POST', 405], ['/favicon.ico', 'GET', 204]] as const) {
      const request = route(`${DEMO_ORIGIN}${path}`, method)
      expect(await fulfillDemoRequest(request.raw)).toBe(true)
      expect(request.fulfill).toHaveBeenCalledWith(expect.objectContaining({ status }))
      expect(request.fetch).not.toHaveBeenCalled()
    }
  })
  it('never bypasses the approved-origin navigation guard', async () => {
    const blocked = route(DEMO_URL), onBlocked = vi.fn()
    await navigationGuard(['https://example.test'], 1000, onBlocked)(blocked.raw)
    expect(blocked.abort).toHaveBeenCalledWith('blockedbyclient')
    expect(blocked.fulfill).not.toHaveBeenCalled()
    const allowed = route(DEMO_URL)
    await navigationGuard([DEMO_ORIGIN], 1000, onBlocked)(allowed.raw)
    expect(allowed.fulfill).toHaveBeenCalledWith(expect.objectContaining({ status: 200 }))
    expect(allowed.fetch).not.toHaveBeenCalled()
  })
})

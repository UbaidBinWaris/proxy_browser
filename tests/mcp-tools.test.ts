import { describe, expect, it } from 'vitest'

import { checkExitIp } from '../src/main/mcp/tools/check-exit-ip'
import { getResults } from '../src/main/mcp/tools/get-results'
import { listCapabilities } from '../src/main/mcp/tools/list-capabilities'
import { runCheck } from '../src/main/mcp/tools/run-check'
import { countManifestCases, runManifest } from '../src/main/mcp/tools/run-manifest'
import { searchDevices } from '../src/main/mcp/tools/search-devices'
import { searchLocations } from '../src/main/mcp/tools/search-locations'
import { pickScreenshots, summarizeBatch } from '../src/main/mcp/tools/summary'
import { parseQaManifest } from '../src/main/qa/cli-manifest'
import type { ToolContent } from '../src/main/mcp/tools/types'
import { PROXY_PASSWORD, createFakeDeps, ctx, fakeBatch, fakeCase } from './helpers/mcp-fakes'

const text = (content: ToolContent[]): string => (content[0]?.type === 'text' ? content[0].text : '')
const json = (content: ToolContent[]): Record<string, unknown> => JSON.parse(text(content)) as Record<string, unknown>

const PROFILE = {
  name: 'Desktop',
  engine: 'chromium',
  deviceType: 'desktop',
  devicePreset: 'desktop-chrome',
  viewportWidth: 1280,
  viewportHeight: 720,
  userAgent: null,
  locale: 'en-US',
  timezone: 'America/New_York',
  proxyMode: 'none',
  stickySessionId: null,
  formUrlOverride: null,
  notes: '',
}

function scenarioManifest(overrides: { scenario?: Record<string, unknown>; profile?: Record<string, unknown>; matrix?: Record<string, unknown> } = {}): string {
  return JSON.stringify({
    scenario: {
      name: 'Signup',
      profileId: 'p1',
      startUrl: 'https://staging.example.com/signup',
      allowedOrigins: ['https://staging.example.com'],
      steps: [{ action: 'fill', selector: '#email', value: '{{email}}' }],
      datasets: [
        { id: 'a', name: 'Row A', variables: { email: 'dataset-secret-a@example.test' } },
        { id: 'b', name: 'Row B', variables: { email: 'dataset-secret-b@example.test' } },
      ],
      ...overrides.scenario,
    },
    profile: { ...PROFILE, ...overrides.profile },
    ...(overrides.matrix ? { matrix: overrides.matrix } : {}),
  })
}

describe('list_capabilities', () => {
  it('reports engines, providers and the limits in force', async () => {
    const deps = createFakeDeps({ proxy: true })
    deps.budget.reserve(5)
    const out = json(await listCapabilities.handler({}, deps, ctx()))
    expect(out.engines).toEqual([{ id: 'chromium', label: 'Chromium', version: '153.0', kind: 'bundled' }])
    expect(out.proxy).toEqual({ configured: true, providerId: 'dataimpulse', product: 'residential' })
    expect(out.limits).toEqual({ allowedOrigins: ['https://staging.example.com'], maxCasesPerCall: 12, concurrency: 2, dailyBudget: 200, remainingToday: 195, workspace: true })
  })
})

describe('search_devices', () => {
  it('finds presets by words, with viewports and engines', async () => {
    const out = json(await searchDevices.handler({ query: 'iphone 15', limit: 5 }, createFakeDeps(), ctx()))
    const devices = out.devices as Array<{ id: string; engines: string[]; viewport: { width: number } }>
    expect(devices.length).toBeGreaterThan(0)
    expect(devices.length).toBeLessThanOrEqual(5)
    expect(devices.map((device) => device.id)).toContain('iphone-15')
    expect(devices.every((device) => device.id.startsWith('iphone-15'))).toBe(true)
    expect(devices[0]!.viewport.width).toBeGreaterThan(300)
  })

  it('filters by engine and rejects a limit above 20', async () => {
    const out = json(await searchDevices.handler({ query: 'iphone', engine: 'firefox', limit: 20 }, createFakeDeps(), ctx()))
    expect(out.devices).toEqual([])
    await expect(searchDevices.handler({ query: 'iphone', limit: 21 }, createFakeDeps(), ctx())).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

describe('search_locations', () => {
  it('returns entries with a ready-to-use target', async () => {
    const out = json(await searchLocations.handler({ query: 'austin' }, createFakeDeps(), ctx()))
    expect(out.locations).toEqual([
      { label: 'Austin, TX', kind: 'city', timezone: 'America/Chicago', target: { mode: 'city', country: 'us', state: 'Texas', stateCode: 'TX', city: 'Austin', zip: null } },
    ])
    await expect(searchLocations.handler({ query: '' }, createFakeDeps(), ctx())).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

describe('check_exit_ip', () => {
  it('needs configured credentials and spends nothing without them', async () => {
    const deps = createFakeDeps()
    await expect(checkExitIp.handler({}, deps, ctx())).rejects.toMatchObject({ code: 'PROXY_NOT_CONFIGURED' })
    expect(deps.budget.remaining()).toBe(200)
    expect(deps.calls.checkExitIp).toBe(0)
  })

  it('refuses a product without credentials', async () => {
    const deps = createFakeDeps({ proxy: true })
    await expect(checkExitIp.handler({ product: 'mobile' }, deps, ctx())).rejects.toMatchObject({ code: 'PROXY_NOT_CONFIGURED' })
    expect(deps.calls.checkExitIp).toBe(0)
  })

  it('reports the verified exit, counts one attempt and redacts secrets', async () => {
    const deps = createFakeDeps({ proxy: true })
    const context = ctx()
    const content = await checkExitIp.handler({ target: { mode: 'city', country: 'us', state: 'Texas', stateCode: 'TX', city: 'Austin', zip: null } }, deps, context)
    const out = json(content)
    expect(out).toMatchObject({ exitIp: '203.0.113.7', locationMatch: 'match', provider: 'dataimpulse', product: 'residential' })
    expect(deps.budget.remaining()).toBe(199)
    expect(context.facts).toMatchObject({ cases: 1, outcome: 'match' })
    expect(text(content)).not.toContain(PROXY_PASSWORD)
  })
})

describe('run_check', () => {
  const valid = { url: 'https://staging.example.com/signup', engines: ['chromium'], devices: ['desktop-chrome'] }

  it('refuses a non-allowlisted origin before any engine check, budget or run', async () => {
    const deps = createFakeDeps()
    const context = ctx()
    await expect(runCheck.handler({ ...valid, url: 'https://evil.example.com/' }, deps, context)).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('Origin not allowlisted: https://evil.example.com') })
    expect(context.facts.origins).toEqual(['https://evil.example.com'])
    expect(deps.calls).toMatchObject({ run: [], assertEngines: [] })
    expect(deps.budget.remaining()).toBe(200)
  })

  it('refuses goto steps to other origins and templated goto URLs', async () => {
    const deps = createFakeDeps()
    await expect(runCheck.handler({ ...valid, steps: [{ action: 'goto', value: 'http://staging.example.com/' }] }, deps, ctx())).rejects.toThrow(/Origin not allowlisted: http:\/\/staging\.example\.com/)
    await expect(runCheck.handler({ ...valid, steps: [{ action: 'goto', value: 'https://{{host}}/x' }] }, deps, ctx())).rejects.toThrow(/absolute http\(s\) URLs/)
    expect(deps.calls.run).toEqual([])
  })

  it('enforces the per-call case limit, device/engine compatibility and the proxy requirement for targets', async () => {
    const deps = createFakeDeps({ policy: { maxCases: 2 } })
    await expect(runCheck.handler({ ...valid, devices: ['desktop-chrome', 'iphone-15', 'pixel-7'] }, deps, ctx())).rejects.toThrow(/would run 3 cases; the limit is 2/)
    await expect(runCheck.handler({ ...valid, engines: ['firefox'], devices: ['iphone-15'] }, deps, ctx())).rejects.toThrow(/cannot emulate/)
    await expect(runCheck.handler({ ...valid, devices: ['no-such-device'] }, deps, ctx())).rejects.toThrow(/Unknown device preset/)
    const target = { mode: 'state', country: 'us', state: 'Texas', stateCode: 'TX', city: null, zip: null }
    await expect(runCheck.handler({ ...valid, targets: [target] }, deps, ctx())).rejects.toThrow(/need proxy credentials/)
    await expect(runCheck.handler({ ...valid, targets: [target], direct: true }, createFakeDeps({ proxy: true }), ctx())).rejects.toThrow(/need the proxy/)
    expect(deps.calls.run).toEqual([])
  })

  it('validates input with the scenario step schema', async () => {
    const deps = createFakeDeps()
    await expect(runCheck.handler({ ...valid, steps: [{ action: 'evaluate', value: 'alert(1)' }] }, deps, ctx())).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(runCheck.handler({ ...valid, devices: [] }, deps, ctx())).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(runCheck.handler({ ...valid, url: 'file:///etc/passwd' }, deps, ctx())).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(runCheck.handler({ ...valid, url: 'https://user:pw@staging.example.com/' }, deps, ctx())).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('refuses when the daily budget cannot cover every case', async () => {
    const deps = createFakeDeps({ budget: 1 })
    await expect(runCheck.handler({ ...valid, devices: ['desktop-chrome', 'iphone-15'] }, deps, ctx())).rejects.toMatchObject({ code: 'SESSION_LIMIT' })
    expect(deps.calls.run).toEqual([])
  })

  it('runs a scenario manifest bounded by the policy and returns a redacted summary with screenshots', async () => {
    const deps = createFakeDeps()
    deps.nextBatch = () =>
      fakeBatch([
        fakeCase(),
        fakeCase({
          id: '2',
          device: 'iphone-15',
          status: 'failed',
          steps: [
            { index: 0, action: 'fill', status: 'passed', durationMs: 3, screenshot: '/artifacts/run/2-1/step-1.png' },
            { index: 1, action: 'click', status: 'failed', durationMs: 3, error: `click failed: typed planted-fill-value with proxy ${PROXY_PASSWORD}`, screenshot: '/artifacts/run/2-1/step-2.png' },
          ],
          errors: ['console: planted-fill-value', `Proxy-Authorization: Basic ${PROXY_PASSWORD}`],
          failedRequests: ['GET https://staging.example.com/api?token=abc123'],
        }),
      ])
    const context = ctx()
    const content = await runCheck.handler(
      {
        ...valid,
        devices: ['desktop-chrome', 'iphone-15'],
        steps: [
          { action: 'fill', selector: '#email', value: 'planted-fill-value' },
          { action: 'click', selector: '#submit' },
        ],
      },
      deps,
      context,
    )
    const request = deps.calls.run[0]!
    expect('scenario' in request.manifest).toBe(true)
    if (!('scenario' in request.manifest)) return
    expect(request.manifest.scenario.allowedOrigins).toEqual(['https://staging.example.com'])
    expect(request.manifest.matrix).toMatchObject({ engines: ['chromium'], devices: ['desktop-chrome', 'iphone-15'], concurrency: 2, retries: 0 })
    expect(request.manifest.profile).toMatchObject({ proxyMode: 'none', devicePreset: 'desktop-chrome' })
    expect(deps.calls.assertEngines).toEqual([['chromium']])
    expect(deps.budget.remaining()).toBe(198)
    expect(context.facts).toEqual({ origins: ['https://staging.example.com'], cases: 2, outcome: 'failed' })

    const summary = json(content)
    expect(summary).toMatchObject({ status: 'failed', total: 2, screenshots: ['case 2, step 2', 'case 1, step 1'] })
    const serialized = JSON.stringify(content)
    expect(serialized).not.toContain('planted-fill-value')
    expect(serialized).not.toContain(PROXY_PASSWORD)
    expect(serialized).not.toContain('abc123')
    expect(content.filter((item) => item.type === 'image')).toHaveLength(2)
    expect(deps.calls.discarded).toEqual(['00000000-0000-4000-8000-000000000001'])

    const stored = json(await getResults.handler({ runId: summary.runId }, deps, ctx()))
    expect(stored.status).toBe('failed')
    expect(JSON.stringify(stored)).not.toContain('planted-fill-value')
  })

  it('routes through the configured proxy with targets unless direct', async () => {
    const deps = createFakeDeps({ proxy: true })
    const target = { mode: 'city', country: 'us', state: 'Texas', stateCode: 'TX', city: 'Austin', zip: null }
    await runCheck.handler({ ...valid, targets: [target] }, deps, ctx())
    const manifest = deps.calls.run[0]!.manifest
    if (!('profile' in manifest)) throw new Error('expected a scenario manifest')
    expect(manifest.profile).toMatchObject({ proxyMode: 'sticky', providerId: 'dataimpulse', proxyPool: 'residential', timezone: 'America/Chicago' })
    await runCheck.handler({ ...valid, direct: true }, deps, ctx())
    const direct = deps.calls.run[1]!.manifest
    if (!('profile' in direct)) throw new Error('expected a scenario manifest')
    expect(direct.profile.proxyMode).toBe('none')
  })
})

describe('run_manifest', () => {
  it('runs a workspace manifest and redacts dataset values', async () => {
    const deps = createFakeDeps({ files: { 'signup.json': scenarioManifest() } })
    deps.nextBatch = () => fakeBatch([fakeCase({ status: 'failed', errors: ['Uncaught: dataset-secret-a@example.test is taken'] })])
    const context = ctx()
    const content = await runManifest.handler({ path: 'signup.json', healing: 'fail' }, deps, context)
    expect(deps.calls.run[0]).toMatchObject({ healing: 'fail' })
    expect(context.facts).toEqual({ origins: ['https://staging.example.com'], cases: 2, outcome: 'failed' })
    expect(JSON.stringify(content)).not.toContain('dataset-secret-a@example.test')
    expect(deps.budget.remaining()).toBe(198)
  })

  it('refuses manifests whose approved origins are not allowlisted', async () => {
    const deps = createFakeDeps({ files: { 'evil.json': scenarioManifest({ scenario: { startUrl: 'https://evil.example.com/', allowedOrigins: ['https://evil.example.com', 'https://staging.example.com'] } }) } })
    await expect(runManifest.handler({ path: 'evil.json' }, deps, ctx())).rejects.toThrow(/Origin not allowlisted: https:\/\/evil\.example\.com\./)
    expect(deps.calls.run).toEqual([])
  })

  it('reports unreadable, invalid and unroutable manifests as input errors', async () => {
    const deps = createFakeDeps({
      files: {
        'broken.json': '{',
        'invalid.json': JSON.stringify({ scenario: {} }),
        'gateway.json': scenarioManifest({ scenario: { gatewayId: 'g1' } }),
        'proxied.json': scenarioManifest({ profile: { proxyMode: 'sticky', stickySessionId: 'abc' } }),
      },
    })
    await expect(runManifest.handler({ path: 'missing.json' }, deps, ctx())).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(runManifest.handler({ path: 'broken.json' }, deps, ctx())).rejects.toMatchObject({ code: 'INVALID_INPUT', message: 'The file is not valid JSON.' })
    await expect(runManifest.handler({ path: 'invalid.json' }, deps, ctx())).rejects.toThrow(/Invalid manifest: scenario\./)
    await expect(runManifest.handler({ path: 'gateway.json' }, deps, ctx())).rejects.toThrow(/custom gateways/)
    await expect(runManifest.handler({ path: 'proxied.json' }, deps, ctx())).rejects.toMatchObject({ code: 'PROXY_NOT_CONFIGURED' })
    await expect(runManifest.handler({ path: 'proxied.json', environment: 'Nope' }, deps, ctx())).rejects.toThrow(/unique environment/)
    expect(deps.calls.run).toEqual([])
  })

  it('counts datasets, matrix and retries against the case limit and budget', async () => {
    const manifest = parseQaManifest(JSON.parse(scenarioManifest({ matrix: { engines: ['chromium', 'firefox'], retries: 1 } })))
    expect(countManifestCases(manifest)).toEqual({ cases: 4, attempts: 8, engines: ['chromium', 'firefox'] })
    const deps = createFakeDeps({ policy: { maxCases: 3 }, files: { 'm.json': scenarioManifest({ matrix: { engines: ['chromium', 'firefox'], retries: 1 } }) } })
    await expect(runManifest.handler({ path: 'm.json' }, deps, ctx())).rejects.toThrow(/would run 4 cases; the limit is 3/)
    const budgeted = createFakeDeps({ budget: 7, files: { 'm.json': scenarioManifest({ matrix: { engines: ['chromium', 'firefox'], retries: 1 } }) } })
    await expect(runManifest.handler({ path: 'm.json' }, budgeted, ctx())).rejects.toMatchObject({ code: 'SESSION_LIMIT' })
  })
})

describe('get_results', () => {
  it('reports unknown run ids', async () => {
    await expect(getResults.handler({ runId: 'nope' }, createFakeDeps(), ctx())).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('summaries', () => {
  it('returns at most 4 screenshots, failed cases first', () => {
    const cases = Array.from({ length: 6 }, (_, index) =>
      fakeCase({ id: String(index + 1), status: index === 4 ? 'failed' : 'passed', steps: [{ index: 0, action: 'assertVisible', status: index === 4 ? 'failed' : 'passed', durationMs: 1, screenshot: `/a/${index + 1}.png` }] }),
    )
    expect(pickScreenshots(fakeBatch(cases)).map((shot) => shot.caseId)).toEqual(['5', '1', '2', '3'])
  })

  it('caps console and request lines per case', () => {
    const batch = fakeBatch([fakeCase({ errors: Array.from({ length: 40 }, (_, index) => `error ${index}`) })])
    expect(summarizeBatch(batch, (value) => value).cases[0]!.consoleErrors).toHaveLength(20)
  })
})

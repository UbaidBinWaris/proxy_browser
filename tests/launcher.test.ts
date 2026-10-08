/**
 * Quick Launch orchestration with fake profile/browser managers, a fake pool
 * configuration and the real targeting-string composer.
 */
import { describe, expect, it, vi } from 'vitest'

import type { AppSettings, BrowserSession, GeoTarget, LogEntry, Profile, ProfileInput, QuickLaunchInput, SessionStatus } from '../src/shared/types'
import { DEFAULT_SETTINGS, STICKY_SESSION_ID_PATTERN } from '../src/shared/types'
import { AppException } from '../src/main/contracts'
import type { BrowserManager, Launcher, Logger, ProfileManager } from '../src/main/contracts'
import { DEVICE_PRESETS } from '../src/main/browser/device-presets'
import { DOUBLE_RATE_WARNING, DIRECT_TARGET_WARNING, createLauncher, describeTarget, generateQuickLaunchSessionId, quickLaunchProfileName } from '../src/main/launcher/launcher'
import { buildTargetingString } from '../src/main/proxy/providers/dataimpulse'

const NJ: GeoTarget = { mode: 'state', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: null, zip: null }
const NEWARK: GeoTarget = { mode: 'city', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: 'Newark', zip: null }
const ZIP: GeoTarget = { mode: 'zip', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: 'Newark', zip: '07102' }
const US: GeoTarget = { mode: 'country', country: 'us', state: null, stateCode: null, city: null, zip: null }

const baseInput: QuickLaunchInput = {
  startUrl: 'https://example.com/',
  engine: 'chromium',
  devicePreset: 'iphone-15',
  proxyPool: 'residential',
  target: NJ,
  sticky: true,
  stickyTtlMinutes: null,
  locale: null,
  timezone: null,
  saveAsProfile: false,
  profileName: null,
  replaceActiveSession: false,
}

interface Harness {
  launcher: Launcher
  profiles: Map<string, Profile>
  launches: Profile[]
  closed: string[]
  active: BrowserSession[]
  settings: AppSettings
  configured: Set<string>
  launchError: { current: AppException | null }
  logs: Array<{ level: string; message: string; meta?: Record<string, unknown> }>
  closeAll: ReturnType<typeof vi.fn>
}

function session(id: string, status: SessionStatus, profileId = `p-${id}`): BrowserSession {
  return {
    id,
    runId: `run-${id}`,
    profileId,
    profileName: `Profile ${id}`,
    engine: 'chromium',
    devicePreset: 'iphone-15',
    proxyPool: 'residential',
    target: null,
    targetingString: null,
    targetMatch: null,
    status,
    statusDetail: status,
    ip: null,
    locationAttempts: 1,
    locationMaxAttempts: 1,
    locationWarning: null,
    proxySessionId: null,
    currentUrl: null,
    startedAt: new Date().toISOString(),
    error: null,
    browserPid: null,
    lastHeartbeatAt: null,
  }
}

function buildHarness(settingsOverrides: Partial<AppSettings> = {}, configured: string[] = ['residential'], engineBusyMessage?: (engine: string) => string | null): Harness {
  const logs: Harness['logs'] = []
  const logger: Logger = {
    info: (_s, message, meta) => void logs.push({ level: 'INFO', message, meta }),
    warn: (_s, message, meta) => void logs.push({ level: 'WARN', message, meta }),
    error: (_s, message, meta) => void logs.push({ level: 'ERROR', message, meta }),
    log: (level, _s, message, meta) => void logs.push({ level, message, meta }),
    onEntry: () => () => undefined,
    query: (): LogEntry[] => [],
    clear: () => undefined,
    registerSecret: () => undefined,
  }
  const rows = new Map<string, Profile>()
  let seq = 0
  const profiles: ProfileManager = {
    list: () => [...rows.values()].filter((p) => !p.ephemeral),
    get: (id) => {
      const p = rows.get(id)
      if (!p) throw new AppException('NOT_FOUND', 'missing')
      return p
    },
    create: (raw) => {
      seq += 1
      const input = raw as ProfileInput
      const now = new Date().toISOString()
      const profile: Profile = { ...input, id: `profile-${seq}`, createdAt: now, updatedAt: now }
      rows.set(profile.id, profile)
      return profile
    },
    update: (id, raw) => {
      const existing = profiles.get(id)
      const updated: Profile = { ...existing, ...(raw as ProfileInput), updatedAt: new Date().toISOString() }
      rows.set(id, updated)
      return updated
    },
    duplicate: (id) => profiles.get(id),
    delete: (id) => {
      if (!rows.delete(id)) throw new AppException('NOT_FOUND', 'missing')
    },
    presets: () => [...DEVICE_PRESETS],
    validateForLaunch: () => undefined,
  }
  const launches: Profile[] = []
  const closed: string[] = []
  const active: BrowserSession[] = []
  const launchError = { current: null as AppException | null }
  const closeAll = vi.fn(async () => undefined)
  const browser: BrowserManager = {
    launch: async (profile) => {
      if (launchError.current) throw launchError.current
      launches.push(profile)
      const s = session(`s${launches.length}`, 'starting', profile.id)
      active.push(s)
      return s
    },
    close: async (id) => {
      const index = active.findIndex((s) => s.id === id)
      if (index === -1) throw new AppException('NOT_FOUND', 'no such session')
      closed.push(id)
      active.splice(index, 1)
    },
    closeAll,
    focus: async () => undefined,
    sessionPids: () => [],
    screenshot: async () => '/tmp/x.png',
    listActive: () => [...active],
    get: (id) => active.find((s) => s.id === id) ?? null,
    onSessionUpdate: () => () => undefined,
    onRunUpdate: () => () => undefined,
    onNetworkEntry: () => () => undefined,
  }
  const configuredSet = new Set(configured)
  const settings: AppSettings = { ...DEFAULT_SETTINGS, screenshotDir: '/tmp/shots', ...settingsOverrides }
  const launcher = createLauncher({
    profiles,
    browser,
    targeting: { buildTargetingString: (request) => buildTargetingString(request), isPoolConfigured: (pool) => configuredSet.has(pool) },
    locations: { timezoneForState: (code) => ({ NJ: 'America/New_York', TX: 'America/Chicago' })[code.toUpperCase()] ?? null },
    getSettings: () => settings,
    logger,
    now: () => new Date('2026-10-05T12:00:00Z'),
    random: () => 0.5,
    ...(engineBusyMessage ? { engineBusyMessage } : {}),
  })
  return { launcher, profiles: rows, launches, closed, active, settings, configured: configuredSet, launchError, logs, closeAll }
}

describe('launcher helpers', () => {
  it('generates ql-<yyyymmdd>-<4 chars> session ids within the profile charset', () => {
    const id = generateQuickLaunchSessionId(new Date('2026-10-05T23:59:00Z'), () => 0.5)
    expect(id).toBe('ql-20261005-ssss')
    expect(id).toMatch(STICKY_SESSION_ID_PATTERN)
    expect(generateQuickLaunchSessionId(new Date('2026-01-02T00:00:00Z'), () => 0)).toBe('ql-20260102-aaaa')
    expect(generateQuickLaunchSessionId(new Date('2026-01-02T00:00:00Z'), () => 0.999999)).toBe('ql-20260102-9999')
    expect(generateQuickLaunchSessionId()).toMatch(/^ql-\d{8}-[a-z0-9]{4}$/)
  })

  it('describes targets and builds profile names within 80 characters', () => {
    expect(describeTarget(null)).toBe('US')
    expect(describeTarget(US)).toBe('US')
    expect(describeTarget(NJ)).toBe('New Jersey')
    expect(describeTarget(NEWARK)).toBe('Newark, NJ')
    expect(describeTarget(ZIP)).toBe('07102 (Newark, NJ)')
    expect(quickLaunchProfileName('residential', NJ, 'iPhone 15')).toBe('Residential · New Jersey · iPhone 15')
    expect(quickLaunchProfileName('mobile', ZIP, 'Pixel 9')).toBe('Mobile · 07102 (Newark, NJ) · Pixel 9')
    expect(quickLaunchProfileName('none', null, 'Windows desktop (Chrome)')).toBe('Direct · Windows desktop (Chrome)')
    // A direct connection has no exit location, even when the form still carries a target.
    expect(quickLaunchProfileName('none', NJ, 'Pixel 9')).toBe('Direct · Pixel 9')
    const long = quickLaunchProfileName('residential', NEWARK, 'X'.repeat(100))
    expect(long.length).toBeLessThanOrEqual(80)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('launcher.preview', () => {
  it('shows the exact targeting string for a sticky residential launch with the double-rate note', () => {
    const h = buildHarness()
    const preview = h.launcher.preview(baseInput)
    expect(preview).toEqual({
      pool: 'residential',
      targetingString: 'cr.us;state.newjersey;sessid.ql-20261005-ssss',
      poolConfigured: true,
      warnings: [DOUBLE_RATE_WARNING],
    })
    expect(h.launcher.preview({ ...baseInput, target: ZIP, stickyTtlMinutes: 60 }).targetingString).toBe('cr.us;state.newjersey;city.newark;zip.07102;sessid.ql-20261005-ssss;sessttl.60')
    expect(h.launcher.preview({ ...baseInput, target: US })).toMatchObject({ targetingString: 'cr.us;sessid.ql-20261005-ssss', warnings: [] })
    expect(h.launcher.preview({ ...baseInput, target: US, sticky: false })).toMatchObject({ targetingString: 'cr.us', warnings: [] })
    expect(h.launcher.preview({ ...baseInput, target: NJ, sticky: false })).toMatchObject({ targetingString: 'cr.us;state.newjersey', warnings: [DOUBLE_RATE_WARNING] })
    expect(h.launcher.preview({ ...baseInput, target: null, sticky: false, stickyTtlMinutes: 30 })).toMatchObject({ targetingString: null, warnings: [] })
  })

  it('flags an unconfigured pool and returns null targeting for a direct connection', () => {
    const h = buildHarness()
    expect(h.launcher.preview({ ...baseInput, proxyPool: 'mobile' })).toMatchObject({
      pool: 'mobile',
      poolConfigured: false,
      warnings: ['DataImpulse Mobile credentials are not configured. Add them under Settings → Advanced → Proxy keys.', DOUBLE_RATE_WARNING],
    })
    expect(h.launcher.preview({ ...baseInput, proxyPool: 'none' })).toEqual({ pool: 'none', targetingString: null, poolConfigured: true, warnings: [DIRECT_TARGET_WARNING] })
    expect(h.launcher.preview({ ...baseInput, proxyPool: 'none', target: null })).toEqual({ pool: 'none', targetingString: null, poolConfigured: true, warnings: [] })
  })

  it('validates the input', () => {
    const h = buildHarness()
    expect(() => h.launcher.preview({ ...baseInput, startUrl: 'ftp://x' })).toThrowError(/startUrl/)
    expect(() => h.launcher.preview({ ...baseInput, target: { ...ZIP, zip: '1234' } })).toThrowError(/ZIP must be 5 digits/)
    expect(() => h.launcher.preview(null)).toThrowError(AppException)
    // Defaults fill the optional fields.
    expect(h.launcher.preview({ startUrl: null, engine: 'chromium', devicePreset: 'iphone-15', proxyPool: 'residential', target: null })).toMatchObject({ targetingString: 'sessid.ql-20261005-ssss' })
  })
})

describe('launcher.quickLaunch', () => {
  it('creates an ephemeral sticky profile with derived timezone/locale and launches it', async () => {
    const h = buildHarness()
    const result = await h.launcher.quickLaunch(baseInput)
    expect(result.status).toBe('starting')
    expect(h.launches).toHaveLength(1)
    const profile = h.launches[0]!
    expect(profile).toMatchObject({
      name: 'Residential · New Jersey · Apple iPhone 15',
      engine: 'chromium',
      deviceType: 'mobile',
      devicePreset: 'iphone-15',
      viewportWidth: 393,
      viewportHeight: 659,
      userAgent: null,
      locale: 'en-US',
      timezone: 'America/New_York',
      proxyMode: 'dataimpulse-sticky',
      stickySessionId: 'ql-20261005-ssss',
      formUrlOverride: 'https://example.com/',
      notes: 'Quick Launch',
      proxyPool: 'residential',
      target: NJ,
      stickyTtlMinutes: null,
      ephemeral: true,
    })
    expect(profile.stickySessionId).toMatch(STICKY_SESSION_ID_PATTERN)
    // Hidden from the regular profile list, but still stored (runs reference it).
    expect([...h.profiles.values()]).toHaveLength(1)
    expect(h.profiles.get(profile.id)?.ephemeral).toBe(true)
    expect(h.logs.some((l) => l.message.startsWith('Quick launch:'))).toBe(true)
  })

  it('honours overrides: saveAsProfile, profileName, locale, timezone, TTL, rotating and direct', async () => {
    const h = buildHarness({ singleSessionMode: false })
    await h.launcher.quickLaunch({ ...baseInput, saveAsProfile: true, profileName: 'My NJ run', locale: 'en-GB', timezone: 'Europe/London', stickyTtlMinutes: 90 })
    expect(h.launches[0]).toMatchObject({ name: 'My NJ run', ephemeral: false, locale: 'en-GB', timezone: 'Europe/London', stickyTtlMinutes: 90, proxyMode: 'dataimpulse-sticky' })

    await h.launcher.quickLaunch({ ...baseInput, sticky: true, proxyPool: 'residential', target: null, devicePreset: 'windows-desktop', engine: 'firefox', startUrl: null })
    expect(h.launches[1]).toMatchObject({ name: 'Residential · US · Windows · Chrome · 1920×1080', deviceType: 'desktop', engine: 'firefox', timezone: 'America/New_York', formUrlOverride: null, target: null })

    await h.launcher.quickLaunch({ ...baseInput, sticky: false, target: { ...NJ, state: 'Texas', stateCode: 'TX' } })
    expect(h.launches[2]).toMatchObject({ proxyMode: 'dataimpulse-rotating', stickySessionId: null, stickyTtlMinutes: null, timezone: 'America/Chicago' })

    await h.launcher.quickLaunch({ ...baseInput, proxyPool: 'none' })
    expect(h.launches[3]).toMatchObject({ proxyMode: 'none', stickySessionId: null, target: null, proxyPool: 'residential', name: 'Direct · Apple iPhone 15', timezone: 'America/New_York' })

    // Unknown state code and a non-US country fall back sensibly.
    await h.launcher.quickLaunch({ ...baseInput, target: { ...NJ, state: 'Puerto Rico', stateCode: 'PR' } })
    expect(h.launches[4]?.timezone).toBe('America/New_York')
    await h.launcher.quickLaunch({ ...baseInput, target: { ...US, country: 'de' } })
    expect(typeof h.launches[5]?.timezone).toBe('string')
  })

  it('rejects an unknown preset and an unconfigured pool before creating anything', async () => {
    const h = buildHarness()
    await expect(h.launcher.quickLaunch({ ...baseInput, devicePreset: 'blackberry-bold' })).rejects.toMatchObject({ code: 'INVALID_INPUT', message: /unknown device preset/ })
    await expect(h.launcher.quickLaunch({ ...baseInput, proxyPool: 'mobile' })).rejects.toMatchObject({
      code: 'PROXY_NOT_CONFIGURED',
      message: 'DataImpulse Mobile credentials are not configured. Add them under Settings → Advanced → Proxy keys.',
    })
    expect(h.profiles.size).toBe(0)
    expect(h.launches).toHaveLength(0)
  })

  it('enforces singleSessionMode: SESSION_LIMIT unless replaceActiveSession closes the open sessions first', async () => {
    const h = buildHarness()
    h.active.push(session('open-1', 'open'), session('err-1', 'error'))
    await expect(h.launcher.quickLaunch(baseInput)).rejects.toMatchObject({
      code: 'SESSION_LIMIT',
      message: 'Another browser session is already open. Close it first or enable "replace active session".',
    })
    expect(h.profiles.size).toBe(0)
    expect(h.closed).toEqual([])

    const launched = await h.launcher.quickLaunch({ ...baseInput, replaceActiveSession: true })
    // Every live session (including the error leftover) is closed before the new one starts.
    expect(h.closed.sort()).toEqual(['err-1', 'open-1'])
    expect(h.active.map((s) => s.id)).toEqual([launched.id])
    expect(h.launches).toHaveLength(1)

    // A lone error leftover without a window never blocks.
    h.active.length = 0
    h.active.push(session('err-2', 'error'))
    await expect(h.launcher.quickLaunch(baseInput)).resolves.toMatchObject({ status: 'starting' })
  })

  it('refuses an engine that is being installed with ENGINE_BUSY before closing the open session or creating a profile', async () => {
    const busy = 'Chromium is being installed — launch will be available when the install finishes.'
    const h = buildHarness({}, ['residential'], (engine) => (engine === 'chromium' ? busy : null))
    h.active.push(session('open-1', 'open'))
    await expect(h.launcher.quickLaunch({ ...baseInput, replaceActiveSession: true })).rejects.toMatchObject({ code: 'ENGINE_BUSY', message: busy })
    // The user keeps the session they have: nothing was closed, nothing was created.
    expect(h.closed).toEqual([])
    expect(h.profiles.size).toBe(0)
    expect(h.launches).toHaveLength(0)
  })

  it('does not block when singleSessionMode is off', async () => {
    const h = buildHarness({ singleSessionMode: false })
    h.active.push(session('open-1', 'open'))
    await expect(h.launcher.quickLaunch(baseInput)).resolves.toMatchObject({ status: 'starting' })
    expect(h.closed).toEqual([])
  })

  it('removes the ephemeral profile again when the launch fails synchronously, keeps saved ones', async () => {
    const h = buildHarness()
    h.launchError.current = new AppException('BROWSER_MISSING', 'Chromium is not installed.')
    await expect(h.launcher.quickLaunch(baseInput)).rejects.toMatchObject({ code: 'BROWSER_MISSING' })
    expect(h.profiles.size).toBe(0)
    await expect(h.launcher.quickLaunch({ ...baseInput, saveAsProfile: true })).rejects.toMatchObject({ code: 'BROWSER_MISSING' })
    expect([...h.profiles.values()]).toHaveLength(1)
    expect([...h.profiles.values()][0]?.ephemeral).toBe(false)
  })

  it('closeAll delegates to the browser manager', async () => {
    const h = buildHarness()
    await h.launcher.closeAll()
    expect(h.closeAll).toHaveBeenCalledTimes(1)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GeoTarget, IpInfo, LocationEntry, Profile, ProfileInput, ProductKey, ProxySession, ProxyTestResult } from '../src/shared/types'
import { AppException } from '../src/main/contracts'
import type { Database, IpChecker, Logger, ProxyConnection, ProxyProvider, ProxyRequest } from '../src/main/contracts'
import { openDatabase } from '../src/main/database/index'
import { DataImpulseProvider, buildTargetingString, dataImpulseDialect, poolNotConfiguredMessage } from '../src/main/proxy/providers/dataimpulse'
import { compareTargetWith, createProxyManager, describeExitLocation, describeRequestedLocation, normalizePostalCode, profileInputFrom } from '../src/main/proxy/proxy-manager'

const PASSWORD = 'Hunter2!Secret'

const ipInfo: IpInfo = {
  ip: '203.0.113.9',
  country: 'United States',
  countryCode: 'US',
  region: 'Texas',
  city: 'Austin',
  postalCode: '78701',
  isp: 'Example ISP',
  asn: 'AS64500',
  latencyMs: 120,
  provider: 'ip-api',
  checkedAt: '2026-10-03T10:00:00.000Z',
}

const NJ: GeoTarget = { mode: 'state', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: null, zip: null }
const TX_CITY: GeoTarget = { mode: 'city', country: 'us', state: 'Texas', stateCode: 'TX', city: 'Austin', zip: null }

const input: ProfileInput = {
  name: 'E2E chromium',
  engine: 'chromium',
  deviceType: 'desktop',
  devicePreset: 'windows-desktop',
  viewportWidth: 1366,
  viewportHeight: 768,
  userAgent: null,
  locale: 'en-US',
  timezone: 'America/New_York',
  proxyMode: 'sticky',
  stickySessionId: 'e2e-chromium-001',
  formUrlOverride: null,
  notes: '',
  proxyPool: 'residential',
  providerId: 'dataimpulse',
  target: null,
  stickyTtlMinutes: null,
  ephemeral: false,
}

function fakeLogger(entries: Array<{ level: string; message: string; meta?: Record<string, unknown> }>): Logger {
  return {
    info: (_s, message, meta) => void entries.push({ level: 'INFO', message, meta }),
    warn: (_s, message, meta) => void entries.push({ level: 'WARN', message, meta }),
    error: (_s, message, meta) => void entries.push({ level: 'ERROR', message, meta }),
    log: (level, _s, message, meta) => void entries.push({ level, message, meta }),
    onEntry: () => () => undefined,
    query: () => [],
    clear: () => undefined,
    registerSecret: () => undefined,
  }
}

function fakeProvider(configuredPools: ProductKey[] = ['residential']): ProxyProvider & { tested: ProxyRequest[] } {
  const tested: ProxyRequest[] = []
  const configured = configuredPools.length > 0
  return {
    tested,
    name: 'dataimpulse',
    displayName: dataImpulseDialect.displayName,
    docsUrl: dataImpulseDialect.docsUrl,
    capabilities: dataImpulseDialect.capabilities,
    isConfigured: () => configured,
    isPoolConfigured: (pool) => configuredPools.includes(pool),
    setCredentials: () => undefined,
    testCredentials: async (): Promise<ProxyTestResult> => ({ status: 'working', sessionId: null, ip: ipInfo, error: null }),
    getConfigStatus: () => ({
      configured,
      pools: (['residential', 'mobile'] as const).map((pool) => ({
        pool,
        configured: configuredPools.includes(pool),
        host: configuredPools.includes(pool) ? 'gw' : null,
        port: configuredPools.includes(pool) ? 823 : null,
        usernameMasked: configuredPools.includes(pool) ? 'ab****yz' : null,
        source: configuredPools.includes(pool) ? ('vault' as const) : ('none' as const),
      })),
      provider: 'dataimpulse',
      host: configured ? 'gw' : null,
      port: configured ? 823 : null,
      usernameMasked: configured ? 'ab****yz' : null,
      missing: configured ? [] : ['password'],
      source: configured ? 'vault' : 'none',
    }),
    buildTargetingString: (request) => buildTargetingString(request),
    buildProxyConfig: (request) => {
      if (!configuredPools.includes(request.pool)) throw new AppException('PROXY_NOT_CONFIGURED', poolNotConfiguredMessage(request.pool))
      const targeting = buildTargetingString(request)
      return {
        server: 'http://gw:823',
        username: targeting ? `${request.pool}-login__${targeting}` : `${request.pool}-login`,
        password: PASSWORD,
        pool: request.pool,
        sessionId: request.sessionId,
        target: request.target,
        targetingString: targeting,
      }
    },
    testConnection: async (request): Promise<ProxyTestResult> => {
      tested.push(request)
      return { status: 'working', sessionId: request.sessionId, ip: ipInfo, error: null }
    },
    getCurrentIp: async () => ipInfo,
    createSession: (name) => `profile-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    rotateSession: (current, name) => `${current ?? `profile-${name.toLowerCase()}`}-r2`,
  }
}

const stateEntry = (state: string, stateCode: string): LocationEntry => ({ kind: 'state', label: `${state} (${stateCode})`, country: 'us', state, stateCode, city: null, zip: null, timezone: null })
const fakeLocations = { states: (): LocationEntry[] => [stateEntry('New Jersey', 'NJ'), stateEntry('New York', 'NY'), stateEntry('Texas', 'TX')] }

describe('createProxyManager', () => {
  let db: Database
  let entries: Array<{ level: string; message: string; meta?: Record<string, unknown> }>

  beforeEach(() => {
    db = openDatabase(':memory:', { defaultScreenshotDir: '/tmp/shots', env: {} })
    entries = []
  })

  afterEach(() => {
    db.close()
  })

  it('resolveForProfile builds the request from pool, sticky id, target and TTL', () => {
    const provider = fakeProvider(['residential', 'mobile'])
    const manager = createProxyManager({ provider, sessions: db.proxySessions, profiles: db.profiles, logger: fakeLogger(entries) })
    const sticky = db.profiles.create({ ...input, proxyPool: 'mobile', target: NJ, stickyTtlMinutes: 45 })
    expect(manager.resolveForProfile(sticky)).toMatchObject({
      pool: 'mobile',
      sessionId: 'e2e-chromium-001',
      username: 'mobile-login__cr.us;state.newjersey;sessid.e2e-chromium-001;sessttl.45',
      targetingString: 'cr.us;state.newjersey;sessid.e2e-chromium-001;sessttl.45',
      target: NJ,
    })
    // Rotating profiles never send a session or TTL even when one is stored.
    const rotating = db.profiles.create({ ...input, name: 'Rot', proxyMode: 'rotating', stickySessionId: null, target: TX_CITY, stickyTtlMinutes: 45 })
    expect(manager.resolveForProfile(rotating)).toMatchObject({ pool: 'residential', sessionId: null, targetingString: 'cr.us;state.texas;city.austin' })
    expect(manager.resolveForProfile(db.profiles.create({ ...input, name: 'Direct', proxyMode: 'none', stickySessionId: null }))).toBeNull()
  })

  it('rotateSession writes the new sticky id back to the profile and tests it', async () => {
    const provider = fakeProvider()
    const manager = createProxyManager({ provider, sessions: db.proxySessions, profiles: db.profiles, logger: fakeLogger(entries) })
    const profile = db.profiles.create(input)
    const updates: ProxySession[] = []
    manager.onSessionUpdate((s) => updates.push(s))

    const session = await manager.rotateSession(profile)
    expect(session.sessionId).toBe('e2e-chromium-001-r2')
    expect(session.status).toBe('working')
    expect(session.profileId).toBe(profile.id)
    expect(session.pool).toBe('residential')
    expect(session.targetingString).toBe('sessid.e2e-chromium-001-r2')
    expect(provider.tested).toEqual([{ pool: 'residential', sessionId: 'e2e-chromium-001-r2', target: null, ttlMinutes: null }])

    const stored = db.profiles.get(profile.id)
    expect(stored?.stickySessionId).toBe('e2e-chromium-001-r2')
    expect(stored?.name).toBe(profile.name)
    expect(Date.parse(stored?.updatedAt ?? '')).toBeGreaterThanOrEqual(Date.parse(profile.updatedAt))
    expect(profile.stickySessionId).toBe('e2e-chromium-001-r2')
    expect(updates.map((u) => u.status)).toEqual(['testing', 'working'])
    expect(JSON.stringify(entries)).not.toContain(PASSWORD)

    const again = await manager.rotateSession(db.profiles.get(profile.id)!)
    expect(again.sessionId).toBe('e2e-chromium-001-r2-r2')
    expect(db.profiles.get(profile.id)?.stickySessionId).toBe('e2e-chromium-001-r2-r2')
    expect(db.proxySessions.list().filter((s) => s.profileId === profile.id)).toHaveLength(1)
  })

  it('persists the new id even when the test of the rotated session fails', async () => {
    const provider = fakeProvider()
    provider.testConnection = async (request) => ({
      status: 'failed',
      sessionId: request.sessionId,
      ip: null,
      error: { code: 'PROXY_TIMEOUT', message: 'The proxy did not respond in time.' },
    })
    const manager = createProxyManager({ provider, sessions: db.proxySessions, profiles: db.profiles, logger: fakeLogger(entries) })
    const profile = db.profiles.create(input)
    const session = await manager.rotateSession(profile)
    expect(session.status).toBe('failed')
    expect(session.targetMatch).toBeNull()
    expect(db.profiles.get(profile.id)?.stickySessionId).toBe('e2e-chromium-001-r2')
  })

  it('auto-generates and saves a sticky id for a sticky profile that has none', async () => {
    const provider = fakeProvider()
    const manager = createProxyManager({ provider, sessions: db.proxySessions, profiles: db.profiles, logger: fakeLogger(entries) })
    const profile = db.profiles.create({ ...input, proxyMode: 'rotating', stickySessionId: null })
    const sticky: Profile = { ...profile, proxyMode: 'sticky', stickySessionId: null }
    db.profiles.update(profile.id, profileInputFrom(sticky))

    const result = await manager.testConnection(sticky)
    expect(result.sessionId).toBe('profile-e2e-chromium')
    expect(db.profiles.get(profile.id)?.stickySessionId).toBe('profile-e2e-chromium')
    expect(db.proxySessions.getByProfile(profile.id)?.sessionId).toBe('profile-e2e-chromium')

    expect(manager.resolveForProfile(db.profiles.get(profile.id)!)?.sessionId).toBe('profile-e2e-chromium')
    expect(entries.filter((e) => e.message.includes('auto-generated'))).toHaveLength(1)
  })

  it('persists pool, target, targeting string and the verified-vs-requested match on the session row', async () => {
    const provider = fakeProvider()
    const manager = createProxyManager({ provider, sessions: db.proxySessions, profiles: db.profiles, logger: fakeLogger(entries), locations: fakeLocations })
    const texas = db.profiles.create({ ...input, name: 'Texas', target: TX_CITY })
    await manager.testConnection(texas)
    expect(db.proxySessions.getByProfile(texas.id)).toMatchObject({
      pool: 'residential',
      target: TX_CITY,
      targetingString: 'cr.us;state.texas;city.austin;sessid.e2e-chromium-001',
      targetMatch: 'match',
      status: 'working',
      region: 'Texas',
    })
    const jersey = db.profiles.create({ ...input, name: 'Jersey', stickySessionId: 'nj-1', target: NJ })
    await manager.testConnection(jersey)
    expect(db.proxySessions.getByProfile(jersey.id)).toMatchObject({ targetingString: 'cr.us;state.newjersey;sessid.nj-1', targetMatch: 'mismatch' })
    const succeeded = entries.find((e) => e.message === 'Proxy test succeeded' && e.meta?.profileName === 'Jersey')
    expect(succeeded?.meta).toMatchObject({ targeting: 'cr.us;state.newjersey;sessid.nj-1', targetMatch: 'mismatch', region: 'Texas' })
    expect(JSON.stringify(entries)).not.toContain(PASSWORD)
    expect(JSON.stringify(entries)).not.toContain('residential-login')
  })

  it('works without a profile repository (nothing is persisted, nothing throws)', async () => {
    const provider = fakeProvider()
    const manager = createProxyManager({ provider, sessions: db.proxySessions, logger: fakeLogger(entries) })
    const profile = db.profiles.create(input)
    const session = await manager.rotateSession(profile)
    expect(session.sessionId).toBe('e2e-chromium-001-r2')
    expect(db.profiles.get(profile.id)?.stickySessionId).toBe('e2e-chromium-001')
  })

  it('rejects rotation for non-sticky profiles and when the pool is not configured', async () => {
    const manager = createProxyManager({ provider: fakeProvider(), sessions: db.proxySessions, profiles: db.profiles, logger: fakeLogger(entries) })
    const rotating = db.profiles.create({ ...input, proxyMode: 'rotating', stickySessionId: null })
    await expect(manager.rotateSession(rotating)).rejects.toMatchObject({ code: 'INVALID_PROFILE' })

    const unconfigured = createProxyManager({ provider: fakeProvider([]), sessions: db.proxySessions, profiles: db.profiles, logger: fakeLogger(entries) })
    const sticky = db.profiles.create({ ...input, name: 'Other' })
    await expect(unconfigured.rotateSession(sticky)).rejects.toMatchObject({ code: 'PROXY_NOT_CONFIGURED' })
    await expect(unconfigured.testConnection(null)).rejects.toBeInstanceOf(AppException)
    expect(db.profiles.get(sticky.id)?.stickySessionId).toBe('e2e-chromium-001')

    // Residential configured, mobile not: the error names the pool.
    const mobile = db.profiles.create({ ...input, name: 'Mobile', proxyPool: 'mobile' })
    await expect(manager.testConnection(mobile)).rejects.toMatchObject({ code: 'PROXY_NOT_CONFIGURED', message: 'DataImpulse Mobile credentials are not configured. Add them under Settings → Advanced → Proxy keys.' })
    await expect(manager.rotateSession(mobile)).rejects.toMatchObject({ code: 'PROXY_NOT_CONFIGURED', message: poolNotConfiguredMessage('mobile') })
    expect(db.proxySessions.getByProfile(mobile.id)).toBeNull()
  })

  it('testConnection for the raw gateway uses the default pool, a null session id, the gateway row and reports to the gateway hook', async () => {
    const provider = fakeProvider(['residential', 'mobile'])
    const gatewayTests: Array<[string, string]> = []
    const manager = createProxyManager({
      provider,
      sessions: db.proxySessions,
      profiles: db.profiles,
      logger: fakeLogger(entries),
      defaultPool: () => 'mobile',
      onGatewayTest: (status, at) => gatewayTests.push([status, at]),
    })
    const result = await manager.testConnection(null)
    expect(result.sessionId).toBeNull()
    expect(provider.tested).toEqual([{ pool: 'mobile', sessionId: null, target: null, ttlMinutes: null }])
    const row = db.proxySessions.getByProfile(null)
    expect(row).toMatchObject({ profileId: null, sessionId: null, pool: 'mobile', target: null, targetingString: null, targetMatch: null, status: 'working', countryCode: 'US' })
    expect(gatewayTests).toEqual([['working', row?.lastCheckedAt]])

    const profile = db.profiles.create(input)
    await manager.testConnection(profile)
    expect(gatewayTests).toHaveLength(1)

    // An explicit pool overrides the default for the raw gateway; a profile keeps its own pool.
    await manager.testConnection(null, 'residential')
    expect(provider.tested.at(-1)).toEqual({ pool: 'residential', sessionId: null, target: null, ttlMinutes: null })
    expect(db.proxySessions.getByProfile(null)?.pool).toBe('residential')
    expect(gatewayTests).toHaveLength(2)
    await manager.testConnection(profile, 'mobile')
    expect(provider.tested.at(-1)?.pool).toBe(profile.proxyPool)
  })

  it('falls back to the first configured pool for the gateway when no default is given', async () => {
    const provider = fakeProvider(['mobile'])
    const manager = createProxyManager({ provider, sessions: db.proxySessions, logger: fakeLogger(entries) })
    await manager.testConnection(null)
    expect(provider.tested[0]?.pool).toBe('mobile')
    expect(await manager.getCurrentIp(null)).toEqual(ipInfo)
  })

  it('testCredentials delegates to the provider without touching session rows', async () => {
    const provider = fakeProvider()
    const manager = createProxyManager({ provider, sessions: db.proxySessions, profiles: db.profiles, logger: fakeLogger(entries) })
    const result = await manager.testCredentials({ pool: 'residential', host: 'gw', port: 823, username: 'u', password: PASSWORD, sessionTemplate: null })
    expect(result.status).toBe('working')
    expect(provider.tested).toEqual([])
    expect(db.proxySessions.list()).toHaveLength(0)
  })

  it('profileInputFrom strips server-managed fields and copies the target', () => {
    const profile = db.profiles.create({ ...input, target: NJ, stickyTtlMinutes: 10, ephemeral: true })
    const back = profileInputFrom(profile)
    expect(back).toEqual({ ...input, target: NJ, stickyTtlMinutes: 10, ephemeral: true })
    expect(back.target).not.toBe(profile.target)
    expect(vi.isMockFunction(profileInputFrom)).toBe(false)
  })
})

describe('compareTarget', () => {
  const resolver = { codeFor: (value: string): string | null => ({ 'new jersey': 'NJ', newjersey: 'NJ', NJ: 'NJ', texas: 'TX', TX: 'TX', 'new york': 'NY', NY: 'NY' })[value.trim().length === 2 ? value.trim().toUpperCase() : value.trim().toLowerCase()] ?? null }
  const ip = (overrides: Partial<IpInfo>): IpInfo => ({ ...ipInfo, ...overrides })
  const nj = (mode: GeoTarget['mode'], extra: Partial<GeoTarget> = {}): GeoTarget => ({ mode, country: 'us', state: 'New Jersey', stateCode: 'NJ', city: null, zip: null, ...extra })

  it('is unknown without a target, an IP, a country code or a region (when a state is requested)', () => {
    expect(compareTargetWith(null, ipInfo, resolver)).toBe('unknown')
    expect(compareTargetWith(nj('state'), null, resolver)).toBe('unknown')
    expect(compareTargetWith(nj('state'), ip({ countryCode: null }), resolver)).toBe('unknown')
    expect(compareTargetWith(nj('state'), ip({ countryCode: 'US', region: null }), resolver)).toBe('unknown')
  })

  it('compares the country case-insensitively', () => {
    expect(compareTargetWith(nj('country', { state: null, stateCode: null }), ip({ countryCode: 'us' }), resolver)).toBe('match')
    expect(compareTargetWith(nj('country', { state: null, stateCode: null }), ip({ countryCode: 'DE', region: null }), resolver)).toBe('mismatch')
    expect(compareTargetWith(nj('state'), ip({ countryCode: 'CA', region: 'New Jersey' }), resolver)).toBe('mismatch')
  })

  it('matches the state by normalised name or USPS code', () => {
    expect(compareTargetWith(nj('state'), ip({ region: 'New Jersey' }), resolver)).toBe('match')
    expect(compareTargetWith(nj('state'), ip({ region: 'new jersey' }), resolver)).toBe('match')
    expect(compareTargetWith(nj('state'), ip({ region: 'NJ' }), resolver)).toBe('match')
    expect(compareTargetWith(nj('state', { stateCode: null }), ip({ region: 'NJ' }), resolver)).toBe('match')
    expect(compareTargetWith(nj('state'), ip({ region: 'Texas' }), resolver)).toBe('mismatch')
    expect(compareTargetWith(nj('state'), ip({ region: 'TX' }), resolver)).toBe('mismatch')
    // Without a resolver only name/code equality counts.
    const none = { codeFor: (): string | null => null }
    expect(compareTargetWith(nj('state'), ip({ region: 'NJ' }), none)).toBe('match')
    expect(compareTargetWith(nj('state', { stateCode: null }), ip({ region: 'NJ' }), none)).toBe('mismatch')
  })

  it('city mode: state + city → match, state only → partial, other state → mismatch', () => {
    const newark = nj('city', { city: 'Newark' })
    expect(compareTargetWith(newark, ip({ region: 'New Jersey', city: 'Newark' }), resolver)).toBe('match')
    expect(compareTargetWith(newark, ip({ region: 'New Jersey', city: 'Jersey City' }), resolver)).toBe('partial')
    expect(compareTargetWith(newark, ip({ region: 'New Jersey', city: null }), resolver)).toBe('partial')
    expect(compareTargetWith(newark, ip({ region: 'New York', city: 'Newark' }), resolver)).toBe('mismatch')
  })

  it('zip mode: the postal code is verified exactly; the same state with another or no ZIP is partial', () => {
    const zip = nj('zip', { city: 'Newark', zip: '07102' })
    expect(compareTargetWith(zip, ip({ region: 'New Jersey', city: 'Newark', postalCode: '07102' }), resolver)).toBe('match')
    expect(compareTargetWith(zip, ip({ region: 'NJ', city: 'Newark', postalCode: '07102-1234' }), resolver)).toBe('match')
    expect(compareTargetWith(zip, ip({ region: 'NJ', city: 'Newark', postalCode: ' 07102 ' }), resolver)).toBe('match')
    // The right city is no longer enough: the ZIP decides.
    expect(compareTargetWith(zip, ip({ region: 'New Jersey', city: 'Newark', postalCode: '07103' }), resolver)).toBe('partial')
    expect(compareTargetWith(zip, ip({ region: 'New Jersey', city: 'Newark', postalCode: null }), resolver)).toBe('partial')
    expect(compareTargetWith(zip, ip({ region: 'New Jersey', city: 'Elizabeth', postalCode: '07201' }), resolver)).toBe('partial')
    expect(compareTargetWith(nj('zip', { city: null, zip: '07102' }), ip({ region: 'New Jersey', city: 'Newark', postalCode: '07104' }), resolver)).toBe('partial')
    // Live finding: a carrier IP in the 07102 pool geolocates to New York, NY 10118.
    expect(compareTargetWith(zip, ip({ region: 'New York', city: 'New York', postalCode: '10118' }), resolver)).toBe('mismatch')
    expect(compareTargetWith(zip, ip({ region: 'Texas', city: 'Newark', postalCode: null }), resolver)).toBe('mismatch')
    // The country is checked first: the same digits abroad are a mismatch.
    expect(compareTargetWith(zip, ip({ countryCode: 'DE', region: 'Thuringia', postalCode: '07102' }), resolver)).toBe('mismatch')
    // An equal ZIP proves the state even when the IP service reported no region; another ZIP without one is not comparable.
    expect(compareTargetWith(zip, ip({ region: null, postalCode: '07102' }), resolver)).toBe('match')
    expect(compareTargetWith(zip, ip({ region: null, postalCode: '07103' }), resolver)).toBe('unknown')
    // A ZIP target without a state compares country + ZIP only.
    const bareZip = nj('zip', { state: null, stateCode: null, city: null, zip: '90012' })
    expect(compareTargetWith(bareZip, ip({ region: 'California', postalCode: '90012' }), resolver)).toBe('match')
    expect(compareTargetWith(bareZip, ip({ region: 'California', postalCode: '90013' }), resolver)).toBe('partial')
  })

  it('state and city modes ignore the postal code', () => {
    expect(compareTargetWith(nj('state'), ip({ region: 'New Jersey', postalCode: '10118' }), resolver)).toBe('match')
    expect(compareTargetWith(nj('city', { city: 'Newark' }), ip({ region: 'New Jersey', city: 'Newark', postalCode: '07103' }), resolver)).toBe('match')
    expect(compareTargetWith(nj('city', { city: 'Newark' }), ip({ region: 'New Jersey', city: 'Jersey City', postalCode: '07102' }), resolver)).toBe('partial')
  })

  it('normalizePostalCode keeps the 5-digit ZIP of ZIP+4 forms and trims anything else', () => {
    expect(normalizePostalCode('07102')).toBe('07102')
    expect(normalizePostalCode('07102-1234')).toBe('07102')
    expect(normalizePostalCode('07102 1234')).toBe('07102')
    expect(normalizePostalCode(' sw1a 1aa ')).toBe('SW1A 1AA')
    expect(normalizePostalCode('')).toBeNull()
    expect(normalizePostalCode('   ')).toBeNull()
    expect(normalizePostalCode(null)).toBeNull()
    expect(normalizePostalCode(undefined)).toBeNull()
  })

  it('describes exit and requested locations for progress lines and warnings', () => {
    expect(describeExitLocation(ip({ region: 'New York', city: 'New York', postalCode: '10118' }), resolver)).toBe('New York, NY 10118')
    expect(describeExitLocation(ip({ region: 'New Jersey', city: 'Jersey City', postalCode: null }), resolver)).toBe('Jersey City, NJ')
    expect(describeExitLocation(ip({ region: 'Ontario', city: 'Toronto', postalCode: 'M5V', countryCode: 'CA' }), resolver)).toBe('Toronto, Ontario M5V, CA')
    expect(describeExitLocation(ip({ region: null, city: null, postalCode: null, country: 'United States' }), resolver)).toBe('United States')
    const zip = nj('zip', { city: 'Newark', zip: '07102' })
    expect(describeRequestedLocation(zip, 'exact')).toBe('ZIP 07102 (Newark, NJ)')
    expect(describeRequestedLocation(zip, 'state')).toBe('New Jersey')
    expect(describeRequestedLocation(nj('city', { city: 'Newark' }), 'exact')).toBe('Newark, NJ')
    expect(describeRequestedLocation(nj('state'), 'exact')).toBe('New Jersey')
    expect(describeRequestedLocation(nj('country', { state: null, stateCode: null }), 'state')).toBe('US')
    expect(describeRequestedLocation(nj('zip', { state: null, stateCode: null, city: null, zip: '90012' }), 'exact')).toBe('ZIP 90012')
  })

  it('the manager wires the dataset-backed state resolver in', () => {
    const db = openDatabase(':memory:', { defaultScreenshotDir: '/tmp/shots', env: {} })
    try {
      const manager = createProxyManager({ provider: fakeProvider(), sessions: db.proxySessions, logger: fakeLogger([]), locations: fakeLocations })
      expect(manager.compareTarget(nj('state', { stateCode: null }), ip({ region: 'NJ' }))).toBe('match')
      expect(manager.compareTarget(nj('state'), ip({ region: 'Texas' }))).toBe('mismatch')
      expect(manager.compareTarget(null, ipInfo)).toBe('unknown')
    } finally {
      db.close()
    }
  })
})

describe('verifyForLaunch (location re-roll)', () => {
  const ZIP_07102: GeoTarget = { mode: 'zip', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: 'Newark', zip: '07102' }
  /** The live 07102 pool: a carrier IP placed in Manhattan, a Newark IP in the next ZIP, and the requested ZIP. */
  const NY_CARRIER: Partial<IpInfo> = { ip: '107.77.76.91', region: 'New York', city: 'New York', postalCode: '10118' }
  const NEWARK_07103: Partial<IpInfo> = { ip: '198.51.100.20', region: 'New Jersey', city: 'Newark', postalCode: '07103' }
  const NEWARK_07102: Partial<IpInfo> = { ip: '198.51.100.21', region: 'New Jersey', city: 'Newark', postalCode: '07102' }
  const BASE_ID = 'ql-20261005-ab12'

  interface Scripted {
    checker: IpChecker
    /** Every connection the checker was asked to look up (never logged; the password is checked separately). */
    seen: ProxyConnection[]
  }

  /** A fake IpChecker answering with a scripted sequence: an IpInfo patch or an AppException per call. */
  function scripted(script: Array<Partial<IpInfo> | AppException>): Scripted {
    const queue = [...script]
    const seen: ProxyConnection[] = []
    return {
      seen,
      checker: {
        lookup: async (connection) => {
          if (connection) seen.push(connection)
          const next = queue.shift()
          if (next === undefined) throw new Error('IP check script exhausted')
          if (next instanceof AppException) throw next
          return { ...ipInfo, ...next }
        },
      },
    }
  }

  let db: Database
  let entries: Array<{ level: string; message: string; meta?: Record<string, unknown> }>

  beforeEach(() => {
    db = openDatabase(':memory:', { defaultScreenshotDir: '/tmp/shots', env: {} })
    entries = []
  })

  afterEach(() => {
    db.close()
  })

  function managerWith(script: Array<Partial<IpInfo> | AppException>): { manager: ReturnType<typeof createProxyManager>; seen: ProxyConnection[] } {
    const { checker, seen } = scripted(script)
    const logger = fakeLogger(entries)
    const provider = new DataImpulseProvider({
      ipChecker: checker,
      logger,
      credentials: [{ pool: 'residential', host: 'gw.dataimpulse.com', port: 823, username: 'acme_login', password: PASSWORD, sessionTemplate: null }],
    })
    return { manager: createProxyManager({ provider, sessions: db.proxySessions, profiles: db.profiles, logger, locations: fakeLocations }), seen }
  }

  const zipProfile = (overrides: Partial<ProfileInput> = {}): Profile =>
    db.profiles.create({ ...input, name: 'Quick ZIP', stickySessionId: BASE_ID, target: ZIP_07102, ephemeral: true, ...overrides })

  it('exact: re-rolls mismatch → partial → match, reports each attempt and keeps the matching session id', async () => {
    const { manager, seen } = managerWith([NY_CARRIER, NEWARK_07103, NEWARK_07102])
    const profile = zipProfile()
    const progress: string[] = []
    const verification = await manager.verifyForLaunch(profile, { policy: 'exact', attempts: 3, onProgress: (p) => progress.push(`${p.attempt}/${p.attempts} ${p.sessionId} ${p.message}`) })

    expect(verification).toMatchObject({ attempts: 3, maxAttempts: 3, sessionId: `${BASE_ID}-r3`, targetMatch: 'match', warning: null })
    expect(verification.result).toMatchObject({ status: 'working', sessionId: `${BASE_ID}-r3`, ip: { ip: '198.51.100.21', postalCode: '07102' } })
    expect(progress).toEqual([
      `2/3 ${BASE_ID}-r2 Exit IP 107.77.76.91 is in New York, NY 10118 — re-rolling session (2/3)…`,
      `3/3 ${BASE_ID}-r3 Exit IP 198.51.100.20 is in Newark, NJ 07103 — re-rolling session (3/3)…`,
    ])
    // One IP check per attempt, each with its own sticky id and the ZIP targeting.
    expect(seen.map((c) => c.sessionId)).toEqual([BASE_ID, `${BASE_ID}-r2`, `${BASE_ID}-r3`])
    expect(seen.map((c) => c.username)).toEqual([
      `acme_login__cr.us;state.newjersey;city.newark;zip.07102;sessid.${BASE_ID}`,
      `acme_login__cr.us;state.newjersey;city.newark;zip.07102;sessid.${BASE_ID}-r2`,
      `acme_login__cr.us;state.newjersey;city.newark;zip.07102;sessid.${BASE_ID}-r3`,
    ])
    // The quick-launch profile and its proxy session row carry the final id and the verified ZIP.
    expect(db.profiles.get(profile.id)?.stickySessionId).toBe(`${BASE_ID}-r3`)
    expect(db.proxySessions.getByProfile(profile.id)).toMatchObject({ sessionId: `${BASE_ID}-r3`, status: 'working', postalCode: '07102', targetMatch: 'match', lastIp: '198.51.100.21' })
    // INFO lines say what was requested and what came back; nothing secret.
    const reroll = entries.find((e) => e.level === 'INFO' && e.message.startsWith('Re-rolling the sticky session for the "exact" location policy (2/3)'))
    expect(reroll?.meta).toMatchObject({ requested: 'ZIP 07102 (Newark, NJ)', got: 'New York, NY 10118', postalCode: '10118', targetMatch: 'mismatch', fromSessionId: BASE_ID, toSessionId: `${BASE_ID}-r2` })
    expect(entries.some((e) => e.level === 'INFO' && e.message === 'Exit location met the "exact" location policy on attempt 3/3')).toBe(true)
    expect(JSON.stringify(entries)).not.toContain(PASSWORD)
  })

  it('state: a partial result (right state, other ZIP) is accepted, so the same sequence stops at attempt 2', async () => {
    const { manager, seen } = managerWith([NY_CARRIER, NEWARK_07103, NEWARK_07102])
    const profile = zipProfile()
    const verification = await manager.verifyForLaunch(profile, { policy: 'state', attempts: 3 })
    expect(verification).toMatchObject({ attempts: 2, maxAttempts: 3, sessionId: `${BASE_ID}-r2`, targetMatch: 'partial', warning: null })
    expect(seen).toHaveLength(2)
    expect(db.profiles.get(profile.id)?.stickySessionId).toBe(`${BASE_ID}-r2`)
  })

  it("policy 'off' does a single check and keeps the session id whatever the location", async () => {
    const { manager, seen } = managerWith([NY_CARRIER, NEWARK_07102])
    const profile = zipProfile()
    const progress = vi.fn()
    const verification = await manager.verifyForLaunch(profile, { policy: 'off', attempts: 5, onProgress: progress })
    expect(verification).toMatchObject({ attempts: 1, maxAttempts: 1, sessionId: BASE_ID, targetMatch: 'mismatch', warning: null })
    expect(seen).toHaveLength(1)
    expect(progress).not.toHaveBeenCalled()
    expect(db.profiles.get(profile.id)?.stickySessionId).toBe(BASE_ID)
  })

  it('rotating sessions and targetless profiles are never re-rolled', async () => {
    const rotating = managerWith([NY_CARRIER, NEWARK_07102])
    const rot = zipProfile({ name: 'Rotating ZIP', proxyMode: 'rotating', stickySessionId: null })
    expect(await rotating.manager.verifyForLaunch(rot, { policy: 'exact', attempts: 8 })).toMatchObject({ attempts: 1, maxAttempts: 1, sessionId: null, targetMatch: 'mismatch' })
    expect(rotating.seen).toHaveLength(1)
    expect(rotating.seen[0]?.username).toBe('acme_login__cr.us;state.newjersey;city.newark;zip.07102')

    const noTarget = managerWith([NY_CARRIER, NEWARK_07102])
    const plain = zipProfile({ name: 'No target', target: null })
    expect(await noTarget.manager.verifyForLaunch(plain, { policy: 'exact', attempts: 8 })).toMatchObject({ attempts: 1, maxAttempts: 1, sessionId: BASE_ID, targetMatch: null })
    expect(noTarget.seen).toHaveLength(1)
  })

  it('when no attempt meets the policy it continues with the best result (match > partial > mismatch) and restores that session', async () => {
    const { manager } = managerWith([NEWARK_07103, NY_CARRIER, NY_CARRIER])
    const profile = zipProfile()
    const updates: ProxySession[] = []
    manager.onSessionUpdate((s) => updates.push(s))
    const verification = await manager.verifyForLaunch(profile, { policy: 'exact', attempts: 3 })
    expect(verification).toMatchObject({ attempts: 3, maxAttempts: 3, sessionId: BASE_ID, targetMatch: 'partial' })
    expect(verification.result.ip).toMatchObject({ ip: '198.51.100.20', postalCode: '07103' })
    expect(verification.warning).toBe('Could not get an exit IP in ZIP 07102 (Newark, NJ) after 3 attempts; using Newark, NJ 07103 (same state)')
    // The first sticky id still holds that exit IP: it is written back and its row shows the chosen result again.
    expect(db.profiles.get(profile.id)?.stickySessionId).toBe(BASE_ID)
    expect(db.proxySessions.getByProfile(profile.id)).toMatchObject({ sessionId: BASE_ID, status: 'working', lastIp: '198.51.100.20', postalCode: '07103', targetMatch: 'partial' })
    expect(updates.at(-1)).toMatchObject({ sessionId: BASE_ID, status: 'working', targetMatch: 'partial' })
    const warn = entries.find((e) => e.level === 'WARN' && e.message === verification.warning)
    expect(warn?.meta).toMatchObject({ policy: 'exact', requested: 'ZIP 07102 (Newark, NJ)', got: 'Newark, NJ 07103', chosenAttempt: 1, attempts: 3 })
  })

  it('ties go to the later attempt; a state-policy fallback names the state', async () => {
    const otherNy: Partial<IpInfo> = { ip: '107.77.76.92', region: 'New York', city: 'Brooklyn', postalCode: '11201' }
    const { manager } = managerWith([NY_CARRIER, otherNy])
    const profile = zipProfile()
    const verification = await manager.verifyForLaunch(profile, { policy: 'state', attempts: 2 })
    expect(verification).toMatchObject({ attempts: 2, sessionId: `${BASE_ID}-r2`, targetMatch: 'mismatch' })
    expect(verification.result.ip?.ip).toBe('107.77.76.92')
    expect(verification.warning).toBe('Could not get an exit IP in New Jersey after 2 attempts; using Brooklyn, NY 11201 (different state)')
  })

  it('a failed first check is returned as-is; a failed re-roll costs an attempt; a refusing gateway or rejected credentials stop re-rolling', async () => {
    const first = managerWith([new AppException('PROXY_DEAD', 'gateway down')])
    const failed = await first.manager.verifyForLaunch(zipProfile(), { policy: 'exact', attempts: 3 })
    expect(failed).toMatchObject({ attempts: 1, maxAttempts: 3, targetMatch: null, warning: null, result: { status: 'failed', error: { code: 'PROXY_DEAD' } } })

    const flaky = managerWith([NY_CARRIER, new AppException('PROXY_TIMEOUT', 'The proxy did not respond in time.'), NEWARK_07102])
    const progress: string[] = []
    const recovered = await flaky.manager.verifyForLaunch(zipProfile({ name: 'Flaky' }), { policy: 'exact', attempts: 3, onProgress: (p) => progress.push(p.message) })
    expect(recovered).toMatchObject({ attempts: 3, sessionId: `${BASE_ID}-r3`, targetMatch: 'match', warning: null })
    expect(progress[1]).toBe('Attempt 2 could not verify the exit IP (PROXY_TIMEOUT) — re-rolling session (3/3)…')

    // Live finding: once both IPs of the 07102 pool were pinned by sticky sessions, the gateway answered HTTP 503 to every new
    // sticky id for that ZIP (other ZIPs and rotating mode kept working) — so a refusal ends the re-roll instead of burning attempts.
    const exhausted = managerWith([NY_CARRIER, NEWARK_07103, new AppException('PROXY_DEAD', 'Could not connect through the proxy gateway.', 'HTTP 503 from the proxy gateway during the ip-api request'), NEWARK_07102])
    const pool = zipProfile({ name: 'Exhausted pool' })
    const settled = await exhausted.manager.verifyForLaunch(pool, { policy: 'exact', attempts: 4 })
    expect(settled).toMatchObject({ attempts: 3, maxAttempts: 4, sessionId: `${BASE_ID}-r2`, targetMatch: 'partial' })
    expect(exhausted.seen).toHaveLength(3)
    expect(settled.warning).toBe(
      'Could not get an exit IP in ZIP 07102 (Newark, NJ) after 3 attempts; using Newark, NJ 07103 (same state). Re-rolling stopped early: the gateway refused a new sticky session (PROXY_DEAD); this location may have no free exit IP right now.',
    )
    expect(db.profiles.get(pool.id)?.stickySessionId).toBe(`${BASE_ID}-r2`)
    // A refusal on the last allowed attempt is just the end of the budget.
    const lastOne = managerWith([NY_CARRIER, new AppException('PROXY_DEAD', 'refused')])
    const budget = await lastOne.manager.verifyForLaunch(zipProfile({ name: 'Last one' }), { policy: 'exact', attempts: 2 })
    expect(budget.warning).toBe('Could not get an exit IP in ZIP 07102 (Newark, NJ) after 2 attempts; using New York, NY 10118 (different state)')

    const rejected = managerWith([NY_CARRIER, new AppException('PROXY_AUTH_FAILED', 'HTTP 407'), NEWARK_07102])
    const profile = zipProfile({ name: 'Rejected' })
    const stopped = await rejected.manager.verifyForLaunch(profile, { policy: 'exact', attempts: 3 })
    expect(stopped).toMatchObject({ attempts: 2, sessionId: BASE_ID, targetMatch: 'mismatch' })
    expect(stopped.warning).toBe(
      'Could not get an exit IP in ZIP 07102 (Newark, NJ) after 2 attempts; using New York, NY 10118 (different state). Re-rolling stopped early: the proxy rejected the credentials (PROXY_AUTH_FAILED).',
    )
    expect(rejected.seen).toHaveLength(2)
    expect(db.profiles.get(profile.id)?.stickySessionId).toBe(BASE_ID)
  })

  it('stops re-rolling when the launch is cancelled and clamps the attempt budget to 1–8', async () => {
    const cancelled = managerWith([NY_CARRIER, NEWARK_07102])
    const result = await cancelled.manager.verifyForLaunch(zipProfile(), { policy: 'exact', attempts: 3, shouldContinue: () => false })
    expect(result).toMatchObject({ attempts: 1, sessionId: BASE_ID, targetMatch: 'mismatch', warning: null })
    expect(cancelled.seen).toHaveLength(1)

    const many = managerWith(Array.from({ length: 10 }, () => NY_CARRIER))
    const clamped = await many.manager.verifyForLaunch(zipProfile({ name: 'Many' }), { policy: 'state', attempts: 20 })
    expect(clamped).toMatchObject({ attempts: 8, maxAttempts: 8 })
    expect(many.seen).toHaveLength(8)
  })

  it('refuses direct profiles and unconfigured pools before any IP check', async () => {
    const { manager, seen } = managerWith([NEWARK_07102])
    await expect(manager.verifyForLaunch(zipProfile({ name: 'Direct', proxyMode: 'none', stickySessionId: null }), { policy: 'exact', attempts: 3 })).rejects.toMatchObject({ code: 'INVALID_PROFILE' })
    await expect(manager.verifyForLaunch(zipProfile({ name: 'Mobile', proxyPool: 'mobile' }), { policy: 'exact', attempts: 3 })).rejects.toMatchObject({ code: 'PROXY_NOT_CONFIGURED' })
    expect(seen).toHaveLength(0)
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'
import type { GeoTarget, IpInfo } from '../src/shared/types'
import { STICKY_SESSION_ID_MAX_LENGTH, STICKY_SESSION_ID_PATTERN } from '../src/shared/types'
import { AppException } from '../src/main/contracts'
import type { IpChecker, Logger, ProxyConnection, ProxyCredentials, ProxyRequest } from '../src/main/contracts'
import { parseDataImpulseStates, parseGeoNamesUs } from '../src/main/locations/geonames-loader'
import { US_STATE_CODES } from '../src/main/locations/us-state-timezones'
import {
  DATAIMPULSE_PRODUCTS,
  DataImpulseProvider,
  DEFAULT_SESSION_TEMPLATE,
  NOT_CONFIGURED_MESSAGE,
  REQUIRED_CREDENTIAL_FIELDS,
  SESSION_ID_PATTERN,
  buildDataImpulseUsername,
  buildTargetingString,
  composeUsername,
  encodePlaceName,
  encodeStateName,
  geoParams,
  kebabSlug,
  maskUsername,
  parseLogin,
  poolNotConfiguredMessage,
  sessionParams,
} from '../src/main/proxy/providers/dataimpulse'

const PASSWORD = 'Sup3rSecretPass!'
const MOBILE_PASSWORD = 'M0bile-Secret!'
const GEONAMES_DIR = join(process.cwd(), 'resources', 'geonames')

function makeLogger(): Logger & { secrets: string[]; entries: Array<{ level: string; message: string; meta?: Record<string, unknown> }> } {
  const entries: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = []
  const secrets: string[] = []
  return {
    secrets,
    entries,
    info: (_s, message, meta) => void entries.push({ level: 'INFO', message, meta }),
    warn: (_s, message, meta) => void entries.push({ level: 'WARN', message, meta }),
    error: (_s, message, meta) => void entries.push({ level: 'ERROR', message, meta }),
    log: (level, _s, message, meta) => void entries.push({ level, message, meta }),
    onEntry: () => () => undefined,
    query: () => [],
    clear: () => undefined,
    registerSecret: (value) => void secrets.push(value),
  }
}

const sampleIp: IpInfo = {
  ip: '203.0.113.10',
  country: 'United States',
  countryCode: 'US',
  region: 'New York',
  city: 'New York',
  postalCode: '10118',
  isp: 'Example ISP',
  asn: 'AS64500 Example',
  latencyMs: 120,
  provider: 'ip-api',
  checkedAt: new Date().toISOString(),
}

const NJ: GeoTarget = { mode: 'state', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: null, zip: null }
const NEWARK: GeoTarget = { mode: 'city', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: 'Newark', zip: null }
const ZIP: GeoTarget = { mode: 'zip', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: 'Newark', zip: '07102' }
const US: GeoTarget = { mode: 'country', country: 'us', state: null, stateCode: null, city: null, zip: null }

const request = (overrides: Partial<ProxyRequest> = {}): ProxyRequest => ({ pool: 'residential', sessionId: null, target: null, ttlMinutes: null, ...overrides })

function credentialsFor(username = 'acme_login', sessionTemplate: string | null = null, pool: ProxyCredentials['pool'] = 'residential'): ProxyCredentials {
  return { pool, host: 'gw.dataimpulse.com', port: 823, username, password: pool === 'mobile' ? MOBILE_PASSWORD : PASSWORD, sessionTemplate }
}

function makeProvider(
  overrides: { username?: string; template?: string; ipChecker?: IpChecker; credentialTemplate?: string | null; credentials?: ProxyCredentials[]; encoding?: 'remove-spaces' | 'underscore' | 'keep' } = {},
): {
  provider: DataImpulseProvider
  logger: ReturnType<typeof makeLogger>
  lookup: ReturnType<typeof vi.fn>
} {
  const logger = makeLogger()
  const lookup = vi.fn(async (_proxy: ProxyConnection | null) => sampleIp)
  const ipChecker: IpChecker = overrides.ipChecker ?? { lookup }
  const provider = new DataImpulseProvider({
    ipChecker,
    logger,
    sessionTemplate: overrides.template,
    credentials: overrides.credentials ?? [credentialsFor(overrides.username ?? 'acme_login', overrides.credentialTemplate ?? null)],
    source: 'vault',
    ...(overrides.encoding ? { getTargetingEncoding: () => overrides.encoding! } : {}),
  })
  return { provider, logger, lookup }
}

describe('place-name encoding', () => {
  it('lower-cases, strips diacritics/punctuation and removes spaces by default', () => {
    expect(encodePlaceName('New Jersey')).toBe('newjersey')
    expect(encodeStateName('North Carolina')).toBe('northcarolina')
    expect(encodePlaceName("'Ewa Beach")).toBe('ewabeach')
    expect(encodePlaceName('St. Louis')).toBe('stlouis')
    expect(encodePlaceName('Winston-Salem')).toBe('winstonsalem')
    expect(encodePlaceName("O'Brien")).toBe('obrien')
    expect(encodePlaceName('São Paulo')).toBe('saopaulo')
    expect(encodePlaceName('  Las   Vegas ')).toBe('lasvegas')
    expect(encodePlaceName('District of Columbia')).toBe('districtofcolumbia')
  })

  it('supports the underscore and keep encodings', () => {
    expect(encodePlaceName('St. Louis', 'underscore')).toBe('st_louis')
    expect(encodePlaceName('New Jersey', 'underscore')).toBe('new_jersey')
    expect(encodePlaceName('St. Louis', 'keep')).toBe('st louis')
    expect(encodePlaceName("'Ewa Beach", 'keep')).toBe('ewa beach')
  })

  it("round-trips every state of DataImpulse's official list from its GeoNames name", () => {
    const official = parseDataImpulseStates(readFileSync(join(GEONAMES_DIR, 'dataimpulse-states.csv'), 'utf8'))
    expect(official.size).toBe(50)
    expect(official.has('newjersey')).toBe(true)
    expect(official.has('northcarolina')).toBe(true)

    const rows = parseGeoNamesUs(readFileSync(join(GEONAMES_DIR, 'US.txt'), 'utf8'))
    const names = new Map<string, string>()
    for (const row of rows) if (US_STATE_CODES.includes(row.stateCode)) names.set(row.stateCode, row.stateName)
    expect(names.size).toBe(51)

    const encodedStates = new Set([...names.entries()].filter(([code]) => code !== 'DC').map(([, name]) => encodeStateName(name)))
    expect(encodedStates).toEqual(official)
    // DC is in the dataset but not on DataImpulse's list; it still encodes by the same rule.
    expect(encodeStateName(names.get('DC')!)).toBe('districtofcolumbia')
    expect(official.has('districtofcolumbia')).toBe(false)
  })
})

describe('targeting string composition', () => {
  it('orders parameters cr, state, city, zip, sessid, sessttl', () => {
    expect(buildTargetingString(request({ target: NJ, sessionId: 'abc', ttlMinutes: 60 }))).toBe('cr.us;state.newjersey;sessid.abc;sessttl.60')
    expect(buildTargetingString(request({ target: ZIP, sessionId: 'abc' }))).toBe('cr.us;state.newjersey;city.newark;zip.07102;sessid.abc')
    expect(buildTargetingString(request({ target: NEWARK }))).toBe('cr.us;state.newjersey;city.newark')
    expect(buildTargetingString(request({ target: US }))).toBe('cr.us')
  })

  it('is empty for a rotating request without a target and ignores a TTL without a session', () => {
    expect(buildTargetingString(request())).toBe('')
    expect(buildTargetingString(request({ ttlMinutes: 30 }))).toBe('')
    expect(buildTargetingString(request({ sessionId: 's1' }))).toBe('sessid.s1')
    expect(sessionParams({ sessionId: 's1', ttlMinutes: 15.9 })).toEqual([
      ['sessid', 's1'],
      ['sessttl', '15'],
    ])
  })

  it('applies the configured encoding and always includes the mandatory country', () => {
    expect(buildTargetingString(request({ target: NEWARK }), 'underscore')).toBe('cr.us;state.new_jersey;city.newark')
    expect(buildTargetingString(request({ target: { ...NJ, state: 'North Carolina', stateCode: 'NC' } }), 'keep')).toBe('cr.us;state.north carolina')
    expect(geoParams({ ...US, country: 'DE' })).toEqual([['cr', 'de']])
  })

  it('parses a configured login into login + parameters', () => {
    expect(parseLogin('acme')).toEqual({ login: 'acme', params: [] })
    expect(parseLogin('acme__cr.us')).toEqual({ login: 'acme', params: [['cr', 'us']] })
    expect(parseLogin('acme__cr.us;type.mobile;flag')).toEqual({
      login: 'acme',
      params: [
        ['cr', 'us'],
        ['type', 'mobile'],
        ['flag', ''],
      ],
    })
  })

  it('composes login + targeting + session on a plain login', () => {
    const composed = composeUsername('acme', request({ target: NJ, sessionId: 'abc', ttlMinutes: 60 }))
    expect(composed.username).toBe('acme__cr.us;state.newjersey;sessid.abc;sessttl.60')
    expect(composed.effectiveParams).toEqual([
      ['cr', 'us'],
      ['state', 'newjersey'],
      ['sessid', 'abc'],
      ['sessttl', '60'],
    ])
    expect(composeUsername('acme', request()).username).toBe('acme')
    expect(composeUsername('acme', request({ sessionId: 's1' })).username).toBe('acme__sessid.s1')
    expect(composeUsername('acme', request({ target: US })).username).toBe('acme__cr.us')
  })

  it('replaces (never duplicates) cr/state/city/zip already present on the login and keeps other parameters', () => {
    expect(composeUsername('acme__cr.us', request({ target: NJ, sessionId: 'abc' })).username).toBe('acme__cr.us;state.newjersey;sessid.abc')
    expect(composeUsername('acme__cr.de;type.mobile', request({ target: NJ, sessionId: 'abc' })).username).toBe('acme__cr.us;state.newjersey;type.mobile;sessid.abc')
    expect(composeUsername('acme__cr.us;city.newyork', request({ target: NJ })).username).toBe('acme__cr.us;state.newjersey')
    // Without a target the login's own geo parameters stay in force.
    expect(composeUsername('acme__cr.us;city.newyork', request({ sessionId: 'x' })).username).toBe('acme__cr.us;city.newyork;sessid.x')
    expect(composeUsername('acme__cr.us', request()).username).toBe('acme__cr.us')
  })

  it('replaces a login-level sessid for sticky requests and keeps it for rotating ones', () => {
    expect(composeUsername('acme__cr.us;sessid.old;sessttl.5', request({ sessionId: 'new', ttlMinutes: 60 })).username).toBe('acme__cr.us;sessid.new;sessttl.60')
    expect(composeUsername('acme__cr.us;sessid.old', request({ sessionId: 'new' })).username).toBe('acme__cr.us;sessid.new')
    expect(composeUsername('acme__sessid.pinned', request()).username).toBe('acme__sessid.pinned')
  })

  it('formats the session part through the template and appends sessttl afterwards', () => {
    expect(composeUsername('acme', request({ sessionId: 'abc' }), 'remove-spaces', '{username}{sep}sid.{session}').username).toBe('acme__sid.abc')
    expect(composeUsername('acme__cr.us', request({ sessionId: 'abc', ttlMinutes: 10 }), 'remove-spaces', '{username}{sep}sid.{session}').username).toBe('acme__cr.us;sid.abc;sessttl.10')
    expect(composeUsername('acme', request({ target: NJ, sessionId: 'abc' }), 'underscore', '{username}-session-{session}').username).toBe('acme__cr.us;state.new_jersey-session-abc')
  })
})

describe('DataImpulse username construction (session template)', () => {
  it('appends the sessid parameter with "__" when the base login has no parameters', () => {
    expect(buildDataImpulseUsername('acme_login', 'profile-qa-1')).toBe('acme_login__sessid.profile-qa-1')
  })

  it('appends the sessid parameter with ";" when the base login already carries targeting', () => {
    expect(buildDataImpulseUsername('acme_login__cr.us', 'profile-qa-1')).toBe('acme_login__cr.us;sessid.profile-qa-1')
    expect(buildDataImpulseUsername('acme_login__cr.us;city.newyork', 's1')).toBe('acme_login__cr.us;city.newyork;sessid.s1')
  })

  it('honours a custom template', () => {
    expect(buildDataImpulseUsername('acme', 'abc', '{username}-session-{session}')).toBe('acme-session-abc')
    expect(buildDataImpulseUsername('acme__cr.de', 'abc', '{username}{sep}sid.{session}')).toBe('acme__cr.de;sid.abc')
  })

  it('uses the documented default template', () => {
    expect(DEFAULT_SESSION_TEMPLATE).toBe('{username}{sep}sessid.{session}')
  })

  it('rejects default templates missing required placeholders', () => {
    expect(() => makeProvider({ template: '{username}-static' })).toThrowError(AppException)
  })
})

describe('DataImpulseProvider.buildProxyConfig', () => {
  it('builds the server URL, the targeted sticky username and a password-free targeting string', () => {
    const { provider } = makeProvider({ username: 'acme_login__cr.us' })
    const conn = provider.buildProxyConfig(request({ sessionId: 'profile-qa', target: NJ, ttlMinutes: 60 }))
    expect(conn).toEqual({
      server: 'http://gw.dataimpulse.com:823',
      username: 'acme_login__cr.us;state.newjersey;sessid.profile-qa;sessttl.60',
      password: PASSWORD,
      pool: 'residential',
      sessionId: 'profile-qa',
      target: NJ,
      targetingString: 'cr.us;state.newjersey;sessid.profile-qa;sessttl.60',
    })
    expect(conn.targetingString).not.toContain('acme_login')
    expect(conn.targetingString).not.toContain(PASSWORD)
  })

  it('uses the bare username for rotating mode without a target and reports the login parameters it carries', () => {
    const { provider } = makeProvider({ username: 'acme_login__cr.us' })
    const conn = provider.buildProxyConfig(request())
    expect(conn.username).toBe('acme_login__cr.us')
    expect(conn.sessionId).toBeNull()
    expect(conn.target).toBeNull()
    expect(conn.targetingString).toBe('cr.us')
  })

  it('applies the default template override from options', () => {
    const { provider } = makeProvider({ username: 'acme', template: '{username}__sessid.{session}' })
    expect(provider.buildProxyConfig(request({ sessionId: 'x1' })).username).toBe('acme__sessid.x1')
  })

  it('a template saved with the credentials wins over the default template', () => {
    const { provider } = makeProvider({ username: 'acme', template: '{username}__sessid.{session}', credentialTemplate: '{username}-s-{session}' })
    expect(provider.buildProxyConfig(request({ sessionId: 'x1' })).username).toBe('acme-s-x1')
  })

  it('an invalid template saved with the credentials is ignored with a warning (never throws)', () => {
    const { provider, logger } = makeProvider({ username: 'acme', credentialTemplate: '{username}-static' })
    expect(provider.buildProxyConfig(request({ sessionId: 'x1' })).username).toBe('acme__sessid.x1')
    expect(logger.entries.some((e) => e.level === 'WARN' && /session template/.test(e.message))).toBe(true)
  })

  it('follows settings.targetingEncoding through the provider', () => {
    const { provider } = makeProvider({ username: 'acme', encoding: 'underscore' })
    expect(provider.buildTargetingString(request({ target: NEWARK }))).toBe('cr.us;state.new_jersey;city.newark')
    expect(provider.buildProxyConfig(request({ target: NEWARK })).username).toBe('acme__cr.us;state.new_jersey;city.newark')
  })
})

describe('DataImpulseProvider pools', () => {
  it('keeps credentials per pool and reports every pool in the config status', () => {
    const { provider } = makeProvider({ credentials: [credentialsFor('res_login'), credentialsFor('mob_login', null, 'mobile')] })
    expect(provider.isConfigured()).toBe(true)
    expect(provider.isPoolConfigured('residential')).toBe(true)
    expect(provider.isPoolConfigured('mobile')).toBe(true)
    const status = provider.getConfigStatus()
    expect(status.pools.map((p) => p.pool)).toEqual([...DATAIMPULSE_PRODUCTS])
    expect(status.pools).toEqual([
      { pool: 'residential', configured: true, host: 'gw.dataimpulse.com', port: 823, usernameMasked: 're****in', source: 'vault' },
      { pool: 'mobile', configured: true, host: 'gw.dataimpulse.com', port: 823, usernameMasked: 'mo****in', source: 'vault' },
    ])
    expect(status).toMatchObject({ configured: true, usernameMasked: 're****in', missing: [], source: 'vault' })
    expect(provider.buildProxyConfig(request({ pool: 'mobile', sessionId: 'm1' }))).toMatchObject({ username: 'mob_login__sessid.m1', password: MOBILE_PASSWORD, pool: 'mobile' })
    expect(provider.buildProxyConfig(request({ pool: 'residential' }))).toMatchObject({ username: 'res_login', password: PASSWORD })
    expect(JSON.stringify(status)).not.toContain(PASSWORD)
    expect(JSON.stringify(status)).not.toContain(MOBILE_PASSWORD)
    expect(JSON.stringify(status)).not.toContain('mob_login')
  })

  it('names the pool when only that pool is missing, and the generic message when nothing is configured', async () => {
    const { provider } = makeProvider({ username: 'res_login' })
    expect(provider.isPoolConfigured('mobile')).toBe(false)
    expect(provider.getConfigStatus().pools.find((p) => p.pool === 'mobile')).toEqual({ pool: 'mobile', configured: false, host: null, port: null, usernameMasked: null, source: 'none' })
    expect(() => provider.buildProxyConfig(request({ pool: 'mobile' }))).toThrowError('DataImpulse Mobile credentials are not configured. Add them under Settings → Advanced → Proxy keys.')
    expect(poolNotConfiguredMessage('residential')).toBe('DataImpulse Residential credentials are not configured. Add them under Settings → Advanced → Proxy keys.')
    const result = await provider.testConnection(request({ pool: 'mobile' }))
    expect(result).toMatchObject({ status: 'failed', error: { code: 'PROXY_NOT_CONFIGURED', message: poolNotConfiguredMessage('mobile') } })

    provider.setCredentials([], 'none')
    expect(() => provider.buildProxyConfig(request({ pool: 'mobile' }))).toThrowError(NOT_CONFIGURED_MESSAGE)
  })

  it('setCredentials replaces the whole pool set, registers every password and re-resolves templates', () => {
    const { provider, logger } = makeProvider({ username: 'from_vault' })
    expect(provider.getConfigStatus()).toMatchObject({ source: 'vault', usernameMasked: 'fr****lt' })

    provider.setCredentials([{ ...credentialsFor('from_env'), host: 'other.example', port: 9000 }, credentialsFor('mob', '{username}-m-{session}', 'mobile')], 'env')
    expect(provider.getConfigStatus()).toMatchObject({ source: 'env', host: 'other.example', port: 9000, usernameMasked: 'fr****nv', missing: [] })
    expect(provider.buildProxyConfig(request()).server).toBe('http://other.example:9000')
    expect(provider.buildProxyConfig(request({ pool: 'mobile', sessionId: 's' })).username).toBe('mob-m-s')
    expect(logger.secrets).toContain(MOBILE_PASSWORD)
    expect(logger.secrets).toContain(`mob:${MOBILE_PASSWORD}`)

    provider.setCredentials([credentialsFor('mobile_job', null, 'mobile')], 'vault')
    expect(provider.isPoolConfigured('residential')).toBe(false)
    expect(provider.isPoolConfigured('mobile')).toBe(true)
    // The summary describes the first configured pool when residential is absent.
    expect(provider.getConfigStatus()).toMatchObject({ configured: true, usernameMasked: 'mo****ob' })
    expect(provider.buildProxyConfig(request({ pool: 'mobile', sessionId: 's' })).username).toBe('mobile_job__sessid.s')

    provider.setCredentials([], 'none')
    expect(provider.isConfigured()).toBe(false)
    expect(provider.getConfigStatus()).toEqual({
      configured: false,
      pools: [
        { pool: 'residential', configured: false, host: null, port: null, usernameMasked: null, source: 'none' },
        { pool: 'mobile', configured: false, host: null, port: null, usernameMasked: null, source: 'none' },
      ],
      provider: 'dataimpulse',
      host: null,
      port: null,
      usernameMasked: null,
      missing: [...REQUIRED_CREDENTIAL_FIELDS],
      source: 'none',
    })
    expect(JSON.stringify(logger.entries)).not.toContain(PASSWORD)
    expect(JSON.stringify(logger.entries)).not.toContain(MOBILE_PASSWORD)
  })
})

describe('DataImpulseProvider sessions', () => {
  it('createSession produces a deterministic kebab slug prefixed with "profile-"', () => {
    const { provider } = makeProvider()
    expect(provider.createSession('QA Tester #1 (NY)')).toBe('profile-qa-tester-1-ny')
    expect(provider.createSession('QA Tester #1 (NY)')).toBe(provider.createSession('QA Tester #1 (NY)'))
    expect(provider.createSession('Émilie Ö')).toBe('profile-emilie-o')
    expect(provider.createSession('***')).toBe('profile-default')
  })

  it('createSession caps the id at 32 chars and keeps it within the allowed alphabet', () => {
    const { provider } = makeProvider()
    const id = provider.createSession('This Is A Very Long Profile Name That Keeps Going And Going')
    expect(id.length).toBeLessThanOrEqual(32)
    expect(id).toMatch(SESSION_ID_PATTERN)
  })

  it('rotateSession returns a different id and increments the round suffix', () => {
    const { provider } = makeProvider()
    const first = provider.createSession('Alpha')
    const second = provider.rotateSession(first, 'Alpha')
    const third = provider.rotateSession(second, 'Alpha')
    expect(second).toBe('profile-alpha-r2')
    expect(third).toBe('profile-alpha-r3')
    expect(new Set([first, second, third]).size).toBe(3)
  })

  it('rotateSession from null derives from the profile name', () => {
    const { provider } = makeProvider()
    expect(provider.rotateSession(null, 'Beta')).toBe('profile-beta-r2')
  })

  it('rotateSession preserves the user-entered id verbatim (upper case, underscores) and appends -r<N>', () => {
    const { provider } = makeProvider()
    expect(provider.rotateSession('e2e-chromium-001', 'E2E proxy chromium')).toBe('e2e-chromium-001-r2')
    expect(provider.rotateSession('e2e-chromium-001-r2', 'E2E proxy chromium')).toBe('e2e-chromium-001-r3')
    expect(provider.rotateSession('QA_Session_A', 'ignored')).toBe('QA_Session_A-r2')
    expect(provider.rotateSession('QA_Session_A-r9', 'ignored')).toBe('QA_Session_A-r10')
    expect(provider.rotateSession('has spaces!', 'Gamma')).toBe('profile-gamma-r2')
  })

  it('rotateSession honours the 64-character profile limit and truncates the stem only when needed', () => {
    const { provider } = makeProvider()
    const long = 'x'.repeat(64)
    const rotated = provider.rotateSession(long, 'ignored')
    expect(rotated).toHaveLength(64)
    expect(rotated.endsWith('-r2')).toBe(true)
    expect(rotated.startsWith('x'.repeat(61))).toBe(true)
    expect(rotated).toMatch(STICKY_SESSION_ID_PATTERN)

    const sixty = 'y'.repeat(60)
    expect(provider.rotateSession(sixty, 'ignored')).toBe(`${sixty}-r2`)

    let id = provider.createSession('This Is A Very Long Profile Name That Keeps Going')
    for (let i = 0; i < 12; i += 1) {
      const next = provider.rotateSession(id, 'This Is A Very Long Profile Name That Keeps Going')
      expect(next).not.toBe(id)
      expect(next.length).toBeLessThanOrEqual(STICKY_SESSION_ID_MAX_LENGTH)
      expect(next).toMatch(STICKY_SESSION_ID_PATTERN)
      id = next
    }
    expect(id).toBe(`${provider.createSession('This Is A Very Long Profile Name That Keeps Going')}-r13`)
  })
})

describe('DataImpulseProvider config status & secrets', () => {
  it('masks the username, reports the source and never exposes the password', () => {
    const { provider, logger } = makeProvider({ username: 'acme_login' })
    const status = provider.getConfigStatus()
    expect(status).toMatchObject({
      configured: true,
      provider: 'dataimpulse',
      host: 'gw.dataimpulse.com',
      port: 823,
      usernameMasked: 'ac****in',
      missing: [],
      source: 'vault',
    })
    expect(JSON.stringify(status)).not.toContain(PASSWORD)
    expect(JSON.stringify(status)).not.toContain('acme_login')
    expect(logger.secrets).toContain(PASSWORD)
    expect(logger.secrets).toContain(`acme_login:${PASSWORD}`)
    expect(JSON.stringify(logger.entries)).not.toContain(PASSWORD)
  })

  it('maskUsername handles short values', () => {
    expect(maskUsername('abcd')).toBe('****')
    expect(maskUsername('abcde')).toBe('ab****de')
  })

  it('kebabSlug normalises arbitrary input', () => {
    expect(kebabSlug('  Hello,  World! ')).toBe('hello-world')
  })
})

describe('DataImpulseProvider.testCredentials', () => {
  const candidate = { pool: 'residential' as const, host: 'gw2.dataimpulse.com', port: 10000, username: 'candidate_user', password: 'Cand1date-Secret', sessionTemplate: null }

  it('tests the candidate through the gateway in rotating mode without touching the active credentials', async () => {
    const { provider, logger, lookup } = makeProvider({ username: 'active_user' })
    const result = await provider.testCredentials(candidate)
    expect(result).toEqual({ status: 'working', sessionId: null, ip: sampleIp, error: null })
    expect(lookup).toHaveBeenCalledWith({
      server: 'http://gw2.dataimpulse.com:10000',
      username: 'candidate_user',
      password: 'Cand1date-Secret',
      pool: 'residential',
      sessionId: null,
      target: null,
      targetingString: '',
    })

    expect(provider.getConfigStatus()).toMatchObject({ host: 'gw.dataimpulse.com', port: 823, usernameMasked: 'ac****er', source: 'vault' })
    expect(provider.buildProxyConfig(request()).password).toBe(PASSWORD)

    expect(logger.secrets).toContain('Cand1date-Secret')
    expect(JSON.stringify(logger.entries)).not.toContain('Cand1date-Secret')
    expect(JSON.stringify(logger.entries)).not.toContain('candidate_user')
    expect(JSON.stringify(result)).not.toContain('Cand1date-Secret')
  })

  it('tests mobile candidates against the mobile pool without needing residential credentials', async () => {
    const provider = new DataImpulseProvider({ ipChecker: { lookup: async () => sampleIp }, logger: makeLogger() })
    const result = await provider.testCredentials({ ...candidate, pool: 'mobile', username: 'mob__cr.us' })
    expect(result.status).toBe('working')
    expect(provider.isConfigured()).toBe(false)
  })

  it('returns a failed result with a credential-free error when the gateway rejects the candidate', async () => {
    const ipChecker: IpChecker = {
      lookup: async () => {
        throw new AppException('PROXY_AUTH_FAILED', 'The proxy rejected the credentials (HTTP 407).')
      },
    }
    const { provider, logger } = makeProvider({ ipChecker })
    const result = await provider.testCredentials(candidate)
    expect(result.status).toBe('failed')
    expect(result.error).toMatchObject({ code: 'PROXY_AUTH_FAILED' })
    expect(logger.entries.some((e) => e.level === 'WARN' && /Candidate proxy credentials failed/.test(e.message))).toBe(true)
    expect(JSON.stringify(logger.entries)).not.toContain('Cand1date-Secret')
  })

  it('wraps unexpected errors as INTERNAL with the candidate credentials stripped', async () => {
    const ipChecker: IpChecker = {
      lookup: async () => {
        throw new Error(`connect failed for http://candidate_user:Cand1date-Secret@gw2.dataimpulse.com:10000`)
      },
    }
    const { provider } = makeProvider({ ipChecker })
    const result = await provider.testCredentials(candidate)
    expect(result.error?.code).toBe('INTERNAL')
    expect(result.error?.detail).not.toContain('Cand1date-Secret')
  })

  it('rejects invalid input, including a template without placeholders', async () => {
    const { provider } = makeProvider()
    await expect(provider.testCredentials({ ...candidate, password: '' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(provider.testCredentials({ ...candidate, port: 70000 })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(provider.testCredentials({ ...candidate, sessionTemplate: 'no-placeholders' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

describe('DataImpulseProvider testConnection / getCurrentIp', () => {
  it('returns a working result with the ip info and sends the targeted username', async () => {
    const { provider, lookup } = makeProvider({ username: 'acme__cr.us' })
    const result = await provider.testConnection(request({ sessionId: 'profile-x', target: NJ }))
    expect(result.status).toBe('working')
    expect(result.ip).toEqual(sampleIp)
    expect(result.error).toBeNull()
    expect(result.sessionId).toBe('profile-x')
    expect(lookup).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'acme__cr.us;state.newjersey;sessid.profile-x', sessionId: 'profile-x', pool: 'residential', targetingString: 'cr.us;state.newjersey;sessid.profile-x' }),
    )
  })

  it('returns a failed result (never throws) with the AppError on failure', async () => {
    const ipChecker: IpChecker = {
      lookup: async () => {
        throw new AppException('PROXY_TIMEOUT', 'The proxy did not respond in time.', 'timeout 15000ms')
      },
    }
    const { provider, logger } = makeProvider({ ipChecker })
    const result = await provider.testConnection(request({ sessionId: 's1' }))
    expect(result.status).toBe('failed')
    expect(result.ip).toBeNull()
    expect(result.error).toEqual({ code: 'PROXY_TIMEOUT', message: 'The proxy did not respond in time.', detail: 'timeout 15000ms' })
    expect(logger.entries.some((e) => e.level === 'WARN')).toBe(true)
    expect(JSON.stringify(logger.entries)).not.toContain(PASSWORD)
  })

  it('wraps non-AppException failures as INTERNAL with credentials stripped', async () => {
    const ipChecker: IpChecker = {
      lookup: async () => {
        throw new Error(`connect failed for http://acme:${PASSWORD}@gw.dataimpulse.com:823`)
      },
    }
    const { provider } = makeProvider({ ipChecker })
    const result = await provider.testConnection(request())
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('INTERNAL')
    expect(result.error?.detail).not.toContain(PASSWORD)
  })

  it('getCurrentIp propagates AppException', async () => {
    const ipChecker: IpChecker = {
      lookup: async () => {
        throw new AppException('DNS_FAILURE', 'Could not resolve host.')
      },
    }
    const { provider } = makeProvider({ ipChecker })
    await expect(provider.getCurrentIp(request({ sessionId: 's1' }))).rejects.toMatchObject({ code: 'DNS_FAILURE' })
  })
})

describe('DataImpulseProvider when not configured', () => {
  function unconfigured(): DataImpulseProvider {
    return new DataImpulseProvider({ ipChecker: { lookup: async () => sampleIp }, logger: makeLogger() })
  }

  it('reports the missing fields and source none without secrets', () => {
    const provider = unconfigured()
    expect(provider.isConfigured()).toBe(false)
    expect(provider.getConfigStatus()).toMatchObject({
      configured: false,
      provider: 'dataimpulse',
      host: null,
      port: null,
      usernameMasked: null,
      missing: ['host', 'port', 'username', 'password'],
      source: 'none',
    })
    expect(provider.getConfigStatus().pools.every((p) => !p.configured)).toBe(true)
  })

  it('buildProxyConfig / getCurrentIp throw PROXY_NOT_CONFIGURED, testConnection returns it as a failed result', async () => {
    const provider = unconfigured()
    expect(() => provider.buildProxyConfig(request({ sessionId: 's1' }))).toThrowError(NOT_CONFIGURED_MESSAGE)
    await expect(provider.getCurrentIp(request())).rejects.toMatchObject({ code: 'PROXY_NOT_CONFIGURED' })
    const result = await provider.testConnection(request())
    expect(result.status).toBe('failed')
    expect(result.error).toMatchObject({ code: 'PROXY_NOT_CONFIGURED', message: NOT_CONFIGURED_MESSAGE })
  })

  it('still derives session ids and targeting strings without credentials', () => {
    expect(unconfigured().createSession('Offline Profile')).toBe('profile-offline-profile')
    expect(unconfigured().buildTargetingString(request({ target: NJ, sessionId: 'x' }))).toBe('cr.us;state.newjersey;sessid.x')
  })

  it('the not-configured messages point at the in-app setup, not at a .env file', () => {
    expect(NOT_CONFIGURED_MESSAGE).not.toMatch(/\.env/)
    expect(NOT_CONFIGURED_MESSAGE).toMatch(/first-run setup|Settings/)
    expect(poolNotConfiguredMessage('mobile')).toMatch(/Settings → Advanced/)
  })
})

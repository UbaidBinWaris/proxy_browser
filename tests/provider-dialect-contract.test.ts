import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppError, GeoTarget, IpInfo, LocationEntry, ProfileInput, ProviderId, TargetMode } from '../src/shared/types'
import { PROVIDER_IDS, ProductKeySchema, STICKY_SESSION_ID_MAX_LENGTH, isValidSessionTemplate } from '../src/shared/types'
import { AppException } from '../src/main/contracts'
import type { Database, IpChecker, Logger, ProxyConnection, ProxyRequest } from '../src/main/contracts'
import { openDatabase } from '../src/main/database/index'
import { DataImpulseProvider, GEO_TARGETING_BILLING_NOTE, TARGETING_ENCODINGS, dataImpulseDialect } from '../src/main/proxy/providers/dataimpulse'
import type { ComposedConnection, ProviderCredentials, ProviderDialect } from '../src/main/proxy/providers/dialect'
import { GatewayProvider, REQUIRED_CREDENTIAL_FIELDS } from '../src/main/proxy/providers/gateway-provider'
import { BUILT_IN_DIALECTS, ProviderRegistry } from '../src/main/proxy/providers/registry'
import { createProxyManager } from '../src/main/proxy/proxy-manager'
import { notConfiguredMessage, productNotConfiguredMessage } from '../src/main/proxy/targeting-text'

const PASSWORD = 'Pw-Contract-91x!'
const LOGIN = 'contractlogin'

type Entry = { level: string; message: string; meta?: Record<string, unknown> }

function makeLogger(): Logger & { secrets: string[]; entries: Entry[] } {
  const entries: Entry[] = []
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
  region: 'New Jersey',
  city: 'Newark',
  postalCode: '07102',
  isp: 'Example ISP',
  asn: 'AS64500 Example',
  latencyMs: 120,
  provider: 'ip-api',
  checkedAt: '2026-10-08T10:00:00.000Z',
}

const TARGETS: Record<TargetMode, GeoTarget> = {
  country: { mode: 'country', country: 'us', state: null, stateCode: null, city: null, zip: null },
  state: { mode: 'state', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: null, zip: null },
  city: { mode: 'city', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: 'Newark', zip: null },
  zip: { mode: 'zip', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: 'Newark', zip: '07102' },
}

const request = (overrides: Partial<ProxyRequest> = {}): ProxyRequest => ({ pool: 'residential', sessionId: null, target: null, ttlMinutes: null, ...overrides })

function credentialsFor(dialect: ProviderDialect, overrides: Partial<ProviderCredentials> = {}): ProviderCredentials {
  const product = dialect.capabilities.products[0]!.key
  return {
    pool: product,
    host: dialect.capabilities.defaults.host,
    port: dialect.capabilities.defaults.port,
    username: LOGIN,
    password: PASSWORD,
    sessionTemplate: dialect.sessionTemplate?.default ?? null,
    extras: Object.fromEntries(dialect.capabilities.extraCredentialFields.map((field) => [field.key, `${field.key}-value`])),
    ...overrides,
  }
}

const PROFILE_NAMES = ['QA Tester #1 (NY)', 'Émilie Ö', '***', '', 'x', 'This Is A Very Long Profile Name That Keeps Going And Going And Going']

// ---------------------------------------------------------------------------
// Contract suite: every registered dialect
// ---------------------------------------------------------------------------

describe('built-in dialect registry', () => {
  it('registers exactly one dialect per provider id', () => {
    expect(BUILT_IN_DIALECTS.map((d) => d.id).sort()).toEqual([...PROVIDER_IDS].sort())
  })
})

describe.each(BUILT_IN_DIALECTS.map((dialect) => [dialect.id, dialect] as const))('dialect contract: %s', (_id, dialect) => {
  const caps = dialect.capabilities
  const idPattern = new RegExp(caps.sticky.idPattern)

  it('describes itself: docs URL, products, modes, defaults', () => {
    expect(dialect.displayName.trim().length).toBeGreaterThan(0)
    expect(dialect.docsUrl).toMatch(/^https:\/\//)
    expect(caps.products.length).toBeGreaterThan(0)
    const keys = caps.products.map((p) => p.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) expect(ProductKeySchema.safeParse(key).success).toBe(true)
    expect(caps.targetModes.length).toBeGreaterThan(0)
    expect(new Set(caps.targetModes).size).toBe(caps.targetModes.length)
    expect(caps.defaults.host.length).toBeGreaterThan(0)
    expect(Number.isInteger(caps.defaults.port) && caps.defaults.port > 0 && caps.defaults.port <= 65535).toBe(true)
    // Session ids are stored on profiles, so they must fit the profile limit.
    expect(caps.sticky.idMaxLength).toBeLessThanOrEqual(STICKY_SESSION_ID_MAX_LENGTH)
    if (caps.sticky.ttlMinutes) expect(caps.sticky.ttlMinutes.min).toBeLessThanOrEqual(caps.sticky.ttlMinutes.max)
    if (dialect.sessionTemplate) expect(isValidSessionTemplate(dialect.sessionTemplate.default)).toBe(true)
  })

  it('createSession ids match the declared pattern and max length, deterministically', () => {
    for (const name of PROFILE_NAMES) {
      const id = dialect.createSession(name)
      expect(id).toMatch(idPattern)
      expect(id.length).toBeLessThanOrEqual(caps.sticky.idMaxLength)
      expect(dialect.createSession(name)).toBe(id)
    }
  })

  it('rotateSession always returns a different id that matches the pattern and max length', () => {
    const starts: Array<string | null> = [null, 'QA_Session_A', 'e2e-chromium-001-r9', 'x'.repeat(caps.sticky.idMaxLength), 'has spaces!', ...PROFILE_NAMES.map((n) => dialect.createSession(n))]
    for (const start of starts) {
      let current = start
      for (let round = 0; round < 15; round += 1) {
        const next = dialect.rotateSession(current, 'Rotation Profile')
        expect(next).not.toBe(current)
        expect(next).toMatch(idPattern)
        expect(next.length).toBeLessThanOrEqual(caps.sticky.idMaxLength)
        current = next
      }
    }
  })

  it('compose is deterministic and the targeting string never contains the password', () => {
    const credentials = credentialsFor(dialect)
    const requests: ProxyRequest[] = [request(), request({ sessionId: 'sess-1', ttlMinutes: 30 })]
    for (const mode of caps.targetModes) {
      requests.push(request({ target: TARGETS[mode] }), request({ target: TARGETS[mode], sessionId: 'sess-2', ttlMinutes: 60 }))
    }
    for (const encoding of [undefined, ...(caps.encodingOptions ?? [])]) {
      for (const req of requests) {
        const options = encoding === undefined ? undefined : { encoding }
        const first = dialect.compose(credentials, req, options)
        expect(dialect.compose(credentials, structuredClone(req), options)).toEqual(first)
        expect(first.server).toMatch(/^https?:\/\/[^/]+:\d+$/)
        expect(first.targetingString).not.toContain(PASSWORD)
        expect(dialect.targetingString(req, options)).not.toContain(PASSWORD)
        expect(dialect.targetingString(req, options)).toBe(dialect.targetingString(structuredClone(req), options))
      }
    }
    if (dialect.composeCredentialCheck) {
      const check = dialect.composeCredentialCheck(credentials)
      expect(check.targetingString).not.toContain(PASSWORD)
      expect(dialect.composeCredentialCheck(credentials)).toEqual(check)
    }
  })

  it('every declared target mode changes the composed connection', () => {
    const credentials = credentialsFor(dialect)
    const key = (c: ComposedConnection): string => `${c.server}\n${c.username}\n${c.password}`
    const untargeted = key(dialect.compose(credentials, request()))
    const seen = new Set<string>([untargeted])
    for (const mode of caps.targetModes) {
      const composed = key(dialect.compose(credentials, request({ target: TARGETS[mode] })))
      expect(composed, `mode ${mode}`).not.toBe(untargeted)
      seen.add(composed)
    }
    expect(seen.size).toBe(caps.targetModes.length + 1)
  })

  it('a sticky session changes the composed connection when sticky sessions are supported', () => {
    if (!caps.sticky.supported) return
    const credentials = credentialsFor(dialect)
    const rotating = dialect.compose(credentials, request())
    const sticky = dialect.compose(credentials, request({ sessionId: 'sess-1' }))
    expect(`${sticky.username}${sticky.password}`).not.toBe(`${rotating.username}${rotating.password}`)
  })

  it('isRetryableLocationFailure, when declared, never retries rejected credentials', () => {
    if (!dialect.isRetryableLocationFailure) return
    expect(dialect.isRetryableLocationFailure({ code: 'PROXY_AUTH_FAILED', message: 'HTTP 407' })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// DataImpulse dialect: golden table + capabilities
// ---------------------------------------------------------------------------

describe('dataImpulseDialect', () => {
  const creds = (username: string, sessionTemplate: string | null = null): ProviderCredentials => ({
    pool: 'residential',
    host: 'gw.dataimpulse.com',
    port: 823,
    username,
    password: PASSWORD,
    sessionTemplate,
  })

  it.each([
    ['rotating, no target', 'acme', request(), undefined, 'acme'],
    ['sticky + TTL, state', 'acme', request({ target: TARGETS.state, sessionId: 's1', ttlMinutes: 60 }), undefined, 'acme__cr.us;state.newjersey;sessid.s1;sessttl.60'],
    ['city', 'acme', request({ target: TARGETS.city }), undefined, 'acme__cr.us;state.newjersey;city.newark'],
    ['zip', 'acme', request({ target: TARGETS.zip }), undefined, 'acme__cr.us;state.newjersey;city.newark;zip.07102'],
    ['country', 'acme', request({ target: TARGETS.country }), undefined, 'acme__cr.us'],
    ['login params kept, geo replaced', 'acme__cr.de;type.mobile', request({ target: TARGETS.state, sessionId: 'abc' }), undefined, 'acme__cr.us;state.newjersey;type.mobile;sessid.abc'],
    ['underscore encoding', 'acme', request({ target: TARGETS.state }), 'underscore', 'acme__cr.us;state.new_jersey'],
    ['unknown encoding falls back to the default', 'acme', request({ target: TARGETS.state }), 'bogus', 'acme__cr.us;state.newjersey'],
  ])('golden: %s', (_label, username, req, encoding, expected) => {
    const composed = dataImpulseDialect.compose(creds(username), req, encoding === undefined ? undefined : { encoding })
    expect(composed).toMatchObject({ server: 'http://gw.dataimpulse.com:823', username: expected, password: PASSWORD })
  })

  it('applies the resolved session template from the credentials', () => {
    expect(dataImpulseDialect.compose(creds('acme', '{username}-s-{session}'), request({ sessionId: 'x1' })).username).toBe('acme-s-x1')
  })

  it('checks candidate credentials with the login exactly as entered', () => {
    expect(dataImpulseDialect.composeCredentialCheck!(creds('acme__type.mobile;cr.us'))).toEqual({
      server: 'http://gw.dataimpulse.com:823',
      username: 'acme__type.mobile;cr.us',
      password: PASSWORD,
      targetingString: 'type.mobile;cr.us',
    })
  })

  it('declares the existing DataImpulse facts as capabilities', () => {
    const caps = dataImpulseDialect.capabilities
    expect(caps.products.map((p) => p.key)).toEqual(['residential', 'mobile'])
    expect(caps.targetModes).toEqual(['country', 'state', 'city', 'zip'])
    expect(caps.defaults).toEqual({ host: 'gw.dataimpulse.com', port: 823 })
    expect(caps.targetingBillingNote).toBe(GEO_TARGETING_BILLING_NOTE)
    expect(caps.targetingBillingNote).toBe('State/city/ZIP targeting is billed at 2× by DataImpulse.')
    expect(caps.encodingOptions).toEqual([...TARGETING_ENCODINGS])
    expect(caps.encodingOptions?.[0]).toBe('remove-spaces')
    expect(existsSync(join(process.cwd(), 'resources', 'geonames', caps.stateAllowlistFile!))).toBe(true)
    expect(dataImpulseDialect.sessionTemplate).toEqual({ default: '{username}{sep}sessid.{session}', settingName: 'DATAIMPULSE_SESSION_TEMPLATE' })
  })

  it('stops re-rolling on PROXY_DEAD (exhausted location pool) and rejected credentials only', () => {
    const err = (code: AppError['code']): AppError => ({ code, message: code })
    expect(dataImpulseDialect.isRetryableLocationFailure!(err('PROXY_DEAD'))).toBe(false)
    expect(dataImpulseDialect.isRetryableLocationFailure!(err('PROXY_AUTH_FAILED'))).toBe(false)
    expect(dataImpulseDialect.isRetryableLocationFailure!(err('PROXY_TIMEOUT'))).toBe(true)
    expect(dataImpulseDialect.isRetryableLocationFailure!(err('IP_VERIFY_FAILED'))).toBe(true)
  })

  it('DataImpulseProvider is a GatewayProvider running this dialect', () => {
    const provider = new DataImpulseProvider({ ipChecker: { lookup: async () => sampleIp }, logger: makeLogger() })
    expect(provider).toBeInstanceOf(GatewayProvider)
    expect(provider.dialect).toBe(dataImpulseDialect)
    expect(provider.name).toBe('dataimpulse')
  })
})

// ---------------------------------------------------------------------------
// GatewayProvider with a non-DataImpulse dialect (parameters in the password)
// ---------------------------------------------------------------------------

/** IPRoyal-style test dialect: targeting goes in the password, a secret extra field is declared. */
const passwordDialect: ProviderDialect = {
  id: 'acme' as ProviderId,
  displayName: 'Acme',
  docsUrl: 'https://example.com/docs',
  capabilities: {
    products: [{ key: 'residential', label: 'Residential' }],
    targetModes: ['country', 'state'],
    sticky: { supported: true, idPattern: '^[a-z0-9]{1,16}$', idMaxLength: 16 },
    defaults: { host: 'gw.example.com', port: 12321 },
    extraCredentialFields: [
      { key: 'zone', label: 'Zone', secret: false },
      { key: 'apiKey', label: 'API key', secret: true },
    ],
    encodingOptions: ['plain', 'loud'],
  },
  compose(credentials, req, options) {
    const params = [req.target ? `country-${req.target.country}` : null, req.target?.state ? `state-${req.target.state.replace(/\s+/g, '')}` : null, req.sessionId ? `session-${req.sessionId}` : null].filter(
      (p): p is string => p !== null,
    )
    const targeting = options?.encoding === 'loud' ? params.join('_').toUpperCase() : params.join('_')
    return {
      server: `http://${credentials.host}:${credentials.port}`,
      username: `${credentials.username}-zone-${credentials.extras?.zone ?? 'none'}`,
      password: targeting ? `${credentials.password}_${targeting}` : credentials.password,
      targetingString: targeting,
    }
  },
  targetingString: (req, options) => passwordDialect.compose({ pool: req.pool, host: 'h', port: 1, username: '', password: '', sessionTemplate: null }, req, options).targetingString,
  createSession: (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'default',
  rotateSession: (current) => (current === 'rerolla' ? 'rerollb' : 'rerolla'),
  isRetryableLocationFailure: (error) => error.code !== 'PROXY_TIMEOUT',
}

describe('GatewayProvider', () => {
  const acmeCreds = (overrides: Partial<ProviderCredentials> = {}): ProviderCredentials => ({
    pool: 'residential',
    host: 'gw.example.com',
    port: 12321,
    username: 'acmeuser',
    password: PASSWORD,
    sessionTemplate: '{username}-ignored-{session}',
    extras: { zone: 'z1', apiKey: 'Api-Key-Secret' },
    ...overrides,
  })

  function makeGateway(overrides: { dialect?: ProviderDialect; ipChecker?: IpChecker; getEncoding?: () => string; credentials?: ProviderCredentials[] } = {}): {
    provider: GatewayProvider
    logger: ReturnType<typeof makeLogger>
    lookup: ReturnType<typeof vi.fn>
  } {
    const logger = makeLogger()
    const lookup = vi.fn(async (_proxy: ProxyConnection | null) => sampleIp)
    const provider = new GatewayProvider({
      dialect: overrides.dialect ?? passwordDialect,
      ipChecker: overrides.ipChecker ?? { lookup },
      logger,
      credentials: overrides.credentials ?? [acmeCreds()],
      source: 'vault',
      ...(overrides.getEncoding ? { getEncoding: overrides.getEncoding } : {}),
    })
    return { provider, logger, lookup }
  }

  it('takes its name and log scope from the dialect and reports a password-free status', () => {
    const { provider, logger } = makeGateway()
    expect(provider.name).toBe('acme')
    const status = provider.getConfigStatus()
    expect(status).toMatchObject({ configured: true, provider: 'acme', host: 'gw.example.com', port: 12321, usernameMasked: 'ac****er', missing: [], source: 'vault' })
    expect(JSON.stringify(status)).not.toContain(PASSWORD)
    expect(logger.entries.some((e) => e.message === 'Proxy credentials activated for the residential pool')).toBe(true)
  })

  it('registers the composed password (parameters in the password) and secret extra fields', () => {
    const { provider, logger } = makeGateway()
    expect(logger.secrets).toContain('Api-Key-Secret')
    expect(logger.secrets).not.toContain('z1')
    const conn = provider.buildProxyConfig(request({ target: TARGETS.state, sessionId: 'abc' }))
    expect(conn).toEqual({
      server: 'http://gw.example.com:12321',
      username: 'acmeuser-zone-z1',
      password: `${PASSWORD}_country-us_state-NewJersey_session-abc`,
      pool: 'residential',
      sessionId: 'abc',
      target: TARGETS.state,
      targetingString: 'country-us_state-NewJersey_session-abc',
    })
    expect(logger.secrets).toContain(conn.password)
    expect(JSON.stringify(logger.entries)).not.toContain(PASSWORD)
  })

  it('ignores session templates for dialects without template support', () => {
    const seen: ProviderCredentials[] = []
    const spy: ProviderDialect = { ...passwordDialect, compose: (c, r, o) => (seen.push(c), passwordDialect.compose(c, r, o)) }
    const { provider } = makeGateway({ dialect: spy })
    provider.buildProxyConfig(request())
    expect(seen[0]?.sessionTemplate).toBeNull()
  })

  it('passes the provider encoding option to the dialect at request time', () => {
    let encoding = 'plain'
    const { provider } = makeGateway({ getEncoding: () => encoding })
    expect(provider.buildTargetingString(request({ target: TARGETS.country }))).toBe('country-us')
    encoding = 'loud'
    expect(provider.buildTargetingString(request({ target: TARGETS.country }))).toBe('COUNTRY-US')
    expect(provider.buildProxyConfig(request({ target: TARGETS.country })).targetingString).toBe('COUNTRY-US')
  })

  it('tests candidate credentials with compose() when the dialect has no credential-check composer', async () => {
    const { provider, logger, lookup } = makeGateway()
    const result = await provider.testCredentials({ providerId: 'acme', pool: 'residential', host: 'gw2.example.com', port: 9000, username: 'cand', password: 'Cand-Secret-1', sessionTemplate: null })
    expect(result).toEqual({ status: 'working', sessionId: null, ip: sampleIp, error: null })
    expect(lookup).toHaveBeenCalledWith({
      server: 'http://gw2.example.com:9000',
      username: 'cand-zone-none',
      password: 'Cand-Secret-1',
      pool: 'residential',
      sessionId: null,
      target: null,
      targetingString: '',
    })
    expect(logger.secrets).toContain('Cand-Secret-1')
    expect(JSON.stringify(logger.entries)).not.toContain('Cand-Secret-1')
  })

  it('fails with the not-configured messages and the generic missing fields', () => {
    const { provider } = makeGateway({ credentials: [] })
    expect(provider.getConfigStatus()).toMatchObject({ configured: false, missing: [...REQUIRED_CREDENTIAL_FIELDS], source: 'none' })
    expect(() => provider.buildProxyConfig(request())).toThrowError(notConfiguredMessage('Acme'))
    provider.setCredentials([acmeCreds()], 'env')
    expect(() => provider.buildProxyConfig(request({ pool: 'mobile' }))).toThrowError(productNotConfiguredMessage(passwordDialect, 'mobile'))
  })

  it('isRetryableLocationFailure never retries rejected credentials and otherwise asks the dialect (default: retry)', () => {
    const { provider } = makeGateway()
    expect(provider.isRetryableLocationFailure({ code: 'PROXY_AUTH_FAILED', message: '' })).toBe(false)
    expect(provider.isRetryableLocationFailure({ code: 'PROXY_TIMEOUT', message: '' })).toBe(false)
    expect(provider.isRetryableLocationFailure({ code: 'PROXY_DEAD', message: '' })).toBe(true)
    const { isRetryableLocationFailure: _omit, ...withoutHook } = passwordDialect
    const plain = makeGateway({ dialect: withoutHook }).provider
    expect(plain.isRetryableLocationFailure({ code: 'PROXY_DEAD', message: '' })).toBe(true)
    expect(plain.isRetryableLocationFailure({ code: 'PROXY_AUTH_FAILED', message: '' })).toBe(false)
  })

  it('rejects an invalid default session template naming the dialect setting', () => {
    expect(
      () => new GatewayProvider({ dialect: dataImpulseDialect, ipChecker: { lookup: async () => sampleIp }, logger: makeLogger(), sessionTemplate: '{username}-static' }),
    ).toThrowError('DATAIMPULSE_SESSION_TEMPLATE must contain both {username} and {session} placeholders.')
  })
})

// ---------------------------------------------------------------------------
// ProviderRegistry
// ---------------------------------------------------------------------------

describe('ProviderRegistry', () => {
  const deps = (): { ipChecker: IpChecker; logger: Logger } => ({ ipChecker: { lookup: async () => sampleIp }, logger: makeLogger() })

  it('registers a dialect as a GatewayProvider and returns it by id', () => {
    const registry = new ProviderRegistry(deps())
    const registered = registry.register(dataImpulseDialect, { getEncoding: () => 'underscore' })
    expect(registered).toBeInstanceOf(GatewayProvider)
    expect(registry.get('dataimpulse')).toBe(registered)
    expect(registry.has('dataimpulse')).toBe(true)
    expect(registered.buildTargetingString(request({ target: TARGETS.state }))).toBe('cr.us;state.new_jersey')
  })

  it('throws INVALID_INPUT naming an unknown provider (no silent fallback)', () => {
    const registry = new ProviderRegistry(deps())
    registry.register(dataImpulseDialect)
    expect(registry.has('brightdata')).toBe(false)
    let thrown: unknown
    try {
      registry.get('brightdata')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(AppException)
    expect((thrown as AppException).code).toBe('INVALID_INPUT')
    expect((thrown as AppException).message).toBe('Unknown proxy provider "brightdata".')
    expect((thrown as AppException).detail).toBe('registered providers: dataimpulse')
  })

  it('refuses to register the same id twice', () => {
    const registry = new ProviderRegistry(deps())
    registry.register(dataImpulseDialect)
    expect(() => registry.register(dataImpulseDialect)).toThrowError(AppException)
  })

  it('lists registered providers with a copy of their capabilities', () => {
    const registry = new ProviderRegistry(deps())
    expect(registry.list()).toEqual([])
    registry.register(dataImpulseDialect)
    const [summary] = registry.list()
    expect(summary).toEqual({ id: 'dataimpulse', displayName: 'DataImpulse', docsUrl: dataImpulseDialect.docsUrl, capabilities: dataImpulseDialect.capabilities })
    summary!.capabilities.products.length = 0
    expect(dataImpulseDialect.capabilities.products).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Proxy manager early stop consults the provider
// ---------------------------------------------------------------------------

describe('location re-roll early stop (provider.isRetryableLocationFailure)', () => {
  let db: Database
  let logger: ReturnType<typeof makeLogger>

  beforeEach(() => {
    db = openDatabase(':memory:', { defaultScreenshotDir: '/tmp/shots', env: {} })
    logger = makeLogger()
  })

  afterEach(() => {
    db.close()
  })

  const profileInput: ProfileInput = {
    name: 'Reroll',
    engine: 'chromium',
    deviceType: 'desktop',
    devicePreset: 'windows-desktop',
    viewportWidth: 1366,
    viewportHeight: 768,
    userAgent: null,
    locale: 'en-US',
    timezone: 'America/New_York',
    proxyMode: 'sticky',
    stickySessionId: 'reroll',
    formUrlOverride: null,
    notes: '',
    proxyPool: 'residential',
    providerId: 'acme',
    target: TARGETS.state,
    stickyTtlMinutes: null,
    ephemeral: true,
  }
  const states = { states: (): LocationEntry[] => [{ kind: 'state', label: 'New Jersey (NJ)', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: null, zip: null, timezone: null }] }
  const TEXAS: Partial<IpInfo> = { region: 'Texas', city: 'Austin', postalCode: '78701' }

  function managerFor(dialect: ProviderDialect, script: Array<Partial<IpInfo> | AppException>): ReturnType<typeof createProxyManager> {
    const queue = [...script]
    const ipChecker: IpChecker = {
      lookup: async () => {
        const next = queue.shift()
        if (next === undefined) throw new Error('IP check script exhausted')
        if (next instanceof AppException) throw next
        return { ...sampleIp, ...next }
      },
    }
    const provider = new GatewayProvider({
      dialect,
      ipChecker,
      logger,
      credentials: [{ pool: 'residential', host: 'gw.example.com', port: 1, username: 'u', password: PASSWORD, sessionTemplate: null }],
    })
    return createProxyManager({ provider, sessions: db.proxySessions, profiles: db.profiles, logger, locations: states })
  }

  it('stops early when the dialect says the failure is not retryable', async () => {
    const manager = managerFor(passwordDialect, [TEXAS, new AppException('PROXY_TIMEOUT', 'timed out'), {}])
    const verification = await manager.verifyForLaunch(db.profiles.create(profileInput), { policy: 'state', attempts: 3 })
    expect(verification.attempts).toBe(2)
    expect(verification.warning).toContain('Re-rolling stopped early: the provider reported a failure another session cannot fix (PROXY_TIMEOUT).')
  })

  it('keeps re-rolling on PROXY_DEAD for a dialect that does not declare the hook', async () => {
    const { isRetryableLocationFailure: _omit, ...withoutHook } = passwordDialect
    const manager = managerFor(withoutHook, [TEXAS, new AppException('PROXY_DEAD', 'HTTP 503'), {}])
    const verification = await manager.verifyForLaunch(db.profiles.create(profileInput), { policy: 'state', attempts: 3 })
    expect(verification).toMatchObject({ attempts: 3, targetMatch: 'match', warning: null })
  })
})

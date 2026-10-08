/**
 * Selecting a proxy provider: per-profile resolution through the registry (never a silent
 * fallback), product validation, provider-named messages, the provider-neutral CLI environment
 * and the renderer's capability-driven labels.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { IpInfo, ProfileInput } from '../src/shared/types'
import { AppException } from '../src/main/contracts'
import type { Database, IpChecker, Logger, ProxyConnection } from '../src/main/contracts'
import { createProfileManager, providerProblem } from '../src/main/browser/profile-manager'
import { PROVIDER_ENV_KEYS, proxySecretEnvKeys, readProviderEnv, scrubProxySecretEnv } from '../src/main/config/env'
import type { ProviderEnvInfo } from '../src/main/config/env'
import { openDatabase } from '../src/main/database/index'
import { classifyHttpStatus, proxyAuthMessage } from '../src/main/proxy/ip-checker'
import { dataImpulseDialect } from '../src/main/proxy/providers/dataimpulse'
import type { ProviderDialect } from '../src/main/proxy/providers/dialect'
import { BUILT_IN_DIALECTS, ProviderRegistry } from '../src/main/proxy/providers/registry'
import { createProxyManager } from '../src/main/proxy/proxy-manager'
import { notConfiguredMessage, productNotConfiguredMessage } from '../src/main/proxy/targeting-text'
import { lookupFromDialects, resolveCliProxy } from '../src/main/qa/cli-proxy'
import {
  configuredProviders,
  connectionLabel,
  encodingOptionsFor,
  productLabelFor,
  providerName,
  providerProductLabel,
  proxyModeLabel,
  recordPoolLabel,
  selectableProviders,
  supportedTargetModes,
} from '../src/renderer/src/lib/providers'
import type { ProviderLike } from '../src/renderer/src/lib/providers'
import { providerFormProblem } from '../src/renderer/src/lib/profileForm'
import { providersStatusPill } from '../src/renderer/src/lib/proxyKeys'

const PASSWORD = 'Selection-Pass-1!'

const sampleIp: IpInfo = {
  ip: '203.0.113.20',
  country: 'United States',
  countryCode: 'US',
  region: 'New Jersey',
  city: 'Newark',
  postalCode: '07102',
  isp: 'ISP',
  asn: 'AS1',
  latencyMs: 50,
  provider: 'ip-api',
  checkedAt: '2026-10-09T10:00:00.000Z',
}

function makeLogger(): Logger & { secrets: string[] } {
  const secrets: string[] = []
  return {
    secrets,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    log: () => undefined,
    onEntry: () => () => undefined,
    query: () => [],
    clear: () => undefined,
    registerSecret: (value) => void secrets.push(value),
  }
}

/** A second provider with a different product set, a narrower target mode set and parameters in the password. */
const acmeDialect: ProviderDialect = {
  id: 'acme',
  displayName: 'Acme Proxies',
  docsUrl: 'https://example.com/acme/docs',
  capabilities: {
    products: [
      { key: 'isp', label: 'Static ISP' },
      { key: 'residential', label: 'Residential' },
    ],
    targetModes: ['country', 'state'],
    sticky: { supported: true, idPattern: '^[a-z0-9-]{1,32}$', idMaxLength: 32 },
    defaults: { host: 'gw.acme.example', port: 7000 },
    extraCredentialFields: [{ key: 'zone', label: 'Zone', secret: true }],
  },
  compose(credentials, request) {
    const params = [request.target ? `country-${request.target.country}` : null, request.sessionId ? `session-${request.sessionId}` : null].filter((part): part is string => part !== null)
    return {
      server: `http://${credentials.host}:${credentials.port}`,
      username: `${credentials.username}-zone-${credentials.extras?.zone ?? 'none'}`,
      password: params.length > 0 ? `${credentials.password}_${params.join('_')}` : credentials.password,
      targetingString: params.join('_'),
    }
  },
  targetingString: (request) => [request.target ? `country-${request.target.country}` : null, request.sessionId ? `session-${request.sessionId}` : null].filter(Boolean).join('_'),
  createSession: (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24) || 'default',
  rotateSession: (current) => `${current ?? 'acme'}-x`.slice(-32),
}

const NJ = { mode: 'state' as const, country: 'us', state: 'New Jersey', stateCode: 'NJ', city: null, zip: null }
const CITY = { mode: 'city' as const, country: 'us', state: 'New Jersey', stateCode: 'NJ', city: 'Newark', zip: null }

const baseProfile: ProfileInput = {
  name: 'Selection',
  engine: 'chromium',
  deviceType: 'desktop',
  devicePreset: 'windows-desktop',
  viewportWidth: 1366,
  viewportHeight: 768,
  userAgent: null,
  locale: 'en-US',
  timezone: 'America/New_York',
  proxyMode: 'sticky',
  stickySessionId: 'sel-1',
  formUrlOverride: null,
  notes: '',
  proxyPool: 'residential',
  providerId: 'dataimpulse',
  target: NJ,
  stickyTtlMinutes: null,
  ephemeral: false,
}

describe('per-profile provider resolution', () => {
  let db: Database
  let seen: ProxyConnection[]
  let registry: ProviderRegistry

  beforeEach(() => {
    db = openDatabase(':memory:', { defaultScreenshotDir: '/tmp/shots', env: {} })
    seen = []
    const ipChecker: IpChecker = {
      lookup: async (connection) => {
        if (connection) seen.push(connection)
        return sampleIp
      },
    }
    registry = new ProviderRegistry({ ipChecker, logger: makeLogger() })
    registry.register(dataImpulseDialect)
    registry.register(acmeDialect)
    registry.get('dataimpulse').setCredentials([{ pool: 'residential', host: 'gw.dataimpulse.com', port: 823, username: 'di_login', password: PASSWORD, sessionTemplate: null }], 'vault')
    registry.get('acme').setCredentials([{ pool: 'isp', host: 'gw.acme.example', port: 7000, username: 'acme_login', password: PASSWORD, sessionTemplate: null, extras: { zone: 'z1' } }], 'vault')
  })

  afterEach(() => {
    db.close()
  })

  const manager = (): ReturnType<typeof createProxyManager> => createProxyManager({ providers: registry, sessions: db.proxySessions, profiles: db.profiles, logger: makeLogger() })

  it("builds each profile's connection through the provider it names", () => {
    const di = db.profiles.create(baseProfile)
    const acme = db.profiles.create({ ...baseProfile, name: 'Acme', providerId: 'acme', proxyPool: 'isp' })
    expect(manager().resolveForProfile(di)).toMatchObject({ server: 'http://gw.dataimpulse.com:823', username: 'di_login__cr.us;state.newjersey;sessid.sel-1', password: PASSWORD })
    expect(manager().resolveForProfile(acme)).toMatchObject({ server: 'http://gw.acme.example:7000', username: 'acme_login-zone-z1', password: `${PASSWORD}_country-us_session-sel-1`, pool: 'isp' })
  })

  it('records the provider on the proxy session and lists every provider without credentials', async () => {
    const acme = db.profiles.create({ ...baseProfile, name: 'Acme', providerId: 'acme', proxyPool: 'isp' })
    await manager().testConnection(acme)
    expect(seen.at(-1)).toMatchObject({ server: 'http://gw.acme.example:7000' })
    expect(db.proxySessions.getByProfile(acme.id)).toMatchObject({ provider: 'acme', pool: 'isp', status: 'working' })

    const providers = manager().providers()
    expect(providers.map((p) => [p.id, p.displayName, p.status.configured])).toEqual([
      ['dataimpulse', 'DataImpulse', true],
      ['acme', 'Acme Proxies', true],
    ])
    expect(providers[0]?.sessionTemplate).toBe('{username}{sep}sessid.{session}')
    expect(providers[1]?.sessionTemplate).toBeNull()
    expect(providers[1]?.status.pools.map((p) => [p.pool, p.configured])).toEqual([
      ['isp', true],
      ['residential', false],
    ])
    const text = JSON.stringify(providers)
    for (const secret of [PASSWORD, 'acme_login', 'di_login', 'z1']) expect(text).not.toContain(secret)
    expect(manager().getConfigStatus('acme')).toMatchObject({ provider: 'acme', usernameMasked: 'ac****in' })
    expect(manager().getConfigStatus()).toMatchObject({ provider: 'dataimpulse' })
  })

  it('fails with INVALID_INPUT naming an unknown provider (no silent switch), at every entry point', async () => {
    const stored = db.profiles.create({ ...baseProfile, providerId: 'brightdata' })
    const m = manager()
    const expectation = { code: 'INVALID_INPUT', message: expect.stringContaining('"brightdata"') }
    expect(() => m.resolveForProfile(stored)).toThrowError(AppException)
    expect(() => m.resolveForProfile(stored)).toThrowError(/uses the proxy provider "brightdata", which this version does not support/)
    await expect(m.testConnection(stored)).rejects.toMatchObject(expectation)
    await expect(m.verifyForLaunch(stored, { policy: 'state', attempts: 3 })).rejects.toMatchObject(expectation)
    await expect(m.rotateSession(stored)).rejects.toMatchObject(expectation)
    await expect(m.getCurrentIp(stored)).rejects.toMatchObject(expectation)
    expect(seen).toEqual([])
    // The stored profile itself is untouched.
    expect(db.profiles.get(stored.id)?.providerId).toBe('brightdata')
  })

  it("fails with PROXY_NOT_CONFIGURED using the provider's product label", async () => {
    const m = manager()
    const notSetUp = db.profiles.create({ ...baseProfile, name: 'Acme residential', providerId: 'acme', proxyPool: 'residential' })
    await expect(m.testConnection(notSetUp)).rejects.toMatchObject({
      code: 'PROXY_NOT_CONFIGURED',
      message: 'Acme Proxies Residential credentials are not configured. Add them under Settings → Advanced → Proxy keys.',
    })
    const notOffered = db.profiles.create({ ...baseProfile, name: 'Acme mobile', providerId: 'acme', proxyPool: 'mobile' })
    await expect(m.verifyForLaunch(notOffered, { policy: 'off', attempts: 1 })).rejects.toMatchObject({
      code: 'PROXY_NOT_CONFIGURED',
      message: expect.stringMatching(/^Acme Proxies does not offer a "mobile" product \(available: Static ISP, Residential\)/),
    })
    registry.get('acme').setCredentials([], 'none')
    await expect(m.testConnection(notSetUp)).rejects.toMatchObject({ code: 'PROXY_NOT_CONFIGURED', message: notConfiguredMessage('Acme Proxies') })
    // Raw gateway tests name their provider and product.
    await expect(m.testConnection(null, 'isp', 'acme')).rejects.toMatchObject({ code: 'PROXY_NOT_CONFIGURED' })
    expect(await m.testConnection(null, 'residential', 'dataimpulse')).toMatchObject({ status: 'working' })
    await expect(m.testConnection(null, 'residential', 'brightdata')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('names the provider when the gateway rejects the login (HTTP 407)', async () => {
    const rejecting = new ProviderRegistry({
      ipChecker: { lookup: async () => Promise.reject(classifyHttpStatus(407, true, 'ip-api')) },
      logger: makeLogger(),
    })
    const acme = rejecting.register(acmeDialect)
    acme.setCredentials([{ pool: 'isp', host: 'gw.acme.example', port: 7000, username: 'acme_login', password: PASSWORD, sessionTemplate: null }], 'vault')
    const result = await acme.testConnection({ pool: 'isp', sessionId: null, target: null, ttlMinutes: null })
    expect(result.error).toMatchObject({ code: 'PROXY_AUTH_FAILED', message: proxyAuthMessage('Acme Proxies') })
    expect(result.error?.message).toContain('Acme Proxies username and password')
    expect(proxyAuthMessage()).not.toMatch(/DataImpulse/)
    expect(classifyHttpStatus(407, true, 'ip-api')?.message).not.toMatch(/DataImpulse/)
  })
})

describe('profile validation against provider capabilities', () => {
  const registry = new ProviderRegistry({ ipChecker: { lookup: async () => sampleIp }, logger: makeLogger() })
  registry.register(dataImpulseDialect)
  registry.register(acmeDialect)

  it('accepts what the provider offers and names what it does not', () => {
    expect(providerProblem(baseProfile, registry)).toBeNull()
    expect(providerProblem({ ...baseProfile, proxyMode: 'none', providerId: 'nobody', proxyPool: 'x' }, registry)).toBeNull()
    expect(providerProblem({ ...baseProfile, providerId: 'nobody' }, registry)).toMatch(/^providerId: the proxy provider "nobody" is not supported by this version \(available: dataimpulse, acme\)/)
    expect(providerProblem({ ...baseProfile, providerId: 'acme', proxyPool: 'mobile' }, registry)).toMatch(/^proxyPool: Acme Proxies does not offer a "mobile" product/)
    expect(providerProblem({ ...baseProfile, providerId: 'acme', proxyPool: 'isp', target: CITY }, registry)).toMatch(/^target: Acme Proxies does not support city targeting/)
  })

  it('is enforced by the profile manager on create and update', () => {
    const db = openDatabase(':memory:', { defaultScreenshotDir: '/tmp/shots', env: {} })
    try {
      const profiles = createProfileManager({ repo: db.profiles, logger: makeLogger(), providers: registry })
      const created = profiles.create({ ...baseProfile, providerId: 'acme', proxyPool: 'isp' })
      expect(created).toMatchObject({ providerId: 'acme', proxyPool: 'isp' })
      expect(() => profiles.create({ ...baseProfile, providerId: 'brightdata' })).toThrowError(/"brightdata" is not supported/)
      expect(() => profiles.update(created.id, { ...baseProfile, providerId: 'acme', proxyPool: 'mobile' })).toThrowError(/does not offer a "mobile" product/)
      // Legacy input (no providerId, legacy mode) is a DataImpulse profile.
      const { providerId: _omit, ...legacy } = baseProfile
      expect(profiles.create({ ...legacy, name: 'Legacy', proxyMode: 'dataimpulse-rotating' })).toMatchObject({ providerId: 'dataimpulse', proxyMode: 'rotating' })
    } finally {
      db.close()
    }
  })
})

describe('provider-neutral proxy environment (QA CLI, development .env)', () => {
  const lookup = lookupFromDialects([...BUILT_IN_DIALECTS, acmeDialect])
  const info = (id: string): ProviderEnvInfo | null =>
    lookup.has(id)
      ? {
          defaults: lookup.get(id).capabilities.defaults,
          extraFieldKeys: lookup.get(id).capabilities.extraCredentialFields.map((field) => field.key),
          productKeys: lookup.get(id).capabilities.products.map((product) => product.key),
        }
      : null

  it('reads QA_PROVIDER* with the provider defaults for host and port and maps QA_PROVIDER_EXTRA_<KEY>', () => {
    const env = { QA_PROVIDER: 'acme', QA_PROVIDER_PRODUCT: 'isp', QA_PROVIDER_USERNAME: ' acme_user ', QA_PROVIDER_PASSWORD: PASSWORD, QA_PROVIDER_EXTRA_ZONE: 'zone-7', QA_PROVIDER_EXTRA_COLOR: 'blue' }
    const read = readProviderEnv(env, info)
    expect(read).toMatchObject({
      source: 'QA_PROVIDER',
      missing: [],
      config: { providerId: 'acme', product: 'isp', host: 'gw.acme.example', port: 7000, username: 'acme_user', password: PASSWORD, extras: { zone: 'zone-7' } },
    })
    expect(read.warnings).toEqual(['QA_PROVIDER_EXTRA_COLOR is ignored: the provider declares no "color" credential field.'])
    expect(readProviderEnv({ ...env, QA_PROVIDER_HOST: 'other.example', QA_PROVIDER_PORT: '9000' }, info).config).toMatchObject({ host: 'other.example', port: 9000 })
  })

  it('reports invalid or missing variables by name only', () => {
    const bad = readProviderEnv({ QA_PROVIDER: 'nobody', QA_PROVIDER_USERNAME: 'u', QA_PROVIDER_PASSWORD: PASSWORD }, info)
    expect(bad).toMatchObject({ config: null, source: 'QA_PROVIDER', missing: ['QA_PROVIDER'] })
    expect(readProviderEnv({ QA_PROVIDER: 'acme', QA_PROVIDER_PRODUCT: 'mobile', QA_PROVIDER_PORT: 'abc' }, info).missing).toEqual([
      'QA_PROVIDER_PRODUCT',
      'QA_PROVIDER_PORT',
      'QA_PROVIDER_USERNAME',
      'QA_PROVIDER_PASSWORD',
    ])
    expect(JSON.stringify(bad)).not.toContain(PASSWORD)
  })

  it('keeps DATAIMPULSE_PROXY_* as an alias of QA_PROVIDER=dataimpulse; QA_PROVIDER* wins when both are set', () => {
    const legacy = { DATAIMPULSE_PROXY_HOST: 'gw.dataimpulse.com', DATAIMPULSE_PROXY_PORT: '823', DATAIMPULSE_PROXY_USERNAME: 'di_user', DATAIMPULSE_PROXY_PASSWORD: PASSWORD }
    expect(readProviderEnv(legacy, info)).toMatchObject({ source: 'DATAIMPULSE_PROXY', config: { providerId: 'dataimpulse', product: null, host: 'gw.dataimpulse.com', port: 823, username: 'di_user', extras: {} } })
    expect(readProviderEnv({ DATAIMPULSE_PROXY_USERNAME: 'only' }, info)).toMatchObject({ config: null, source: null, missing: ['DATAIMPULSE_PROXY_HOST', 'DATAIMPULSE_PROXY_PORT', 'DATAIMPULSE_PROXY_PASSWORD'] })
    expect(readProviderEnv({}, info)).toEqual({ config: null, missing: [], source: null, warnings: [] })
    const both = readProviderEnv({ ...legacy, QA_PROVIDER: 'acme', QA_PROVIDER_USERNAME: 'a', QA_PROVIDER_PASSWORD: 'b' }, info)
    expect(both.config?.providerId).toBe('acme')
    expect(both.warnings[0]).toMatch(/DATAIMPULSE_PROXY_\* variables are ignored/)
  })

  it('resolves the CLI credentials and product from the environment and the manifest', () => {
    const legacy = { DATAIMPULSE_PROXY_HOST: 'gw.dataimpulse.com', DATAIMPULSE_PROXY_PORT: '823', DATAIMPULSE_PROXY_USERNAME: 'di_user', DATAIMPULSE_PROXY_PASSWORD: PASSWORD }
    const mobileProfile = { proxyMode: 'rotating' as const, proxyPool: 'mobile' }
    // v1.3.0 manifests carry no providerId: they are DataImpulse manifests, and the product follows the first proxied profile.
    expect(resolveCliProxy(legacy, lookup, [{ proxyMode: 'none', proxyPool: 'residential' }, mobileProfile])).toMatchObject({
      providerId: 'dataimpulse',
      source: 'DATAIMPULSE_PROXY',
      credentials: { pool: 'mobile', host: 'gw.dataimpulse.com', port: 823, username: 'di_user', password: PASSWORD, sessionTemplate: null, extras: {} },
    })
    const acme = resolveCliProxy({ QA_PROVIDER: 'acme', QA_PROVIDER_USERNAME: 'acme_user', QA_PROVIDER_PASSWORD: PASSWORD, QA_PROVIDER_EXTRA_zone: 'zone-secret' }, lookup, [
      { proxyMode: 'sticky', proxyPool: 'isp', providerId: 'acme' },
    ])
    expect(acme).toMatchObject({ providerId: 'acme', credentials: { pool: 'isp', extras: { zone: 'zone-secret' } } })
    expect(acme.secrets).toEqual(expect.arrayContaining([PASSWORD, 'acme_user', `acme_user:${PASSWORD}`, 'zone-secret']))
    // QA_PROVIDER_PRODUCT wins over the manifest; no credentials → nothing configured, provider from the manifest.
    expect(resolveCliProxy({ QA_PROVIDER: 'acme', QA_PROVIDER_PRODUCT: 'residential', QA_PROVIDER_USERNAME: 'u', QA_PROVIDER_PASSWORD: 'p' }, lookup, [{ proxyMode: 'sticky', proxyPool: 'isp', providerId: 'acme' }]).credentials?.pool).toBe('residential')
    expect(resolveCliProxy({}, lookup, [{ proxyMode: 'sticky', proxyPool: 'isp', providerId: 'acme' }])).toMatchObject({ providerId: 'acme', credentials: null, secrets: [] })
  })

  it('refuses incomplete QA_PROVIDER variables and a manifest that names another provider', () => {
    expect(() => resolveCliProxy({ QA_PROVIDER: 'acme', QA_PROVIDER_PASSWORD: PASSWORD }, lookup, [])).toThrowError(/^Proxy variables are incomplete or invalid: QA_PROVIDER_USERNAME\./)
    const legacy = { DATAIMPULSE_PROXY_HOST: 'gw.dataimpulse.com', DATAIMPULSE_PROXY_PORT: '823', DATAIMPULSE_PROXY_USERNAME: 'di_user', DATAIMPULSE_PROXY_PASSWORD: PASSWORD }
    expect(() => resolveCliProxy(legacy, lookup, [{ proxyMode: 'sticky', proxyPool: 'isp', providerId: 'acme' }])).toThrowError(/uses the proxy provider "acme", but the proxy credentials are for "dataimpulse"/)
    try {
      resolveCliProxy({ QA_PROVIDER: 'acme', QA_PROVIDER_PASSWORD: PASSWORD }, lookup, [])
    } catch (err) {
      expect(String(err)).not.toContain(PASSWORD)
    }
  })

  it('removes every proxy secret variable before anything is launched', () => {
    const env: NodeJS.ProcessEnv = {
      DATAIMPULSE_PROXY_USERNAME: 'a',
      DATAIMPULSE_PROXY_PASSWORD: 'b',
      DATAIMPULSE_PROXY_HOST: 'gw',
      QA_PROVIDER: 'acme',
      QA_PROVIDER_USERNAME: 'c',
      QA_PROVIDER_PASSWORD: 'd',
      QA_PROVIDER_EXTRA_ZONE: 'e',
      PATH: '/usr/bin',
    }
    expect(proxySecretEnvKeys(env).sort()).toEqual(['DATAIMPULSE_PROXY_PASSWORD', 'DATAIMPULSE_PROXY_USERNAME', 'QA_PROVIDER_EXTRA_ZONE', 'QA_PROVIDER_PASSWORD', 'QA_PROVIDER_USERNAME'])
    scrubProxySecretEnv(env)
    expect(env).toEqual({ DATAIMPULSE_PROXY_HOST: 'gw', QA_PROVIDER: 'acme', PATH: '/usr/bin' })
    expect(PROVIDER_ENV_KEYS.extraPrefix).toBe('QA_PROVIDER_EXTRA_')
  })
})

describe('neutral messages', () => {
  it('name the provider and its product label instead of a fixed provider', () => {
    expect(notConfiguredMessage('Acme Proxies')).toBe(
      'Proxy credentials are not configured. Enter and save your Acme Proxies credentials in the app (first-run setup or Settings) to use the proxy modes.',
    )
    expect(productNotConfiguredMessage(acmeDialect, 'isp')).toBe('Acme Proxies Static ISP credentials are not configured. Add them under Settings → Advanced → Proxy keys.')
    expect(productNotConfiguredMessage(dataImpulseDialect, 'mobile')).toBe('DataImpulse Mobile credentials are not configured. Add them under Settings → Advanced → Proxy keys.')
  })
})

describe('renderer provider presentation', () => {
  const status = (configured: string[]): ProviderLike['status'] => ({ configured: configured.length > 0, pools: ['isp', 'residential'].map((pool) => ({ pool, configured: configured.includes(pool), host: null, port: null, usernameMasked: null, source: 'vault' as const })) })
  const dataimpulse: ProviderLike = { id: 'dataimpulse', displayName: 'DataImpulse', capabilities: dataImpulseDialect.capabilities, status: status(['residential']) }
  const acme: ProviderLike = { id: 'acme', displayName: 'Acme Proxies', capabilities: acmeDialect.capabilities, status: status([]) }

  it('labels products, connections and modes from capabilities', () => {
    expect(providerName([dataimpulse], 'dataimpulse')).toBe('DataImpulse')
    expect(providerName([dataimpulse], 'brightdata')).toBe('brightdata')
    expect(productLabelFor(acme, 'isp')).toBe('Static ISP')
    expect(productLabelFor(null, 'isp-static')).toBe('Isp static')
    expect(providerProductLabel(dataimpulse, 'mobile')).toBe('DataImpulse Mobile')
    expect(connectionLabel([dataimpulse, acme], 'acme', 'isp')).toBe('Acme Proxies · Static ISP')
    expect(connectionLabel([dataimpulse], null, 'residential')).toBe('DataImpulse · Residential')
    expect(connectionLabel([dataimpulse], 'dataimpulse', null)).toBe('Direct (no proxy)')
    // Tables stay as they were while one provider is registered.
    expect(recordPoolLabel([dataimpulse], 'dataimpulse', 'residential')).toBe('Residential')
    expect(recordPoolLabel([dataimpulse, acme], 'acme', 'isp')).toBe('Acme Proxies · Static ISP')
    expect(recordPoolLabel([dataimpulse], null, null)).toBe('Direct (no proxy)')
    expect(proxyModeLabel('sticky', 'DataImpulse')).toBe('DataImpulse · sticky')
    expect(proxyModeLabel('none', 'DataImpulse')).toBe('Direct (no proxy)')
    expect(encodingOptionsFor(dataimpulse)).toEqual([
      { value: 'remove-spaces', label: 'Remove spaces (DataImpulse default)' },
      { value: 'underscore', label: 'Replace spaces with underscores' },
      { value: 'keep', label: 'Keep spaces' },
    ])
    expect(encodingOptionsFor(acme)).toEqual([])
  })

  it('offers only providers with keys (plus the current one) and their target modes', () => {
    expect(configuredProviders([dataimpulse, acme]).map((p) => p.id)).toEqual(['dataimpulse'])
    expect(selectableProviders([dataimpulse, acme]).map((p) => p.id)).toEqual(['dataimpulse'])
    expect(selectableProviders([dataimpulse, acme], 'acme').map((p) => p.id)).toEqual(['dataimpulse', 'acme'])
    expect(selectableProviders([acme]).map((p) => p.id)).toEqual(['acme'])
    expect(supportedTargetModes(acme, ['country', 'state', 'city', 'zip'])).toEqual(['country', 'state'])
    expect(supportedTargetModes(null, ['country', 'state', 'city', 'zip'])).toEqual(['country', 'state', 'city', 'zip'])
    // The sidebar pill is ready when any provider has keys.
    expect(providersStatusPill(null).label).toBe('Proxy …')
    expect(providersStatusPill([acme]).label).toBe('Proxy not set')
    expect(providersStatusPill([acme, dataimpulse]).label).toBe('Proxy ready')
  })

  it('flags a profile form the provider cannot serve', () => {
    const form = { proxyMode: 'sticky' as const, proxyPool: 'isp', target: CITY, targetMode: 'city' as const }
    expect(providerFormProblem(form, acme)).toEqual({ field: 'target', message: 'Acme Proxies does not support targeting by city.' })
    expect(providerFormProblem({ ...form, proxyPool: 'mobile' }, acme)?.field).toBe('proxyPool')
    expect(providerFormProblem({ ...form, target: NJ, targetMode: 'state' }, acme)).toBeNull()
    expect(providerFormProblem({ ...form, target: NJ, targetMode: 'state' }, { ...acme, capabilities: { ...acme.capabilities, sticky: { ...acme.capabilities.sticky, supported: false } } })?.field).toBe('proxyMode')
  })
})

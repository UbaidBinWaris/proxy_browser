/**
 * Golden tables for the community-verified dialects (Bright Data, Oxylabs, Decodo, IPRoyal).
 *
 * Every expected username/password below is copied from the provider's official documentation
 * (fetched 2026-10-09), with the docs' own placeholders (USERNAME, <customer_id>, password321…)
 * replaced by obvious example values. Rows marked "derived" apply a documented rule to an app
 * target instead of reproducing a literal example.
 *
 *   Bright Data  https://docs.brightdata.com/proxy-networks/config-options
 *                https://docs.brightdata.com/api-reference/proxy/geolocation-targeting
 *                https://docs.brightdata.com/api-reference/proxy/rotate_ips
 *   Oxylabs      https://developers.oxylabs.io/products/proxies/residential-proxies
 *                https://developers.oxylabs.io/products/proxies/residential-proxies/location-settings
 *                https://developers.oxylabs.io/products/proxies/residential-proxies/session-control
 *   Decodo       https://help.decodo.com/docs/residential-proxy-advanced-parameters
 *                https://help.decodo.com/docs/residential-proxy-user-pass-requests
 *                https://help.decodo.com/docs/residential-proxy-custom-sticky-sessions
 *   IPRoyal      https://docs.iproyal.com/proxies/residential/proxy
 *                https://docs.iproyal.com/proxies/residential/proxy/location
 *                https://docs.iproyal.com/proxies/residential/proxy/rotation
 */
import { describe, expect, it } from 'vitest'
import type { GeoTarget, IpInfo } from '../src/shared/types'
import { AppException } from '../src/main/contracts'
import type { Logger, ProxyRequest } from '../src/main/contracts'
import { brightDataDialect } from '../src/main/proxy/providers/brightdata'
import { dataImpulseDialect } from '../src/main/proxy/providers/dataimpulse'
import { decodoDialect } from '../src/main/proxy/providers/decodo'
import type { ProviderCredentials, ProviderDialect } from '../src/main/proxy/providers/dialect'
import { createAlphanumericSession, hashBase36, placeWords, rotateAlphanumericSession, rotateFixedLengthSession, toAlphanumericSession, toFixedLengthSession } from '../src/main/proxy/providers/dialect-helpers'
import { GatewayProvider } from '../src/main/proxy/providers/gateway-provider'
import { ipRoyalDialect } from '../src/main/proxy/providers/iproyal'
import { OXYLABS_US_STATES, oxylabsDialect } from '../src/main/proxy/providers/oxylabs'
import { BUILT_IN_DIALECTS } from '../src/main/proxy/providers/registry'
import { COMMUNITY_VERIFIED_NOTE, providerOptionLabel, providerVerificationNote } from '../src/renderer/src/lib/providers'

const PASSWORD = 'password321'

const req = (overrides: Partial<ProxyRequest> = {}): ProxyRequest => ({ pool: 'residential', sessionId: null, target: null, ttlMinutes: null, ...overrides })

const country = (code: string): GeoTarget => ({ mode: 'country', country: code, state: null, stateCode: null, city: null, zip: null })
const state = (name: string, code: string, countryCode = 'us'): GeoTarget => ({ mode: 'state', country: countryCode, state: name, stateCode: code, city: null, zip: null })
const city = (name: string, countryCode = 'us', stateName: string | null = null, stateCode: string | null = null): GeoTarget => ({
  mode: 'city',
  country: countryCode,
  state: stateName,
  stateCode,
  city: name,
  zip: null,
})
const zip = (code: string, cityName: string | null, stateName: string | null = null, stateCode: string | null = null): GeoTarget => ({
  mode: 'zip',
  country: 'us',
  state: stateName,
  stateCode,
  city: cityName,
  zip: code,
})

function creds(dialect: ProviderDialect, username: string): ProviderCredentials {
  return { pool: 'residential', host: dialect.capabilities.defaults.host, port: dialect.capabilities.defaults.port, username, password: PASSWORD, sessionTemplate: null }
}

function expectInvalidInput(fn: () => unknown, message: RegExp): void {
  let thrown: unknown
  try {
    fn()
  } catch (err) {
    thrown = err
  }
  expect(thrown).toBeInstanceOf(AppException)
  expect((thrown as AppException).code).toBe('INVALID_INPUT')
  expect((thrown as AppException).message).toMatch(message)
}

// ---------------------------------------------------------------------------
// Bright Data
// ---------------------------------------------------------------------------

describe('brightDataDialect (golden, docs.brightdata.com)', () => {
  const LOGIN = 'brd-customer-EXAMPLE-zone-EXAMPLE'

  it.each([
    ['rotating, no parameters', req(), LOGIN],
    ['country: -country-us', req({ target: country('us') }), `${LOGIN}-country-us`],
    ['state: -country-us-state-ny', req({ target: state('New York', 'NY') }), `${LOGIN}-country-us-state-ny`],
    ['city: -country-us-city-sanfrancisco', req({ target: city('San Francisco') }), `${LOGIN}-country-us-city-sanfrancisco`],
    ['city keeps the documented country + city form even with a state (derived)', req({ target: city('San Francisco', 'us', 'California', 'CA') }), `${LOGIN}-country-us-city-sanfrancisco`],
    ['zip: -city-memphis-zip-37501', req({ target: zip('37501', 'Memphis', 'Tennessee', 'TN') }), `${LOGIN}-city-memphis-zip-37501`],
    ['zip without a city (derived)', req({ target: zip('37501', null) }), `${LOGIN}-zip-37501`],
    ['session: -session-mystring12345', req({ sessionId: 'mystring12345' }), `${LOGIN}-session-mystring12345`],
    ['state + session, TTL ignored (no lifetime parameter)', req({ target: state('New Jersey', 'NJ'), sessionId: 'abc123', ttlMinutes: 60 }), `${LOGIN}-country-us-state-nj-session-abc123`],
  ])('%s', (_label, request, username) => {
    const composed = brightDataDialect.compose(creds(brightDataDialect, LOGIN), request)
    expect(composed).toEqual({ server: 'http://brd.superproxy.io:44445', username, password: PASSWORD, targetingString: username.slice(LOGIN.length + 1) })
    expect(brightDataDialect.targetingString(request)).toBe(composed.targetingString)
  })

  it('maps session ids with special characters to alphanumerics ("special characters like - or * will result in errors")', () => {
    const a = brightDataDialect.compose(creds(brightDataDialect, LOGIN), req({ sessionId: 'qa-1' })).username
    const b = brightDataDialect.compose(creds(brightDataDialect, LOGIN), req({ sessionId: 'qa1' })).username
    expect(a).toMatch(/-session-qa1[a-z0-9]{6}$/)
    expect(b).toBe(`${LOGIN}-session-qa1`)
    expect(a).not.toBe(b)
  })

  it('refuses state targeting without a state code or outside the US', () => {
    expectInvalidInput(() => brightDataDialect.targetingString(req({ target: { ...state('New York', 'NY'), stateCode: null } })), /state code/)
    expectInvalidInput(() => brightDataDialect.targetingString(req({ target: state('England', 'EN', 'gb') })), /United States only/)
  })

  it('declares its capabilities', () => {
    expect(brightDataDialect.capabilities).toMatchObject({
      products: [{ key: 'residential', label: 'Residential' }],
      targetModes: ['country', 'state', 'city', 'zip'],
      sticky: { supported: true, idPattern: '^[a-zA-Z0-9]{1,32}$', idMaxLength: 32 },
      defaults: { host: 'brd.superproxy.io', port: 44445 },
      extraCredentialFields: [],
      verification: 'community',
    })
    expect(brightDataDialect.capabilities.sticky.ttlMinutes).toBeUndefined()
    expect(brightDataDialect.capabilities.targetingBillingNote).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Oxylabs
// ---------------------------------------------------------------------------

describe('oxylabsDialect (golden, developers.oxylabs.io)', () => {
  it.each([
    ['basic query: customer-USERNAME', 'customer-USERNAME', req(), 'customer-USERNAME'],
    ['the mandatory customer- prefix is added (derived)', 'USERNAME', req(), 'customer-USERNAME'],
    ['country: customer-USERNAME-cc-US', 'customer-USERNAME', req({ target: country('us') }), 'customer-USERNAME-cc-US'],
    ['country: customer-USERNAME-cc-DE', 'customer-USERNAME', req({ target: country('de') }), 'customer-USERNAME-cc-DE'],
    ['state: customer-USERNAME-st-us_california', 'customer-USERNAME', req({ target: state('California', 'CA') }), 'customer-USERNAME-st-us_california'],
    ['multi-word state from the state list: us_new_jersey', 'customer-USERNAME', req({ target: state('New Jersey', 'NJ') }), 'customer-USERNAME-st-us_new_jersey'],
    ['city: customer-USERNAME-cc-US-city-los_angeles', 'customer-USERNAME', req({ target: city('Los Angeles', 'us', 'California', 'CA') }), 'customer-USERNAME-cc-US-city-los_angeles'],
    ['city: customer-USERNAME-cc-US-city-new_york', 'customer-USERNAME', req({ target: city('New York') }), 'customer-USERNAME-cc-US-city-new_york'],
    ['zip: customer-USERNAME-cc-US-postalcode-90210', 'customer-USERNAME', req({ target: zip('90210', 'Beverly Hills', 'California', 'CA') }), 'customer-USERNAME-cc-US-postalcode-90210'],
    ['sticky: customer-USERNAME-cc-DE-sessid-abcd1234', 'customer-USERNAME', req({ target: country('de'), sessionId: 'abcd1234' }), 'customer-USERNAME-cc-DE-sessid-abcd1234'],
    ['sticky + TTL: customer-USERNAME-cc-DE-sessid-abcd1234-sesstime-30', 'customer-USERNAME', req({ target: country('de'), sessionId: 'abcd1234', ttlMinutes: 30 }), 'customer-USERNAME-cc-DE-sessid-abcd1234-sesstime-30'],
    ['sticky + TTL: ...-sesstime-7', 'customer-USERNAME', req({ target: country('de'), sessionId: 'abcd1234', ttlMinutes: 7 }), 'customer-USERNAME-cc-DE-sessid-abcd1234-sesstime-7'],
    ['TTL above "up to 1440" is clamped (derived)', 'customer-USERNAME', req({ sessionId: 'abcd1234', ttlMinutes: 5000 }), 'customer-USERNAME-sessid-abcd1234-sesstime-1440'],
  ])('%s', (_label, login, request, username) => {
    const composed = oxylabsDialect.compose(creds(oxylabsDialect, login), request)
    expect(composed).toMatchObject({ server: 'http://pr.oxylabs.io:7777', username, password: PASSWORD })
    expect(oxylabsDialect.targetingString(request)).toBe(composed.targetingString)
  })

  it.each([
    ["Coeur d'Alene", 'coeur_dalene'],
    ['St. Louis', 'st_louis'],
    ['Winston-Salem', 'winston_salem'],
    ["'Ewa Beach", 'ewa_beach'],
  ])('city %s matches the official city list value %s', (name, value) => {
    expect(oxylabsDialect.targetingString(req({ target: city(name) }))).toBe(`cc-US-city-${value}`)
  })

  it('carries the published 50-state list and refuses states outside it (District of Columbia)', () => {
    expect(OXYLABS_US_STATES.size).toBe(50)
    expect(OXYLABS_US_STATES.has('us_district_of_columbia')).toBe(false)
    expectInvalidInput(() => oxylabsDialect.targetingString(req({ target: state('District of Columbia', 'DC') })), /does not list "District of Columbia"/)
  })

  it('declares its capabilities', () => {
    expect(oxylabsDialect.capabilities).toMatchObject({
      products: [{ key: 'residential', label: 'Residential' }],
      targetModes: ['country', 'state', 'city', 'zip'],
      sticky: { supported: true, ttlMinutes: { min: 1, max: 1440 }, idPattern: '^[a-zA-Z0-9]{1,32}$', idMaxLength: 32 },
      defaults: { host: 'pr.oxylabs.io', port: 7777 },
      extraCredentialFields: [],
      verification: 'community',
    })
  })
})

// ---------------------------------------------------------------------------
// Decodo
// ---------------------------------------------------------------------------

describe('decodoDialect (golden, help.decodo.com)', () => {
  it.each([
    ['rotating, random location: user-username', req(), 'user-username'],
    ['country: user-username-country-it', req({ target: country('it') }), 'user-username-country-it'],
    ['country + session: user-username-country-pt-session-randomstring123', req({ target: country('pt'), sessionId: 'randomstring123' }), 'user-username-country-pt-session-randomstring123'],
    ['city + session: user-username-country-us-city-new_york-session-randomstring123', req({ target: city('New York'), sessionId: 'randomstring123' }), 'user-username-country-us-city-new_york-session-randomstring123'],
    ['state: user-username-country-us-state-us_california', req({ target: state('California', 'CA') }), 'user-username-country-us-state-us_california'],
    ['state: user-username-country-us-state-us_new_york', req({ target: state('New York', 'NY') }), 'user-username-country-us-state-us_new_york'],
    ['state: us_rhode_island', req({ target: state('Rhode Island', 'RI') }), 'user-username-country-us-state-us_rhode_island'],
    [
      'state + city + session + duration: user-username-country-us-state-us_texas-city-austin-session-randomstring123-sessionduration-30',
      req({ target: city('Austin', 'us', 'Texas', 'TX'), sessionId: 'randomstring123', ttlMinutes: 30 }),
      'user-username-country-us-state-us_texas-city-austin-session-randomstring123-sessionduration-30',
    ],
    [
      'zip + session + duration: user-username-country-us-zip-10001-session-randomstring123-sessionduration-30',
      req({ target: zip('10001', 'New York', 'New York', 'NY'), sessionId: 'randomstring123', ttlMinutes: 30 }),
      'user-username-country-us-zip-10001-session-randomstring123-sessionduration-30',
    ],
    ['session + duration: user-username-session-example1-sessionduration-90', req({ sessionId: 'example1', ttlMinutes: 90 }), 'user-username-session-example1-sessionduration-90'],
  ])('%s', (_label, request, username) => {
    const composed = decodoDialect.compose(creds(decodoDialect, 'username'), request)
    expect(composed).toMatchObject({ server: 'http://gate.decodo.com:7000', username, password: PASSWORD })
    expect(decodoDialect.targetingString(request)).toBe(composed.targetingString)
  })

  it('keeps a saved username that already starts with user-', () => {
    expect(decodoDialect.compose(creds(decodoDialect, 'user-username'), req({ target: country('it') })).username).toBe('user-username-country-it')
  })

  it('declares its capabilities', () => {
    expect(decodoDialect.capabilities).toMatchObject({
      products: [{ key: 'residential', label: 'Residential' }],
      targetModes: ['country', 'state', 'city', 'zip'],
      sticky: { supported: true, ttlMinutes: { min: 1, max: 1440 }, idPattern: '^[a-zA-Z0-9]{1,32}$', idMaxLength: 32 },
      defaults: { host: 'gate.decodo.com', port: 7000 },
      extraCredentialFields: [],
      verification: 'community',
    })
  })
})

// ---------------------------------------------------------------------------
// IPRoyal (parameters in the password)
// ---------------------------------------------------------------------------

describe('ipRoyalDialect (golden, docs.iproyal.com)', () => {
  it.each([
    ['rotating ("you don\'t need to add anything")', req(), PASSWORD],
    ['city: password321_country-de_city-berlin', req({ target: city('Berlin', 'de') }), 'password321_country-de_city-berlin'],
    ['state: password321_country-us_state-iowa', req({ target: state('Iowa', 'IA') }), 'password321_country-us_state-iowa'],
    ['state: password321_country-us_state-california', req({ target: state('California', 'CA') }), 'password321_country-us_state-california'],
    ['sticky: password321_country-br_session-sgn34f3e_lifetime-10m', req({ target: country('br'), sessionId: 'sgn34f3e', ttlMinutes: 10 }), 'password321_country-br_session-sgn34f3e_lifetime-10m'],
    ['sticky without location: password321_session-sgn34f3e_lifetime-30m', req({ sessionId: 'sgn34f3e', ttlMinutes: 30 }), 'password321_session-sgn34f3e_lifetime-30m'],
    ['multi-word state, concatenated like the location API codes (derived)', req({ target: state('New Jersey', 'NJ') }), 'password321_country-us_state-newjersey'],
    ['lifetime is capped at 7 days (derived)', req({ sessionId: 'sgn34f3e', ttlMinutes: 20_000 }), 'password321_session-sgn34f3e_lifetime-10080m'],
  ])('%s', (_label, request, password) => {
    const composed = ipRoyalDialect.compose(creds(ipRoyalDialect, 'username123'), request)
    expect(composed).toEqual({ server: 'http://geo.iproyal.com:12321', username: 'username123', password, targetingString: password === PASSWORD ? '' : password.slice(PASSWORD.length + 1) })
    expect(ipRoyalDialect.targetingString(request)).toBe(composed.targetingString)
  })

  it('turns any session id into "a random alphanumeric string, precisely 8 characters"', () => {
    const mapped = ipRoyalDialect.targetingString(req({ sessionId: 'profile-qa-tester-1' }))
    expect(mapped).toMatch(/^session-[a-zA-Z0-9]{8}$/)
    expect(ipRoyalDialect.targetingString(req({ sessionId: 'profile-qa-tester-1' }))).toBe(mapped)
    expect(ipRoyalDialect.targetingString(req({ sessionId: 'profile-qa-tester-2' }))).not.toBe(mapped)
    expect(ipRoyalDialect.createSession('QA Tester')).toMatch(/^[a-zA-Z0-9]{8}$/)
  })

  it('offers no ZIP targeting (undocumented) and sends a ZIP target at city level', () => {
    expect(ipRoyalDialect.capabilities.targetModes).toEqual(['country', 'state', 'city'])
    expect(ipRoyalDialect.targetingString(req({ target: zip('07102', 'Newark', 'New Jersey', 'NJ') }))).toBe('country-us_city-newark')
  })

  it('works through GatewayProvider: the composed password carries the targeting and is registered as a secret', () => {
    const secrets: string[] = []
    const entries: string[] = []
    const logger: Logger = {
      info: (_s, message, meta) => void entries.push(`${message} ${JSON.stringify(meta ?? {})}`),
      warn: (_s, message, meta) => void entries.push(`${message} ${JSON.stringify(meta ?? {})}`),
      error: (_s, message, meta) => void entries.push(`${message} ${JSON.stringify(meta ?? {})}`),
      log: (_l, _s, message, meta) => void entries.push(`${message} ${JSON.stringify(meta ?? {})}`),
      onEntry: () => () => undefined,
      query: () => [],
      clear: () => undefined,
      registerSecret: (value) => void secrets.push(value),
    }
    const ip: IpInfo = {
      ip: '203.0.113.10',
      country: 'United States',
      countryCode: 'US',
      region: 'Iowa',
      city: 'Des Moines',
      postalCode: '50309',
      isp: 'Example ISP',
      asn: 'AS64500 Example',
      latencyMs: 100,
      provider: 'ip-api',
      checkedAt: '2026-10-09T10:00:00.000Z',
    }
    const provider = new GatewayProvider({ dialect: ipRoyalDialect, ipChecker: { lookup: async () => ip }, logger, credentials: [creds(ipRoyalDialect, 'username123')], source: 'vault' })
    const connection = provider.buildProxyConfig(req({ target: state('Iowa', 'IA'), sessionId: 'sgn34f3e', ttlMinutes: 30 }))
    expect(connection).toMatchObject({
      server: 'http://geo.iproyal.com:12321',
      username: 'username123',
      password: 'password321_country-us_state-iowa_session-sgn34f3e_lifetime-30m',
      targetingString: 'country-us_state-iowa_session-sgn34f3e_lifetime-30m',
    })
    expect(secrets).toContain(PASSWORD)
    expect(secrets).toContain(connection.password)
    expect(entries.join('\n')).not.toContain(PASSWORD)
  })

  it('declares its capabilities', () => {
    expect(ipRoyalDialect.capabilities).toMatchObject({
      products: [{ key: 'residential', label: 'Residential' }],
      sticky: { supported: true, ttlMinutes: { min: 1, max: 10080 }, idPattern: '^[a-zA-Z0-9]{8}$', idMaxLength: 8 },
      defaults: { host: 'geo.iproyal.com', port: 12321 },
      extraCredentialFields: [],
      verification: 'community',
    })
  })
})

// ---------------------------------------------------------------------------
// Shared helpers and registration
// ---------------------------------------------------------------------------

describe('community dialect helpers', () => {
  it('splits place names into ASCII words, dropping apostrophes and diacritics', () => {
    expect(placeWords("Coeur d'Alene")).toEqual(['coeur', 'dalene'])
    expect(placeWords('Cañon City')).toEqual(['canon', 'city'])
    expect(placeWords('  St. Louis ')).toEqual(['st', 'louis'])
  })

  it('hashBase36 is deterministic and sized', () => {
    expect(hashBase36('abc', 8)).toBe(hashBase36('abc', 8))
    expect(hashBase36('abc', 8)).toMatch(/^[a-z0-9]{8}$/)
    expect(hashBase36('abc', 8)).not.toBe(hashBase36('abd', 8))
  })

  it('alphanumeric sessions: kept when valid, digest-suffixed otherwise, rotated with r<N>', () => {
    expect(toAlphanumericSession('abc123', 32)).toBe('abc123')
    expect(toAlphanumericSession('x'.repeat(40), 32)).toHaveLength(32)
    expect(createAlphanumericSession('QA Tester #1 (NY)', 32)).toBe('profileqatester1ny')
    expect(rotateAlphanumericSession('profileqatester1ny', 'QA Tester #1 (NY)', 32)).toBe('profileqatester1nyr2')
    expect(rotateAlphanumericSession('profileqatester1nyr2', 'QA Tester #1 (NY)', 32)).toBe('profileqatester1nyr3')
    expect(rotateAlphanumericSession('has-dash', 'Fallback', 32)).toBe('profilefallbackr2')
  })

  it('fixed-length sessions: kept when exactly the right length, rotated to a different token', () => {
    expect(toFixedLengthSession('sgn34f3e', 8)).toBe('sgn34f3e')
    expect(toFixedLengthSession('sgn34f3', 8)).toMatch(/^[a-z0-9]{8}$/)
    const next = rotateFixedLengthSession('sgn34f3e', 'P', 8)
    expect(next).toMatch(/^[a-z0-9]{8}$/)
    expect(next).not.toBe('sgn34f3e')
  })

  it('registers the community dialects after DataImpulse, which stays the only live-verified one', () => {
    expect(BUILT_IN_DIALECTS.map((d) => d.id)).toEqual(['dataimpulse', 'brightdata', 'oxylabs', 'decodo', 'iproyal'])
    expect(dataImpulseDialect.capabilities.verification).toBeUndefined()
    for (const dialect of BUILT_IN_DIALECTS.slice(1)) expect(dialect.capabilities.verification).toBe('community')
  })
})

describe('provider picker verification label', () => {
  it('labels community dialects "Community-verified (not tested with a live account)" and leaves DataImpulse plain', () => {
    expect(providerOptionLabel(brightDataDialect)).toBe('Bright Data (community-verified)')
    expect(providerOptionLabel(dataImpulseDialect)).toBe('DataImpulse')
    expect(providerOptionLabel({ displayName: 'unknown-id' })).toBe('unknown-id')
    expect(providerVerificationNote(ipRoyalDialect)).toBe(COMMUNITY_VERIFIED_NOTE)
    expect(COMMUNITY_VERIFIED_NOTE).toBe('Community-verified (not tested with a live account)')
    expect(providerVerificationNote(dataImpulseDialect)).toBeNull()
    expect(providerVerificationNote(null)).toBeNull()
  })
})

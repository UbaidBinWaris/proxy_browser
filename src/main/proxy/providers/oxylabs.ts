/**
 * Oxylabs proxy dialect (`oxylabsDialect`), Residential Proxies.
 *
 * Community-verified: written from the official documentation below and NOT
 * tested with a live Oxylabs account.
 *
 * Official documentation (fetched 2026-10-09):
 *   - https://developers.oxylabs.io/products/proxies/residential-proxies                   (entry node, query parameters)
 *   - https://developers.oxylabs.io/products/proxies/residential-proxies/location-settings (cc / st / city / postalcode)
 *   - https://developers.oxylabs.io/products/proxies/residential-proxies/session-control   (sessid / sesstime)
 *   - Supported US state list linked from the "State" section of location-settings
 *     (us_states.txt, 50 states, no District of Columbia), copied into OXYLABS_US_STATES.
 *
 * Username: `customer-USERNAME` ("customer" is a mandatory prefix; added here
 * when the saved username lacks it) followed by `-key-value` parameters:
 *
 *   country  `-cc-US`                        2-letter ISO 3166-1, case-insensitive
 *   state    `-st-us_california`             US only, `us_` prefix; multi-word names use
 *                                            underscores (`us_new_jersey`, from the state list)
 *   city     `-cc-US-city-los_angeles`       English name, underscores for spaces; requires `cc`
 *                                            (official city list: `st_louis`, `winston_salem`, `coeur_dalene`)
 *   ZIP      `-cc-US-postalcode-90210`       5-digit US ZIP; requires `cc-US`
 *   session  `-sessid-abcd1234`              "random alphanumeric string"; 10 minutes by default
 *   TTL      `-sesstime-30`                  minutes, "up to 1440"
 *
 * Gateway: `pr.oxylabs.io:7777`.
 *
 * Left out: `st` combined with `city` is only documented for Mobile Proxies, so
 * a residential city target sends `cc` + `city`; a state outside the published
 * list (District of Columbia) is refused with INVALID_INPUT. No maximum session
 * id length is documented; ids are capped at 32 characters here. No targeting
 * surcharge is documented, so no billing note.
 */
import { AppException } from '../../contracts'
import type { ProxyRequest } from '../../contracts'
import { clampTtlMinutes, createAlphanumericSession, effectiveTargetMode, gatewayServer, placeWords, requireUnitedStates, rotateAlphanumericSession, toAlphanumericSession } from './dialect-helpers'
import type { ComposedConnection, ProviderCredentials, ProviderDialect } from './dialect'

export const OXYLABS_GATEWAY = { host: 'pr.oxylabs.io', port: 7777 } as const
export const OXYLABS_SESSION_ID_MAX_LENGTH = 32
export const OXYLABS_SESSION_ID_PATTERN = /^[a-zA-Z0-9]{1,32}$/
export const OXYLABS_TTL_MINUTES = { min: 1, max: 1440 } as const
const USERNAME_PREFIX = 'customer-'
const DISPLAY_NAME = 'Oxylabs'

/** Oxylabs' published state values (us_states.txt from the location-settings page). */
export const OXYLABS_US_STATES: ReadonlySet<string> = new Set([
  'us_alabama', 'us_alaska', 'us_arizona', 'us_arkansas', 'us_california', 'us_colorado', 'us_connecticut', 'us_delaware',
  'us_florida', 'us_georgia', 'us_hawaii', 'us_idaho', 'us_illinois', 'us_indiana', 'us_iowa', 'us_kansas', 'us_kentucky',
  'us_louisiana', 'us_maine', 'us_maryland', 'us_massachusetts', 'us_michigan', 'us_minnesota', 'us_mississippi',
  'us_missouri', 'us_montana', 'us_nebraska', 'us_nevada', 'us_new_hampshire', 'us_new_jersey', 'us_new_mexico',
  'us_new_york', 'us_north_carolina', 'us_north_dakota', 'us_ohio', 'us_oklahoma', 'us_oregon', 'us_pennsylvania',
  'us_rhode_island', 'us_south_carolina', 'us_south_dakota', 'us_tennessee', 'us_texas', 'us_utah', 'us_vermont',
  'us_virginia', 'us_washington', 'us_west_virginia', 'us_wisconsin', 'us_wyoming',
])

/** "New Jersey" → "us_new_jersey"; INVALID_INPUT when Oxylabs does not list the state. */
export function encodeOxylabsState(state: string): string {
  const value = `us_${placeWords(state).join('_')}`
  if (!OXYLABS_US_STATES.has(value)) {
    throw new AppException('INVALID_INPUT', `Oxylabs does not list "${state}" as a targetable US state. Target a city or ZIP code there instead.`, `st=${value}`)
  }
  return value
}

/** "Los Angeles" → "los_angeles", "Coeur d'Alene" → "coeur_dalene". */
export function encodeOxylabsCity(city: string): string {
  return placeWords(city).join('_')
}

/** The `-`-separated parameters for a request (no login), in documented order. */
export function oxylabsParams(request: ProxyRequest): string[] {
  const params: string[] = []
  const target = request.target
  if (target) {
    const country = target.country.trim().toUpperCase()
    switch (effectiveTargetMode(target)) {
      case 'zip':
        requireUnitedStates(target, DISPLAY_NAME, 'ZIP')
        params.push('cc', country, 'postalcode', (target.zip ?? '').trim())
        break
      case 'city':
        params.push('cc', country, 'city', encodeOxylabsCity(target.city ?? ''))
        break
      case 'state':
        requireUnitedStates(target, DISPLAY_NAME, 'state')
        params.push('st', encodeOxylabsState(target.state ?? target.stateCode ?? ''))
        break
      case 'country':
        params.push('cc', country)
        break
    }
  }
  if (request.sessionId) {
    params.push('sessid', toAlphanumericSession(request.sessionId, OXYLABS_SESSION_ID_MAX_LENGTH))
    const ttl = clampTtlMinutes(request.ttlMinutes, OXYLABS_TTL_MINUTES)
    if (ttl !== null) params.push('sesstime', String(ttl))
  }
  return params
}

/** The saved username with the mandatory `customer-` prefix. */
export function oxylabsLogin(username: string): string {
  const trimmed = username.trim()
  return trimmed.startsWith(USERNAME_PREFIX) ? trimmed : `${USERNAME_PREFIX}${trimmed}`
}

export const oxylabsDialect: ProviderDialect = {
  id: 'oxylabs',
  displayName: DISPLAY_NAME,
  docsUrl: 'https://developers.oxylabs.io/products/proxies/residential-proxies/location-settings',
  capabilities: {
    products: [{ key: 'residential', label: 'Residential' }],
    targetModes: ['country', 'state', 'city', 'zip'],
    sticky: {
      supported: true,
      ttlMinutes: { min: OXYLABS_TTL_MINUTES.min, max: OXYLABS_TTL_MINUTES.max },
      idPattern: OXYLABS_SESSION_ID_PATTERN.source,
      idMaxLength: OXYLABS_SESSION_ID_MAX_LENGTH,
    },
    defaults: { host: OXYLABS_GATEWAY.host, port: OXYLABS_GATEWAY.port },
    extraCredentialFields: [],
    verification: 'community',
  },

  compose(credentials: ProviderCredentials, request: ProxyRequest): ComposedConnection {
    const targeting = oxylabsParams(request).join('-')
    const login = oxylabsLogin(credentials.username)
    return {
      server: gatewayServer(credentials),
      username: targeting ? `${login}-${targeting}` : login,
      password: credentials.password,
      targetingString: targeting,
    }
  },

  targetingString(request: ProxyRequest): string {
    return oxylabsParams(request).join('-')
  },

  createSession: (profileName) => createAlphanumericSession(profileName, OXYLABS_SESSION_ID_MAX_LENGTH),
  rotateSession: (current, profileName) => rotateAlphanumericSession(current, profileName, OXYLABS_SESSION_ID_MAX_LENGTH),
}

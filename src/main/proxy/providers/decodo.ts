/**
 * Decodo (formerly Smartproxy) proxy dialect (`decodoDialect`), Residential proxies.
 *
 * Community-verified: written from the official documentation below and NOT
 * tested with a live Decodo account.
 *
 * Official documentation (fetched 2026-10-09):
 *   - https://help.decodo.com/docs/residential-proxy-advanced-parameters     (parameter table, cURL examples)
 *   - https://help.decodo.com/docs/residential-proxy-user-pass-requests      (`user-` prefix, gate.decodo.com:7000)
 *   - https://help.decodo.com/docs/residential-proxy-custom-sticky-sessions  (sessionduration 1–1440)
 *
 * Username: "your username line will always start with `user-` followed by
 * your proxy username" (added here when the saved username lacks it), then
 * `-key-value` parameters:
 *
 *   country  `-country-us`                                      two-symbol ISO code (examples are lower case)
 *   state    `-country-us-state-us_california`                  US only; "Use underscores when a city or
 *                                                               state name consists of multiple words"
 *                                                               (`us_new_york`, `us_rhode_island`)
 *   city     `-country-us-state-us_texas-city-austin`           use with `country`; the documented example
 *                                                               also carries the state, as sent here
 *   ZIP      `-country-us-zip-10001`                            5-digit, US only, with `country-us`
 *   session  `-session-randomstring123`                         10 minutes by default
 *   TTL      `-sessionduration-30`                              "any integer (minute) value between 1 and 1440"
 *
 * Gateway: `gate.decodo.com:7000`.
 *
 * Notes: the docs let the session id be "any string of your choice", but the
 * syntax is `-`-separated and every example is alphanumeric, so ids are mapped
 * to alphanumerics (capped at 32 characters; no limit is documented).
 * Apostrophes in place names are dropped (no example covers them). No targeting
 * surcharge is documented, so no billing note.
 */
import type { ProxyRequest } from '../../contracts'
import { clampTtlMinutes, createAlphanumericSession, effectiveTargetMode, gatewayServer, placeWords, requireUnitedStates, rotateAlphanumericSession, toAlphanumericSession } from './dialect-helpers'
import type { ComposedConnection, ProviderCredentials, ProviderDialect } from './dialect'

export const DECODO_GATEWAY = { host: 'gate.decodo.com', port: 7000 } as const
export const DECODO_SESSION_ID_MAX_LENGTH = 32
export const DECODO_SESSION_ID_PATTERN = /^[a-zA-Z0-9]{1,32}$/
export const DECODO_TTL_MINUTES = { min: 1, max: 1440 } as const
const USERNAME_PREFIX = 'user-'
const DISPLAY_NAME = 'Decodo'

/** "New York" → "us_new_york". */
export function encodeDecodoState(state: string): string {
  return `us_${placeWords(state).join('_')}`
}

/** "Las Vegas" → "las_vegas". */
export function encodeDecodoCity(city: string): string {
  return placeWords(city).join('_')
}

/** The `-`-separated parameters for a request (no login), in documented order. */
export function decodoParams(request: ProxyRequest): string[] {
  const params: string[] = []
  const target = request.target
  if (target) {
    const country = target.country.trim().toLowerCase()
    params.push('country', country)
    switch (effectiveTargetMode(target)) {
      case 'zip':
        requireUnitedStates(target, DISPLAY_NAME, 'ZIP')
        params.push('zip', (target.zip ?? '').trim())
        break
      case 'city':
        if (target.state && country === 'us') params.push('state', encodeDecodoState(target.state))
        params.push('city', encodeDecodoCity(target.city ?? ''))
        break
      case 'state':
        requireUnitedStates(target, DISPLAY_NAME, 'state')
        params.push('state', encodeDecodoState(target.state ?? target.stateCode ?? ''))
        break
      case 'country':
        break
    }
  }
  if (request.sessionId) {
    params.push('session', toAlphanumericSession(request.sessionId, DECODO_SESSION_ID_MAX_LENGTH))
    const ttl = clampTtlMinutes(request.ttlMinutes, DECODO_TTL_MINUTES)
    if (ttl !== null) params.push('sessionduration', String(ttl))
  }
  return params
}

/** The saved username with the `user-` prefix the parameter syntax requires. */
export function decodoLogin(username: string): string {
  const trimmed = username.trim()
  return trimmed.startsWith(USERNAME_PREFIX) ? trimmed : `${USERNAME_PREFIX}${trimmed}`
}

export const decodoDialect: ProviderDialect = {
  id: 'decodo',
  displayName: 'Decodo (formerly Smartproxy)',
  docsUrl: 'https://help.decodo.com/docs/residential-proxy-advanced-parameters',
  capabilities: {
    products: [{ key: 'residential', label: 'Residential' }],
    targetModes: ['country', 'state', 'city', 'zip'],
    sticky: {
      supported: true,
      ttlMinutes: { min: DECODO_TTL_MINUTES.min, max: DECODO_TTL_MINUTES.max },
      idPattern: DECODO_SESSION_ID_PATTERN.source,
      idMaxLength: DECODO_SESSION_ID_MAX_LENGTH,
    },
    defaults: { host: DECODO_GATEWAY.host, port: DECODO_GATEWAY.port },
    extraCredentialFields: [],
    verification: 'community',
  },

  compose(credentials: ProviderCredentials, request: ProxyRequest): ComposedConnection {
    const targeting = decodoParams(request).join('-')
    const login = decodoLogin(credentials.username)
    return {
      server: gatewayServer(credentials),
      username: targeting ? `${login}-${targeting}` : login,
      password: credentials.password,
      targetingString: targeting,
    }
  },

  targetingString(request: ProxyRequest): string {
    return decodoParams(request).join('-')
  },

  createSession: (profileName) => createAlphanumericSession(profileName, DECODO_SESSION_ID_MAX_LENGTH),
  rotateSession: (current, profileName) => rotateAlphanumericSession(current, profileName, DECODO_SESSION_ID_MAX_LENGTH),
}

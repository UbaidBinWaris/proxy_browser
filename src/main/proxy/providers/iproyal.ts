/**
 * IPRoyal proxy dialect (`ipRoyalDialect`), Residential proxies.
 *
 * Community-verified: written from the official documentation below and NOT
 * tested with a live IPRoyal account.
 *
 * Official documentation (fetched 2026-10-09):
 *   - https://docs.iproyal.com/proxies/residential/proxy             (parameters live in the PASSWORD; gateways)
 *   - https://docs.iproyal.com/proxies/residential/proxy/location    (`_country-`, `_state-`, `_city-`)
 *   - https://docs.iproyal.com/proxies/residential/proxy/rotation    (`_session-`, `_lifetime-`)
 *   - https://docs.iproyal.com/proxies/residential/api/access        (GET /access/countries: location codes)
 *
 * IPRoyal residential proxies carry every setting in the password: the account
 * password followed by `_key-value` parameters. The username is sent unchanged.
 *
 *   country  `password321_country-us`                   ISO 3166-1 alpha-2 (examples are lower case)
 *   state    `password321_country-us_state-iowa`        US only, "the name of the state"; select US as country
 *   city     `password321_country-de_city-berlin`       "it's essential to specify the country"
 *   session  `_session-sgn34f3e`                        "a random alphanumeric string, precisely 8 characters"
 *   TTL      `_lifetime-10m`                            1 second to 7 days, a single unit (sent as minutes)
 *
 * Multi-word names: `_` separates parameters, so names cannot contain it. The
 * location API returns lower-case concatenated codes ("Prostie Reshenia LLC" →
 * `prostieresheniallc`; ISPs are documented as "a concatenated name"), so
 * states and cities are sent lower case without spaces ("New Jersey" →
 * `newjersey`). The docs only show single-word examples; check a multi-word
 * code against GET /access/countries if a target is refused.
 *
 * Gateway: `geo.iproyal.com:12321` (automatic region; `proxy.iproyal.com`,
 * `us.proxy.iproyal.com`, `sg.proxy.iproyal.com` are the fixed regions).
 *
 * Left out: ZIP targeting (not documented for residential proxies). Without a
 * TTL on the request no `_lifetime-` is sent (the docs do not state a default).
 * No targeting surcharge is documented, so no billing note.
 */
import type { ProxyRequest } from '../../contracts'
import { clampTtlMinutes, createFixedLengthSession, effectiveTargetMode, gatewayServer, placeWords, requireUnitedStates, rotateFixedLengthSession, toFixedLengthSession } from './dialect-helpers'
import type { ComposedConnection, ProviderCredentials, ProviderDialect } from './dialect'

export const IPROYAL_GATEWAY = { host: 'geo.iproyal.com', port: 12321 } as const
export const IPROYAL_SESSION_ID_LENGTH = 8
export const IPROYAL_SESSION_ID_PATTERN = /^[a-zA-Z0-9]{8}$/
/** 1 minute (the app's TTL unit) to 7 days. */
export const IPROYAL_TTL_MINUTES = { min: 1, max: 7 * 24 * 60 } as const
const DISPLAY_NAME = 'IPRoyal'

/** "New Jersey" → "newjersey" (see the file header). */
export function encodeIpRoyalPlace(name: string): string {
  return placeWords(name).join('')
}

/** The `_key-value` parameters appended to the password, without the leading `_` (no password). */
export function ipRoyalParams(request: ProxyRequest): string[] {
  const params: string[] = []
  const target = request.target
  if (target) {
    params.push(`country-${target.country.trim().toLowerCase()}`)
    // ZIP is not offered (targetModes); a ZIP target still sends its city.
    switch (effectiveTargetMode(target)) {
      case 'zip':
      case 'city':
        params.push(`city-${encodeIpRoyalPlace(target.city ?? '')}`)
        break
      case 'state':
        requireUnitedStates(target, DISPLAY_NAME, 'state')
        params.push(`state-${encodeIpRoyalPlace(target.state ?? target.stateCode ?? '')}`)
        break
      case 'country':
        break
    }
  }
  if (request.sessionId) {
    params.push(`session-${toFixedLengthSession(request.sessionId, IPROYAL_SESSION_ID_LENGTH)}`)
    const ttl = clampTtlMinutes(request.ttlMinutes, IPROYAL_TTL_MINUTES)
    if (ttl !== null) params.push(`lifetime-${ttl}m`)
  }
  return params
}

export const ipRoyalDialect: ProviderDialect = {
  id: 'iproyal',
  displayName: DISPLAY_NAME,
  docsUrl: 'https://docs.iproyal.com/proxies/residential/proxy',
  capabilities: {
    products: [{ key: 'residential', label: 'Residential' }],
    targetModes: ['country', 'state', 'city'],
    sticky: {
      supported: true,
      ttlMinutes: { min: IPROYAL_TTL_MINUTES.min, max: IPROYAL_TTL_MINUTES.max },
      idPattern: IPROYAL_SESSION_ID_PATTERN.source,
      idMaxLength: IPROYAL_SESSION_ID_LENGTH,
    },
    defaults: { host: IPROYAL_GATEWAY.host, port: IPROYAL_GATEWAY.port },
    extraCredentialFields: [],
    verification: 'community',
  },

  compose(credentials: ProviderCredentials, request: ProxyRequest): ComposedConnection {
    const params = ipRoyalParams(request)
    const targeting = params.join('_')
    return {
      server: gatewayServer(credentials),
      username: credentials.username.trim(),
      // Parameters go in the password; GatewayProvider registers the composed password as a secret.
      password: params.length > 0 ? `${credentials.password}_${targeting}` : credentials.password,
      targetingString: targeting,
    }
  },

  targetingString(request: ProxyRequest): string {
    return ipRoyalParams(request).join('_')
  },

  createSession: (profileName) => createFixedLengthSession(profileName, IPROYAL_SESSION_ID_LENGTH),
  rotateSession: (current, profileName) => rotateFixedLengthSession(current, profileName, IPROYAL_SESSION_ID_LENGTH),
}

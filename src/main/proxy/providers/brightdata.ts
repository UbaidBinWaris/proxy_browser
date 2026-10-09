/**
 * Bright Data proxy dialect (`brightDataDialect`), Residential zones.
 *
 * Community-verified: written from the official documentation below and NOT
 * tested with a live Bright Data account.
 *
 * Official documentation (fetched 2026-10-09):
 *   - https://docs.brightdata.com/proxy-networks/config-options              (username structure, parameter table)
 *   - https://docs.brightdata.com/api-reference/proxy/geolocation-targeting  (country / state / city / ZIP)
 *   - https://docs.brightdata.com/api-reference/proxy/rotate_ips             (`-session`, 5-minute idle time)
 *   - https://docs.brightdata.com/products/residential/introduction          (gateway brd.superproxy.io:44445)
 *
 * Username: `brd-customer-<customer_id>-zone-<zone_name>-[optional parameters]`.
 * The username shown for the zone in the Bright Data control panel already
 * carries the customer id and zone name, so no extra credential field is
 * needed: enter that username as is (without targeting parameters) and the
 * zone password. Parameters are appended with `-`:
 *
 *   country  `-country-us`                    two-letter, lower case
 *   state    `-country-us-state-ny`           residential only; lower-case ISO 3166-2 code
 *                                             (for the US the USPS code); "You must include US as country"
 *   city     `-country-us-city-sanfrancisco`  lower case, no spaces; the country is required
 *   ZIP      `-city-memphis-zip-37501`        residential only; 5 digits (the documented example
 *                                             pairs it with the city and no country, reproduced as is)
 *   session  `-session-mystring12345`         "alphanumeric characters only. Using special
 *                                             characters like `-` or `*` will result in errors"
 *
 * Not used / left out:
 *   - Session TTL: Bright Data has no lifetime parameter (a session is lost after
 *     5 minutes idle), so `ttlMinutes` is ignored and no TTL range is declared.
 *   - City + state together: not documented, so a city target sends country + city only.
 *   - No maximum session id length is documented; ids are capped at 32 characters here.
 *   - No targeting surcharge is documented, so no billing note.
 */
import type { ProxyRequest } from '../../contracts'
import { createAlphanumericSession, effectiveTargetMode, gatewayServer, placeWords, requireStateCode, requireUnitedStates, rotateAlphanumericSession, toAlphanumericSession } from './dialect-helpers'
import type { ComposedConnection, ProviderCredentials, ProviderDialect } from './dialect'

export const BRIGHTDATA_GATEWAY = { host: 'brd.superproxy.io', port: 44445 } as const
export const BRIGHTDATA_SESSION_ID_MAX_LENGTH = 32
export const BRIGHTDATA_SESSION_ID_PATTERN = /^[a-zA-Z0-9]{1,32}$/
const DISPLAY_NAME = 'Bright Data'

/** City name as Bright Data expects it: lower case, no spaces ("San Francisco" → sanfrancisco). */
export function encodeBrightDataCity(city: string): string {
  return placeWords(city).join('')
}

/** The `-`-separated parameters for a request (no login), in documented order. */
export function brightDataParams(request: ProxyRequest): string[] {
  const params: string[] = []
  const target = request.target
  if (target) {
    const country = target.country.trim().toLowerCase()
    switch (effectiveTargetMode(target)) {
      case 'zip':
        requireUnitedStates(target, DISPLAY_NAME, 'ZIP')
        if (target.city) params.push('city', encodeBrightDataCity(target.city))
        params.push('zip', (target.zip ?? '').trim())
        break
      case 'city':
        params.push('country', country, 'city', encodeBrightDataCity(target.city ?? ''))
        break
      case 'state':
        requireUnitedStates(target, DISPLAY_NAME, 'state')
        params.push('country', country, 'state', requireStateCode(target, DISPLAY_NAME))
        break
      case 'country':
        params.push('country', country)
        break
    }
  }
  if (request.sessionId) params.push('session', toAlphanumericSession(request.sessionId, BRIGHTDATA_SESSION_ID_MAX_LENGTH))
  return params
}

export const brightDataDialect: ProviderDialect = {
  id: 'brightdata',
  displayName: DISPLAY_NAME,
  docsUrl: 'https://docs.brightdata.com/proxy-networks/config-options',
  capabilities: {
    products: [{ key: 'residential', label: 'Residential' }],
    targetModes: ['country', 'state', 'city', 'zip'],
    sticky: {
      supported: true,
      idPattern: BRIGHTDATA_SESSION_ID_PATTERN.source,
      idMaxLength: BRIGHTDATA_SESSION_ID_MAX_LENGTH,
    },
    defaults: { host: BRIGHTDATA_GATEWAY.host, port: BRIGHTDATA_GATEWAY.port },
    extraCredentialFields: [],
    verification: 'community',
  },

  compose(credentials: ProviderCredentials, request: ProxyRequest): ComposedConnection {
    const targeting = brightDataParams(request).join('-')
    const login = credentials.username.trim()
    return {
      server: gatewayServer(credentials),
      username: targeting ? `${login}-${targeting}` : login,
      password: credentials.password,
      targetingString: targeting,
    }
  },

  targetingString(request: ProxyRequest): string {
    return brightDataParams(request).join('-')
  },

  createSession: (profileName) => createAlphanumericSession(profileName, BRIGHTDATA_SESSION_ID_MAX_LENGTH),
  rotateSession: (current, profileName) => rotateAlphanumericSession(current, profileName, BRIGHTDATA_SESSION_ID_MAX_LENGTH),
}

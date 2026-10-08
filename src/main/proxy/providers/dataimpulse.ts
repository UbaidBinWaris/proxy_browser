/**
 * DataImpulse proxy dialect (`dataImpulseDialect`).
 *
 * ALL DataImpulse-specific username / parameter construction lives in this file.
 * The generic gateway handling (per-pool credentials, status, tests, IP lookup,
 * secrets) is `GatewayProvider` (./gateway-provider.ts); `DataImpulseProvider`
 * below is kept as a thin compatibility wrapper (GatewayProvider + this dialect).
 *
 * Username syntax (verified against the official docs):
 *   - https://docs.dataimpulse.com/proxies/parameters            (general format)
 *   - https://docs.dataimpulse.com/proxies/parameters/session-id (sticky sessions)
 *
 *   Parameters are appended to the login after a double underscore, as
 *   `key.value` pairs separated by semicolons (`,` separates multiple values):
 *
 *     login__cr.us;state.newjersey;city.newark;zip.07102;sessid.profile01;sessttl.60
 *
 *   - `cr.<iso2>` is MANDATORY whenever state/city/zip are used (a GeoTarget always
 *     carries its country, so every geo-targeted username starts with `cr`).
 *   - State and city names are lower-case with spaces removed (DataImpulse's own
 *     state list: `state.newjersey`, `state.northcarolina`); diacritics and
 *     punctuation are stripped too ("'Ewa Beach" → `ewabeach`). The separator is
 *     configurable through `settings.providerOptions.dataimpulse.encoding`
 *     ('remove-spaces' default, 'underscore', 'keep') in case the gateway changes
 *     its convention.
 *   - `zip.<5 digits>`.
 *   - `sessid.<value>` pins the exit IP (~30 min by default); `sessttl.<minutes>`
 *     sets the interval.
 *
 * Products: Residential and Mobile are separate plans with separate logins on the
 * same gateway (gw.dataimpulse.com:823). Credentials are kept per product.
 *
 * Composition (`buildProxyConfig`): the configured login may already carry
 * parameters (e.g. `login__cr.us`). They are parsed; `cr`/`state`/`city`/`zip`
 * from the login are replaced by the request's target (never duplicated), every
 * other login parameter is kept, and the session parameters are appended last.
 *
 * Session template: the `sessid` part still goes through the template mechanism
 * (placeholders `{username}` = login incl. targeting, `{session}`, `{sep}` which
 * resolves to `;` when the username already has `__`, otherwise `__`). Default:
 * `{username}{sep}sessid.{session}`. Precedence: template saved with the pool's
 * credentials → gateway default (env DATAIMPULSE_SESSION_TEMPLATE in
 * development) → DEFAULT_SESSION_TEMPLATE; GatewayProvider resolves it and
 * hands it to `compose()` as `credentials.sessionTemplate`. `sessttl` is
 * appended after the template result, so a custom template never has to know
 * about it.
 *
 * Location re-roll: a PROXY_DEAD failure (HTTP 503 from the gateway, an
 * exhausted location pool) is not retryable — see `isRetryableDataImpulseFailure`.
 */
import { STICKY_SESSION_ID_MAX_LENGTH, STICKY_SESSION_ID_PATTERN, TARGET_MODES } from '../../../shared/types'
import type { AppError, CredentialSource, GeoTarget } from '../../../shared/types'
import type { IpChecker, Logger, ProxyCredentials, ProxyRequest } from '../../contracts'
import { DATAIMPULSE_STATES_FILE } from '../../locations/geonames-loader'
import { DEFAULT_TARGETING_ENCODING, TARGETING_ENCODINGS, encodePlaceName, encodeStateName, notConfiguredMessage, productNotConfiguredMessage } from '../targeting-text'
import type { TargetingEncoding } from '../targeting-text'
import type { ComposedConnection, DialectOptions, ProviderCredentials, ProviderDialect } from './dialect'
import { GatewayProvider } from './gateway-provider'

// Neutral helpers re-exported so existing imports from this module keep working.
export { DEFAULT_TARGETING_ENCODING, TARGETING_ENCODINGS, encodePlaceName, encodeStateName } from '../targeting-text'
export type { TargetingEncoding } from '../targeting-text'
export { REQUIRED_CREDENTIAL_FIELDS, maskUsername } from './gateway-provider'

export interface DataImpulseProviderOptions {
  ipChecker: IpChecker
  logger: Logger
  /** Default sticky-session template; a template saved with the credentials overrides it. */
  sessionTemplate?: string
  /** Initial credentials (same as calling `setCredentials` right after construction). */
  credentials?: ProxyCredentials[]
  source?: CredentialSource
  /** How multi-word place names are encoded (settings.providerOptions.dataimpulse.encoding). Defaults to 'remove-spaces'. */
  getTargetingEncoding?: () => string
}

export const DEFAULT_SESSION_TEMPLATE = '{username}{sep}sessid.{session}'
/** DataImpulse plans (product keys), in picker order. Stored values from before providers existed use these keys. */
export const DATAIMPULSE_PRODUCTS = ['residential', 'mobile'] as const
export const DATAIMPULSE_GATEWAY = { host: 'gw.dataimpulse.com', port: 823 } as const
/** Shown when a target asks for more than a country (same text as the launcher's DOUBLE_RATE_WARNING). */
export const GEO_TARGETING_BILLING_NOTE = 'State/city/ZIP targeting is billed at 2× by DataImpulse.'
/** Auto-generated ids (`createSession`) are short lowercase slugs. */
export const SESSION_ID_MAX_LENGTH = 32
export const SESSION_ID_PATTERN = /^[a-z0-9-]{1,32}$/
/** Rotation keeps whatever the user typed (profile charset) and only appends `-r<N>`. */
const ROTATION_SUFFIX_PATTERN = /^(.*)-r(\d+)$/

export const PARAM_PREFIX = '__'
export const PARAM_SEPARATOR = ';'
const KEY_VALUE_SEPARATOR = '.'

/** Parameter keys owned by the geo target: replaced (never duplicated) when a request carries a target. */
const GEO_KEYS = ['cr', 'state', 'city', 'zip'] as const
/** Parameter keys owned by the session: replaced when a request carries a sticky id. */
const SESSION_KEYS = ['sessid', 'sessttl'] as const

/** Convert any profile name to a lowercase kebab slug ([a-z0-9-]). */
export function kebabSlug(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
}

// ---------------------------------------------------------------------------
// Encoding helpers (exported for unit tests and the launcher preview).
// Place/state name encoding is provider-neutral: see ../targeting-text.ts
// (DataImpulse's documented convention is the 'remove-spaces' default).
// ---------------------------------------------------------------------------

/** Lower-case ISO-2 country for the `cr` parameter. */
export function encodeCountry(country: string): string {
  return country.trim().toLowerCase()
}

export type TargetingParam = readonly [key: string, value: string]

/** `cr`, `state`, `city`, `zip` parameters for a target, in that order (country is always present). */
export function geoParams(target: GeoTarget | null, encoding: TargetingEncoding = DEFAULT_TARGETING_ENCODING): TargetingParam[] {
  if (!target) return []
  const params: TargetingParam[] = [['cr', encodeCountry(target.country)]]
  if (target.state) params.push(['state', encodeStateName(target.state, encoding)])
  if (target.city) params.push(['city', encodePlaceName(target.city, encoding)])
  if (target.zip) params.push(['zip', target.zip.trim()])
  return params
}

/** `sessid` and `sessttl` for a request (nothing for a rotating request: a TTL without a session is meaningless). */
export function sessionParams(request: Pick<ProxyRequest, 'sessionId' | 'ttlMinutes'>): TargetingParam[] {
  if (!request.sessionId) return []
  const params: TargetingParam[] = [['sessid', request.sessionId]]
  if (request.ttlMinutes !== null && request.ttlMinutes > 0) params.push(['sessttl', String(Math.trunc(request.ttlMinutes))])
  return params
}

export function joinParams(params: readonly TargetingParam[]): string {
  return params.map(([key, value]) => (value.length > 0 ? `${key}${KEY_VALUE_SEPARATOR}${value}` : key)).join(PARAM_SEPARATOR)
}

/**
 * The canonical parameter string for a request (no login, no password):
 * cr, state, city, zip, sessid, sessttl — e.g. "cr.us;state.newjersey;sessid.abc;sessttl.60".
 * Empty for a rotating request without a target.
 */
export function buildTargetingString(request: ProxyRequest, encoding: TargetingEncoding = DEFAULT_TARGETING_ENCODING): string {
  return joinParams([...geoParams(request.target, encoding), ...sessionParams(request)])
}

export interface ParsedLogin {
  /** The login proper (everything before the first `__`). */
  login: string
  /** `key.value` parameters already present on the configured username, in order. */
  params: TargetingParam[]
}

/** Split a configured username into its login and existing `__k.v;k.v` parameters. */
export function parseLogin(username: string): ParsedLogin {
  const index = username.indexOf(PARAM_PREFIX)
  if (index === -1) return { login: username, params: [] }
  const params: TargetingParam[] = []
  for (const part of username.slice(index + PARAM_PREFIX.length).split(PARAM_SEPARATOR)) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const dot = trimmed.indexOf(KEY_VALUE_SEPARATOR)
    params.push(dot === -1 ? [trimmed, ''] : [trimmed.slice(0, dot), trimmed.slice(dot + 1)])
  }
  return { login: username.slice(0, index), params }
}

export interface ComposedUsername {
  /** Login + parameters (session part formatted through the template). */
  username: string
  /** Every parameter the username carries, canonical form: geo, other login params, session. */
  effectiveParams: TargetingParam[]
}

/**
 * Compose the full username for a request on top of the configured login.
 *
 * - geo keys (`cr`, `state`, `city`, `zip`) from the login are replaced by the
 *   request's target when there is one; without a target the login's own geo
 *   parameters are kept;
 * - every other login parameter is kept in its original order;
 * - session keys from the login are replaced by the request's `sessid`/`sessttl`
 *   when the request is sticky; a rotating request keeps the login's own.
 *
 * With the default template the username is exactly `login__<effectiveParams>`.
 */
export function composeUsername(
  baseUsername: string,
  request: ProxyRequest,
  encoding: TargetingEncoding = DEFAULT_TARGETING_ENCODING,
  template: string = DEFAULT_SESSION_TEMPLATE,
): ComposedUsername {
  const { login, params: loginParams } = parseLogin(baseUsername)
  const isGeo = (key: string): boolean => (GEO_KEYS as readonly string[]).includes(key)
  const isSession = (key: string): boolean => (SESSION_KEYS as readonly string[]).includes(key)

  const geo: TargetingParam[] = request.target
    ? geoParams(request.target, encoding)
    : GEO_KEYS.flatMap((key) => loginParams.filter(([k]) => k === key).slice(0, 1))
  const others = loginParams.filter(([key]) => !isGeo(key) && !isSession(key))
  const session: TargetingParam[] = request.sessionId ? sessionParams(request) : loginParams.filter(([key]) => isSession(key))

  const staticParams = [...geo, ...others, ...(request.sessionId ? [] : session)]
  let username = staticParams.length > 0 ? `${login}${PARAM_PREFIX}${joinParams(staticParams)}` : login
  if (request.sessionId) {
    username = buildDataImpulseUsername(username, request.sessionId, template)
    const ttl = session.find(([key]) => key === 'sessttl')
    if (ttl) username = `${username}${username.includes(PARAM_PREFIX) ? PARAM_SEPARATOR : PARAM_PREFIX}${joinParams([ttl])}`
  }
  return { username, effectiveParams: [...geo, ...others, ...session] }
}

/**
 * Apply the sticky-session template to a username that may already carry parameters.
 * Exported for unit tests; `composeUsername` delegates to it.
 */
export function buildDataImpulseUsername(baseUsername: string, sessionId: string, template: string = DEFAULT_SESSION_TEMPLATE): string {
  const sep = baseUsername.includes(PARAM_PREFIX) ? PARAM_SEPARATOR : PARAM_PREFIX
  return template.replaceAll('{username}', baseUsername).replaceAll('{session}', sessionId).replaceAll('{sep}', sep)
}

/** The request's encoding option when it is one DataImpulse knows, otherwise the documented default. */
function encodingFrom(options: DialectOptions | undefined): TargetingEncoding {
  const value = options?.encoding
  return value !== undefined && (TARGETING_ENCODINGS as readonly string[]).includes(value) ? (value as TargetingEncoding) : DEFAULT_TARGETING_ENCODING
}

function gatewayServer(credentials: Pick<ProviderCredentials, 'host' | 'port'>): string {
  return `http://${credentials.host}:${credentials.port}`
}

/** Deterministic sticky session id for a profile: `profile-<kebab slug>`, at most 32 characters. */
export function createDataImpulseSession(profileName: string): string {
  const slug = kebabSlug(profileName)
  const body = slug.length > 0 ? slug : 'default'
  return trimSessionId(`profile-${body}`)
}

/**
 * Next sticky session id for a profile. The current id is preserved verbatim
 * (the profile charset allows upper case and underscores, which DataImpulse
 * accepts) and `-r<N>` is appended or incremented; the stem is truncated only
 * when needed to stay within the 64-character profile limit.
 */
export function rotateDataImpulseSession(currentSessionId: string | null, profileName: string): string {
  const base = currentSessionId && STICKY_SESSION_ID_PATTERN.test(currentSessionId) ? currentSessionId : createDataImpulseSession(profileName)
  const match = ROTATION_SUFFIX_PATTERN.exec(base)
  const stem = match ? (match[1] ?? base) : base
  const nextRound = match ? Number.parseInt(match[2] ?? '1', 10) + 1 : 2
  const suffix = `-r${nextRound}`
  const next = trimSessionId(stem, STICKY_SESSION_ID_MAX_LENGTH - suffix.length) + suffix
  if (next !== currentSessionId) return next
  // Degenerate case (e.g. counter overflowed the length budget): fall back to a random suffix.
  const random = `-${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`
  return trimSessionId(stem, STICKY_SESSION_ID_MAX_LENGTH - random.length) + random
}

/**
 * Whether a failed exit-IP check is worth another sticky session id.
 * Not for PROXY_DEAD: after the IP checker's own retries it means the gateway
 * refused a new sticky session (live: HTTP 503 once a thin ZIP pool's IPs were
 * all pinned), and it keeps refusing until a session expires. Not for rejected
 * credentials either.
 */
export function isRetryableDataImpulseFailure(error: AppError): boolean {
  return error.code !== 'PROXY_DEAD' && error.code !== 'PROXY_AUTH_FAILED'
}

export const dataImpulseDialect: ProviderDialect = {
  id: 'dataimpulse',
  displayName: 'DataImpulse',
  docsUrl: 'https://docs.dataimpulse.com/proxies/parameters',
  capabilities: {
    products: DATAIMPULSE_PRODUCTS.map((key) => ({ key, label: key === 'residential' ? 'Residential' : 'Mobile' })),
    targetModes: [...TARGET_MODES],
    sticky: {
      supported: true,
      // `sessttl` range accepted by the profile schema (stickyTtlMinutes).
      ttlMinutes: { min: 1, max: 1440 },
      idPattern: STICKY_SESSION_ID_PATTERN.source,
      idMaxLength: STICKY_SESSION_ID_MAX_LENGTH,
    },
    defaults: { host: DATAIMPULSE_GATEWAY.host, port: DATAIMPULSE_GATEWAY.port },
    extraCredentialFields: [],
    targetingBillingNote: GEO_TARGETING_BILLING_NOTE,
    stateAllowlistFile: DATAIMPULSE_STATES_FILE,
    encodingOptions: [...TARGETING_ENCODINGS],
  },
  sessionTemplate: { default: DEFAULT_SESSION_TEMPLATE, settingName: 'DATAIMPULSE_SESSION_TEMPLATE' },

  compose(credentials: ProviderCredentials, request: ProxyRequest, options?: DialectOptions): ComposedConnection {
    const composed = composeUsername(credentials.username, request, encodingFrom(options), credentials.sessionTemplate ?? DEFAULT_SESSION_TEMPLATE)
    return {
      server: gatewayServer(credentials),
      username: composed.username,
      password: credentials.password,
      targetingString: joinParams(composed.effectiveParams),
    }
  },

  /** Candidate credentials are tested with the login exactly as entered; the parameters it carries are reported. */
  composeCredentialCheck(credentials: ProviderCredentials): ComposedConnection {
    return {
      server: gatewayServer(credentials),
      username: credentials.username,
      password: credentials.password,
      targetingString: joinParams(parseLogin(credentials.username).params),
    }
  },

  targetingString(request: ProxyRequest, options?: DialectOptions): string {
    return buildTargetingString(request, encodingFrom(options))
  },

  createSession: createDataImpulseSession,
  rotateSession: rotateDataImpulseSession,
  isRetryableLocationFailure: isRetryableDataImpulseFailure,
}

/** "Proxy credentials are not configured. Enter and save your DataImpulse credentials …" */
export const NOT_CONFIGURED_MESSAGE = notConfiguredMessage(dataImpulseDialect.displayName)

/** "DataImpulse Mobile credentials are not configured. Add them under Settings → Advanced → Proxy keys." */
export function poolNotConfiguredMessage(pool: string): string {
  return productNotConfiguredMessage(dataImpulseDialect, pool)
}

/**
 * Compatibility wrapper kept for existing call sites and tests:
 * `GatewayProvider` with the DataImpulse dialect.
 */
export class DataImpulseProvider extends GatewayProvider {
  constructor(options: DataImpulseProviderOptions) {
    super({
      dialect: dataImpulseDialect,
      ipChecker: options.ipChecker,
      logger: options.logger,
      sessionTemplate: options.sessionTemplate,
      credentials: options.credentials,
      source: options.source,
      getEncoding: options.getTargetingEncoding,
    })
  }
}

function trimSessionId(value: string, max: number = SESSION_ID_MAX_LENGTH): string {
  return value.slice(0, max).replace(/-+$/g, '')
}

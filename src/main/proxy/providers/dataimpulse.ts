/**
 * DataImpulse proxy provider.
 *
 * ALL DataImpulse-specific username / parameter construction lives in this file.
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
 *     configurable through `settings.targetingEncoding` ('remove-spaces' default,
 *     'underscore', 'keep') in case the gateway changes its convention.
 *   - `zip.<5 digits>`.
 *   - `sessid.<value>` pins the exit IP (~30 min by default); `sessttl.<minutes>`
 *     sets the interval.
 *
 * Pools: Residential and Mobile are separate plans with separate logins on the
 * same gateway (gw.dataimpulse.com:823). Credentials are kept per pool.
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
 * credentials → constructor default (env DATAIMPULSE_SESSION_TEMPLATE in
 * development) → DEFAULT_SESSION_TEMPLATE. `sessttl` is appended after the
 * template result, so a custom template never has to know about it.
 *
 * Credentials are dynamic: `setCredentials()` is called by the composition root
 * whenever the vault changes (or the development .env fallback applies).
 */
import { PROXY_POOLS, PROXY_POOL_LABELS, ProxyCredentialsInputSchema, STICKY_SESSION_ID_MAX_LENGTH, STICKY_SESSION_ID_PATTERN, isValidSessionTemplate } from '../../../shared/types'
import type { AppSettings, CredentialSource, GeoTarget, IpInfo, ProxyConfigStatus, ProxyCredentialsInput, ProxyPool, ProxyPoolStatus, ProxyTestResult } from '../../../shared/types'
import { AppException } from '../../contracts'
import type { IpChecker, Logger, ProxyConnection, ProxyCredentials, ProxyProvider, ProxyRequest } from '../../contracts'
import { stripCredentials } from '../ip-checker'

export type TargetingEncoding = AppSettings['targetingEncoding']

export interface DataImpulseProviderOptions {
  ipChecker: IpChecker
  logger: Logger
  /** Default sticky-session template; a template saved with the credentials overrides it. */
  sessionTemplate?: string
  /** Initial credentials (same as calling `setCredentials` right after construction). */
  credentials?: ProxyCredentials[]
  source?: CredentialSource
  /** How multi-word place names are encoded (settings.targetingEncoding). Defaults to 'remove-spaces'. */
  getTargetingEncoding?: () => TargetingEncoding
}

export const DEFAULT_SESSION_TEMPLATE = '{username}{sep}sessid.{session}'
export const DEFAULT_TARGETING_ENCODING: TargetingEncoding = 'remove-spaces'
/** Auto-generated ids (`createSession`) are short lowercase slugs. */
export const SESSION_ID_MAX_LENGTH = 32
export const SESSION_ID_PATTERN = /^[a-z0-9-]{1,32}$/
/** Rotation keeps whatever the user typed (profile charset) and only appends `-r<N>`. */
const ROTATION_SUFFIX_PATTERN = /^(.*)-r(\d+)$/

export const PARAM_PREFIX = '__'
export const PARAM_SEPARATOR = ';'
const KEY_VALUE_SEPARATOR = '.'
const LOG_SCOPE = 'proxy.dataimpulse'

/** Parameter keys owned by the geo target: replaced (never duplicated) when a request carries a target. */
const GEO_KEYS = ['cr', 'state', 'city', 'zip'] as const
/** Parameter keys owned by the session: replaced when a request carries a sticky id. */
const SESSION_KEYS = ['sessid', 'sessttl'] as const

/** Fields reported as missing while no credentials are active. */
export const REQUIRED_CREDENTIAL_FIELDS = ['host', 'port', 'username', 'password'] as const

export const NOT_CONFIGURED_MESSAGE =
  'Proxy credentials are not configured. Enter and save your DataImpulse credentials in the app (first-run setup or Settings) to use the proxy modes.'

/** Message for a request against a pool that has no credentials. */
export function poolNotConfiguredMessage(pool: ProxyPool): string {
  return `${PROXY_POOL_LABELS[pool]} credentials are not configured. Add them under Settings → Advanced → Proxy keys.`
}

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

/** Mask a username as "ab****yz"; very short usernames are fully masked. */
export function maskUsername(username: string): string {
  if (username.length <= 4) return '*'.repeat(Math.max(username.length, 4))
  return `${username.slice(0, 2)}****${username.slice(-2)}`
}

// ---------------------------------------------------------------------------
// Encoding helpers (exported for unit tests and the launcher preview)
// ---------------------------------------------------------------------------

/**
 * Encode a human place name the way DataImpulse expects it: ASCII, lower-case,
 * no punctuation/apostrophes, words joined according to `encoding`.
 *   "New Jersey"  → "newjersey"  ('remove-spaces', the documented convention)
 *   "'Ewa Beach"  → "ewabeach"
 *   "St. Louis"   → "stlouis"    ('underscore' → "st_louis", 'keep' → "st louis")
 *   "Winston-Salem" → "winstonsalem"
 */
export function encodePlaceName(name: string, encoding: TargetingEncoding = DEFAULT_TARGETING_ENCODING): string {
  const words = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
  switch (encoding) {
    case 'underscore':
      return words.join('_')
    case 'keep':
      return words.join(' ')
    case 'remove-spaces':
      return words.join('')
  }
}

/** DataImpulse state parameter value ("New Jersey" → "newjersey"). */
export function encodeStateName(state: string, encoding: TargetingEncoding = DEFAULT_TARGETING_ENCODING): string {
  return encodePlaceName(state, encoding)
}

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

function validateTemplate(template: string): string {
  if (!isValidSessionTemplate(template)) {
    throw new AppException(
      'INVALID_INPUT',
      'DATAIMPULSE_SESSION_TEMPLATE must contain both {username} and {session} placeholders.',
      `template="${template}"`,
    )
  }
  return template
}

function firstIssue(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  const issue = issues[0]
  if (!issue) return 'Invalid credentials.'
  const path = issue.path.map(String).join('.')
  return path ? `${path}: ${issue.message}` : issue.message
}

interface PoolState {
  credentials: ProxyCredentials
  template: string
}

export class DataImpulseProvider implements ProxyProvider {
  readonly name = 'dataimpulse' as const

  private readonly ipChecker: IpChecker
  private readonly logger: Logger
  private readonly defaultTemplate: string
  private readonly getTargetingEncoding: () => TargetingEncoding
  private readonly pools = new Map<ProxyPool, PoolState>()
  private source: CredentialSource = 'none'

  constructor(options: DataImpulseProviderOptions) {
    this.ipChecker = options.ipChecker
    this.logger = options.logger
    this.defaultTemplate = validateTemplate(options.sessionTemplate?.trim() || DEFAULT_SESSION_TEMPLATE)
    this.getTargetingEncoding = options.getTargetingEncoding ?? ((): TargetingEncoding => DEFAULT_TARGETING_ENCODING)
    if (options.credentials !== undefined) {
      this.setCredentials(options.credentials, options.source ?? 'vault')
    }
  }

  isConfigured(): boolean {
    return this.pools.size > 0
  }

  isPoolConfigured(pool: ProxyPool): boolean {
    return this.pools.has(pool)
  }

  /** Replace the whole pool set. An empty list clears every pool. */
  setCredentials(credentials: ProxyCredentials[], source: CredentialSource): void {
    const had = [...this.pools.keys()]
    this.pools.clear()
    for (const entry of credentials) {
      if (this.pools.has(entry.pool)) {
        this.logger.warn(LOG_SCOPE, `Duplicate credentials for the ${entry.pool} pool; keeping the first entry`)
        continue
      }
      this.pools.set(entry.pool, { credentials: { ...entry }, template: this.resolveTemplate(entry.sessionTemplate, entry.pool) })
      this.logger.registerSecret(entry.password)
      this.logger.registerSecret(`${entry.username}:${entry.password}`)
    }
    this.source = this.pools.size > 0 ? source : 'none'
    if (this.pools.size === 0) {
      if (had.length > 0) this.logger.info(LOG_SCOPE, 'Proxy credentials cleared; proxy modes are unavailable until credentials are saved again')
      return
    }
    for (const [pool, state] of this.pools) {
      this.logger.info(LOG_SCOPE, `Proxy credentials activated for the ${pool} pool`, {
        pool,
        source: this.source,
        host: state.credentials.host,
        port: state.credentials.port,
        username: maskUsername(state.credentials.username),
        templateOverride: state.credentials.sessionTemplate !== null,
      })
    }
    const dropped = had.filter((pool) => !this.pools.has(pool))
    if (dropped.length > 0) this.logger.info(LOG_SCOPE, `Proxy credentials removed for pool(s): ${dropped.join(', ')}`)
  }

  getConfigStatus(): ProxyConfigStatus {
    const pools: ProxyPoolStatus[] = PROXY_POOLS.map((pool) => {
      const state = this.pools.get(pool)
      return {
        pool,
        configured: state !== undefined,
        host: state?.credentials.host ?? null,
        port: state?.credentials.port ?? null,
        usernameMasked: state ? maskUsername(state.credentials.username) : null,
        source: state ? this.source : 'none',
      }
    })
    // Summary fields describe the primary pool: residential when present, otherwise the first configured one.
    const primary = this.pools.get('residential') ?? [...this.pools.values()][0] ?? null
    return {
      configured: primary !== null,
      pools,
      provider: 'dataimpulse',
      host: primary?.credentials.host ?? null,
      port: primary?.credentials.port ?? null,
      usernameMasked: primary ? maskUsername(primary.credentials.username) : null,
      missing: primary ? [] : [...REQUIRED_CREDENTIAL_FIELDS],
      source: this.source,
    }
  }

  buildTargetingString(request: ProxyRequest): string {
    return buildTargetingString(request, this.getTargetingEncoding())
  }

  buildProxyConfig(request: ProxyRequest): ProxyConnection {
    const state = this.requirePool(request.pool)
    const composed = composeUsername(state.credentials.username, request, this.getTargetingEncoding(), state.template)
    return {
      server: `http://${state.credentials.host}:${state.credentials.port}`,
      username: composed.username,
      password: state.credentials.password,
      pool: request.pool,
      sessionId: request.sessionId,
      target: request.target ? { ...request.target } : null,
      targetingString: joinParams(composed.effectiveParams),
    }
  }

  async testConnection(request: ProxyRequest): Promise<ProxyTestResult> {
    try {
      const ip = await this.getCurrentIp(request)
      return { status: 'working', sessionId: request.sessionId, ip, error: null }
    } catch (err) {
      const error = err instanceof AppException ? err.toAppError() : toInternalError(err)
      this.logger.warn(LOG_SCOPE, 'Proxy test failed', { pool: request.pool, sessionId: request.sessionId, code: error.code, message: error.message })
      return { status: 'failed', sessionId: request.sessionId, ip: null, error }
    }
  }

  /**
   * Live check of candidate credentials through the gateway (rotating mode, no
   * targeting). The active credentials are untouched and nothing is persisted;
   * the input password is registered as a secret so it can never appear in a
   * log line.
   */
  async testCredentials(input: ProxyCredentialsInput): Promise<ProxyTestResult> {
    const parsed = ProxyCredentialsInputSchema.safeParse(input)
    if (!parsed.success) throw new AppException('INVALID_INPUT', firstIssue(parsed.error.issues))
    const c = parsed.data
    this.logger.registerSecret(c.password)
    this.logger.registerSecret(`${c.username}:${c.password}`)
    const meta = { pool: c.pool, host: c.host, port: c.port, username: maskUsername(c.username) }
    const connection: ProxyConnection = {
      server: `http://${c.host}:${c.port}`,
      username: c.username,
      password: c.password,
      pool: c.pool,
      sessionId: null,
      target: null,
      targetingString: joinParams(parseLogin(c.username).params),
    }
    this.logger.info(LOG_SCOPE, 'Testing candidate proxy credentials (not saved)', meta)
    try {
      const ip = await this.ipChecker.lookup(connection)
      this.logger.info(LOG_SCOPE, 'Candidate proxy credentials work', { ...meta, ip: ip.ip, country: ip.countryCode, latencyMs: ip.latencyMs })
      return { status: 'working', sessionId: null, ip, error: null }
    } catch (err) {
      const error = err instanceof AppException ? err.toAppError() : toInternalError(err)
      this.logger.warn(LOG_SCOPE, 'Candidate proxy credentials failed', { ...meta, code: error.code, message: error.message })
      return { status: 'failed', sessionId: null, ip: null, error }
    }
  }

  async getCurrentIp(request: ProxyRequest): Promise<IpInfo> {
    const connection = this.buildProxyConfig(request)
    return this.ipChecker.lookup(connection)
  }

  createSession(profileName: string): string {
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
  rotateSession(currentSessionId: string | null, profileName: string): string {
    const base = currentSessionId && STICKY_SESSION_ID_PATTERN.test(currentSessionId) ? currentSessionId : this.createSession(profileName)
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

  private resolveTemplate(override: string | null, pool: ProxyPool): string {
    const candidate = override?.trim()
    if (!candidate) return this.defaultTemplate
    if (!isValidSessionTemplate(candidate)) {
      this.logger.warn(LOG_SCOPE, `Ignoring the session template saved with the ${pool} credentials (missing {username}/{session}); using the default`, {
        pool,
        template: candidate,
      })
      return this.defaultTemplate
    }
    return candidate
  }

  private requirePool(pool: ProxyPool): PoolState {
    const state = this.pools.get(pool)
    if (!state) {
      throw new AppException(
        'PROXY_NOT_CONFIGURED',
        this.pools.size === 0 ? NOT_CONFIGURED_MESSAGE : poolNotConfiguredMessage(pool),
        this.pools.size === 0 ? `missing: ${REQUIRED_CREDENTIAL_FIELDS.join(', ')}` : `pool=${pool}; configured: ${[...this.pools.keys()].join(', ')}`,
      )
    }
    return state
  }
}

function trimSessionId(value: string, max: number = SESSION_ID_MAX_LENGTH): string {
  return value.slice(0, max).replace(/-+$/g, '')
}

function toInternalError(err: unknown): { code: 'INTERNAL'; message: string; detail: string } {
  const detail = stripCredentials(err instanceof Error ? err.message : String(err))
  return { code: 'INTERNAL', message: 'Unexpected error while testing the proxy. Check the logs for details.', detail }
}

/**
 * Proxy manager: resolves per-profile proxy connections (provider + product +
 * sticky session + geo target), runs connectivity tests, persists ProxySession
 * rows and broadcasts session updates.
 *
 * The provider is resolved per request from `profile.providerId` through the
 * provider registry. An unknown provider id fails with INVALID_INPUT naming it;
 * a profile is never silently switched to another provider.
 *
 * Sticky session ids are owned by the profile: whenever this layer picks a new
 * id for a sticky profile (first auto-generated id, a rotation, or a location
 * re-roll) it is written back to the profile so the next launch uses it.
 *
 * Location re-roll (`verifyForLaunch`): a sticky session with a target whose
 * verified exit location falls short of the location policy is retried with a
 * fresh sticky id (`<id>-r<N>`, the provider's rotation scheme) up to the
 * attempt budget. Each attempt is one IP-check request, not browser traffic.
 * Rotating sessions are never re-rolled (they cannot keep an IP).
 *
 * Credentials never leave this layer: logs and emitted sessions carry only the
 * pool, the provider parameter string (no login/password), the session id, the
 * exit IP and latency.
 */
import { DEFAULT_PROVIDER_ID, LOCATION_MATCH_ATTEMPTS_MAX, LOCATION_MATCH_ATTEMPTS_MIN, ProxyCredentialsInputSchema, satisfiesLocationPolicy } from '../../shared/types'
import type {
  GeoTarget,
  IpInfo,
  LocationMatchPolicy,
  ProductKey,
  Profile,
  ProfileInput,
  ProviderId,
  ProviderInfo,
  ProxyConfigStatus,
  ProxyCredentialsInput,
  ProxySession,
  ProxyStatus,
  ProxyTestResult,
  TargetMatch,
} from '../../shared/types'
import { AppException } from '../contracts'
import type {
  LaunchVerification,
  LaunchVerifyOptions,
  LocationsService,
  Logger,
  ProfileRepository,
  ProxyConnection,
  ProxyManager,
  ProxyProvider,
  ProxyProviderResolver,
  ProxyRequest,
  ProxySessionRepository,
} from '../contracts'
import { encodePlaceName, encodeStateName, notConfiguredMessage, productNotConfiguredMessage } from './targeting-text'

export interface ProxyManagerOptions {
  /** Providers by id (the provider registry). */
  providers?: ProxyProviderResolver
  /** Single-provider shortcut (QA CLI, tests): the same as a resolver holding only this provider. */
  provider?: ProxyProvider
  /** Provider for raw gateway tests and `getConfigStatus()` without an id. Defaults to DataImpulse when registered, else the first provider. */
  defaultProviderId?: () => ProviderId
  sessions: ProxySessionRepository
  logger: Logger
  /** When present, auto-generated and rotated sticky session ids are persisted on the profile. */
  profiles?: ProfileRepository
  /** Called after every raw-gateway test (profile === null) so the vault health can show the last result without re-testing. */
  onGatewayTest?: (status: ProxyStatus, at: string) => void
  /** Product for raw-gateway tests (profile === null) of the default provider. Defaults to its first configured product, else its first product. */
  defaultPool?: () => ProductKey
  /**
   * Sticky lifetime (minutes) for profiles that do not set their own (settings.defaultStickyTtlMinutes).
   * Without it a provider uses its own short default: DataImpulse moved sticky sessions to another
   * exit IP after ~5 minutes in testing, which is how a form ended up recorded from a different city.
   */
  defaultStickyTtlMinutes?: () => number | null
  /** Pause between the two checks of the stickiness confirmation (tests use 0). */
  stickyConfirmDelayMs?: number
  /** State catalogue so `compareTarget` can match a USPS code against a state name (and vice versa). */
  locations?: Pick<LocationsService, 'states'>
}

const LOG_SCOPE = 'proxy.manager'
type SessionListener = (session: ProxySession) => void

/** One working IP check made by `verifyForLaunch`. */
/** A resolver over one provider (`get` of any other id fails like the registry does). */
export function singleProviderResolver(provider: ProxyProvider): ProxyProviderResolver {
  return {
    get: (id) => {
      if (id === provider.name) return provider
      throw new AppException('INVALID_INPUT', `Unknown proxy provider "${id}".`, `registered providers: ${provider.name}`)
    },
    has: (id) => id === provider.name,
    ids: () => [provider.name],
  }
}

interface VerifiedAttempt {
  attempt: number
  sessionId: string | null
  result: ProxyTestResult
  ip: IpInfo
  targetMatch: TargetMatch | null
}

/** Strip server-managed fields so a stored Profile can be written back through the repository. */
export function profileInputFrom(profile: Profile): ProfileInput {
  return {
    name: profile.name,
    engine: profile.engine,
    deviceType: profile.deviceType,
    devicePreset: profile.devicePreset,
    viewportWidth: profile.viewportWidth,
    viewportHeight: profile.viewportHeight,
    userAgent: profile.userAgent,
    locale: profile.locale,
    timezone: profile.timezone,
    proxyMode: profile.proxyMode,
    stickySessionId: profile.stickySessionId,
    formUrlOverride: profile.formUrlOverride,
    notes: profile.notes,
    proxyPool: profile.proxyPool,
    providerId: profile.providerId,
    target: profile.target ? { ...profile.target } : null,
    stickyTtlMinutes: profile.stickyTtlMinutes,
    ephemeral: profile.ephemeral,
  }
}

/** Resolves state names ↔ USPS codes from the bundled dataset (built lazily, once). */
export interface StateResolver {
  /** "New Jersey" / "new jersey" / "NJ" → "NJ"; null when unknown. */
  codeFor(regionOrCode: string): string | null
}

function createStateResolver(locations: Pick<LocationsService, 'states'> | undefined): StateResolver {
  let byEncodedName: Map<string, string> | null = null
  let codes: Set<string> | null = null
  const load = (): void => {
    if (byEncodedName && codes) return
    byEncodedName = new Map()
    codes = new Set()
    if (!locations) return
    try {
      for (const state of locations.states()) {
        byEncodedName.set(encodeStateName(state.state), state.stateCode.toUpperCase())
        codes.add(state.stateCode.toUpperCase())
      }
    } catch {
      // Without the dataset only exact name/code comparisons are possible.
    }
  }
  return {
    codeFor(regionOrCode: string): string | null {
      load()
      const trimmed = regionOrCode.trim()
      if (trimmed.length === 0) return null
      const upper = trimmed.toUpperCase()
      if (upper.length === 2 && codes?.has(upper)) return upper
      return byEncodedName?.get(encodeStateName(trimmed)) ?? null
    },
  }
}

/**
 * Comparable form of a postal code: the 5-digit ZIP of a US "07102" / "07102-1234" / "07102 1234",
 * otherwise the trimmed upper-case value. Null when empty.
 */
export function normalizePostalCode(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  if (trimmed.length === 0) return null
  const zip = /^(\d{5})(?:[-\s]?\d{4})?$/.exec(trimmed)
  return zip?.[1] ?? trimmed.toUpperCase()
}

/**
 * Verified-vs-requested comparison. Exported for unit tests; the manager wires
 * the dataset-backed state resolver in.
 *
 * The country is checked first. A ZIP target is verified exactly against the
 * IP service's postal code (an equal ZIP is a match on its own); the same state
 * with a different or unreported ZIP is 'partial'. A city target is a match
 * when the city name agrees, 'partial' within the right state otherwise.
 */
export function compareTargetWith(target: GeoTarget | null, ip: IpInfo | null, states: StateResolver): TargetMatch {
  if (!target || !ip) return 'unknown'
  const wantCountry = target.country.trim().toLowerCase()
  const gotCountry = ip.countryCode?.trim().toLowerCase() ?? null
  if (!gotCountry) return 'unknown'
  if (gotCountry !== wantCountry) return 'mismatch'
  if (target.mode === 'country') return 'match'

  const wantZip = target.mode === 'zip' ? normalizePostalCode(target.zip) : null
  if (wantZip !== null && normalizePostalCode(ip.postalCode) === wantZip) return 'match'
  if (!target.state) return wantZip !== null ? 'partial' : 'match'

  const region = ip.region?.trim() ?? ''
  if (region.length === 0) return 'unknown'
  const wantCode = target.stateCode?.toUpperCase() ?? states.codeFor(target.state)
  const gotCode = states.codeFor(region)
  const stateMatches =
    encodeStateName(region) === encodeStateName(target.state) ||
    (wantCode !== null && region.toUpperCase() === wantCode) ||
    (wantCode !== null && gotCode !== null && gotCode === wantCode)
  if (!stateMatches) return 'mismatch'
  if (target.mode === 'state') return 'match'

  // City (and ZIP): the state matched; the city name decides between partial and match.
  // A ZIP in the requested city counts as a match: IP location databases disagree by a ZIP or two
  // for the same IP (live: one Seattle IP was 98104 in ip-api and 98101 in ipinfo), so a neighbouring
  // ZIP is not evidence of a wrong exit — and re-rolling for it only burns sessions in a thin pool.
  const wantCity = target.city ? encodePlaceName(target.city) : null
  const gotCity = ip.city ? encodePlaceName(ip.city) : null
  if (wantCity && gotCity && wantCity === gotCity) return 'match'
  return 'partial'
}

/** Extra sessions tried when a sticky session does not hold its IP between two checks. */
export const STICKY_CONFIRM_RETRIES = 2
/** Pause between the two checks: unstable sessions changed IP on every request, 3 s apart, in testing. */
export const STICKY_CONFIRM_DELAY_MS = 3_000

/** Preference when no attempt met the location policy (higher wins; ties go to the later attempt). */
const MATCH_RANK: Record<TargetMatch, number> = { match: 3, partial: 2, unknown: 1, mismatch: 0 }

function rankOf(match: TargetMatch | null): number {
  return match === null ? MATCH_RANK.unknown : MATCH_RANK[match]
}

/** "New York, NY 10118" — city, state code (or region name) and postal code of an exit IP; the country is added outside the US. */
export function describeExitLocation(ip: IpInfo, states: StateResolver): string {
  const state = ip.region ? (states.codeFor(ip.region) ?? ip.region) : null
  const statePostal = [state, ip.postalCode].filter((part): part is string => !!part && part.trim().length > 0).join(' ')
  const parts = [ip.city, statePostal].filter((part): part is string => !!part && part.trim().length > 0)
  const code = ip.countryCode?.trim().toUpperCase() ?? null
  if (parts.length === 0) return ip.country ?? code ?? 'an unknown location'
  if (code && code !== 'US') parts.push(code)
  return parts.join(', ')
}

/** What the policy asked for, in words: "New Jersey" (state policy), "Newark, NJ" / "ZIP 07102 (Newark, NJ)" (exact). */
export function describeRequestedLocation(target: GeoTarget, policy: LocationMatchPolicy): string {
  const country = target.country.toUpperCase()
  const stateLabel = target.state ?? target.stateCode ?? country
  const stateShort = target.stateCode ?? target.state
  if (target.mode === 'country') return country
  if (policy !== 'exact' || target.mode === 'state') return stateLabel
  if (target.mode === 'city') return target.city ? (stateShort ? `${target.city}, ${stateShort}` : target.city) : stateLabel
  const place = target.city ? (stateShort ? `${target.city}, ${stateShort}` : target.city) : stateShort
  if (!target.zip) return place ?? stateLabel
  return place ? `ZIP ${target.zip} (${place})` : `ZIP ${target.zip}`
}

/**
 * Wider areas to try, in order, when the target area has no exit IP right now:
 * ZIP → its city → its state; city → its state. State and country targets have nothing wider
 * that still keeps the state, so they return [].
 */
export function widerTargets(target: GeoTarget): GeoTarget[] {
  const state: GeoTarget | null = target.state || target.stateCode ? { ...target, mode: 'state', city: null, zip: null } : null
  if (target.mode === 'zip') {
    const city: GeoTarget | null = target.city ? { ...target, mode: 'city', zip: null } : null
    return [city, state].filter((t): t is GeoTarget => t !== null)
  }
  if (target.mode === 'city') return state ? [state] : []
  return []
}

/** The gateway answered but had no exit IP for this session and area (HTTP 503 → PROXY_DEAD). */
export function isNoExitIpAvailable(error: { code: string; message: string; detail?: string } | null | undefined): boolean {
  if (!error || error.code !== 'PROXY_DEAD') return false
  return /\b503\b/.test(error.detail ?? '') || /no exit IP available/i.test(error.message)
}

/** "ZIP 58250 (Lankin, ND)", "Newark, NJ", "North Dakota" — the area as the user picked it. */
export function describeArea(target: GeoTarget): string {
  return describeRequestedLocation(target, 'exact')
}

/** "same state" / "different state" … for the fallback warning. */
function qualifierFor(match: TargetMatch | null, target: GeoTarget, ip: IpInfo): string {
  switch (match) {
    case 'match':
      return 'match'
    case 'partial':
      return target.state ? 'same state' : 'same country'
    case 'mismatch':
      return ip.countryCode?.trim().toLowerCase() !== target.country.trim().toLowerCase() ? 'different country' : 'different state'
    case 'unknown':
    case null:
      return 'location not comparable'
  }
}

export function createProxyManager(opts: ProxyManagerOptions): ProxyManager {
  const { sessions, logger, profiles } = opts
  const resolver: ProxyProviderResolver | null = opts.providers ?? (opts.provider ? singleProviderResolver(opts.provider) : null)
  if (!resolver) throw new AppException('INTERNAL', 'The proxy manager needs at least one proxy provider.')
  const providers: ProxyProviderResolver = resolver

  function defaultProviderId(): ProviderId {
    const configured = opts.defaultProviderId?.()
    if (configured && providers.has(configured)) return configured
    if (providers.has(DEFAULT_PROVIDER_ID)) return DEFAULT_PROVIDER_ID
    const first = providers.ids()[0]
    if (!first) throw new AppException('INTERNAL', 'No proxy provider is registered.')
    return first
  }

  /** The provider a profile names; INVALID_INPUT naming the id when this build does not have it. */
  function providerFor(profile: Profile | null, override?: ProviderId): ProxyProvider {
    const id = profile ? (profile.providerId ?? DEFAULT_PROVIDER_ID) : (override ?? defaultProviderId())
    if (!providers.has(id) && profile) {
      throw new AppException(
        'INVALID_INPUT',
        `Profile "${profile.name}" uses the proxy provider "${id}", which this version does not support. Edit the profile and pick another provider.`,
        `registered providers: ${providers.ids().join(', ') || 'none'}`,
      )
    }
    return providers.get(id)
  }
  const listeners = new Set<SessionListener>()
  const states = createStateResolver(opts.locations)

  function emit(session: ProxySession): void {
    for (const listener of listeners) {
      try {
        listener(session)
      } catch (err) {
        logger.error(LOG_SCOPE, 'Proxy session listener threw', { error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  /** Persist a new sticky id on the profile (no-op without a repository or when unchanged). */
  function persistStickySessionId(profile: Profile, sessionId: string, reason: string): void {
    if (!profiles || profile.stickySessionId === sessionId) return
    profiles.update(profile.id, { ...profileInputFrom(profile), stickySessionId: sessionId })
    profile.stickySessionId = sessionId
    logger.info(LOG_SCOPE, `Saved sticky session id on profile "${profile.name}" (${reason})`, {
      profileId: profile.id,
      sessionId,
    })
  }

  /** The sticky id a profile should use right now, generating (and saving) one when it has none. */
  function stickySessionIdFor(profile: Profile, provider: ProxyProvider): string {
    if (profile.stickySessionId) return profile.stickySessionId
    const generated = provider.createSession(profile.name)
    persistStickySessionId(profile, generated, 'auto-generated')
    return generated
  }

  function sessionIdFor(profile: Profile | null, provider: ProxyProvider): string | null {
    if (!profile || profile.proxyMode !== 'sticky') return null
    return stickySessionIdFor(profile, provider)
  }

  function gatewayPool(provider: ProxyProvider): ProductKey {
    // The settings' default product applies to the default provider only (another provider may not offer it).
    const preferred = opts.defaultPool?.()
    if (preferred && provider.name === defaultProviderId() && provider.capabilities.products.some((p) => p.key === preferred)) return preferred
    const configured = provider.getConfigStatus().pools.find((p) => p.configured)
    return configured?.pool ?? provider.capabilities.products[0]?.key ?? 'residential'
  }

  /** The profile's own sticky lifetime, else the configured default (null only when neither is set). */
  function effectiveStickyTtl(own: number | null): number | null {
    if (own !== null && own > 0) return own
    const fallback = opts.defaultStickyTtlMinutes?.() ?? null
    return fallback !== null && fallback > 0 ? fallback : null
  }

  /** Everything the provider needs for a profile (or the raw gateway when profile is null). */
  function requestFor(profile: Profile | null, provider: ProxyProvider): ProxyRequest {
    if (!profile) return { pool: gatewayPool(provider), sessionId: null, target: null, ttlMinutes: null }
    return {
      pool: profile.proxyPool,
      sessionId: sessionIdFor(profile, provider),
      target: profile.target ? { ...profile.target } : null,
      ttlMinutes: profile.proxyMode === 'sticky' ? effectiveStickyTtl(profile.stickyTtlMinutes) : null,
    }
  }

  /** PROXY_NOT_CONFIGURED for a product without credentials (or one the provider does not offer). */
  function requireConfigured(provider: ProxyProvider, pool: ProductKey): void {
    if (provider.isPoolConfigured(pool)) return
    const offered = provider.capabilities.products.some((product) => product.key === pool)
    if (offered && !provider.isConfigured()) {
      const status = provider.getConfigStatus()
      throw new AppException('PROXY_NOT_CONFIGURED', notConfiguredMessage(provider.displayName), `provider=${provider.name}; missing: ${status.missing.join(', ') || 'unknown'}`)
    }
    throw new AppException('PROXY_NOT_CONFIGURED', productNotConfiguredMessage(provider, pool), `provider=${provider.name}; pool=${pool}`)
  }

  function contextFor(provider: ProxyProvider, request: ProxyRequest, targetingString: string): { providerId: ProviderId; pool: ProductKey; target: GeoTarget | null; targetingString: string | null } {
    return { providerId: provider.name, pool: request.pool, target: request.target, targetingString: targetingString || null }
  }

  function compareTarget(target: GeoTarget | null, ip: IpInfo | null): TargetMatch {
    return compareTargetWith(target, ip, states)
  }

  async function runTest(profile: Profile | null, provider: ProxyProvider, request: ProxyRequest): Promise<{ result: ProxyTestResult; session: ProxySession }> {
    const profileName = profile?.name ?? 'gateway'
    const connection = provider.buildProxyConfig(request)
    let row = sessions.upsertForProfile(profile?.id ?? null, request.sessionId, contextFor(provider, request, connection.targetingString))
    row = sessions.updateStatus(row.id, { status: 'testing', error: null })
    emit(row)
    logger.info(LOG_SCOPE, 'Proxy test started', {
      profileId: profile?.id ?? null,
      profileName,
      provider: provider.name,
      pool: request.pool,
      sessionId: request.sessionId,
      targeting: connection.targetingString || null,
    })

    const startedAt = Date.now()
    const result = await provider.testConnection(request)
    const elapsedMs = Date.now() - startedAt

    if (result.status === 'working' && result.ip) {
      const targetMatch = request.target ? compareTarget(request.target, result.ip) : null
      row = sessions.updateStatus(row.id, { status: 'working', ip: result.ip, error: null, targetMatch })
      logger.info(LOG_SCOPE, 'Proxy test succeeded', {
        profileId: profile?.id ?? null,
        profileName,
        pool: request.pool,
        sessionId: request.sessionId,
        targeting: connection.targetingString || null,
        ip: result.ip.ip,
        country: result.ip.countryCode,
        region: result.ip.region,
        city: result.ip.city,
        postalCode: result.ip.postalCode,
        targetMatch,
        latencyMs: result.ip.latencyMs,
        elapsedMs,
      })
    } else {
      const error = result.error ?? { code: 'INTERNAL' as const, message: 'Proxy test failed without an error.' }
      row = sessions.updateStatus(row.id, { status: 'failed', ip: null, error: error.message, targetMatch: null })
      logger.error(LOG_SCOPE, 'Proxy test failed', {
        profileId: profile?.id ?? null,
        profileName,
        pool: request.pool,
        sessionId: request.sessionId,
        targeting: connection.targetingString || null,
        code: error.code,
        message: error.message,
        detail: error.detail ?? null,
        elapsedMs,
      })
    }
    emit(row)
    if (profile === null && opts.onGatewayTest) {
      try {
        opts.onGatewayTest(row.status, row.lastCheckedAt ?? row.updatedAt)
      } catch (err) {
        logger.error(LOG_SCOPE, 'Gateway test hook threw', { error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { result, session: row }
  }

  /** Show an earlier attempt again as the profile's proxy session (its sticky id still holds that exit IP). */
  function restoreAttempt(profile: Profile, provider: ProxyProvider, base: ProxyRequest, chosen: VerifiedAttempt): void {
    const request: ProxyRequest = { ...base, sessionId: chosen.sessionId }
    const connection = provider.buildProxyConfig(request)
    let row = sessions.upsertForProfile(profile.id, chosen.sessionId, contextFor(provider, request, connection.targetingString))
    row = sessions.updateStatus(row.id, { status: 'working', ip: chosen.ip, error: null, targetMatch: chosen.targetMatch })
    emit(row)
  }

  /**
   * Checks a sticky session again a few seconds after its first check: the IP it switched to, or
   * null when it kept its IP (or the second check failed — the first one worked, so it gets the benefit).
   */
  async function switchedIp(provider: ProxyProvider, request: ProxyRequest, first: IpInfo): Promise<IpInfo | null> {
    const delay = opts.stickyConfirmDelayMs ?? STICKY_CONFIRM_DELAY_MS
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    try {
      const second = await provider.getCurrentIp(request)
      return second.ip !== first.ip ? second : null
    } catch {
      return null
    }
  }

  /** Logs a session that did not keep its exit IP; the failed verification once that happened more than STICKY_CONFIRM_RETRIES times. */
  function unstableSession(profile: Profile, sessionId: string, first: IpInfo, second: IpInfo, unstable: number, target: GeoTarget | null, attempts: number, maxAttempts: number): LaunchVerification | null {
    logger.warn(LOG_SCOPE, `Sticky session did not keep its exit IP (${first.ip} then ${second.ip})`, { profileId: profile.id, profileName: profile.name, sessionId, unstable })
    if (unstable <= STICKY_CONFIRM_RETRIES) return null
    const where = target ? describeArea(target) : 'this location'
    const error = {
      code: 'IP_UNSTABLE' as const,
      message: `The proxy could not keep one IP in ${where}: the IP changed within seconds in ${unstable} sessions in a row. Try again in a minute or choose another location.`,
      detail: `${first.ip} then ${second.ip}`,
    }
    return { result: { status: 'failed', sessionId, ip: null, error }, targetMatch: null, attempts, maxAttempts, sessionId, warning: null }
  }

  /**
   * The requested area had no exit IP: try each wider area once with a fresh sticky id. The first
   * one that works is used for this launch (the saved profile keeps its own target); null when none does.
   */
  async function tryWiderAreas(profile: Profile, provider: ProxyProvider, base: ProxyRequest, target: GeoTarget, options: LaunchVerifyOptions): Promise<LaunchVerification | null> {
    const candidates = widerTargets(target).filter((wider) => provider.capabilities.targetModes.includes(wider.mode))
    let sessionId = base.sessionId
    let checks = 1
    for (const wider of candidates) {
      if (options.shouldContinue && !options.shouldContinue()) return null
      if (sessionId !== null) sessionId = provider.rotateSession(sessionId, profile.name)
      checks += 1
      options.onProgress?.({ attempt: checks, attempts: checks, sessionId, message: `No exit IPs in ${describeArea(target)} right now — trying ${describeArea(wider)}…` })
      let { result } = await runTest(profile, provider, { ...base, target: wider, sessionId })
      let unstable = 0
      while (result.status === 'working' && result.ip && options.confirmSticky && sessionId !== null) {
        const second = await switchedIp(provider, { ...base, target: wider, sessionId }, result.ip)
        if (!second) break
        unstable += 1
        const failed = unstableSession(profile, sessionId, result.ip, second, unstable, wider, checks, checks)
        if (failed) return failed
        sessionId = provider.rotateSession(sessionId, profile.name)
        options.onProgress?.({ attempt: checks, attempts: checks, sessionId, message: `Exit IP ${result.ip.ip} changed to ${second.ip} within seconds — trying another session…` })
        ;({ result } = await runTest(profile, provider, { ...base, target: wider, sessionId }))
      }
      if (result.status === 'working' && result.ip) {
        if (sessionId !== null) persistStickySessionId(profile, sessionId, `widened to ${describeArea(wider)}`)
        const targetMatch = compareTarget(wider, result.ip)
        const warning = `No exit IPs available in ${describeArea(target)} right now; connected via ${describeArea(wider)} instead (${describeExitLocation(result.ip, states)}).`
        logger.warn(LOG_SCOPE, warning, { profileId: profile.id, profileName: profile.name, requested: describeArea(target), widenedTo: describeArea(wider), sessionId, targetMatch })
        return { result, targetMatch, attempts: checks, maxAttempts: checks, sessionId, warning, widenedTarget: wider }
      }
      if (!isNoExitIpAvailable(result.error)) return null
    }
    return null
  }

  async function verifyForLaunch(profile: Profile, options: LaunchVerifyOptions): Promise<LaunchVerification> {
    if (profile.proxyMode === 'none') {
      throw new AppException('INVALID_PROFILE', `Profile "${profile.name}" does not use a proxy; there is no proxy exit IP to verify.`)
    }
    const provider = providerFor(profile)
    const base = requestFor(profile, provider)
    requireConfigured(provider, base.pool)
    const { policy } = options
    const target = base.target
    // Only a sticky session can be re-rolled: a rotating one gets a new IP per request anyway.
    const canReroll = profile.proxyMode === 'sticky' && base.sessionId !== null && target !== null && policy !== 'off'
    const requested = target ? describeRequestedLocation(target, policy) : null
    const maxAttempts = canReroll
      ? Math.min(LOCATION_MATCH_ATTEMPTS_MAX, Math.max(LOCATION_MATCH_ATTEMPTS_MIN, Math.trunc(options.attempts) || LOCATION_MATCH_ATTEMPTS_MIN))
      : 1

    let request = base
    let best: VerifiedAttempt | null = null
    let attempts = 0
    let stopped = false
    /** Why re-rolling ended before the budget was spent (gateway refused another session, credentials rejected). */
    let gaveUp: string | null = null
    let unstable = 0
    while (attempts < maxAttempts) {
      attempts += 1
      const { result } = await runTest(profile, provider, request)
      let progressReason: string
      if (result.status === 'working' && result.ip) {
        const targetMatch = target ? compareTarget(target, result.ip) : null
        const current: VerifiedAttempt = { attempt: attempts, sessionId: request.sessionId, result, ip: result.ip, targetMatch }
        const acceptable = !canReroll || satisfiesLocationPolicy(policy, targetMatch)
        // Only the session about to be used is checked a second time; one being re-rolled for its location is dropped anyway.
        if (acceptable && options.confirmSticky && request.sessionId !== null) {
          const second = await switchedIp(provider, request, result.ip)
          if (second) {
            unstable += 1
            const failed = unstableSession(profile, request.sessionId, result.ip, second, unstable, target, attempts, maxAttempts)
            if (failed) return failed
            // An unstable session does not use up the location budget: try a fresh one.
            attempts -= 1
            const next = provider.rotateSession(request.sessionId, profile.name)
            persistStickySessionId(profile, next, 'previous session did not keep its exit IP')
            request = { ...base, sessionId: next }
            options.onProgress?.({ attempt: attempts + 1, attempts: maxAttempts, sessionId: next, message: `Exit IP ${result.ip.ip} changed to ${second.ip} within seconds — trying another session…` })
            continue
          }
        }
        // Ties go to the later attempt.
        if (!best || rankOf(targetMatch) >= rankOf(best.targetMatch)) best = current
        if (acceptable) {
          if (attempts > 1) {
            logger.info(LOG_SCOPE, `Exit location met the "${policy}" location policy on attempt ${attempts}/${maxAttempts}`, {
              profileId: profile.id,
              profileName: profile.name,
              requested,
              got: describeExitLocation(result.ip, states),
              postalCode: result.ip.postalCode,
              targetMatch,
              sessionId: request.sessionId,
            })
          }
          return { result, targetMatch, attempts, maxAttempts, sessionId: request.sessionId, warning: null }
        }
        progressReason = `Exit IP ${result.ip.ip} is in ${describeExitLocation(result.ip, states)}`
      } else {
        // The first check failing means there is nothing to launch with — unless the area simply has no
        // exit IP right now, in which case a wider area may (ZIP → city → state). A failed re-roll only costs an attempt.
        if (attempts === 1) {
          if (options.widenWhenUnavailable && target && isNoExitIpAvailable(result.error)) {
            const widened = await tryWiderAreas(profile, provider, base, target, options)
            if (widened) return widened
          }
          return { result, targetMatch: null, attempts, maxAttempts, sessionId: request.sessionId, warning: null }
        }
        const code = result.error?.code ?? 'INTERNAL'
        logger.warn(LOG_SCOPE, `Location re-roll attempt ${attempts}/${maxAttempts} could not verify the exit IP`, {
          profileId: profile.id,
          profileName: profile.name,
          sessionId: request.sessionId,
          code,
          message: result.error?.message ?? null,
        })
        // Another session id cannot fix rejected credentials. Whether any other failure is worth a new session id is the
        // provider's call: DataImpulse's gateway, once it refused a new sticky session (PROXY_DEAD after the IP checker's
        // own retries — live: HTTP 503 once a thin ZIP pool's IPs were all pinned), keeps refusing until a session expires.
        const error = result.error ?? { code, message: 'Proxy test failed without an error.' }
        if (code === 'PROXY_AUTH_FAILED') {
          gaveUp = 'the proxy rejected the credentials (PROXY_AUTH_FAILED)'
          break
        }
        if (provider.isRetryableLocationFailure && !provider.isRetryableLocationFailure(error)) {
          gaveUp =
            code === 'PROXY_DEAD'
              ? 'the gateway refused a new sticky session (PROXY_DEAD); this location may have no free exit IP right now'
              : `the provider reported a failure another session cannot fix (${code})`
          break
        }
        progressReason = `Attempt ${attempts} could not verify the exit IP (${code})`
      }
      if (attempts >= maxAttempts) break
      if (options.shouldContinue && !options.shouldContinue()) {
        stopped = true
        break
      }

      const next = provider.rotateSession(request.sessionId, profile.name)
      const message = `${progressReason} — re-rolling session (${attempts + 1}/${maxAttempts})…`
      logger.info(LOG_SCOPE, `Re-rolling the sticky session for the "${policy}" location policy (${attempts + 1}/${maxAttempts})`, {
        profileId: profile.id,
        profileName: profile.name,
        policy,
        requested,
        got: best && best.attempt === attempts ? describeExitLocation(best.ip, states) : null,
        postalCode: best && best.attempt === attempts ? best.ip.postalCode : null,
        targetMatch: best && best.attempt === attempts ? best.targetMatch : null,
        fromSessionId: request.sessionId,
        toSessionId: next,
      })
      persistStickySessionId(profile, next, 're-rolled for the location policy')
      request = { ...base, sessionId: next }
      options.onProgress?.({ attempt: attempts + 1, attempts: maxAttempts, sessionId: next, message })
    }

    // No attempt met the policy: continue with the best working result (attempt 1 worked, so there is one).
    if (!best || !target) throw new AppException('INTERNAL', 'Location re-roll ended without a verified exit IP.')
    const chosen = best
    if (chosen.sessionId !== null && chosen.sessionId !== request.sessionId) {
      persistStickySessionId(profile, chosen.sessionId, `best location result, attempt ${chosen.attempt}`)
      restoreAttempt(profile, provider, base, chosen)
    }
    const got = describeExitLocation(chosen.ip, states)
    if (stopped) {
      logger.info(LOG_SCOPE, `Location re-roll stopped after ${attempts}/${maxAttempts} attempts (launch cancelled)`, {
        profileId: profile.id,
        profileName: profile.name,
        sessionId: chosen.sessionId,
      })
      return { result: chosen.result, targetMatch: chosen.targetMatch, attempts, maxAttempts, sessionId: chosen.sessionId, warning: null }
    }
    const reason = gaveUp && attempts < maxAttempts ? `. Re-rolling stopped early: ${gaveUp}.` : ''
    const warning = `Could not get an exit IP in ${describeRequestedLocation(target, policy)} after ${attempts} attempt${attempts === 1 ? '' : 's'}; using ${got} (${qualifierFor(chosen.targetMatch, target, chosen.ip)})${reason}`
    logger.warn(LOG_SCOPE, warning, {
      profileId: profile.id,
      profileName: profile.name,
      policy,
      requested,
      got,
      ip: chosen.ip.ip,
      postalCode: chosen.ip.postalCode,
      targetMatch: chosen.targetMatch,
      attempts,
      maxAttempts,
      chosenAttempt: chosen.attempt,
      stoppedEarly: gaveUp !== null,
      sessionId: chosen.sessionId,
    })
    return { result: chosen.result, targetMatch: chosen.targetMatch, attempts, maxAttempts, sessionId: chosen.sessionId, warning }
  }

  return {
    getConfigStatus(providerId?: ProviderId): ProxyConfigStatus {
      return providers.get(providerId ?? defaultProviderId()).getConfigStatus()
    },

    providers(): ProviderInfo[] {
      return providers.ids().map((id) => {
        const provider = providers.get(id)
        return {
          id: provider.name,
          displayName: provider.displayName,
          docsUrl: provider.docsUrl,
          capabilities: structuredClone(provider.capabilities),
          sessionTemplate: provider.sessionTemplateDefault ?? null,
          status: provider.getConfigStatus(),
        }
      })
    },

    testCredentials(input: ProxyCredentialsInput): Promise<ProxyTestResult> {
      // The provider id names the gateway to test through; an unknown id fails with INVALID_INPUT naming it.
      const providerId = ProxyCredentialsInputSchema.shape.providerId.safeParse(input.providerId)
      return providers.get(providerId.success ? providerId.data : DEFAULT_PROVIDER_ID).testCredentials(input)
    },

    resolveForProfile(profile: Profile): ProxyConnection | null {
      if (profile.proxyMode === 'none') return null
      const provider = providerFor(profile)
      return provider.buildProxyConfig(requestFor(profile, provider))
    },

    compareTarget,

    async testConnection(profile: Profile | null, pool?: ProductKey, providerId?: ProviderId): Promise<ProxyTestResult> {
      if (profile && profile.proxyMode === 'none') {
        throw new AppException(
          'INVALID_PROFILE',
          `Profile "${profile.name}" has proxy mode "none"; there is no proxy to test. Switch it to a sticky or rotating proxy mode first.`,
        )
      }
      // A raw gateway test may name its provider and product (Settings → Advanced → Proxy keys tests each one); profiles always use their own.
      const provider = providerFor(profile, profile === null ? providerId : undefined)
      const base = requestFor(profile, provider)
      const request = profile === null && pool !== undefined ? { ...base, pool } : base
      requireConfigured(provider, request.pool)
      const { result } = await runTest(profile, provider, request)
      return result
    },

    verifyForLaunch,

    async getCurrentIp(profile: Profile | null): Promise<IpInfo> {
      if (profile && profile.proxyMode === 'none') {
        throw new AppException('INVALID_PROFILE', `Profile "${profile.name}" does not use a proxy; it has no proxy exit IP.`)
      }
      const provider = providerFor(profile)
      return provider.getCurrentIp(requestFor(profile, provider))
    },

    async rotateSession(profile: Profile): Promise<ProxySession> {
      if (profile.proxyMode !== 'sticky') {
        throw new AppException(
          'INVALID_PROFILE',
          `Profile "${profile.name}" is not in sticky-session mode; only sticky sessions can be rotated.`,
          `proxyMode=${profile.proxyMode}`,
        )
      }
      const provider = providerFor(profile)
      requireConfigured(provider, profile.proxyPool)
      const existing = sessions.getByProfile(profile.id)
      const current = profile.stickySessionId ?? existing?.sessionId ?? null
      const next = provider.rotateSession(current, profile.name)
      logger.info(LOG_SCOPE, 'Rotating sticky session', { profileId: profile.id, profileName: profile.name, provider: provider.name, pool: profile.proxyPool, from: current, to: next })
      // Write the new id back first so the profile and its session row never disagree, even if the test fails.
      persistStickySessionId(profile, next, 'rotated')
      const { session } = await runTest(profile, provider, { ...requestFor(profile, provider), sessionId: next })
      return session
    },

    listSessions(): ProxySession[] {
      return sessions.list()
    },

    onSessionUpdate(listener: SessionListener): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * Proxy manager: resolves per-profile proxy connections (pool + sticky session +
 * geo target), runs connectivity tests, persists ProxySession rows and
 * broadcasts session updates.
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
import { LOCATION_MATCH_ATTEMPTS_MAX, LOCATION_MATCH_ATTEMPTS_MIN, satisfiesLocationPolicy } from '../../shared/types'
import type {
  GeoTarget,
  IpInfo,
  LocationMatchPolicy,
  Profile,
  ProfileInput,
  ProxyConfigStatus,
  ProxyCredentialsInput,
  ProxyPool,
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
  ProxyRequest,
  ProxySessionRepository,
} from '../contracts'
import { NOT_CONFIGURED_MESSAGE, encodePlaceName, encodeStateName, poolNotConfiguredMessage } from './providers/dataimpulse'

export interface ProxyManagerOptions {
  provider: ProxyProvider
  sessions: ProxySessionRepository
  logger: Logger
  /** When present, auto-generated and rotated sticky session ids are persisted on the profile. */
  profiles?: ProfileRepository
  /** Called after every raw-gateway test (profile === null) so the vault health can show the last result without re-testing. */
  onGatewayTest?: (status: ProxyStatus, at: string) => void
  /** Pool for raw-gateway tests (profile === null). Defaults to settings-free behaviour: the first configured pool, else residential. */
  defaultPool?: () => ProxyPool
  /** State catalogue so `compareTarget` can match a USPS code against a state name (and vice versa). */
  locations?: Pick<LocationsService, 'states'>
}

const LOG_SCOPE = 'proxy.manager'
type SessionListener = (session: ProxySession) => void

/** One working IP check made by `verifyForLaunch`. */
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
  // ZIP: the state matched but the postal code differs (or the IP service did not report one).
  if (wantZip !== null) return 'partial'

  // City: the state matched; the city name decides between partial and match.
  const wantCity = target.city ? encodePlaceName(target.city) : null
  const gotCity = ip.city ? encodePlaceName(ip.city) : null
  if (wantCity && gotCity && wantCity === gotCity) return 'match'
  return 'partial'
}

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
  const { provider, sessions, logger, profiles } = opts
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
  function stickySessionIdFor(profile: Profile): string {
    if (profile.stickySessionId) return profile.stickySessionId
    const generated = provider.createSession(profile.name)
    persistStickySessionId(profile, generated, 'auto-generated')
    return generated
  }

  function sessionIdFor(profile: Profile | null): string | null {
    if (!profile || profile.proxyMode !== 'dataimpulse-sticky') return null
    return stickySessionIdFor(profile)
  }

  function gatewayPool(): ProxyPool {
    if (opts.defaultPool) return opts.defaultPool()
    const configured = provider.getConfigStatus().pools.find((p) => p.configured)
    return configured?.pool ?? 'residential'
  }

  /** Everything the provider needs for a profile (or the raw gateway when profile is null). */
  function requestFor(profile: Profile | null): ProxyRequest {
    if (!profile) return { pool: gatewayPool(), sessionId: null, target: null, ttlMinutes: null }
    return {
      pool: profile.proxyPool,
      sessionId: sessionIdFor(profile),
      target: profile.target ? { ...profile.target } : null,
      ttlMinutes: profile.proxyMode === 'dataimpulse-sticky' ? profile.stickyTtlMinutes : null,
    }
  }

  function requireConfigured(pool: ProxyPool): void {
    if (provider.isPoolConfigured(pool)) return
    if (!provider.isConfigured()) {
      const status = provider.getConfigStatus()
      throw new AppException('PROXY_NOT_CONFIGURED', NOT_CONFIGURED_MESSAGE, `missing: ${status.missing.join(', ') || 'unknown'}`)
    }
    throw new AppException('PROXY_NOT_CONFIGURED', poolNotConfiguredMessage(pool), `pool=${pool}`)
  }

  function compareTarget(target: GeoTarget | null, ip: IpInfo | null): TargetMatch {
    return compareTargetWith(target, ip, states)
  }

  async function runTest(profile: Profile | null, request: ProxyRequest): Promise<{ result: ProxyTestResult; session: ProxySession }> {
    const profileName = profile?.name ?? 'gateway'
    const connection = provider.buildProxyConfig(request)
    let row = sessions.upsertForProfile(profile?.id ?? null, request.sessionId, {
      pool: request.pool,
      target: request.target,
      targetingString: connection.targetingString || null,
    })
    row = sessions.updateStatus(row.id, { status: 'testing', error: null })
    emit(row)
    logger.info(LOG_SCOPE, 'Proxy test started', {
      profileId: profile?.id ?? null,
      profileName,
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
  function restoreAttempt(profile: Profile, base: ProxyRequest, chosen: VerifiedAttempt): void {
    const request: ProxyRequest = { ...base, sessionId: chosen.sessionId }
    const connection = provider.buildProxyConfig(request)
    let row = sessions.upsertForProfile(profile.id, chosen.sessionId, { pool: request.pool, target: request.target, targetingString: connection.targetingString || null })
    row = sessions.updateStatus(row.id, { status: 'working', ip: chosen.ip, error: null, targetMatch: chosen.targetMatch })
    emit(row)
  }

  async function verifyForLaunch(profile: Profile, options: LaunchVerifyOptions): Promise<LaunchVerification> {
    if (profile.proxyMode === 'none') {
      throw new AppException('INVALID_PROFILE', `Profile "${profile.name}" does not use a proxy; there is no proxy exit IP to verify.`)
    }
    const base = requestFor(profile)
    requireConfigured(base.pool)
    const { policy } = options
    const target = base.target
    // Only a sticky session can be re-rolled: a rotating one gets a new IP per request anyway.
    const canReroll = profile.proxyMode === 'dataimpulse-sticky' && base.sessionId !== null && target !== null && policy !== 'off'
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
    while (attempts < maxAttempts) {
      attempts += 1
      const { result } = await runTest(profile, request)
      let progressReason: string
      if (result.status === 'working' && result.ip) {
        const targetMatch = target ? compareTarget(target, result.ip) : null
        const current: VerifiedAttempt = { attempt: attempts, sessionId: request.sessionId, result, ip: result.ip, targetMatch }
        // Ties go to the later attempt.
        if (!best || rankOf(targetMatch) >= rankOf(best.targetMatch)) best = current
        if (!canReroll || satisfiesLocationPolicy(policy, targetMatch)) {
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
        // The first check failing means there is nothing to launch with; a failed re-roll only costs an attempt.
        if (attempts === 1) return { result, targetMatch: null, attempts, maxAttempts, sessionId: request.sessionId, warning: null }
        const code = result.error?.code ?? 'INTERNAL'
        logger.warn(LOG_SCOPE, `Location re-roll attempt ${attempts}/${maxAttempts} could not verify the exit IP`, {
          profileId: profile.id,
          profileName: profile.name,
          sessionId: request.sessionId,
          code,
          message: result.error?.message ?? null,
        })
        // Another session id cannot fix rejected credentials, and a gateway that already refused a new sticky session
        // (PROXY_DEAD after the IP checker's own retries — live: HTTP 503 once a thin ZIP pool's IPs were all pinned)
        // keeps refusing until a session expires, so further re-rolls would only cost time.
        if (code === 'PROXY_AUTH_FAILED' || code === 'PROXY_DEAD') {
          gaveUp = code === 'PROXY_AUTH_FAILED' ? 'the proxy rejected the credentials (PROXY_AUTH_FAILED)' : 'the gateway refused a new sticky session (PROXY_DEAD); this location may have no free exit IP right now'
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
      restoreAttempt(profile, base, chosen)
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
    getConfigStatus(): ProxyConfigStatus {
      return provider.getConfigStatus()
    },

    testCredentials(input: ProxyCredentialsInput): Promise<ProxyTestResult> {
      return provider.testCredentials(input)
    },

    resolveForProfile(profile: Profile): ProxyConnection | null {
      if (profile.proxyMode === 'none') return null
      return provider.buildProxyConfig(requestFor(profile))
    },

    compareTarget,

    async testConnection(profile: Profile | null, pool?: ProxyPool): Promise<ProxyTestResult> {
      if (profile && profile.proxyMode === 'none') {
        throw new AppException(
          'INVALID_PROFILE',
          `Profile "${profile.name}" has proxy mode "none"; there is no proxy to test. Switch it to a DataImpulse mode first.`,
        )
      }
      const base = requestFor(profile)
      // A raw gateway test may name its pool (Settings → Advanced → Proxy keys tests each pool); profiles always use their own.
      const request = profile === null && pool !== undefined ? { ...base, pool } : base
      requireConfigured(request.pool)
      const { result } = await runTest(profile, request)
      return result
    },

    verifyForLaunch,

    async getCurrentIp(profile: Profile | null): Promise<IpInfo> {
      if (profile && profile.proxyMode === 'none') {
        throw new AppException('INVALID_PROFILE', `Profile "${profile.name}" does not use a proxy; it has no proxy exit IP.`)
      }
      return provider.getCurrentIp(requestFor(profile))
    },

    async rotateSession(profile: Profile): Promise<ProxySession> {
      if (profile.proxyMode !== 'dataimpulse-sticky') {
        throw new AppException(
          'INVALID_PROFILE',
          `Profile "${profile.name}" is not in sticky-session mode; only sticky sessions can be rotated.`,
          `proxyMode=${profile.proxyMode}`,
        )
      }
      requireConfigured(profile.proxyPool)
      const existing = sessions.getByProfile(profile.id)
      const current = profile.stickySessionId ?? existing?.sessionId ?? null
      const next = provider.rotateSession(current, profile.name)
      logger.info(LOG_SCOPE, 'Rotating sticky session', { profileId: profile.id, profileName: profile.name, pool: profile.proxyPool, from: current, to: next })
      // Write the new id back first so the profile and its session row never disagree, even if the test fails.
      persistStickySessionId(profile, next, 'rotated')
      const { session } = await runTest(profile, { ...requestFor(profile), sessionId: next })
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

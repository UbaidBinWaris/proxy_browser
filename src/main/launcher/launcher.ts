/**
 * Quick Launch: one-shot "Connect & Launch" from the launcher page.
 *
 * `preview()` shows the exact DataImpulse parameter string the launch would
 * send (no login, no password) together with warnings (pool not configured,
 * double-rate geo targeting). `quickLaunch()` turns the form into a profile —
 * ephemeral (hidden from the Profiles page) unless "save as profile" is on —
 * and launches it through the BrowserManager, which returns at once with the
 * 'starting' session and reports progress through events.
 *
 * Single-session rule (settings.singleSessionMode): when another session is
 * open, the launch is refused with SESSION_LIMIT unless the caller asked to
 * replace it, in which case every live session is closed first. The browser
 * manager applies the same rule as the final authority; a profile created here
 * that fails to launch synchronously is removed again when it is ephemeral.
 *
 * An engine with a queued or running install task is refused with ENGINE_BUSY
 * before anything else happens (in particular before an open session is
 * replaced), so a refused launch never costs the user their current session.
 */
import type { AppSettings, BrowserSession, GeoTarget, ProfileInput, ProxyPool, QuickLaunchInput, SessionStatus, TargetingPreview } from '@shared/types'
import { QuickLaunchInputSchema } from '@shared/types'

import { AppException } from '../contracts'
import type { BrowserManager, Launcher, LocationsService, Logger, ProfileManager, ProxyProvider, ProxyRequest } from '../contracts'
import { SESSION_LIMIT_MESSAGE } from '../browser/browser-manager'
import { poolNotConfiguredMessage } from '../proxy/providers/dataimpulse'

const SCOPE = 'launcher'
const PROFILE_NAME_MAX = 80
const QUICK_LAUNCH_NOTES = 'Quick Launch'
const SESSION_ID_RANDOM_LENGTH = 4
const SESSION_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
/** Most of the US population lives in Eastern time; used when a US target carries no state. */
const DEFAULT_US_TIMEZONE = 'America/New_York'
export const DEFAULT_LOCALE = 'en-US'

export const DOUBLE_RATE_WARNING = 'State/city/ZIP targeting is billed at 2× by DataImpulse.'
export const DIRECT_TARGET_WARNING = 'Direct connection: the exit location is not controlled, so the geo target is ignored.'

export interface LauncherOptions {
  profiles: ProfileManager
  browser: BrowserManager
  /** Provider access needed for the preview: parameter string + pool configuration. */
  targeting: Pick<ProxyProvider, 'buildTargetingString' | 'isPoolConfigured'>
  locations: Pick<LocationsService, 'timezoneForState'>
  getSettings: () => AppSettings
  logger: Logger
  /** Why the engine cannot be launched right now (install task queued/running), or null. */
  engineBusyMessage?: (engine: QuickLaunchInput['engine']) => string | null
  now?: () => Date
  random?: () => number
}

/** Session statuses the launcher treats as "open" (an 'error' session without a window is a dismissable leftover). */
export const BLOCKING_SESSION_STATUSES: readonly SessionStatus[] = ['starting', 'verifying-proxy', 'launching', 'open', 'closing']

/** True when the target asks for more than a country (DataImpulse bills these at double rate). */
export function hasGeoFilter(target: GeoTarget | null): boolean {
  return target !== null && (target.state !== null || target.city !== null || target.zip !== null)
}

/** Human label of a target for profile names: "US", "New Jersey", "Newark, NJ", "07102 (Newark, NJ)". */
export function describeTarget(target: GeoTarget | null): string {
  if (!target) return 'US'
  const state = target.stateCode ?? target.state
  if (target.zip) return `${target.zip}${target.city && state ? ` (${target.city}, ${state})` : state ? ` (${state})` : ''}`
  if (target.city) return state ? `${target.city}, ${state}` : target.city
  if (target.state) return target.state
  return target.country.toUpperCase()
}

export function poolLabel(pool: ProxyPool | 'none'): string {
  switch (pool) {
    case 'residential':
      return 'Residential'
    case 'mobile':
      return 'Mobile'
    case 'none':
      return 'Direct'
  }
}

/**
 * "<Pool> · <target> · <preset label>", capped at the profile-name limit. A direct connection has no
 * exit location to name, so it is just "Direct · <preset label>".
 */
export function quickLaunchProfileName(pool: ProxyPool | 'none', target: GeoTarget | null, presetLabel: string): string {
  const name = pool === 'none' ? `${poolLabel(pool)} · ${presetLabel}` : `${poolLabel(pool)} · ${describeTarget(target)} · ${presetLabel}`
  return name.length <= PROFILE_NAME_MAX ? name : `${name.slice(0, PROFILE_NAME_MAX - 1).trimEnd()}…`
}

/** `ql-<yyyymmdd>-<4 random [a-z0-9]>` — within the profile sticky-id charset. */
export function generateQuickLaunchSessionId(now: Date = new Date(), random: () => number = Math.random): string {
  const date = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`
  let suffix = ''
  for (let i = 0; i < SESSION_ID_RANDOM_LENGTH; i += 1) {
    const index = Math.min(SESSION_ID_ALPHABET.length - 1, Math.max(0, Math.floor(random() * SESSION_ID_ALPHABET.length)))
    suffix += SESSION_ID_ALPHABET[index]
  }
  return `ql-${date}-${suffix}`
}

function hostTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function parseInput(input: unknown): QuickLaunchInput {
  const result = QuickLaunchInputSchema.safeParse(input)
  if (!result.success) {
    const issue = result.error.issues[0]
    const field = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''
    throw new AppException('INVALID_INPUT', `${field}${issue?.message ?? 'Invalid quick launch input'}`)
  }
  return result.data
}

export function createLauncher(opts: LauncherOptions): Launcher {
  const { profiles, browser, targeting, locations, getSettings, logger } = opts
  const now = opts.now ?? ((): Date => new Date())
  const random = opts.random ?? Math.random

  const requestFor = (input: QuickLaunchInput, pool: ProxyPool, sessionId: string | null): ProxyRequest => ({
    pool,
    sessionId,
    target: input.target,
    ttlMinutes: sessionId ? input.stickyTtlMinutes : null,
  })

  /** Explicit override → state time zone → Eastern for a US-wide target → the host's zone for anything else. */
  const deriveTimezone = (input: QuickLaunchInput): string => {
    if (input.timezone) return input.timezone
    const code = input.target?.stateCode
    const fromState = code ? locations.timezoneForState(code) : null
    if (fromState) return fromState
    if (!input.target || input.target.country === 'us') return DEFAULT_US_TIMEZONE
    return hostTimezone()
  }

  const preview = (raw: unknown): TargetingPreview => {
    const input = parseInput(raw)
    const pool = input.proxyPool
    if (pool === 'none') {
      return { pool, targetingString: null, poolConfigured: true, warnings: hasGeoFilter(input.target) ? [DIRECT_TARGET_WARNING] : [] }
    }
    const sessionId = input.sticky ? generateQuickLaunchSessionId(now(), random) : null
    const targetingString = targeting.buildTargetingString(requestFor(input, pool, sessionId))
    const poolConfigured = targeting.isPoolConfigured(pool)
    const warnings: string[] = []
    if (!poolConfigured) warnings.push(poolNotConfiguredMessage(pool))
    if (hasGeoFilter(input.target)) warnings.push(DOUBLE_RATE_WARNING)
    return { pool, targetingString: targetingString.length > 0 ? targetingString : null, poolConfigured, warnings }
  }

  /** Enforce singleSessionMode before anything is created; with `replace` every live session is closed first. */
  const enforceSingleSession = async (replace: boolean): Promise<void> => {
    if (!getSettings().singleSessionMode) return
    const active = browser.listActive()
    const blocking = active.filter((session) => BLOCKING_SESSION_STATUSES.includes(session.status))
    if (blocking.length === 0) return
    if (!replace) {
      throw new AppException('SESSION_LIMIT', SESSION_LIMIT_MESSAGE, `open: ${blocking.map((s) => `${s.profileName} (${s.status})`).join(', ')}`)
    }
    logger.info(SCOPE, `Replacing ${active.length} active session(s) before quick launch`, { sessionIds: active.map((s) => s.id) })
    for (const session of active) {
      try {
        await browser.close(session.id)
      } catch (err) {
        // SESSION_CLOSED / NOT_FOUND: it went away on its own in the meantime.
        if (!(err instanceof AppException && (err.code === 'SESSION_CLOSED' || err.code === 'NOT_FOUND'))) throw err
      }
    }
  }

  const quickLaunch = async (raw: unknown): Promise<BrowserSession> => {
    const input = parseInput(raw)
    const preset = profiles.presets().find((candidate) => candidate.id === input.devicePreset)
    if (!preset) throw new AppException('INVALID_INPUT', `devicePreset: unknown device preset "${input.devicePreset}". Pick a preset from the catalogue.`)

    const pool = input.proxyPool
    if (pool !== 'none' && !targeting.isPoolConfigured(pool)) {
      throw new AppException('PROXY_NOT_CONFIGURED', poolNotConfiguredMessage(pool), `pool=${pool}`)
    }
    const busy = opts.engineBusyMessage?.(input.engine) ?? null
    if (busy) throw new AppException('ENGINE_BUSY', busy)
    await enforceSingleSession(input.replaceActiveSession)

    const sticky = pool !== 'none' && input.sticky
    const stickySessionId = sticky ? generateQuickLaunchSessionId(now(), random) : null
    const target = pool === 'none' ? null : input.target
    const profileInput: ProfileInput = {
      name: input.profileName ?? quickLaunchProfileName(pool, input.target, preset.label),
      engine: input.engine,
      deviceType: preset.deviceType,
      devicePreset: preset.id,
      viewportWidth: preset.viewportWidth,
      viewportHeight: preset.viewportHeight,
      userAgent: null,
      locale: input.locale ?? DEFAULT_LOCALE,
      timezone: deriveTimezone(input),
      proxyMode: pool === 'none' ? 'none' : sticky ? 'dataimpulse-sticky' : 'dataimpulse-rotating',
      stickySessionId,
      formUrlOverride: input.startUrl,
      notes: QUICK_LAUNCH_NOTES,
      proxyPool: pool === 'none' ? getSettings().defaultProxyPool : pool,
      target,
      stickyTtlMinutes: sticky ? input.stickyTtlMinutes : null,
      ephemeral: !input.saveAsProfile,
    }
    const profile = profiles.create(profileInput)
    logger.info(SCOPE, `Quick launch: ${profile.name}`, {
      profileId: profile.id,
      ephemeral: profile.ephemeral,
      engine: profile.engine,
      devicePreset: profile.devicePreset,
      pool,
      target,
      sticky,
      stickySessionId,
      timezone: profile.timezone,
      startUrl: input.startUrl,
    })
    try {
      return await browser.launch(profile)
    } catch (err) {
      // Nothing references a profile whose launch failed before a run existed; drop the ephemeral one again.
      if (profile.ephemeral) {
        try {
          profiles.delete(profile.id)
        } catch (cleanupErr) {
          logger.warn(SCOPE, 'Could not remove the ephemeral profile after a failed launch', {
            profileId: profile.id,
            error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          })
        }
      }
      throw err
    }
  }

  return {
    preview,
    quickLaunch,
    closeAll: () => browser.closeAll(),
  }
}

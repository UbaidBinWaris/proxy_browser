/**
 * Profile manager: validation, normalisation and launch-readiness checks on top
 * of the ProfileRepository. All renderer input enters through `create`/`update`
 * as `unknown` and is parsed with the shared Zod schema.
 */
import type { BrowserEngine, DevicePresetInfo, Profile, ProfileInput } from '@shared/types'
import { BROWSER_ENGINES, BROWSER_ENGINE_LABELS, ProfileInputSchema, STICKY_SESSION_ID_MAX_LENGTH } from '@shared/types'
import { AppException } from '../contracts'
import type { Logger, ProfileManager, ProfileRepository } from '../contracts'
import { DEVICE_PRESETS } from './device-presets'

const SCOPE = 'profiles'
const STICKY_SESSION_MAX_LENGTH = STICKY_SESSION_ID_MAX_LENGTH
const COPY_SUFFIX_PATTERN = /\s\(copy(?: \d+)?\)$/

export interface ProfileManagerOptions {
  repo: ProfileRepository
  logger: Logger
}

function parseInput(input: unknown): ProfileInput {
  const result = ProfileInputSchema.safeParse(input)
  if (!result.success) {
    const issue = result.error.issues[0]
    const field = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''
    throw new AppException('INVALID_INPUT', `${field}${issue?.message ?? 'Invalid profile data'}`)
  }
  return result.data
}

function normalise(input: ProfileInput): ProfileInput {
  const userAgent = input.userAgent?.trim() ?? ''
  const stickySessionId = input.stickySessionId?.trim().toLowerCase() ?? ''
  return {
    ...input,
    userAgent: userAgent.length > 0 ? userAgent : null,
    stickySessionId: stickySessionId.length > 0 ? stickySessionId : null,
  }
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

function isValidLocale(locale: string): boolean {
  try {
    return Intl.getCanonicalLocales(locale).length === 1
  } catch {
    return false
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

const isKnownEngine = (value: string): value is BrowserEngine => (BROWSER_ENGINES as readonly string[]).includes(value)

/**
 * Checks shared by create/update (INVALID_INPUT) and validateForLaunch (INVALID_PROFILE).
 * Zod already rejects unknown engines on create/update; the explicit check here covers
 * stored rows (the `engine` column is free text) so a launch never indexes an unknown label.
 */
function collectConsistencyProblems(input: ProfileInput, preset: DevicePresetInfo): string[] {
  const problems: string[] = []
  if (input.deviceType !== preset.deviceType) {
    problems.push(
      `Device type "${input.deviceType}" does not match preset "${preset.label}" (${preset.deviceType}).`,
    )
  }
  if (!isKnownEngine(input.engine)) {
    problems.push(`Browser engine "${String(input.engine)}" is not supported by this version. Edit the profile and pick an engine.`)
  } else if (!preset.supportedEngines.includes(input.engine)) {
    const supported = preset.supportedEngines.map((e) => BROWSER_ENGINE_LABELS[e]).join(', ')
    problems.push(
      `${BROWSER_ENGINE_LABELS[input.engine]} cannot emulate "${preset.label}". Supported engines: ${supported}.`,
    )
  }
  if (input.proxyMode === 'dataimpulse-sticky' && !input.stickySessionId) {
    problems.push('Sticky proxy mode requires a session ID. Set one on the profile or switch to rotating.')
  }
  if (!isValidTimezone(input.timezone)) {
    problems.push(`Timezone "${input.timezone}" is not a valid IANA timezone (e.g. "America/New_York").`)
  }
  if (!isValidLocale(input.locale)) {
    problems.push(`Locale "${input.locale}" is not a valid BCP 47 locale (e.g. "en-US").`)
  }
  if (input.formUrlOverride !== null && !isHttpUrl(input.formUrlOverride)) {
    problems.push('Form URL override must start with http:// or https://.')
  }
  return problems
}

function nextCopyName(baseName: string, existingNames: ReadonlySet<string>): string {
  const base = baseName.replace(COPY_SUFFIX_PATTERN, '')
  const first = `${base} (copy)`
  if (!existingNames.has(first)) return first
  for (let n = 2; ; n += 1) {
    const candidate = `${base} (copy ${n})`
    if (!existingNames.has(candidate)) return candidate
  }
}

function nextCopySessionId(sessionId: string, existingIds: ReadonlySet<string>): string {
  const base = sessionId.replace(/-copy\d*$/, '')
  for (let n = 1; ; n += 1) {
    const suffix = n === 1 ? '-copy' : `-copy${n}`
    const trimmedBase = base.slice(0, STICKY_SESSION_MAX_LENGTH - suffix.length)
    const candidate = `${trimmedBase}${suffix}`
    if (!existingIds.has(candidate)) return candidate
  }
}

/** Preset lookup over the runtime catalogue; preset ids are open strings so an unknown one is a normal input error. */
function findPreset(id: string): DevicePresetInfo | null {
  return DEVICE_PRESETS.find((preset) => preset.id === id) ?? null
}

export function createProfileManager(opts: ProfileManagerOptions): ProfileManager {
  const { repo, logger } = opts

  const get = (id: string): Profile => {
    const profile = repo.get(id)
    if (!profile) throw new AppException('NOT_FOUND', `Profile "${id}" was not found. It may have been deleted.`)
    return profile
  }

  const prepare = (raw: unknown): ProfileInput => {
    const input = normalise(parseInput(raw))
    const preset = findPreset(input.devicePreset)
    if (!preset) throw new AppException('INVALID_INPUT', `devicePreset: unknown device preset "${input.devicePreset}". Pick a preset from the catalogue.`)
    const problems = collectConsistencyProblems(input, preset)
    const first = problems[0]
    if (first) throw new AppException('INVALID_INPUT', first)
    return input
  }

  return {
    // Quick Launch profiles are hidden until saved ("Save as profile" flips `ephemeral` off via update()).
    list: () => repo.list(),
    get,
    presets: () => [...DEVICE_PRESETS],

    create(raw: unknown): Profile {
      const input = prepare(raw)
      const profile = repo.create(input)
      logger.info(SCOPE, `Created ${profile.ephemeral ? 'ephemeral ' : ''}profile "${profile.name}"`, {
        profileId: profile.id,
        engine: profile.engine,
        devicePreset: profile.devicePreset,
        proxyMode: profile.proxyMode,
        proxyPool: profile.proxyPool,
        target: profile.target,
        ephemeral: profile.ephemeral,
      })
      return profile
    },

    update(id: string, raw: unknown): Profile {
      const before = get(id)
      const input = prepare(raw)
      const profile = repo.update(id, input)
      logger.info(SCOPE, `Updated profile "${profile.name}"`, {
        profileId: id,
        ...(before.ephemeral && !profile.ephemeral ? { savedFromQuickLaunch: true } : {}),
      })
      return profile
    },

    duplicate(id: string): Profile {
      const source = get(id)
      const all = repo.list({ includeEphemeral: true })
      const names = new Set(all.map((p) => p.name))
      const sessionIds = new Set(all.map((p) => p.stickySessionId).filter((s): s is string => s !== null))
      const input: ProfileInput = {
        name: source.name,
        engine: source.engine,
        deviceType: source.deviceType,
        devicePreset: source.devicePreset,
        viewportWidth: source.viewportWidth,
        viewportHeight: source.viewportHeight,
        userAgent: source.userAgent,
        locale: source.locale,
        timezone: source.timezone,
        proxyMode: source.proxyMode,
        stickySessionId: source.stickySessionId ? nextCopySessionId(source.stickySessionId, sessionIds) : null,
        formUrlOverride: source.formUrlOverride,
        notes: source.notes,
        proxyPool: source.proxyPool,
        target: source.target ? { ...source.target } : null,
        stickyTtlMinutes: source.stickyTtlMinutes,
        // A copy is always a regular, visible profile.
        ephemeral: false,
      }
      input.name = nextCopyName(source.name, names)
      const copy = repo.create(input)
      logger.info(SCOPE, `Duplicated profile "${source.name}" as "${copy.name}"`, {
        sourceId: source.id,
        profileId: copy.id,
      })
      return copy
    },

    delete(id: string): void {
      const profile = get(id)
      repo.delete(id)
      logger.info(SCOPE, `Deleted profile "${profile.name}"`, { profileId: id })
    },

    validateForLaunch(profile: Profile): void {
      const preset = findPreset(profile.devicePreset)
      if (!preset) {
        throw new AppException(
          'INVALID_PROFILE',
          `Profile "${profile.name}" uses unknown device preset "${profile.devicePreset}". Edit the profile and pick a preset.`,
        )
      }
      const problems = collectConsistencyProblems(profile, preset)
      const first = problems[0]
      if (first) throw new AppException('INVALID_PROFILE', `Profile "${profile.name}" cannot launch: ${first}`)
    },
  }
}

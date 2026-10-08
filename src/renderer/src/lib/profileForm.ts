import type { BrowserEngine, BrowserEngineInfo, DevicePresetId, DevicePresetInfo, DeviceType, GeoTarget, Profile, ProfileInput, ProxyMode, ProxyPool, TargetMode } from '@shared/types'
import { BROWSER_ENGINES, BROWSER_ENGINE_KIND, BROWSER_ENGINE_LABELS, DEVICE_TYPES, DEVICE_TYPE_LABELS, ProfileInputSchema } from '@shared/types'
import { engineAction } from './engines'
import { toKebab } from './utils'

/** Structural twin of the `Select` component's option group (this module is also compiled for Node tests, without the `@/` alias). */
export interface OptionGroup<V extends string = string> {
  label: string
  options: Array<{ value: V; label: string; disabled?: boolean }>
}

/** Same rule as `ProfileInputSchema.stickySessionId`. */
export const STICKY_SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/
export const STICKY_SESSION_ID_FORMAT_MESSAGE = 'Session ID may contain letters, digits, dash and underscore only (max 64)'
export const STICKY_SESSION_ID_REQUIRED_MESSAGE = 'A session ID is required for sticky proxy mode'

/** String-backed form model for the profile editor (numbers are parsed on validate). */
export interface ProfileFormState {
  name: string
  engine: BrowserEngine
  deviceType: DeviceType
  devicePreset: DevicePresetId
  viewportWidth: string
  viewportHeight: string
  userAgent: string
  locale: string
  timezone: string
  proxyMode: ProxyMode
  stickySessionId: string
  formUrlOverride: string
  notes: string
  /** Provider pool used when proxyMode is not 'none'. */
  proxyPool: ProxyPool
  /** Mode shown by the target segmented control (kept even while `target` is null). */
  targetMode: TargetMode
  /** Requested exit location; null = provider default. */
  target: GeoTarget | null
  /** Sticky TTL in minutes as typed; empty = provider default. */
  stickyTtlMinutes: string
  /** Quick-launch profiles stay hidden from the Profiles page until saved. */
  ephemeral: boolean
}

export type ProfileFormErrors = Partial<Record<keyof ProfileFormState, string>>

export const STICKY_TTL_MESSAGE = 'TTL must be a whole number between 1 and 1440 minutes'

export function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function emptyProfileForm(): ProfileFormState {
  return {
    name: '',
    engine: 'chromium',
    deviceType: 'desktop',
    devicePreset: 'windows-desktop',
    viewportWidth: '1920',
    viewportHeight: '1080',
    userAgent: '',
    locale: 'en-US',
    timezone: detectTimezone(),
    proxyMode: 'dataimpulse-sticky',
    stickySessionId: '',
    formUrlOverride: '',
    notes: '',
    proxyPool: 'residential',
    targetMode: 'state',
    target: null,
    stickyTtlMinutes: '',
    ephemeral: false,
  }
}

export function profileFormFrom(profile: Profile): ProfileFormState {
  return {
    name: profile.name,
    engine: profile.engine,
    deviceType: profile.deviceType,
    devicePreset: profile.devicePreset,
    viewportWidth: String(profile.viewportWidth),
    viewportHeight: String(profile.viewportHeight),
    userAgent: profile.userAgent ?? '',
    locale: profile.locale,
    timezone: profile.timezone,
    proxyMode: profile.proxyMode,
    stickySessionId: profile.stickySessionId ?? '',
    formUrlOverride: profile.formUrlOverride ?? '',
    notes: profile.notes,
    proxyPool: profile.proxyPool,
    targetMode: profile.target?.mode ?? 'state',
    target: profile.target,
    stickyTtlMinutes: profile.stickyTtlMinutes === null ? '' : String(profile.stickyTtlMinutes),
    ephemeral: profile.ephemeral,
  }
}

/** The editable part of a stored profile (what `profiles.update` takes). */
export function profileInputFrom(profile: Profile): ProfileInput {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = profile
  return input
}

/** "My Texas Profile" → "profile-my-texas-profile" (max 64 chars); empty when the name has no usable characters. */
export function suggestSessionId(name: string): string {
  const slug = toKebab(name)
  return slug ? `profile-${slug}`.slice(0, 64) : ''
}

/**
 * Validate a sticky session id with the shared rule.
 * `requireWhenSticky` controls whether an empty value is an error (submit/blur) or tolerated (while typing).
 */
export function validateStickySessionId(value: string, proxyMode: ProxyMode, requireWhenSticky = true): string | null {
  const trimmed = value.trim()
  if (trimmed === '') return proxyMode === 'dataimpulse-sticky' && requireWhenSticky ? STICKY_SESSION_ID_REQUIRED_MESSAGE : null
  return STICKY_SESSION_ID_PATTERN.test(trimmed) ? null : STICKY_SESSION_ID_FORMAT_MESSAGE
}

/** Error text when the chosen engine cannot emulate the preset (e.g. Firefox with a mobile preset), else null. */
export function engineConflictMessage(preset: DevicePresetInfo | null | undefined, engine: BrowserEngine): string | null {
  if (!preset || preset.supportedEngines.includes(engine)) return null
  const supported = preset.supportedEngines.map((e) => BROWSER_ENGINE_LABELS[e])
  const choices = supported.length === 0 ? 'another preset' : supported.length === 1 ? supported[0] : `${supported.slice(0, -1).join(', ')} or ${supported[supported.length - 1]}`
  return `${BROWSER_ENGINE_LABELS[engine]} cannot emulate ${preset.label}. Choose ${choices}.`
}

// ---------------------------------------------------------------------------
// Select groups for the profile editor
// ---------------------------------------------------------------------------

export const ENGINE_GROUP_LABELS = { bundled: 'Bundled with the app', installed: 'Installed on this machine' } as const
export const NOT_INSTALLED_SUFFIX = ' · not installed'
export const UNSUPPORTED_SUFFIX = ' — not supported by this preset'
export const ENGINE_INSTALL_HINT = 'Install it with one click below or in Settings → Browsers, or set its path there.'
export const WEBKIT_HINT = 'WebKit is Safari-compatible QA, not Safari itself.'

/** A missing vendor browser the app can install here (one click, or vendor page + automatic detection). */
export function isEngineInstallable(engines: readonly BrowserEngineInfo[] | null, engine: BrowserEngine): boolean {
  const info = engines?.find((e) => e.id === engine)
  if (!info || info.kind !== 'installed' || info.available) return false
  const action = engineAction(info)
  return action === 'install' || action === 'get'
}

/** True when the engine is an installed browser the machine does not have (unknown while `engines` is null). */
export function isEngineUnavailable(engines: readonly BrowserEngineInfo[] | null, engine: BrowserEngine): boolean {
  if (!engines) return false
  const info = engines.find((e) => e.id === engine)
  return info ? !info.available : false
}

/**
 * Engine `<select>` groups: bundled engines first, then installed browsers. An engine the
 * preset cannot emulate or that is not installed is disabled — except the engine currently
 * selected, which stays selectable so the control can display it and the hint can explain.
 */
export function groupEngineOptions(
  engines: readonly BrowserEngineInfo[] | null,
  preset: DevicePresetInfo | null | undefined,
  currentEngine: BrowserEngine,
  unsupportedSuffix: string = UNSUPPORTED_SUFFIX,
): OptionGroup<BrowserEngine>[] {
  const build = (engine: BrowserEngine): OptionGroup<BrowserEngine>['options'][number] => {
    const unsupported = preset ? !preset.supportedEngines.includes(engine) : false
    const unavailable = isEngineUnavailable(engines, engine)
    const suffix = unsupported ? unsupportedSuffix : unavailable ? NOT_INSTALLED_SUFFIX : ''
    // A missing browser that can be installed from here stays selectable: the hint under the select installs it.
    const blocked = unsupported || (unavailable && !isEngineInstallable(engines, engine))
    return { value: engine, label: `${BROWSER_ENGINE_LABELS[engine]}${suffix}`, disabled: blocked && engine !== currentEngine }
  }
  return [
    { label: ENGINE_GROUP_LABELS.bundled, options: BROWSER_ENGINES.filter((e) => BROWSER_ENGINE_KIND[e] === 'bundled').map(build) },
    { label: ENGINE_GROUP_LABELS.installed, options: BROWSER_ENGINES.filter((e) => BROWSER_ENGINE_KIND[e] === 'installed').map(build) },
  ]
}

/** Human line describing why the selected engine is unavailable, or null when it can launch (or is unknown). */
export function engineAvailabilityMessage(engines: readonly BrowserEngineInfo[] | null, engine: BrowserEngine): string | null {
  const info = engines?.find((e) => e.id === engine)
  if (!info || info.available) return null
  return `${info.label} is not available on this machine. ${info.kind === 'installed' ? ENGINE_INSTALL_HINT : info.note}`
}

/** Hint under the engine select: preset support (when limited) + install hint (when relevant) + the WebKit disclaimer. */
export function engineFieldHint(engines: readonly BrowserEngineInfo[] | null, preset: DevicePresetInfo | null | undefined): string {
  const parts: string[] = []
  if (preset && preset.supportedEngines.length < BROWSER_ENGINES.length) {
    const supported = preset.supportedEngines.map((e) => BROWSER_ENGINE_LABELS[e])
    parts.push(`${preset.label} supports ${supported.length === 1 ? supported[0] : `${supported.slice(0, -1).join(', ')} and ${supported[supported.length - 1]}`}.`)
  }
  if (engines?.some((e) => e.kind === 'installed' && !e.available)) parts.push(`Greyed-out browsers are not installed. ${ENGINE_INSTALL_HINT}`)
  parts.push(WEBKIT_HINT)
  return parts.join(' ')
}

/** Device preset `<select>` groups in `DEVICE_TYPES` order (Desktop / Mobile / Tablet) showing label and viewport. */
export function groupPresetOptions(presets: readonly DevicePresetInfo[]): OptionGroup<DevicePresetId>[] {
  return DEVICE_TYPES.map((type) => ({
    label: DEVICE_TYPE_LABELS[type],
    options: presets.filter((p) => p.deviceType === type).map((p) => ({ value: p.id, label: `${p.label} · ${p.viewportWidth}×${p.viewportHeight}` })),
  }))
}

/**
 * Keep an auto-suggested session id tracking the profile name until the user types their own.
 * Returns the next session id: a fresh suggestion when the current value is empty or still equals the
 * suggestion for the previous name; otherwise the current (user-entered) value untouched.
 */
export function nextSuggestedSessionId(current: string, previousName: string, nextName: string): string {
  if (current === '' || current === suggestSessionId(previousName)) return suggestSessionId(nextName)
  return current
}

function toNumberOrNaN(value: string): number {
  const trimmed = value.trim()
  return trimmed === '' ? Number.NaN : Number(trimmed)
}

function humaniseIssue(key: string, message: string): string {
  if ((key === 'viewportWidth' || key === 'viewportHeight') && /nan|number|int|expected/i.test(message)) {
    return key === 'viewportWidth' ? 'Width must be a whole number between 320 and 7680' : 'Height must be a whole number between 320 and 4320'
  }
  if (key === 'formUrlOverride' && /url/i.test(message)) return 'Enter a full URL including https://'
  if (key === 'stickyTtlMinutes') return STICKY_TTL_MESSAGE
  if (key === 'target') return TARGET_MESSAGE
  return message
}

export const TARGET_MESSAGE = 'Pick a location from the list (the country must be a 2-letter code, e.g. US)'

/** Sticky TTL as typed → minutes (null when empty); NaN when not a whole number so the schema rejects it. */
export function parseStickyTtl(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN
}

/**
 * Convert form strings to a candidate ProfileInput and validate it with the shared schema.
 * Pass the selected preset to also reject engine/preset combinations the preset cannot emulate.
 */
export function validateProfileForm(
  form: ProfileFormState,
  preset: DevicePresetInfo | null = null,
): { input: ProfileInput; errors: null } | { input: null; errors: ProfileFormErrors } {
  const candidate = {
    name: form.name,
    engine: form.engine,
    deviceType: form.deviceType,
    devicePreset: form.devicePreset,
    viewportWidth: toNumberOrNaN(form.viewportWidth),
    viewportHeight: toNumberOrNaN(form.viewportHeight),
    userAgent: form.userAgent.trim() === '' ? null : form.userAgent,
    locale: form.locale,
    timezone: form.timezone,
    proxyMode: form.proxyMode,
    stickySessionId: form.stickySessionId.trim() === '' ? null : form.stickySessionId,
    formUrlOverride: form.formUrlOverride.trim() === '' ? null : form.formUrlOverride.trim(),
    notes: form.notes,
    proxyPool: form.proxyPool,
    // A direct profile never carries a geo target or TTL; the fields stay in the form for when the mode flips back.
    target: form.proxyMode === 'none' ? null : form.target === null ? null : { ...form.target, mode: form.targetMode },
    stickyTtlMinutes: form.proxyMode === 'dataimpulse-sticky' ? parseStickyTtl(form.stickyTtlMinutes) : null,
    ephemeral: form.ephemeral,
  }
  const parsed = ProfileInputSchema.safeParse(candidate)
  const errors: ProfileFormErrors = {}
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]
      if (typeof key === 'string' && key in form && !(key in errors)) {
        errors[key as keyof ProfileFormState] = humaniseIssue(key, issue.message)
      }
    }
  }
  if (candidate.proxyMode === 'dataimpulse-sticky' && candidate.stickySessionId === null) {
    errors.stickySessionId = STICKY_SESSION_ID_REQUIRED_MESSAGE
  }
  const engineConflict = engineConflictMessage(preset, form.engine)
  if (engineConflict && !errors.engine) errors.engine = engineConflict
  if (preset && form.deviceType !== preset.deviceType && !errors.deviceType) {
    errors.deviceType = `Device type is set by the preset (${preset.deviceType}).`
  }
  if (Object.keys(errors).length > 0) return { input: null, errors }
  if (!parsed.success) return { input: null, errors: { name: 'Profile is invalid' } }
  return { input: parsed.data, errors: null }
}

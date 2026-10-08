import { z } from 'zod'
import type { BrowserEngine, BrowserEngineInfo, DevicePresetId, DevicePresetInfo, GeoTarget, ProductKey, ProviderId, QuickLaunchInput, TargetMode } from '@shared/types'
import {
  BROWSER_ENGINES,
  BrowserEngineSchema,
  DEFAULT_PRODUCT_KEY,
  DEFAULT_PROVIDER_ID,
  DEVICE_TYPE_LABELS,
  DevicePresetIdSchema,
  ProductKeySchema,
  ProviderIdSchema,
  QuickLaunchInputSchema,
  TargetModeSchema,
  isAutomaticInstallMethod,
} from '@shared/types'
import type { ProviderLike } from './providers'
import { countryTarget, describeTarget, poolShortLabel } from './targeting'
import type { PoolChoice } from './targeting'

// ---------------------------------------------------------------------------
// Form model
// ---------------------------------------------------------------------------

/** String-backed launcher form; `buildQuickLaunchInput` converts and validates it. */
export interface LauncherFormState {
  /** Proxy provider of `pool` (kept when the pool switches to 'none'). */
  providerId: ProviderId
  pool: PoolChoice
  mode: TargetMode
  /** ISO-2 country for `country` mode (also the country of every other mode's target). */
  country: string
  /** Selected state / city / ZIP entry; null until picked. Kept when the pool switches to 'none'. */
  target: GeoTarget | null
  sticky: boolean
  stickyTtlMinutes: string
  engine: BrowserEngine
  devicePreset: DevicePresetId
  startUrl: string
  saveAsProfile: boolean
  profileName: string
}

export type LauncherFormErrors = Partial<Record<keyof LauncherFormState, string>>

export const DEFAULT_LAUNCHER_PRESET: DevicePresetId = 'windows-desktop'

export interface LauncherDefaults {
  defaultProviderId?: ProviderId
  defaultProxyPool?: ProductKey
  defaultTargetCountry?: string
}

export function defaultLauncherForm(defaults: LauncherDefaults = {}): LauncherFormState {
  return {
    providerId: defaults.defaultProviderId ?? DEFAULT_PROVIDER_ID,
    pool: defaults.defaultProxyPool ?? DEFAULT_PRODUCT_KEY,
    mode: 'state',
    country: (defaults.defaultTargetCountry ?? 'us').toLowerCase(),
    target: null,
    sticky: true,
    stickyTtlMinutes: '',
    engine: 'chromium',
    devicePreset: DEFAULT_LAUNCHER_PRESET,
    startUrl: '',
    saveAsProfile: false,
    profileName: '',
  }
}

// ---------------------------------------------------------------------------
// Remembered choices (localStorage)
// ---------------------------------------------------------------------------

export const LAUNCHER_PREFS_KEY = 'proxyqa.launcher.v1'

export const LauncherPrefsSchema = z
  .object({
    providerId: ProviderIdSchema,
    pool: z.union([z.literal('none'), ProductKeySchema]),
    mode: TargetModeSchema,
    engine: BrowserEngineSchema,
    devicePreset: DevicePresetIdSchema,
    sticky: z.boolean(),
  })
  .partial()
export type LauncherPrefs = z.infer<typeof LauncherPrefsSchema>

/** Minimal storage contract so the store compiles without DOM types and tests can inject a fake. */
export interface PrefsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function prefsFromForm(form: LauncherFormState): Required<LauncherPrefs> {
  return { providerId: form.providerId, pool: form.pool, mode: form.mode, engine: form.engine, devicePreset: form.devicePreset, sticky: form.sticky }
}

export function applyLauncherPrefs(form: LauncherFormState, prefs: LauncherPrefs | null | undefined): LauncherFormState {
  if (!prefs) return form
  return {
    ...form,
    providerId: prefs.providerId ?? form.providerId,
    pool: prefs.pool ?? form.pool,
    mode: prefs.mode ?? form.mode,
    engine: prefs.engine ?? form.engine,
    devicePreset: prefs.devicePreset ?? form.devicePreset,
    sticky: prefs.sticky ?? form.sticky,
  }
}

/** Parse remembered choices; anything malformed is ignored (never throws). */
export function readLauncherPrefs(storage: PrefsStorage | null | undefined, key: string = LAUNCHER_PREFS_KEY): LauncherPrefs | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    const parsed = LauncherPrefsSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function writeLauncherPrefs(storage: PrefsStorage | null | undefined, prefs: LauncherPrefs, key: string = LAUNCHER_PREFS_KEY): boolean {
  if (!storage) return false
  try {
    storage.setItem(key, JSON.stringify(prefs))
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Validation → QuickLaunchInput
// ---------------------------------------------------------------------------

const COUNTRY_PATTERN = /^[a-z]{2}$/i

export const LOCATION_REQUIRED_MESSAGE = 'Pick a location or press Random.'
export const COUNTRY_MESSAGE = 'Country must be a 2-letter ISO code, e.g. US.'
export const TTL_MESSAGE = 'TTL must be a whole number between 1 and 1440 minutes'
export const START_URL_MESSAGE = 'Enter a full URL including https://'

/** The GeoTarget that will be sent: none for direct connections, the country alone in country mode, the picked entry otherwise. */
export function launcherTarget(form: LauncherFormState): GeoTarget | null {
  if (form.pool === 'none') return null
  if (form.mode === 'country') return COUNTRY_PATTERN.test(form.country.trim()) ? countryTarget(form.country) : null
  if (!form.target) return null
  return { ...form.target, mode: form.mode, country: form.target.country || form.country.trim().toLowerCase() }
}

function intOrNaN(value: string): number {
  const trimmed = value.trim()
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN
}

/**
 * Convert the form into a `QuickLaunchInput` validated by the shared schema.
 * Field errors are keyed by form field so the page can focus the first offender.
 */
export function buildQuickLaunchInput(
  form: LauncherFormState,
  options: { replaceActiveSession?: boolean } = {},
): { input: QuickLaunchInput; errors: null } | { input: null; errors: LauncherFormErrors } {
  const errors: LauncherFormErrors = {}
  if (form.pool !== 'none') {
    if (form.mode === 'country') {
      if (!COUNTRY_PATTERN.test(form.country.trim())) errors.country = COUNTRY_MESSAGE
    } else if (!form.target) {
      errors.target = LOCATION_REQUIRED_MESSAGE
    }
  }
  if (form.devicePreset.trim() === '') errors.devicePreset = 'Choose a device preset.'
  const ttlText = form.stickyTtlMinutes.trim()
  const stickyTtlMinutes = ttlText === '' ? null : intOrNaN(ttlText)
  if (stickyTtlMinutes !== null && (!Number.isInteger(stickyTtlMinutes) || stickyTtlMinutes < 1 || stickyTtlMinutes > 1440)) errors.stickyTtlMinutes = TTL_MESSAGE

  const startUrl = form.startUrl.trim()
  const profileName = form.profileName.trim()
  const candidate = {
    startUrl: startUrl === '' ? null : startUrl,
    engine: form.engine,
    devicePreset: form.devicePreset.trim(),
    providerId: form.providerId,
    proxyPool: form.pool,
    target: launcherTarget(form),
    sticky: form.pool === 'none' ? false : form.sticky,
    stickyTtlMinutes: form.pool === 'none' || !form.sticky ? null : stickyTtlMinutes,
    locale: null,
    timezone: null,
    saveAsProfile: form.saveAsProfile,
    profileName: form.saveAsProfile && profileName !== '' ? profileName : null,
    replaceActiveSession: options.replaceActiveSession ?? false,
  }
  const parsed = QuickLaunchInputSchema.safeParse(candidate)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]
      if (key === 'startUrl' && !errors.startUrl) errors.startUrl = START_URL_MESSAGE
      else if (key === 'target' && !errors.target) errors.target = issue.message
      else if (key === 'proxyPool' && !errors.pool) errors.pool = issue.message
      else if (key === 'stickyTtlMinutes' && !errors.stickyTtlMinutes) errors.stickyTtlMinutes = TTL_MESSAGE
      else if (key === 'profileName' && !errors.profileName) errors.profileName = issue.message
      else if (typeof key === 'string' && key in form && !(key in errors)) errors[key as keyof LauncherFormState] = issue.message
    }
  }
  if (Object.keys(errors).length > 0) return { input: null, errors }
  if (!parsed.success) return { input: null, errors: { devicePreset: 'Launch settings are invalid' } }
  return { input: parsed.data, errors: null }
}

// ---------------------------------------------------------------------------
// Compatibility & random pickers
// ---------------------------------------------------------------------------

export type Rng = () => number

export function pickRandom<T>(items: readonly T[], rng: Rng = Math.random): T | null {
  if (items.length === 0) return null
  const index = Math.min(items.length - 1, Math.max(0, Math.floor(rng() * items.length)))
  return items[index] ?? null
}

/** True when the engine can launch on this machine (unknown availability counts as available). */
export function isEngineAvailable(engines: readonly BrowserEngineInfo[] | null | undefined, engine: BrowserEngine): boolean {
  if (!engines) return true
  const info = engines.find((e) => e.id === engine)
  return info ? info.available : true
}

/**
 * Whether the launcher keeps the selected engine for this preset: the preset must support it, and it must
 * be available — or be a missing vendor browser the user picked to install from the hint under the select.
 */
export function keepsSelectedEngine(engines: readonly BrowserEngineInfo[] | null | undefined, preset: DevicePresetInfo | null | undefined, engine: BrowserEngine): boolean {
  if (preset && !preset.supportedEngines.includes(engine)) return false
  if (isEngineAvailable(engines, engine)) return true
  const info = engines?.find((e) => e.id === engine)
  return info?.kind === 'installed' && (info.installMethod === 'download-page' || isAutomaticInstallMethod(info.installMethod))
}

/** Engines that are available AND can emulate the preset (every engine when no preset is given). */
export function compatibleEngines(engines: readonly BrowserEngineInfo[] | null | undefined, preset: DevicePresetInfo | null | undefined): BrowserEngine[] {
  return BROWSER_ENGINES.filter((engine) => isEngineAvailable(engines, engine) && (!preset || preset.supportedEngines.includes(engine)))
}

/**
 * How well a preset matches the typed search text (lower is better), or null when it does not match.
 * Label matches rank above matches that only hit the id, type or viewport ("15" in "414x715").
 */
export function presetMatchScore(preset: Pick<DevicePresetInfo, 'label' | 'id' | 'deviceType' | 'viewportWidth' | 'viewportHeight'>, needle: string): number | null {
  const query = needle.trim().toLowerCase()
  if (query === '') return 0
  const label = preset.label.toLowerCase()
  if (label.startsWith(query)) return 0
  if (label.includes(query)) return 1
  const words = query.split(/\s+/)
  if (words.every((word) => label.includes(word))) return 2
  const haystack = `${label} ${preset.id} ${DEVICE_TYPE_LABELS[preset.deviceType]} ${preset.viewportWidth}x${preset.viewportHeight}`.toLowerCase()
  return words.every((word) => haystack.includes(word)) ? 3 : null
}

/** Presets the engine can emulate (every preset when no engine is given). Firefox therefore drops mobile/tablet presets. */
export function compatiblePresets(presets: readonly DevicePresetInfo[], engine: BrowserEngine | null | undefined): DevicePresetInfo[] {
  return presets.filter((preset) => !engine || preset.supportedEngines.includes(engine))
}

/** A random configured product; 'none' when no product is configured. */
export function pickRandomPool(configuredPools: readonly ProductKey[], rng: Rng = Math.random): PoolChoice {
  return pickRandom(configuredPools, rng) ?? 'none'
}

export function pickRandomEngine(engines: readonly BrowserEngineInfo[] | null | undefined, preset: DevicePresetInfo | null | undefined, rng: Rng = Math.random): BrowserEngine | null {
  return pickRandom(compatibleEngines(engines, preset), rng)
}

export function pickRandomPreset(presets: readonly DevicePresetInfo[], engine: BrowserEngine | null | undefined, rng: Rng = Math.random): DevicePresetInfo | null {
  return pickRandom(compatiblePresets(presets, engine), rng)
}

export interface DevicePick {
  preset: DevicePresetInfo
  engine: BrowserEngine
}

/** Presets a random draw may land on: current (non-legacy) devices at least one available engine can emulate. */
function launchablePresets(presets: readonly DevicePresetInfo[], engines: readonly BrowserEngineInfo[] | null | undefined): DevicePresetInfo[] {
  return presets.filter((preset) => preset.legacy !== true && compatibleEngines(engines, preset).length > 0)
}

/**
 * "Random device": any current (non-legacy) preset that at least one available engine can emulate. The
 * current engine is kept when it is compatible with the pick; otherwise a compatible engine is chosen at random.
 */
export function pickRandomDevice(
  presets: readonly DevicePresetInfo[],
  engines: readonly BrowserEngineInfo[] | null | undefined,
  currentEngine: BrowserEngine | null,
  rng: Rng = Math.random,
): DevicePick | null {
  const preset = pickRandom(launchablePresets(presets, engines), rng)
  if (!preset) return null
  const keepCurrent = currentEngine !== null && compatibleEngines(engines, preset).includes(currentEngine)
  const engine = keepCurrent ? currentEngine : pickRandomEngine(engines, preset, rng)
  return engine ? { preset, engine } : null
}

export interface RandomAllResult {
  pool: PoolChoice
  preset: DevicePresetInfo
  engine: BrowserEngine
}

/** "Random all" (the location is drawn separately through `locations.random`): pool → device → engine, always compatible. */
export function randomAll(params: {
  configuredPools: readonly ProductKey[]
  presets: readonly DevicePresetInfo[]
  engines: readonly BrowserEngineInfo[] | null | undefined
  rng?: Rng
}): RandomAllResult | null {
  const rng = params.rng ?? Math.random
  const pool = pickRandomPool(params.configuredPools, rng)
  const preset = pickRandom(launchablePresets(params.presets, params.engines), rng)
  if (!preset) return null
  const engine = pickRandomEngine(params.engines, preset, rng)
  if (!engine) return null
  return { pool, preset, engine }
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/** Placeholder for "Save as profile": "NJ · Newark · iPhone 15 · Residential" / "Direct · Windows desktop". */
export function suggestProfileName(form: LauncherFormState, preset: DevicePresetInfo | null | undefined, provider?: Pick<ProviderLike, 'capabilities'> | null): string {
  const device = preset?.label ?? form.devicePreset
  const target = launcherTarget(form)
  const parts = form.pool === 'none' ? ['Direct', device] : [describeTarget(target), device, poolShortLabel(form.pool, provider)]
  return parts
    .filter((part) => part.trim().length > 0 && part !== '—')
    .join(' · ')
    .slice(0, 80)
}

/** Engine select suffix on the launcher: "WebKit · not compatible with Galaxy S24". */
export function incompatibleEngineSuffix(preset: Pick<DevicePresetInfo, 'label'> | null | undefined): string {
  return preset ? ` · not compatible with ${preset.label}` : ' · not compatible'
}

function browserFromUserAgent(ua: string): string {
  if (/\bEdg(A|iOS)?\//.test(ua)) return 'Edge'
  if (/\bOPR\/|\bOpera\b/.test(ua)) return 'Opera'
  if (/\bSamsungBrowser\//.test(ua)) return 'Samsung Internet'
  if (/\bFirefox\/|\bFxiOS\//.test(ua)) return 'Firefox'
  if (/\bCriOS\//.test(ua)) return 'Chrome'
  if (/\bChrome\//.test(ua)) return 'Chrome'
  if (/\bSafari\//.test(ua)) return 'Safari'
  return 'browser'
}

/** "Android Chrome", "iOS Safari", "Windows Edge", "macOS Firefox"… from a user-agent string. */
export function userAgentFamily(ua: string): string {
  const browser = browserFromUserAgent(ua)
  if (/\bAndroid\b/.test(ua)) return `Android ${browser}`
  if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return `iOS ${browser}`
  if (/\bWindows Phone\b/.test(ua)) return `Windows Phone ${browser}`
  if (/\bWindows\b/.test(ua)) return `Windows ${browser}`
  if (/\bCrOS\b/.test(ua)) return `ChromeOS ${browser}`
  if (/\bMacintosh\b|\bMac OS X\b/.test(ua)) return `macOS ${browser}`
  if (/\bLinux\b|\bX11\b/.test(ua)) return `Linux ${browser}`
  return browser === 'browser' ? 'Custom' : browser
}

/** One muted line under the device picker: "Mobile · 412×915 · Android Chrome UA". */
export function deviceSummary(preset: Pick<DevicePresetInfo, 'deviceType' | 'viewportWidth' | 'viewportHeight' | 'userAgent'>): string {
  return `${DEVICE_TYPE_LABELS[preset.deviceType]} · ${preset.viewportWidth}×${preset.viewportHeight} · ${userAgentFamily(preset.userAgent)} UA`
}

/** Field focus order for the first validation error. */
export const LAUNCHER_FIELD_ORDER: readonly (keyof LauncherFormState)[] = [
  'providerId',
  'pool',
  'mode',
  'country',
  'target',
  'stickyTtlMinutes',
  'engine',
  'devicePreset',
  'startUrl',
  'profileName',
]

export function firstLauncherError(errors: LauncherFormErrors): keyof LauncherFormState | null {
  return LAUNCHER_FIELD_ORDER.find((key) => errors[key] !== undefined) ?? null
}

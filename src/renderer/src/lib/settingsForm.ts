import type { AppSettings, BrowserExecutableOverrides, IpCheckProvider, LocationMatchPolicy, ProxyPool } from '@shared/types'
import { AppSettingsSchema, LOCATION_MATCH_ATTEMPTS_MAX, LOCATION_MATCH_ATTEMPTS_MIN, LOCATION_MATCH_POLICIES } from '@shared/types'
import { flagsErrorMessage, formatChromiumArgs, parseChromiumArgs } from './flags'

export type TargetingEncoding = AppSettings['targetingEncoding']

export const TARGETING_ENCODINGS: readonly TargetingEncoding[] = ['remove-spaces', 'underscore', 'keep']
export const TARGETING_ENCODING_LABELS: Record<TargetingEncoding, string> = {
  'remove-spaces': 'Remove spaces (DataImpulse default)',
  underscore: 'Replace spaces with underscores',
  keep: 'Keep spaces',
}

export const LOCATION_MATCH_POLICY_LABELS: Record<LocationMatchPolicy, string> = {
  off: 'Off',
  state: 'Same state (default)',
  exact: 'Exact (city or ZIP)',
}

/** One-line explanation under the "Location match" select. */
export const LOCATION_MATCH_POLICY_HINTS: Record<LocationMatchPolicy, string> = {
  off: 'The first exit IP is used wherever it is; nothing is re-rolled.',
  state: 'Sticky sessions with a target get a fresh session id while the exit IP is in another state. Rotating sessions are never re-rolled.',
  exact: 'Re-roll until the city name or the exact ZIP (postal code of the exit IP) matches; the right state alone is not enough.',
}

/** Settings → Targeting "Location match" options, in display order. */
export const LOCATION_MATCH_POLICY_OPTIONS: ReadonlyArray<{ value: LocationMatchPolicy; label: string }> = LOCATION_MATCH_POLICIES.map((value) => ({
  value,
  label: LOCATION_MATCH_POLICY_LABELS[value],
}))

export interface SettingsFormState {
  defaultFormUrl: string
  ipCheckProvider: IpCheckProvider
  ipCheckTimeoutMs: string
  ipCheckRetries: string
  networkInspectorEnabled: boolean
  navigationTimeoutMs: string
  singleSessionMode: boolean
  /** Editor text: one Chromium flag per line. */
  extraChromiumArgs: string
  targetingEncoding: TargetingEncoding
  defaultProxyPool: ProxyPool
  defaultTargetCountry: string
  locationMatchPolicy: LocationMatchPolicy
  /** Editor text; validated as a whole number in the shared range. */
  locationMatchAttempts: string
}

export type SettingsFormErrors = Partial<Record<keyof SettingsFormState, string>>

export function settingsFormFrom(settings: AppSettings): SettingsFormState {
  return {
    defaultFormUrl: settings.defaultFormUrl,
    ipCheckProvider: settings.ipCheckProvider,
    ipCheckTimeoutMs: String(settings.ipCheckTimeoutMs),
    ipCheckRetries: String(settings.ipCheckRetries),
    networkInspectorEnabled: settings.networkInspectorEnabled,
    navigationTimeoutMs: String(settings.navigationTimeoutMs),
    singleSessionMode: settings.singleSessionMode,
    extraChromiumArgs: formatChromiumArgs(settings.extraChromiumArgs),
    targetingEncoding: settings.targetingEncoding,
    defaultProxyPool: settings.defaultProxyPool,
    defaultTargetCountry: settings.defaultTargetCountry.toUpperCase(),
    locationMatchPolicy: settings.locationMatchPolicy,
    locationMatchAttempts: String(settings.locationMatchAttempts),
  }
}

function numberOrNaN(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value)
}

function friendly(key: keyof SettingsFormState, message: string): string {
  switch (key) {
    case 'defaultFormUrl':
      return 'Enter a full URL including https://'
    case 'ipCheckTimeoutMs':
      return 'Timeout must be a whole number between 1000 and 120000 ms'
    case 'ipCheckRetries':
      return 'Retries must be a whole number between 0 and 5'
    case 'navigationTimeoutMs':
      return 'Timeout must be a whole number between 5000 and 300000 ms'
    case 'defaultTargetCountry':
      return 'Country must be a 2-letter ISO code, e.g. US'
    case 'locationMatchAttempts':
      return `Attempts must be a whole number between ${LOCATION_MATCH_ATTEMPTS_MIN} and ${LOCATION_MATCH_ATTEMPTS_MAX}`
    default:
      return message
  }
}

/**
 * Validate the settings form against the shared schema. `screenshotDir` and
 * `browserExecutables` are not edited by this form (the first is read-only, the second
 * is managed row by row in Settings → Browsers) and are passed through unchanged.
 */
export function validateSettingsForm(
  form: SettingsFormState,
  screenshotDir: string,
  browserExecutables: BrowserExecutableOverrides = {},
): { data: AppSettings; errors: null } | { data: null; errors: SettingsFormErrors } {
  const errors: SettingsFormErrors = {}
  const flags = parseChromiumArgs(form.extraChromiumArgs)
  const flagsError = flagsErrorMessage(flags.errors)
  if (flagsError) errors.extraChromiumArgs = flagsError

  const parsed = AppSettingsSchema.safeParse({
    defaultFormUrl: form.defaultFormUrl.trim(),
    ipCheckProvider: form.ipCheckProvider,
    ipCheckTimeoutMs: numberOrNaN(form.ipCheckTimeoutMs),
    ipCheckRetries: numberOrNaN(form.ipCheckRetries),
    networkInspectorEnabled: form.networkInspectorEnabled,
    screenshotDir,
    navigationTimeoutMs: numberOrNaN(form.navigationTimeoutMs),
    browserExecutables,
    singleSessionMode: form.singleSessionMode,
    extraChromiumArgs: flags.args,
    targetingEncoding: form.targetingEncoding,
    defaultProxyPool: form.defaultProxyPool,
    defaultTargetCountry: form.defaultTargetCountry.trim().toLowerCase(),
    locationMatchPolicy: form.locationMatchPolicy,
    locationMatchAttempts: numberOrNaN(form.locationMatchAttempts),
  })
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]
      if (typeof key === 'string' && key in form && !(key in errors)) {
        errors[key as keyof SettingsFormState] = friendly(key as keyof SettingsFormState, issue.message)
      }
    }
  }
  if (Object.keys(errors).length > 0) return { data: null, errors }
  if (!parsed.success) return { data: null, errors: { defaultFormUrl: 'Settings are invalid' } }
  return { data: parsed.data, errors: null }
}

/**
 * Next override map after setting (non-empty path) or clearing (empty path) one engine.
 * Returns a fresh object; the input is never mutated.
 */
export function withBrowserExecutable(current: BrowserExecutableOverrides, engine: keyof BrowserExecutableOverrides, path: string): BrowserExecutableOverrides {
  const next: BrowserExecutableOverrides = { ...current }
  const trimmed = path.trim()
  if (trimmed === '') delete next[engine]
  else next[engine] = trimmed
  return next
}

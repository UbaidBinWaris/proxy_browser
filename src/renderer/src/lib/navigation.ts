/**
 * Route map of the renderer (pure, unit-tested): the five primary destinations,
 * the Settings tabs and Advanced sections, the keys-window route and the
 * redirects that keep links to removed pages working.
 */

/** Hash route of the secure "Manage proxy keys" window; the renderer shows only the keys view there. */
export const KEYS_ROUTE = '/keys'

/** True for `#/keys` (optionally followed by a query or a trailing slash), i.e. the keys window. */
export function isKeysWindowHash(hash: string): boolean {
  const path = hash.replace(/^#/, '').split(/[?#]/)[0] ?? ''
  return path === KEYS_ROUTE || path === `${KEYS_ROUTE}/`
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const SETTINGS_TABS = ['general', 'browsers', 'advanced', 'about'] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]

export const SETTINGS_TAB_LABELS: Record<SettingsTab, string> = {
  general: 'General',
  browsers: 'Browsers',
  advanced: 'Advanced',
  about: 'App & updates',
}

/** A route segment → tab; null for anything unknown (the page then redirects to General). */
export function parseSettingsTab(value: string | null | undefined): SettingsTab | null {
  return (SETTINGS_TABS as readonly string[]).includes(value ?? '') ? (value as SettingsTab) : null
}

/** Collapsible sections of Settings → Advanced, in display order. Only Proxy keys starts open. */
export const ADVANCED_SECTIONS = ['proxy-keys', 'site-access', 'targeting', 'browser-flags', 'ip-verification', 'network-inspector', 'proxy-sessions', 'logs'] as const
export type AdvancedSection = (typeof ADVANCED_SECTIONS)[number]

export const ADVANCED_SECTION_LABELS: Record<AdvancedSection, string> = {
  'proxy-keys': 'Proxy keys',
  'site-access': 'Site access tokens',
  targeting: 'Targeting & location match',
  'browser-flags': 'Browser flags',
  'ip-verification': 'IP verification',
  'network-inspector': 'Network inspector',
  'proxy-sessions': 'Proxy session history',
  logs: 'Logs',
}

export const DEFAULT_OPEN_SECTIONS: readonly AdvancedSection[] = ['proxy-keys']

/** `#proxy-keys` → 'proxy-keys'; null for an empty or unknown hash. */
export function advancedSectionFromHash(hash: string | null | undefined): AdvancedSection | null {
  const id = (hash ?? '').replace(/^#/, '')
  return (ADVANCED_SECTIONS as readonly string[]).includes(id) ? (id as AdvancedSection) : null
}

/** '/settings/advanced#proxy-keys' */
export function settingsPath(tab: SettingsTab, section?: AdvancedSection): string {
  return `/settings/${tab}${section ? `#${section}` : ''}`
}

export const PROXY_KEYS_PATH = settingsPath('advanced', 'proxy-keys')

/** Fields of the settings form (mirrors `SettingsFormState` without importing the form module). */
export type SettingsField =
  | 'defaultFormUrl'
  | 'singleSessionMode'
  | 'ipCheckProvider'
  | 'ipCheckTimeoutMs'
  | 'ipCheckRetries'
  | 'networkInspectorEnabled'
  | 'navigationTimeoutMs'
  | 'extraChromiumArgs'
  | 'providerEncodings'
  | 'defaultProviderId'
  | 'defaultProxyPool'
  | 'defaultTargetCountry'
  | 'locationMatchPolicy'
  | 'locationMatchAttempts'
  | 'checkUpdatesOnStartup'

export interface SettingsFieldLocation {
  tab: SettingsTab
  section: AdvancedSection | null
}

/** Each setting lives in exactly one place; this says where (used to reveal the first invalid field). */
export const SETTINGS_FIELD_LOCATIONS: Record<SettingsField, SettingsFieldLocation> = {
  defaultFormUrl: { tab: 'general', section: null },
  singleSessionMode: { tab: 'general', section: null },
  checkUpdatesOnStartup: { tab: 'general', section: null },
  defaultProviderId: { tab: 'advanced', section: 'targeting' },
  defaultProxyPool: { tab: 'advanced', section: 'targeting' },
  providerEncodings: { tab: 'advanced', section: 'targeting' },
  defaultTargetCountry: { tab: 'advanced', section: 'targeting' },
  locationMatchPolicy: { tab: 'advanced', section: 'targeting' },
  locationMatchAttempts: { tab: 'advanced', section: 'targeting' },
  extraChromiumArgs: { tab: 'advanced', section: 'browser-flags' },
  ipCheckProvider: { tab: 'advanced', section: 'ip-verification' },
  ipCheckTimeoutMs: { tab: 'advanced', section: 'ip-verification' },
  ipCheckRetries: { tab: 'advanced', section: 'ip-verification' },
  networkInspectorEnabled: { tab: 'advanced', section: 'network-inspector' },
  navigationTimeoutMs: { tab: 'advanced', section: 'network-inspector' },
}

/** The first field (in display order) that has an error, with where it lives; null when there is none. */
export function firstSettingsError(errors: Partial<Record<SettingsField, string | undefined>>): (SettingsFieldLocation & { field: SettingsField }) | null {
  const order = Object.keys(SETTINGS_FIELD_LOCATIONS) as SettingsField[]
  const field = order.find((key) => errors[key] !== undefined)
  return field ? { field, ...SETTINGS_FIELD_LOCATIONS[field] } : null
}

// ---------------------------------------------------------------------------
// History & legacy routes
// ---------------------------------------------------------------------------

export function historyRunPath(runId: string): string {
  return `/history/${encodeURIComponent(runId)}`
}

/** Pages that no longer exist → where their content lives now. `/runs/:id` is redirected separately. */
export const LEGACY_REDIRECTS: Readonly<Record<string, string>> = {
  '/dashboard': '/launch',
  '/proxy': PROXY_KEYS_PATH,
  '/proxy-sessions': settingsPath('advanced', 'proxy-sessions'),
  '/logs': settingsPath('advanced', 'logs'),
  '/runs': '/history',
}

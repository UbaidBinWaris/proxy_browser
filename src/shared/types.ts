/**
 * Shared domain types and Zod schemas.
 *
 * This file is imported by BOTH the Electron main process and the React renderer.
 * It must stay free of Node.js and Electron imports.
 *
 * Zod v4 API is in use (e.g. `z.enum`, `z.url()`, `z.int()`, `schema.safeParse`).
 */
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/**
 * Every browser a profile can run in.
 *
 * - `chromium`, `firefox`, `webkit` are the engines Playwright bundles ("bundled" kind).
 * - The rest are real browsers already installed on the machine ("installed" kind). They
 *   are detected on disk and driven through Chromium's automation protocol with their
 *   own executable, so each one really is the browser its label says it is.
 */
export const BROWSER_ENGINES = ['chromium', 'firefox', 'webkit', 'chrome', 'msedge', 'brave', 'opera', 'opera-gx', 'vivaldi', 'system-chromium'] as const
export const BrowserEngineSchema = z.enum(BROWSER_ENGINES)
export type BrowserEngine = z.infer<typeof BrowserEngineSchema>

/** The engines Playwright ships and the app can install itself. */
export const BUNDLED_BROWSER_ENGINES = ['chromium', 'firefox', 'webkit'] as const
export const BundledBrowserEngineSchema = z.enum(BUNDLED_BROWSER_ENGINES)
export type BundledBrowserEngine = z.infer<typeof BundledBrowserEngineSchema>

/** Real vendor browsers: detected on the machine, or installed by the app from the vendor's official packages. */
export const INSTALLED_BROWSER_ENGINES = ['chrome', 'msedge', 'brave', 'opera', 'opera-gx', 'vivaldi', 'system-chromium'] as const
export const InstalledBrowserEngineSchema = z.enum(INSTALLED_BROWSER_ENGINES)
export type InstalledBrowserEngine = (typeof INSTALLED_BROWSER_ENGINES)[number]

export const BROWSER_ENGINE_FAMILIES = ['chromium', 'firefox', 'webkit'] as const
export type BrowserEngineFamily = (typeof BROWSER_ENGINE_FAMILIES)[number]

/** Which Playwright `BrowserType` drives the engine (device emulation and proxy support follow the family). */
export const BROWSER_ENGINE_FAMILY: Record<BrowserEngine, BrowserEngineFamily> = {
  chromium: 'chromium',
  firefox: 'firefox',
  webkit: 'webkit',
  chrome: 'chromium',
  msedge: 'chromium',
  brave: 'chromium',
  opera: 'chromium',
  'opera-gx': 'chromium',
  vivaldi: 'chromium',
  'system-chromium': 'chromium',
}

export const BROWSER_ENGINE_KINDS = ['bundled', 'installed'] as const
export type BrowserEngineKind = (typeof BROWSER_ENGINE_KINDS)[number]

export const BROWSER_ENGINE_KIND: Record<BrowserEngine, BrowserEngineKind> = {
  chromium: 'bundled',
  firefox: 'bundled',
  webkit: 'bundled',
  chrome: 'installed',
  msedge: 'installed',
  brave: 'installed',
  opera: 'installed',
  'opera-gx': 'installed',
  vivaldi: 'installed',
  'system-chromium': 'installed',
}

/**
 * Human label for an engine. Every label names exactly what runs: WebKit must never be
 * presented as "real Safari", and an installed browser is named as itself.
 */
export const BROWSER_ENGINE_LABELS: Record<BrowserEngine, string> = {
  chromium: 'Chromium (bundled)',
  firefox: 'Firefox (Playwright Firefox)',
  webkit: 'WebKit / Safari-compatible QA',
  chrome: 'Google Chrome (installed)',
  msedge: 'Microsoft Edge (installed)',
  brave: 'Brave (installed)',
  opera: 'Opera (installed)',
  'opera-gx': 'Opera GX (installed)',
  vivaldi: 'Vivaldi (installed)',
  'system-chromium': 'Chromium (system install)',
}

export const isBundledEngine = (engine: BrowserEngine): engine is BundledBrowserEngine => BROWSER_ENGINE_KIND[engine] === 'bundled'
export const isInstalledEngine = (engine: BrowserEngine): engine is InstalledBrowserEngine => BROWSER_ENGINE_KIND[engine] === 'installed'

/**
 * Where an engine's executable came from: 'bundled' (Playwright's browsers directory),
 * 'detected' (found at a well-known location, on PATH or in the app's own install folder),
 * 'settings' (path typed by the user in Settings → Browsers), 'auto-saved' (path the app
 * remembered after detecting or installing the browser) or 'not-found'.
 */
export const BROWSER_ENGINE_SOURCES = ['bundled', 'detected', 'settings', 'auto-saved', 'not-found'] as const
export type BrowserEngineSource = (typeof BROWSER_ENGINE_SOURCES)[number]

/**
 * How an engine can be obtained on this machine:
 * - 'bundled': a Playwright download (chromium / firefox / webkit);
 * - 'winget': silent install through the Windows Package Manager;
 * - 'vendor-package': the vendor's official Linux package extracted into the app's data folder (no root);
 * - 'portable-archive': the vendor's official portable archive extracted into the app's data folder;
 * - 'playwright': Playwright's CLI runs the vendor installer (Chrome / Edge on macOS);
 * - 'download-page': the vendor site is opened and the app watches for the install to appear;
 * - 'none': not available for this operating system.
 */
export const ENGINE_INSTALL_METHODS = ['bundled', 'winget', 'vendor-package', 'portable-archive', 'playwright', 'download-page', 'none'] as const
export type EngineInstallMethod = (typeof ENGINE_INSTALL_METHODS)[number]

/** Methods the app runs itself (one click, no browser window to the vendor site). */
export const AUTOMATIC_INSTALL_METHODS: readonly EngineInstallMethod[] = ['winget', 'vendor-package', 'portable-archive', 'playwright']
export const isAutomaticInstallMethod = (method: EngineInstallMethod): boolean => AUTOMATIC_INSTALL_METHODS.includes(method)

/** Availability of one engine on this machine. Safe to send to the renderer (paths are not secrets). */
export interface BrowserEngineInfo {
  /** How the engine can be installed on this machine (see `ENGINE_INSTALL_METHODS`). */
  installMethod: EngineInstallMethod
  /** One human sentence about the install method ("Downloads the official .deb and extracts it — no root needed."). */
  installNote: string
  /** Vendor download page (installed-kind engines), null for bundled engines. */
  downloadUrl: string | null
  /** A copy installed by the app itself exists in its data folder (Uninstall is offered). */
  managedInstall: boolean
  id: BrowserEngine
  label: string
  family: BrowserEngineFamily
  kind: BrowserEngineKind
  available: boolean
  /** Executable the engine launches from; null for bundled engines (Playwright resolves them) and when not found. */
  executablePath: string | null
  /** Best-effort version string ("153.0.8010.52"); null when it could not be read. */
  version: string | null
  source: BrowserEngineSource
  /** Human-readable explanation of the status, including what to do when the engine is unavailable. */
  note: string
}

export const DEVICE_TYPES = ['desktop', 'mobile', 'tablet'] as const
export const DeviceTypeSchema = z.enum(DEVICE_TYPES)
export type DeviceType = z.infer<typeof DeviceTypeSchema>

export const DEVICE_TYPE_LABELS: Record<DeviceType, string> = { desktop: 'Desktop', mobile: 'Mobile', tablet: 'Tablet' }

export const DEVICE_PRESET_IDS = [
  // Desktop
  'windows-desktop',
  'windows-desktop-hidpi',
  'linux-desktop',
  'macos-desktop',
  'macos-safari-desktop',
  'desktop-edge',
  'desktop-firefox',
  // Mobile
  'iphone-13',
  'iphone-14',
  'iphone-15',
  'iphone-15-pro',
  'iphone-16',
  'iphone-16-pro',
  'iphone-16-pro-max',
  'iphone-16e',
  'iphone-17',
  'iphone-17-pro',
  'iphone-17-pro-max',
  'iphone-se-3',
  'pixel-7',
  'pixel-8',
  'pixel-8-pro',
  'pixel-9',
  'pixel-9-pro',
  'pixel-10',
  'galaxy-s22',
  'galaxy-s23',
  'galaxy-s24',
  'galaxy-a55',
  'galaxy-z-fold-7',
  'galaxy-z-flip-7',
  // Tablet
  'ipad-gen-11',
  'ipad-mini',
  'ipad-pro-11',
  'galaxy-tab-s9',
] as const
/**
 * Device preset ids are open strings validated against the runtime catalog
 * (src/main/browser/device-presets.ts), which contains 100+ presets generated from
 * Playwright's device descriptors plus curated custom entries. DEVICE_PRESET_IDS above
 * is the guaranteed core subset.
 */
export const DevicePresetIdSchema = z.string().trim().min(1).max(80)
export type DevicePresetId = string
export type CoreDevicePresetId = (typeof DEVICE_PRESET_IDS)[number]

export const PROXY_MODES = ['none', 'dataimpulse-sticky', 'dataimpulse-rotating'] as const
export const ProxyModeSchema = z.enum(PROXY_MODES)
export type ProxyMode = z.infer<typeof ProxyModeSchema>

export const PROXY_STATUSES = ['untested', 'testing', 'working', 'failed', 'offline'] as const
export const ProxyStatusSchema = z.enum(PROXY_STATUSES)
export type ProxyStatus = z.infer<typeof ProxyStatusSchema>

export const RUN_STATUSES = ['running', 'success', 'failed', 'aborted'] as const
export const RunStatusSchema = z.enum(RUN_STATUSES)
export type RunStatus = z.infer<typeof RunStatusSchema>

export const LOG_LEVELS = ['INFO', 'WARN', 'ERROR'] as const
export const LogLevelSchema = z.enum(LOG_LEVELS)
export type LogLevel = z.infer<typeof LogLevelSchema>

export const IP_CHECK_PROVIDERS = ['ip-api', 'ipinfo', 'ipwhois'] as const
export const IpCheckProviderSchema = z.enum(IP_CHECK_PROVIDERS)
export type IpCheckProvider = z.infer<typeof IpCheckProviderSchema>

export const SESSION_STATUSES = ['starting', 'verifying-proxy', 'launching', 'open', 'closing', 'closed', 'error'] as const
export const SessionStatusSchema = z.enum(SESSION_STATUSES)
export type SessionStatus = z.infer<typeof SessionStatusSchema>

// ---------------------------------------------------------------------------
// Device presets (static metadata shared with the UI)
// ---------------------------------------------------------------------------

/** Device makers in the catalog; desktop presets are not tied to a maker and use 'Generic'. */
export const DEVICE_BRANDS = ['Apple', 'Samsung', 'Google', 'Motorola', 'OnePlus', 'Xiaomi', 'Microsoft', 'Nokia', 'BlackBerry', 'LG', 'Amazon', 'Generic'] as const
export type DeviceBrand = (typeof DEVICE_BRANDS)[number]

/**
 * Operating system a preset's user agent reports. 'other' covers the handful of legacy
 * platforms that fit none of the mainstream families (BlackBerry 10 / PlayBook OS, MeeGo).
 */
export const DEVICE_OS = ['ios', 'ipados', 'android', 'windows', 'macos', 'linux', 'chromeos', 'other'] as const
export type DeviceOs = (typeof DEVICE_OS)[number]
export const DEVICE_OS_LABELS: Record<DeviceOs, string> = {
  ios: 'iOS',
  ipados: 'iPadOS',
  android: 'Android',
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  chromeos: 'ChromeOS',
  other: 'Other',
}

export const DEVICE_ORIENTATIONS = ['portrait', 'landscape'] as const
export type DeviceOrientation = (typeof DEVICE_ORIENTATIONS)[number]

/**
 * Size bucket. Phones (by portrait CSS width): 'compact' < 380 px, 'regular' < 428 px, 'large' otherwise.
 * Tablets (by shorter side) and desktops (by width): 'small' | 'medium' | 'large' | 'xl'.
 */
export const SCREEN_CLASSES = ['compact', 'regular', 'small', 'medium', 'large', 'xl'] as const
export type ScreenClass = (typeof SCREEN_CLASSES)[number]

export interface DevicePresetInfo {
  id: DevicePresetId
  /** "<Brand> <Model>" for phones/tablets ("Apple iPhone 15 Pro"), "<OS> · <Browser> · <W×H>" for desktops. Landscape twins end in " (landscape)". */
  label: string
  deviceType: DeviceType
  /** Playwright `devices[...]` descriptor name, or null for custom desktop presets. */
  playwrightDevice: string | null
  viewportWidth: number
  viewportHeight: number
  userAgent: string
  /** Engines that can faithfully emulate this preset. */
  supportedEngines: readonly BrowserEngine[]
  /**
   * Discontinued device (e.g. iPhone 6, Nexus 5, Lumia). Kept for regression testing;
   * hidden from "Random device" and flagged in the picker. Absent means not legacy.
   */
  legacy?: boolean
  // --- Catalog metadata (populated for every catalog preset; optional for older callers) ---
  brand?: DeviceBrand
  /** Marketing name without the brand ("iPhone 15 Pro Max", "Galaxy Z Fold 7"); desktops repeat the label. */
  model?: string
  os?: DeviceOs
  /** Version parsed from the user agent ("17.5", "14"); null when the UA does not carry a meaningful one. */
  osVersion?: string | null
  orientation?: DeviceOrientation
  /** For landscape variants: id of the portrait twin. Null otherwise. */
  landscapeOf?: DevicePresetId | null
  deviceScaleFactor?: number
  hasTouch?: boolean
  screenClass?: ScreenClass
  /** Best-effort launch year for known models; null when unknown (desktop presets). */
  releaseYear?: number | null
  /** Part of the curated "Popular" set of current mainstream devices. */
  popular?: boolean
}

// ---------------------------------------------------------------------------
// Proxy pools & geo targeting
// ---------------------------------------------------------------------------

/** DataImpulse sells pools as separate plans with their own logins on the same gateway. */
export const PROXY_POOLS = ['residential', 'mobile'] as const
export const ProxyPoolSchema = z.enum(PROXY_POOLS)
export type ProxyPool = z.infer<typeof ProxyPoolSchema>
export const PROXY_POOL_LABELS: Record<ProxyPool, string> = {
  residential: 'DataImpulse Residential',
  mobile: 'DataImpulse Mobile',
}

/** How precisely the exit IP location is requested from the provider. */
export const TARGET_MODES = ['country', 'state', 'city', 'zip'] as const
export const TargetModeSchema = z.enum(TARGET_MODES)
export type TargetMode = z.infer<typeof TargetModeSchema>

/**
 * Requested exit location. `country` is always required by DataImpulse (lower-case ISO-2).
 * `state`/`city` hold the human-readable names (e.g. "New Jersey", "Los Angeles"); the
 * provider adapter encodes them (DataImpulse: lower-case, spaces removed → state.newjersey).
 */
export const GeoTargetSchema = z.object({
  mode: TargetModeSchema,
  country: z.string().trim().length(2).toLowerCase(),
  state: z.string().trim().min(1).max(64).nullable(),
  /** USPS code when known (e.g. "NJ"), used to compare with the verified IP region. */
  stateCode: z.string().trim().length(2).toUpperCase().nullable(),
  city: z.string().trim().min(1).max(80).nullable(),
  zip: z.string().trim().regex(/^\d{5}$/, 'ZIP must be 5 digits').nullable(),
})
export type GeoTarget = z.infer<typeof GeoTargetSchema>

/** A searchable entry from the bundled US location dataset (GeoNames, CC BY 4.0). */
export interface LocationEntry {
  kind: TargetMode
  /** Display label, e.g. "New Jersey (NJ)", "Newark, NJ", "07102 — Newark, NJ". */
  label: string
  country: string
  state: string
  stateCode: string
  city: string | null
  zip: string | null
  /** IANA timezone typical for the state (used to auto-fill profile timezone). */
  timezone: string | null
  /** States only: distinct cities in the dataset. */
  cityCount?: number
  /** States and cities: distinct ZIP codes in the dataset. */
  zipCount?: number
}

/** USPS state code filter ("NJ"), case-insensitive on input. */
export const StateCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, 'State code must be 2 letters')
  .transform((code) => code.toUpperCase())

export const LocationSearchSchema = z.object({
  mode: TargetModeSchema,
  query: z.string().trim().max(80),
  limit: z.int().min(1).max(200).default(50),
  /** Only cities / ZIP codes in this state (ignored for state and country searches). */
  stateCode: StateCodeSchema.optional(),
})
export type LocationSearch = z.input<typeof LocationSearchSchema>

/** One page of search results plus how many entries match in total (the page is capped at `limit`). */
export interface LocationQueryResult {
  entries: LocationEntry[]
  total: number
}

/** Size of the bundled dataset, for the picker's start hint. */
export interface LocationStats {
  states: number
  cities: number
  zips: number
}

/** Verified-vs-requested comparison after the exit IP is known. */
export const TARGET_MATCHES = ['match', 'partial', 'mismatch', 'unknown'] as const
export type TargetMatch = (typeof TARGET_MATCHES)[number]

/**
 * What a sticky session's exit location must achieve before the browser opens
 * (settings.locationMatchPolicy). A result that falls short is re-rolled with a
 * fresh sticky session id, up to settings.locationMatchAttempts attempts in total.
 * - `off`: accept the first exit IP.
 * - `state`: the state (or, for a country target, the country) must match — re-roll on 'mismatch'.
 * - `exact`: every requested level must match (city name, or the exact ZIP) — re-roll on 'mismatch' and 'partial'.
 */
export const LOCATION_MATCH_POLICIES = ['off', 'state', 'exact'] as const
export const LocationMatchPolicySchema = z.enum(LOCATION_MATCH_POLICIES)
export type LocationMatchPolicy = z.infer<typeof LocationMatchPolicySchema>
export const LOCATION_MATCH_ATTEMPTS_MIN = 1
export const LOCATION_MATCH_ATTEMPTS_MAX = 8

/** True when `match` satisfies `policy` ('unknown' cannot be improved by a re-roll, so it is accepted). */
export function satisfiesLocationPolicy(policy: LocationMatchPolicy, match: TargetMatch | null): boolean {
  switch (policy) {
    case 'off':
      return true
    case 'state':
      return match !== 'mismatch'
    case 'exact':
      return match !== 'mismatch' && match !== 'partial'
  }
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/** Sticky session ids: user-facing charset and length limit (also honoured when rotating). */
export const STICKY_SESSION_ID_MAX_LENGTH = 64
export const STICKY_SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

/** Form URLs must be plain http(s) — nothing else can be opened in a QA browser. */
export const FORM_URL_MESSAGE = 'Form URL must start with http:// or https://'
export const FormUrlSchema = z.url({ protocol: /^https?$/, error: FORM_URL_MESSAGE })

export const ProfileInputSchema = z.object({
  name: z.string().trim().min(1, 'Profile name is required').max(80),
  engine: BrowserEngineSchema,
  deviceType: DeviceTypeSchema,
  devicePreset: DevicePresetIdSchema,
  viewportWidth: z.int().min(320).max(7680),
  viewportHeight: z.int().min(320).max(4320),
  /** Empty string or null means "use preset default". */
  userAgent: z.string().trim().max(512).nullable(),
  locale: z.string().trim().min(2).max(35),
  timezone: z.string().trim().min(1).max(64),
  proxyMode: ProxyModeSchema,
  /** Required when proxyMode is dataimpulse-sticky; letters, digits, dash, underscore (max 64). */
  stickySessionId: z
    .string()
    .trim()
    .regex(STICKY_SESSION_ID_PATTERN, 'Session ID may contain letters, digits, dash and underscore only')
    .nullable(),
  /** Optional per-profile override of the default test form URL (http/https only). */
  formUrlOverride: FormUrlSchema.nullable(),
  notes: z.string().max(4000),
  /** Which provider pool (plan/login) to use when proxyMode is not 'none'. */
  proxyPool: ProxyPoolSchema.default('residential'),
  /** Requested exit location; null = provider default (no geo filter beyond the login). */
  target: GeoTargetSchema.nullable().default(null),
  /** Sticky session TTL in minutes (DataImpulse sessttl); null = provider default (~30 min). */
  stickyTtlMinutes: z.int().min(1).max(1440).nullable().default(null),
  /** Created by Quick Launch and hidden from the Profiles page unless saved. */
  ephemeral: z.boolean().default(false),
})
export type ProfileInput = z.infer<typeof ProfileInputSchema>

// ---------------------------------------------------------------------------
// Quick Launch (one-shot session from the launcher page)
// ---------------------------------------------------------------------------

export const QuickLaunchInputSchema = z.object({
  /** Falls back to settings.defaultFormUrl when null. */
  startUrl: FormUrlSchema.nullable(),
  engine: BrowserEngineSchema,
  devicePreset: DevicePresetIdSchema,
  /** 'none' = direct connection. */
  proxyPool: z.union([ProxyPoolSchema, z.literal('none')]),
  target: GeoTargetSchema.nullable(),
  /** true → a fresh sticky session id is generated for this launch; false → rotating. */
  sticky: z.boolean().default(true),
  stickyTtlMinutes: z.int().min(1).max(1440).nullable().default(null),
  /** Optional overrides; when null they are derived from the target (US state → timezone) / preset. */
  locale: z.string().trim().min(2).max(35).nullable().default(null),
  timezone: z.string().trim().min(1).max(64).nullable().default(null),
  /** Keep the generated profile visible on the Profiles page. */
  saveAsProfile: z.boolean().default(false),
  profileName: z.string().trim().min(1).max(80).nullable().default(null),
  /** When a session is already open and singleSessionMode is on: close it first. */
  replaceActiveSession: z.boolean().default(false),
})
export type QuickLaunchInput = z.infer<typeof QuickLaunchInputSchema>

/** What the launcher shows before connecting: the exact targeting string that will be sent (no secrets). */
export interface TargetingPreview {
  pool: ProxyPool | 'none'
  /** e.g. "cr.us;state.newjersey;sessid.ql-7f3a" — parameters only, never the login or password. */
  targetingString: string | null
  poolConfigured: boolean
  warnings: string[]
}

export const ProfileSchema = ProfileInputSchema.extend({
  id: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Profile = z.infer<typeof ProfileSchema>

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

/** What the renderer may know about proxy configuration. NEVER includes the password. */
export interface ProxyPoolStatus {
  pool: ProxyPool
  configured: boolean
  host: string | null
  port: number | null
  usernameMasked: string | null
  source: CredentialSource
}

export interface ProxyConfigStatus {
  /** True when at least one pool is configured. */
  configured: boolean
  pools: ProxyPoolStatus[]
  provider: 'dataimpulse'
  host: string | null
  port: number | null
  /** Username with the middle masked, e.g. "ab****yz". */
  usernameMasked: string | null
  /** Which required fields are missing, for the setup message. */
  missing: string[]
  /** Where the active credentials come from. */
  source: CredentialSource
}

// ---------------------------------------------------------------------------
// Encrypted credential vault & first-run setup
// ---------------------------------------------------------------------------

/** 'vault' = encrypted per-machine vault; 'env' = development-only .env fallback; 'none' = not configured. */
export const CREDENTIAL_SOURCES = ['vault', 'env', 'none'] as const
export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number]

/** How the vault key is protected at rest. */
export const KEY_BACKENDS = ['os-keychain', 'machine-derived', 'none'] as const
export type KeyBackend = (typeof KEY_BACKENDS)[number]

/** A sticky-session username template must place both the login and the session id. */
export const SESSION_TEMPLATE_MESSAGE = 'Session template must contain both {username} and {session}'
export const isValidSessionTemplate = (template: string): boolean => template.includes('{username}') && template.includes('{session}')

/** Input for saving/testing proxy credentials from the UI. Never echoed back. */
export const ProxyCredentialsInputSchema = z.object({
  pool: ProxyPoolSchema.default('residential'),
  host: z.string().trim().min(1, 'Proxy host is required').max(253),
  port: z.int().min(1).max(65535),
  username: z.string().trim().min(1, 'Proxy username is required').max(256),
  password: z.string().min(1, 'Proxy password is required').max(512),
  /** Optional override of the sticky-session username template (empty string = no override). */
  sessionTemplate: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .refine((t) => t === null || t === '' || isValidSessionTemplate(t), SESSION_TEMPLATE_MESSAGE),
})
export type ProxyCredentialsInput = z.infer<typeof ProxyCredentialsInputSchema>

/**
 * Partial update of one pool's stored credentials (Manage keys window). Absent or empty
 * host / username / password keep the stored value, so a password can be rotated without
 * retyping the username. `sessionTemplate`: absent keeps the stored template, null or ''
 * removes the override. The main process merges with the vault entry and validates the
 * merged result with `ProxyCredentialsInputSchema`. Never echoed back.
 */
export const ProxyCredentialsUpdateSchema = z.object({
  pool: ProxyPoolSchema,
  host: z.string().trim().max(253).optional(),
  port: z.int().min(1).max(65535).optional(),
  username: z.string().trim().max(256).optional(),
  password: z.string().max(512).optional(),
  sessionTemplate: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .optional()
    .refine((t) => t === undefined || t === null || t === '' || isValidSessionTemplate(t), SESSION_TEMPLATE_MESSAGE),
})
export type ProxyCredentialsUpdate = z.infer<typeof ProxyCredentialsUpdateSchema>

/** Local, network-free health of the credential vault. Safe to send to the renderer. */
export interface SecurityStatus {
  source: CredentialSource
  /** Pools with credentials present in the vault (or env fallback). */
  configuredPools: ProxyPool[]
  /** Backend protecting the vault key ('none' when no key exists yet). */
  keyBackend: KeyBackend
  /** Human label of the OS backend, e.g. "Windows DPAPI", "GNOME Keyring / libsecret", "machine-derived (reduced protection)". */
  keyBackendLabel: string
  keyPath: string
  vaultPath: string
  keyPresent: boolean
  vaultPresent: boolean
  /** The vault decrypted and its integrity tag verified during the last local check. */
  decryptOk: boolean
  /** Key/vault files have owner-only permissions (always true on Windows where ACLs apply). */
  permissionsOk: boolean
  /** Stable per-installation id (random UUID generated on first run). */
  installId: string
  keyCreatedAt: string | null
  vaultUpdatedAt: string | null
  lastCheckedAt: string
  /** Last on-demand proxy test result (from the gateway proxy session), to avoid re-testing on every start. */
  lastProxyTestAt: string | null
  lastProxyTestStatus: ProxyStatus | null
  /** Non-fatal problems, human-readable. */
  warnings: string[]
}

/** First-run / continuation state. */
export interface SetupStatus {
  /** True until setup.complete() has been called once on this installation. */
  firstRun: boolean
  completedAt: string | null
  appVersion: string
  browsers: BrowsersStatus
  security: SecurityStatus
  proxy: ProxyConfigStatus
  /** Which steps still need attention. */
  pending: SetupStep[]
}
export const SETUP_STEPS = ['browsers', 'credentials'] as const
export type SetupStep = (typeof SETUP_STEPS)[number]

export interface IpInfo {
  ip: string
  country: string | null
  countryCode: string | null
  region: string | null
  city: string | null
  /** Postal / ZIP code of the exit IP as reported by the IP service (ip-api `zip`, ipinfo & ipwho.is `postal`). */
  postalCode: string | null
  isp: string | null
  asn: string | null
  latencyMs: number
  provider: IpCheckProvider
  checkedAt: string
}

export interface ProxySession {
  id: string
  profileId: string | null
  provider: 'dataimpulse'
  pool: ProxyPool
  target: GeoTarget | null
  targetingString: string | null
  targetMatch: TargetMatch | null
  /** Sticky session identifier sent to the provider (null for rotating). */
  sessionId: string | null
  status: ProxyStatus
  lastIp: string | null
  country: string | null
  /** ISO 3166-1 alpha-2 code of the last exit IP, when the IP service reported one. */
  countryCode: string | null
  region: string | null
  city: string | null
  postalCode: string | null
  isp: string | null
  asn: string | null
  latencyMs: number | null
  lastCheckedAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export interface ProxyTestResult {
  status: ProxyStatus
  sessionId: string | null
  ip: IpInfo | null
  error: AppError | null
}

// ---------------------------------------------------------------------------
// Test runs & network inspector
// ---------------------------------------------------------------------------

export interface TestRun {
  id: string
  profileId: string | null
  profileName: string
  engine: BrowserEngine
  devicePreset: DevicePresetId
  proxyPool: ProxyPool | null
  target: GeoTarget | null
  /** Parameters sent to the provider (no login/password), e.g. "cr.us;zip.07102;sessid.x". */
  targetingString: string | null
  targetMatch: TargetMatch | null
  publicIp: string | null
  country: string | null
  region: string | null
  city: string | null
  postalCode: string | null
  /** Sticky session ids tried before the browser opened (1 = the first exit IP was used). */
  locationAttempts: number
  /** Attempt budget at launch (settings.locationMatchAttempts when a re-roll was possible, else 1). */
  locationMaxAttempts: number
  /** Set when no attempt met the location policy and the best result was used, e.g. "Could not get an exit IP in …". */
  locationWarning: string | null
  proxySessionId: string | null
  formUrl: string
  startedAt: string
  endedAt: string | null
  status: RunStatus
  notes: string
  httpStatus: number | null
  finalUrl: string | null
  screenshotPath: string | null
  leadId: string | null
  certificateId: string | null
  errorMessage: string | null
}

/** Statuses the renderer may set by hand; 'running' and 'aborted' are owned by the browser manager. */
export const USER_RUN_STATUSES = ['success', 'failed'] as const
export const UserRunStatusSchema = z.enum(USER_RUN_STATUSES)

export const TestRunPatchSchema = z.object({
  notes: z.string().max(4000).optional(),
  leadId: z.string().trim().max(128).nullable().optional(),
  certificateId: z.string().trim().max(128).nullable().optional(),
  status: UserRunStatusSchema.optional(),
})
export type TestRunPatch = z.infer<typeof TestRunPatchSchema>

export interface NetworkEntry {
  id: string
  runId: string
  method: string
  url: string
  status: number | null
  resourceType: string
  requestTime: string
  responseTime: string | null
  durationMs: number | null
  /** IDs extracted from JSON response bodies: leadId, lead_id, certificateId, certificate_id. */
  extractedIds: Record<string, string>
}

export const NETWORK_FILTER_KEYWORDS = ['lead', 'submit', 'certificate', 'cert', 'form', 'api'] as const

// ---------------------------------------------------------------------------
// Sessions (live browser sessions)
// ---------------------------------------------------------------------------

export interface BrowserSession {
  id: string
  runId: string
  profileId: string
  profileName: string
  engine: BrowserEngine
  devicePreset: DevicePresetId
  proxyPool: ProxyPool | null
  target: GeoTarget | null
  targetingString: string | null
  targetMatch: TargetMatch | null
  status: SessionStatus
  /** Human-readable progress line, e.g. "Verifying proxy exit IP…". */
  statusDetail: string
  ip: IpInfo | null
  /** Sticky session ids tried so far for the location policy (see TestRun.locationAttempts). */
  locationAttempts: number
  locationMaxAttempts: number
  /** Set when no attempt met the location policy and the best result was used. */
  locationWarning: string | null
  proxySessionId: string | null
  currentUrl: string | null
  startedAt: string
  error: AppError | null
  /**
   * OS process id of the session's browser, when known. Chromium-family browsers are found by
   * the `--proxy-qa-session=<id>` marker switch on their command line; Firefox and WebKit stay null.
   */
  browserPid: number | null
  /** Last time the session monitor confirmed the browser is connected and has an open page (ISO). */
  lastHeartbeatAt: string | null
}

// ---------------------------------------------------------------------------
// Background tasks (browser installs / uninstalls run one after another)
// ---------------------------------------------------------------------------

/**
 * - 'install-bundled': download a Playwright engine (chromium / firefox / webkit);
 * - 'install-vendor': install a real vendor browser with its automatic method (winget, user-space package…);
 * - 'uninstall': remove the copy the app installed into its data folder.
 */
export const TASK_KINDS = ['install-bundled', 'install-vendor', 'uninstall'] as const
export type TaskKind = (typeof TASK_KINDS)[number]

/** queued → running → verifying → done | failed; any unfinished state → cancelled. */
export const TASK_STATES = ['queued', 'running', 'verifying', 'done', 'failed', 'cancelled'] as const
export type TaskState = (typeof TASK_STATES)[number]
export const ACTIVE_TASK_STATES: readonly TaskState[] = ['queued', 'running', 'verifying']
export const FINISHED_TASK_STATES: readonly TaskState[] = ['done', 'failed', 'cancelled']
export const isTaskActive = (state: TaskState): boolean => ACTIVE_TASK_STATES.includes(state)

/** The "check and balance" after an install: what was verified, without ever opening a visible window. */
export interface TaskVerification {
  /** The executable (or Playwright's install marker) exists. */
  exists: boolean
  /** Version read from the binary's metadata (never by running it on Windows/macOS); null when unknown. */
  version: string | null
  executablePath: string | null
  /** Headless launch → context → about:blank → close. 'skipped' for uninstalls. */
  smoke: 'passed' | 'failed' | 'skipped'
  /** Why the smoke launch failed (sanitised), or null. */
  smokeDetail: string | null
  /** The executable path is remembered in settings (auto-saved or user path); always true for bundled engines. */
  pathSaved: boolean
}

export interface Task {
  id: string
  kind: TaskKind
  engine: BrowserEngine
  /** "Install Google Chrome", "Uninstall Brave". */
  label: string
  state: TaskState
  /** Human status line ("Downloading 42.0 of 140.2 MB", "Waiting for 1 task", "Verifying…"). */
  phase: string
  percent: number | null
  queuedAt: string
  startedAt: string | null
  finishedAt: string | null
  error: AppError | null
  /** Outcome line ("Verified · 154.0.8037.97 · C:\…\chrome.exe"). */
  note: string | null
  verification: TaskVerification | null
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export interface LogEntry {
  id: number
  timestamp: string
  level: LogLevel
  scope: string
  message: string
  meta: Record<string, unknown> | null
}

export interface LogQuery {
  level?: LogLevel
  scope?: string
  search?: string
  limit?: number
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const AppSettingsSchema = z.object({
  defaultFormUrl: FormUrlSchema,
  ipCheckProvider: IpCheckProviderSchema,
  ipCheckTimeoutMs: z.int().min(1000).max(120000),
  ipCheckRetries: z.int().min(0).max(5),
  networkInspectorEnabled: z.boolean(),
  /** Absolute path; defaults to <userData>/data/screenshots. */
  screenshotDir: z.string().min(1),
  /** Navigation timeout for the QA form. */
  navigationTimeoutMs: z.int().min(5000).max(300000),
  /**
   * User overrides of browser executable paths, keyed by engine. An override wins over
   * detection when the file exists. Absent for every engine by default (databases created
   * before this key existed load as `{}`).
   */
  browserExecutables: z.partialRecord(BrowserEngineSchema, z.string().trim().min(1)).default({}),
  /**
   * Who set each `browserExecutables` entry: 'user' (typed in Settings → Browsers — never
   * overwritten while the file exists) or 'auto' (remembered by the app after detection or an
   * install — dropped again when the file disappears, e.g. after moving to another machine).
   * An entry without an origin is treated as 'user' (settings saved before origins existed).
   */
  browserExecutableOrigins: z.partialRecord(BrowserEngineSchema, z.enum(['user', 'auto'])).default({}),
  /** Only one browser session may be open at a time (matches the previous tool's behaviour). */
  singleSessionMode: z.boolean().default(true),
  /** Extra command-line flags for Chromium-family launches ("Flags settings"). */
  extraChromiumArgs: z.array(z.string().trim().regex(/^--[A-Za-z0-9-]+(=.*)?$/, 'Flags must look like --flag or --flag=value')).default([]),
  /** How multi-word place names are encoded for the provider. DataImpulse publishes state.newjersey → 'remove-spaces'. */
  targetingEncoding: z.enum(['remove-spaces', 'underscore', 'keep']).default('remove-spaces'),
  defaultProxyPool: ProxyPoolSchema.default('residential'),
  defaultTargetCountry: z.string().trim().length(2).toLowerCase().default('us'),
  /** Sticky sessions with a target: what the verified exit location must achieve before the browser opens. */
  locationMatchPolicy: LocationMatchPolicySchema.default('state'),
  /** Total attempts (first check + re-rolls) for the location policy. Each costs one small IP-check request. */
  locationMatchAttempts: z.int().min(LOCATION_MATCH_ATTEMPTS_MIN).max(LOCATION_MATCH_ATTEMPTS_MAX).default(3),
})
export type AppSettings = z.infer<typeof AppSettingsSchema>
export type BrowserExecutableOverrides = AppSettings['browserExecutables']
export type BrowserExecutableOrigins = AppSettings['browserExecutableOrigins']
export type BrowserExecutableOrigin = 'user' | 'auto'
/**
 * Every key optional and — unlike `.partial()`, which in Zod 4 still fills in `.default()`s — absent
 * keys stay absent, so a patch never resets settings it does not mention.
 */
function optionalWithoutDefaults<S extends z.ZodRawShape>(shape: S): z.ZodObject<{ [K in keyof S]: z.ZodOptional<S[K]> }> {
  const optional: Record<string, z.ZodType> = {}
  for (const [key, field] of Object.entries(shape)) {
    const inner = field instanceof z.ZodDefault ? (field.unwrap() as z.ZodType) : (field as z.ZodType)
    optional[key] = inner.optional()
  }
  return z.object(optional) as unknown as z.ZodObject<{ [K in keyof S]: z.ZodOptional<S[K]> }>
}
export const AppSettingsPatchSchema = optionalWithoutDefaults(AppSettingsSchema.shape)
export type AppSettingsPatch = z.infer<typeof AppSettingsPatchSchema>

export const DEFAULT_SETTINGS: Omit<AppSettings, 'screenshotDir'> = {
  defaultFormUrl: 'https://example.com/',
  ipCheckProvider: 'ip-api',
  ipCheckTimeoutMs: 15000,
  ipCheckRetries: 2,
  networkInspectorEnabled: true,
  navigationTimeoutMs: 60000,
  browserExecutables: {},
  browserExecutableOrigins: {},
  singleSessionMode: true,
  extraChromiumArgs: [],
  targetingEncoding: 'remove-spaces',
  defaultProxyPool: 'residential',
  defaultTargetCountry: 'us',
  locationMatchPolicy: 'state',
  locationMatchAttempts: 3,
}

// ---------------------------------------------------------------------------
// Dashboard & environment
// ---------------------------------------------------------------------------

export interface DashboardStats {
  totalProfiles: number
  activeSessions: number
  workingProxies: number
  failedProxies: number
  currentIp: IpInfo | null
  recentRuns: TestRun[]
  proxyConfigured: boolean
  browsers: BrowsersStatus
}

/**
 * Where the browsers directory came from:
 * 'env' = PLAYWRIGHT_BROWSERS_PATH set by the user; 'bundled' = shipped inside
 * the packaged app (read-only); 'provisioned' = <userData>/data/browsers,
 * installed on demand; 'dev-cache' = Playwright's default cache (development).
 */
export const BROWSERS_SOURCES = ['env', 'bundled', 'provisioned', 'dev-cache'] as const
export type BrowsersSource = (typeof BROWSERS_SOURCES)[number]

export interface BrowsersStatus {
  /** Directory where Playwright browsers are provisioned. */
  browsersPath: string
  chromium: boolean
  firefox: boolean
  webkit: boolean
  /** Playwright-core version driving the browser revisions. */
  playwrightVersion: string
  source: BrowsersSource
  /** False when the browsers are bundled with the build (read-only): Install/Reinstall is not available. */
  installable: boolean
  /** One entry per `BROWSER_ENGINES` member (bundled and installed), in that order. */
  engines: BrowserEngineInfo[]
}

/** Only bundled engines can be installed by the app; 'all' means every bundled engine. */
export type BrowserInstallTarget = BundledBrowserEngine | 'all'

export const INSTALL_PHASES = ['starting', 'downloading', 'extracting', 'installing', 'verifying', 'done', 'error'] as const
export type InstallPhase = (typeof INSTALL_PHASES)[number]

export interface BrowserInstallProgress {
  /** A bundled engine / 'all' for Playwright downloads; an installed-kind engine for vendor installs. */
  engine: BrowserInstallTarget | BrowserEngine
  phase: InstallPhase
  /** Last line of installer output, or a human status line ("Downloading 42.0 of 140.2 MB"). */
  message: string
  percent: number | null
  /** Set while `installAllMissing` runs: this engine is install `index` (1-based) of `total`. */
  batch?: { index: number; total: number }
}

/** Outcome of `browsers.installAllMissing`: every automatic install was attempted in turn. */
export interface InstallAllResult {
  status: BrowsersStatus
  installed: InstalledBrowserEngine[]
  failed: Array<{ engine: InstalledBrowserEngine; message: string }>
}

/**
 * State of the "waiting for you to install it" watcher started by "Get <Browser>":
 * 'watching' (polling every few seconds), 'found' (the browser appeared; `info` carries it),
 * 'expired' (gave up after the time limit) or 'cancelled' (replaced, or the app is quitting).
 */
export interface BrowserWatchUpdate {
  engine: InstalledBrowserEngine
  state: 'watching' | 'found' | 'expired' | 'cancelled'
  info: BrowserEngineInfo | null
}

export interface AppInfo {
  version: string
  platform: NodeJS.Platform | string
  userDataPath: string
  dataPath: string
  isPackaged: boolean
}

// ---------------------------------------------------------------------------
// Errors & IPC result envelope
// ---------------------------------------------------------------------------

export const APP_ERROR_CODES = [
  'PROXY_NOT_CONFIGURED',
  /** Vault key or vault file missing/corrupt/undecryptable. */
  'VAULT_ERROR',
  'PROXY_AUTH_FAILED',
  'PROXY_TIMEOUT',
  'PROXY_DEAD',
  'DNS_FAILURE',
  'IP_VERIFY_FAILED',
  'BROWSER_MISSING',
  'BROWSER_LAUNCH_FAILED',
  'SITE_TIMEOUT',
  /** The form URL answered, but with an HTTP error status (≥ 400). */
  'SITE_HTTP_ERROR',
  'SSL_ERROR',
  'INVALID_PROFILE',
  'INVALID_INPUT',
  'NOT_FOUND',
  'SESSION_CLOSED',
  /** singleSessionMode is on and another browser session is already open. */
  'SESSION_LIMIT',
  /** The engine is being installed (or uninstalled) by a background task; launch it once that finishes. */
  'ENGINE_BUSY',
  'INTERNAL',
] as const
export type AppErrorCode = (typeof APP_ERROR_CODES)[number]

export interface AppError {
  code: AppErrorCode
  /** Human-readable, actionable, never contains secrets. */
  message: string
  /** Optional technical detail (sanitised). */
  detail?: string
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: AppError }

export const ok = <T>(data: T): IpcResult<T> => ({ ok: true, data })
export const fail = <T = never>(error: AppError): IpcResult<T> => ({ ok: false, error })

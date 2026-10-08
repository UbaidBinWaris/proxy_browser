/**
 * Device preset catalog (200+ presets).
 *
 * The catalog is generated at module load from two sources:
 *
 * 1. **Every Playwright device descriptor** in `playwright-core`'s `devices`
 *    registry — phones, tablets and the "Desktop …" descriptors, portrait *and*
 *    landscape — so viewport, scale factor, screen size and user agent track the
 *    installed Playwright release. The preset id is the kebab-case of the
 *    descriptor key (`"iPhone 15 Pro Max"` → `iphone-15-pro-max`,
 *    `"iPad (gen 11)"` → `ipad-gen-11`), except for the handful of core ids that
 *    predate the generated catalog (`macos-safari-desktop`, `desktop-edge`,
 *    `desktop-firefox`, `iphone-se-3`), which keep their historical id so saved
 *    profiles stay valid. Descriptors whose viewport is below the 320 px floor
 *    enforced by `ProfileInputSchema` (a few landscape and cover-screen
 *    variants) are skipped: a profile could never be saved with them.
 *
 * 2. **Curated custom descriptors** for devices Playwright lacks: recent Samsung,
 *    OnePlus, Xiaomi and Motorola phones (Chrome-on-Android UA with the Chrome
 *    version taken from Playwright's own "Desktop Chrome" descriptor) and a set
 *    of desktop profiles (Windows / Linux / macOS-style / Chromebook with Chrome
 *    UA, plus a Windows Edge-UA desktop).
 *
 * Discontinued devices (iPhone 6 … X/XR, first-gen SE, Nexus, Lumia, BlackBerry,
 * Galaxy S III/S5/Note 2/3, Kindle Fire HDX, Moto G4, Pixel 2–4) carry
 * `legacy: true` (the picker shows a badge; the label stays clean);
 * `randomPreset` skips them unless asked otherwise.
 *
 * Every preset carries picker metadata: brand, model (marketing name without the
 * brand), OS and version parsed from the user agent, orientation (+ the portrait
 * twin of a landscape variant), scale factor, touch, a screen-size class, a
 * best-effort release year and a curated `popular` flag. Labels are
 * "<Brand> <Model>" for phones and tablets ("Apple iPhone 15 Pro", landscape
 * twins add " (landscape)") and "<OS> · <Browser> · <W×H>" for desktops; a HiDPI
 * scale is metadata (`deviceScaleFactor`), never part of the name.
 *
 * Engine gating follows the engine *family* (see `BROWSER_ENGINE_FAMILY`):
 * - mobile and tablet presets need `isMobile`/touch emulation, which Playwright
 *   Firefox does not support, so they accept every Chromium-family engine
 *   (bundled Chromium and the installed Chrome/Edge/Brave/Opera/Opera GX/
 *   Vivaldi/system Chromium) plus WebKit;
 * - desktop presets accept every engine, except the descriptor-specific ones
 *   that only make sense on one engine ("Desktop Safari" → WebKit only,
 *   "Desktop Firefox [HiDPI]" → Firefox only, "Desktop Edge [HiDPI]" and the
 *   Edge-UA Windows desktop → Chromium family).
 *
 * The macOS Chrome presets are labelled "macOS · Chrome" on purpose: they are not
 * Safari and must never be presented as such. The "Desktop Safari" descriptor is
 * labelled "macOS · Safari (WebKit)" — Playwright's WebKit, never Apple Safari.
 */
import { devices } from 'playwright-core'
import type { BrowserContextOptions } from 'playwright-core'
import type { BrowserEngine, DeviceBrand, DeviceOs, DevicePresetId, DevicePresetInfo, DeviceType, Profile, ScreenClass } from '@shared/types'
import { BROWSER_ENGINES, BROWSER_ENGINE_FAMILY, DEVICE_OS_LABELS, DEVICE_PRESET_IDS, DEVICE_TYPES } from '@shared/types'
import { AppException } from '../contracts'

/** Emulation details needed to build a context but not exposed to the renderer. */
interface EmulationDescriptor {
  deviceScaleFactor: number
  isMobile: boolean
  hasTouch: boolean
  screen: { width: number; height: number } | null
}

interface PresetDefinition {
  info: DevicePresetInfo
  emulation: EmulationDescriptor
}

/** Every engine, in `BROWSER_ENGINES` order. */
const ALL_ENGINES: readonly BrowserEngine[] = BROWSER_ENGINES
/** Every engine driven by Playwright's Chromium `BrowserType` (bundled Chromium + installed Chromium-based browsers). */
export const CHROMIUM_FAMILY_ENGINES: readonly BrowserEngine[] = BROWSER_ENGINES.filter((engine) => BROWSER_ENGINE_FAMILY[engine] === 'chromium')
/** Playwright Firefox does not support `isMobile`, so mobile/tablet presets exclude it. */
export const MOBILE_ENGINES: readonly BrowserEngine[] = BROWSER_ENGINES.filter((engine) => BROWSER_ENGINE_FAMILY[engine] !== 'firefox')
const WEBKIT_ONLY: readonly BrowserEngine[] = ['webkit']
const FIREFOX_ONLY: readonly BrowserEngine[] = ['firefox']

/** Smallest viewport side a profile may have — mirrors the `viewportWidth`/`viewportHeight` minimums in `ProfileInputSchema`. */
const MIN_VIEWPORT_PX = 320

interface PlaywrightDescriptor {
  userAgent: string
  viewport: { width: number; height: number }
  screen?: { width: number; height: number }
  deviceScaleFactor: number
  isMobile: boolean
  hasTouch: boolean
  defaultBrowserType: 'chromium' | 'firefox' | 'webkit'
}

const PLAYWRIGHT_DEVICES = devices as Record<string, PlaywrightDescriptor | undefined>

function requirePlaywrightDevice(name: string): PlaywrightDescriptor {
  const descriptor = PLAYWRIGHT_DEVICES[name]
  if (!descriptor) {
    throw new Error(
      `Playwright device descriptor "${name}" is missing from the installed playwright-core. ` +
        'Reinstall dependencies or update device-presets.ts to match the installed version.',
    )
  }
  return descriptor
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** Kebab-case preset id for a Playwright descriptor key: `"Galaxy S9+"` → `galaxy-s9-plus`, `"iPad (gen 11)"` → `ipad-gen-11`. */
export function toPresetId(descriptorKey: string): DevicePresetId {
  return descriptorKey
    .toLowerCase()
    .replace(/\+/g, ' plus')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Core ids that predate the generated catalog and differ from the kebab-case of their descriptor key. */
const CORE_ID_BY_KEY: Readonly<Record<string, DevicePresetId>> = {
  'Desktop Safari': 'macos-safari-desktop',
  'Desktop Edge': 'desktop-edge',
  'Desktop Firefox': 'desktop-firefox',
  'iPhone SE (3rd gen)': 'iphone-se-3',
}

function ordinal(n: number): string {
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`
  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}

function appleModel(key: string): string {
  const ipadGen = /^iPad \(gen (\d+)\)$/.exec(key)?.[1]
  if (ipadGen) return `iPad (${ordinal(Number(ipadGen))} gen)`
  if (key === 'iPhone SE') return 'iPhone SE (1st gen)'
  if (key === 'iPad Pro 11') return 'iPad Pro 11"'
  // Apple writes "mini" in lower case ("iPhone 13 mini", "iPad mini").
  return key.replace(/ Mini\b/, ' mini')
}

/** Brand and marketing model for a (portrait) phone/tablet descriptor key. */
export function brandAndModel(key: string): { brand: DeviceBrand; model: string } {
  if (/^(iPhone|iPad)\b/.test(key)) return { brand: 'Apple', model: appleModel(key) }
  if (/^(Pixel|Nexus) /.test(key)) return { brand: 'Google', model: key }
  if (/^Galaxy /.test(key)) return { brand: 'Samsung', model: key.replace(/ Cover$/, ' (cover screen)') }
  if (/^Kindle /.test(key)) return { brand: 'Amazon', model: key }
  if (/^Moto /.test(key)) return { brand: 'Motorola', model: key }
  if (/^BlackBerry /i.test(key)) return { brand: 'BlackBerry', model: key.replace(/^BlackBerry /i, '') }
  if (/^Nokia /.test(key)) return { brand: 'Nokia', model: key.slice('Nokia '.length) }
  if (/^Microsoft /.test(key)) return { brand: 'Microsoft', model: key.slice('Microsoft '.length) }
  if (/^LG /.test(key)) return { brand: 'LG', model: key.slice('LG '.length) }
  return { brand: 'Generic', model: key }
}

/** "<Brand> <Model>", without repeating a brand that is part of the product name ("OnePlus 12", "Xiaomi 14"). */
export function deviceLabel(brand: DeviceBrand, model: string, landscape: boolean): string {
  const name = brand === 'Generic' || model.startsWith(`${brand} `) ? model : `${brand} ${model}`
  return landscape ? `${name} (landscape)` : name
}

/** Desktop label: "Windows · Chrome · 1920×1080", "Chromebook · 1366×768". */
export function desktopLabel(os: DeviceOs, browser: string, width: number, height: number): string {
  const size = `${width}×${height}`
  if (os === 'chromeos') return `Chromebook · ${size}`
  return `${DEVICE_OS_LABELS[os]} · ${browser} · ${size}`
}

/** Browser named by a desktop descriptor's user agent and engine. */
function desktopBrowserName(d: PlaywrightDescriptor): string {
  if (d.defaultBrowserType === 'webkit') return 'Safari (WebKit)'
  if (d.defaultBrowserType === 'firefox') return 'Firefox'
  return /\bEdg\//.test(d.userAgent) ? 'Edge' : 'Chrome'
}

// ---------------------------------------------------------------------------
// User-agent parsing
// ---------------------------------------------------------------------------

/** "8.0.0" → "8", "7.0" → "7", "17_5" → "17.5", "4.4.2" stays. */
function cleanVersion(raw: string): string {
  const parts = raw.replace(/_/g, '.').split('.')
  while (parts.length > 1 && parts[parts.length - 1] === '0') parts.pop()
  return parts.join('.')
}

/** Operating system and version a user agent reports. Windows Phone is checked before Android (Lumia UAs carry both). */
export function parseUserAgentOs(ua: string): { os: DeviceOs; osVersion: string | null } {
  const windowsPhone = /Windows Phone (\d+)/.exec(ua)?.[1]
  if (windowsPhone) return { os: 'windows', osVersion: Number(windowsPhone) >= 10 ? `${windowsPhone} Mobile` : `Phone ${windowsPhone}` }
  const ipad = /\biPad\b.*?CPU OS (\d+(?:_\d+)*)/.exec(ua)
  if (ipad) return { os: 'ipados', osVersion: ipad[1] ? cleanVersion(ipad[1]) : null }
  const iphone = /\biPhone\b.*?iPhone OS (\d+(?:_\d+)*)/.exec(ua)
  if (iphone) return { os: 'ios', osVersion: iphone[1] ? cleanVersion(iphone[1]) : null }
  const android = /\bAndroid (\d+(?:\.\d+)*)/.exec(ua)?.[1]
  if (android) return { os: 'android', osVersion: cleanVersion(android) }
  // Fire OS is Android underneath; the Kindle UA carries no Android version.
  if (/\bKF[A-Z]{2,}\b|\bSilk\//.test(ua)) return { os: 'android', osVersion: null }
  if (/\bBB10\b|\bPlayBook\b|\bRIM Tablet OS\b|\bMeeGo\b/.test(ua)) return { os: 'other', osVersion: null }
  if (/\bCrOS\b/.test(ua)) return { os: 'chromeos', osVersion: null }
  // Chrome and Edge freeze the token at "Windows NT 10.0" for Windows 10 and 11 alike.
  if (/\bWindows NT 10\.0\b/.test(ua)) return { os: 'windows', osVersion: '10/11' }
  if (/\bWindows\b/.test(ua)) return { os: 'windows', osVersion: null }
  // The macOS token is frozen at 10_15_7 by every browser: not a real version.
  if (/\bMacintosh\b/.test(ua)) return { os: 'macos', osVersion: null }
  if (/\bLinux\b|\bX11\b/.test(ua)) return { os: 'linux', osVersion: null }
  return { os: 'other', osVersion: null }
}

// ---------------------------------------------------------------------------
// Catalog metadata
// ---------------------------------------------------------------------------

/** Launch year by marketing model (portrait name, without the "(cover screen)" suffix). Best effort; unknown models get null. */
const RELEASE_YEARS: Readonly<Record<string, number>> = {
  // Apple
  'iPhone SE (1st gen)': 2016,
  'iPhone 6': 2014,
  'iPhone 6 Plus': 2014,
  'iPhone 7': 2016,
  'iPhone 7 Plus': 2016,
  'iPhone 8': 2017,
  'iPhone 8 Plus': 2017,
  'iPhone X': 2017,
  'iPhone XR': 2018,
  'iPhone 11': 2019,
  'iPhone 11 Pro': 2019,
  'iPhone 11 Pro Max': 2019,
  'iPhone 12': 2020,
  'iPhone 12 mini': 2020,
  'iPhone 12 Pro': 2020,
  'iPhone 12 Pro Max': 2020,
  'iPhone 13': 2021,
  'iPhone 13 mini': 2021,
  'iPhone 13 Pro': 2021,
  'iPhone 13 Pro Max': 2021,
  'iPhone SE (3rd gen)': 2022,
  'iPhone 14': 2022,
  'iPhone 14 Plus': 2022,
  'iPhone 14 Pro': 2022,
  'iPhone 14 Pro Max': 2022,
  'iPhone 15': 2023,
  'iPhone 15 Plus': 2023,
  'iPhone 15 Pro': 2023,
  'iPhone 15 Pro Max': 2023,
  'iPhone 16': 2024,
  'iPhone 16 Plus': 2024,
  'iPhone 16 Pro': 2024,
  'iPhone 16 Pro Max': 2024,
  'iPhone 16e': 2025,
  'iPhone 17': 2025,
  'iPhone 17 Pro': 2025,
  'iPhone 17 Pro Max': 2025,
  'iPhone Air': 2025,
  'iPhone 17e': 2026,
  'iPad (5th gen)': 2017,
  'iPad (6th gen)': 2018,
  'iPad (7th gen)': 2019,
  'iPad (11th gen)': 2025,
  'iPad mini': 2019,
  'iPad Pro 11"': 2018,
  // Google
  'Nexus 4': 2012,
  'Nexus 5': 2013,
  'Nexus 5X': 2015,
  'Nexus 6': 2014,
  'Nexus 6P': 2015,
  'Nexus 7': 2013,
  'Nexus 10': 2012,
  'Pixel 2': 2017,
  'Pixel 2 XL': 2017,
  'Pixel 3': 2018,
  'Pixel 4': 2019,
  'Pixel 4a (5G)': 2020,
  'Pixel 5': 2020,
  'Pixel 6': 2021,
  'Pixel 6 Pro': 2021,
  'Pixel 6a': 2022,
  'Pixel 7': 2022,
  'Pixel 7 Pro': 2022,
  'Pixel 7a': 2023,
  'Pixel 8': 2023,
  'Pixel 8 Pro': 2023,
  'Pixel 8a': 2024,
  'Pixel 9': 2024,
  'Pixel 9 Pro': 2024,
  'Pixel 9 Pro XL': 2024,
  'Pixel 10': 2025,
  'Pixel 10 Pro': 2025,
  'Pixel 10 Pro XL': 2025,
  // Samsung
  'Galaxy S III': 2012,
  'Galaxy Note II': 2012,
  'Galaxy Note 3': 2013,
  'Galaxy S5': 2014,
  'Galaxy S8': 2017,
  'Galaxy S9+': 2018,
  'Galaxy S21': 2021,
  'Galaxy S21 Ultra': 2021,
  'Galaxy S22': 2022,
  'Galaxy S22 Ultra': 2022,
  'Galaxy S23': 2023,
  'Galaxy S23 Ultra': 2023,
  'Galaxy S24': 2024,
  'Galaxy S25': 2025,
  'Galaxy S25 Ultra': 2025,
  'Galaxy A15': 2023,
  'Galaxy A35': 2024,
  'Galaxy A55': 2024,
  'Galaxy Z Fold 5': 2023,
  'Galaxy Z Fold 6': 2024,
  'Galaxy Z Flip 6': 2024,
  'Galaxy Z Fold 7': 2025,
  'Galaxy Z Flip 7': 2025,
  'Galaxy Tab S4': 2018,
  'Galaxy Tab S9': 2023,
  // Others
  'OnePlus 12': 2024,
  'OnePlus Nord 4': 2024,
  'Xiaomi 14': 2023,
  'Redmi Note 13': 2024,
  'Edge 50': 2024,
  'Moto G Power (2024)': 2024,
  'Moto G4': 2016,
  'Kindle Fire HDX': 2013,
  Z30: 2013,
  PlayBook: 2011,
  'Lumia 520': 2013,
  'Lumia 550': 2015,
  'Lumia 950': 2015,
  'Optimus L70': 2014,
  N9: 2011,
}

/** Curated "Popular" set: current mainstream devices (portrait) and the common desktop resolutions. */
const POPULAR_IDS: ReadonlySet<DevicePresetId> = new Set([
  'iphone-15',
  'iphone-15-pro',
  'iphone-15-pro-max',
  'iphone-16',
  'iphone-16-pro',
  'iphone-16-pro-max',
  'iphone-17',
  'iphone-17-pro',
  'iphone-17-pro-max',
  'iphone-air',
  'galaxy-s23',
  'galaxy-s24',
  'galaxy-s25',
  'galaxy-s25-ultra',
  'galaxy-a55',
  'galaxy-z-fold-7',
  'galaxy-z-flip-7',
  'pixel-8',
  'pixel-9',
  'pixel-9-pro',
  'pixel-10',
  'ipad-pro-11',
  'ipad-gen-11',
  'galaxy-tab-s9',
  'windows-desktop',
  'windows-11-desktop-1366',
  'windows-11-desktop-1536',
  'macos-desktop',
  'macos-desktop-1512',
  'linux-desktop',
])

/** Size bucket — see `ScreenClass` in the shared types. */
export function screenClassFor(deviceType: DeviceType, width: number, height: number): ScreenClass {
  const shortSide = Math.min(width, height)
  if (deviceType === 'mobile') return shortSide < 380 ? 'compact' : shortSide < 428 ? 'regular' : 'large'
  if (deviceType === 'tablet') return shortSide < 700 ? 'small' : shortSide < 800 ? 'medium' : shortSide < 900 ? 'large' : 'xl'
  return width < 1366 ? 'small' : width < 1600 ? 'medium' : width < 2560 ? 'large' : 'xl'
}

interface PresetIdentity {
  brand: DeviceBrand
  model: string
  landscape: boolean
}

/** Fill in the derived metadata of a preset (everything but `landscapeOf`, which needs the whole catalog). */
function withMetadata(info: DevicePresetInfo, identity: PresetIdentity, emulation: EmulationDescriptor): DevicePresetInfo {
  const { os, osVersion } = parseUserAgentOs(info.userAgent)
  const yearKey = identity.model.replace(/ \(cover screen\)$/, '')
  return {
    ...info,
    brand: identity.brand,
    model: identity.model,
    os,
    osVersion,
    orientation: identity.landscape || (info.deviceType === 'desktop' && info.viewportWidth > info.viewportHeight) ? 'landscape' : 'portrait',
    landscapeOf: null,
    deviceScaleFactor: emulation.deviceScaleFactor,
    hasTouch: emulation.hasTouch,
    screenClass: screenClassFor(info.deviceType, info.viewportWidth, info.viewportHeight),
    releaseYear: info.deviceType === 'desktop' ? null : (RELEASE_YEARS[yearKey] ?? null),
    popular: POPULAR_IDS.has(info.id),
  }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Descriptor names that describe tablets. The viewport alone cannot decide:
 * iPad (gen 11) is 656 CSS px wide and Galaxy Tab S9 640 px, while the unfolded
 * Galaxy Z Fold is 984 px wide and still a phone.
 */
const TABLET_NAME = /^(iPad\b|Galaxy Tab\b|Nexus (7|10)$|Kindle Fire\b|Blackberry PlayBook\b)/i

/** Discontinued devices, matched on the portrait descriptor key. */
const LEGACY_NAME =
  /^(BlackBerry\b|Nokia Lumia\b|Microsoft Lumia\b|Nexus \d|Galaxy (S III|S5|Note II|Note 3)$|LG Optimus\b|Nokia N9\b|iPhone (6|6 Plus|7|7 Plus|8|8 Plus|X|XR|SE)$|Kindle Fire HDX\b|Moto G4\b|Pixel (2|2 XL|3|4)$)/i

function classify(baseKey: string, d: PlaywrightDescriptor): DeviceType {
  if (!d.isMobile) return 'desktop'
  if (TABLET_NAME.test(baseKey)) return 'tablet'
  // Fallback for descriptors future Playwright releases may add: tablet-sized, unless it is a foldable phone.
  if (Math.min(d.viewport.width, d.viewport.height) >= 700 && !/Fold/.test(baseKey)) return 'tablet'
  return 'mobile'
}

/** Desktop descriptors are gated by the engine they describe; a plain Chrome UA desktop accepts every engine (see `resolveUserAgent`). */
function desktopEnginesFor(d: PlaywrightDescriptor): readonly BrowserEngine[] {
  switch (d.defaultBrowserType) {
    case 'firefox':
      return FIREFOX_ONLY
    case 'webkit':
      return WEBKIT_ONLY
    default:
      return /\bEdg\//.test(d.userAgent) ? CHROMIUM_FAMILY_ENGINES : ALL_ENGINES
  }
}

// ---------------------------------------------------------------------------
// Playwright-derived presets
// ---------------------------------------------------------------------------

const LANDSCAPE_SUFFIX = ' landscape'

function playwrightPresets(): PresetDefinition[] {
  const out: PresetDefinition[] = []
  for (const [key, d] of Object.entries(PLAYWRIGHT_DEVICES)) {
    if (!d) continue
    if (d.viewport.width < MIN_VIEWPORT_PX || d.viewport.height < MIN_VIEWPORT_PX) continue
    const landscape = key.endsWith(LANDSCAPE_SUFFIX)
    const baseKey = landscape ? key.slice(0, -LANDSCAPE_SUFFIX.length) : key
    const coreId = CORE_ID_BY_KEY[baseKey]
    const id = coreId ? (landscape ? `${coreId}-landscape` : coreId) : toPresetId(key)
    const legacy = LEGACY_NAME.test(baseKey)
    const deviceType = classify(baseKey, d)
    const identity: PresetIdentity =
      deviceType === 'desktop'
        ? { brand: 'Generic', model: desktopLabel(parseUserAgentOs(d.userAgent).os, desktopBrowserName(d), d.viewport.width, d.viewport.height), landscape: false }
        : { ...brandAndModel(baseKey), landscape }
    const emulation: EmulationDescriptor = {
      deviceScaleFactor: d.deviceScaleFactor,
      isMobile: d.isMobile,
      hasTouch: d.hasTouch,
      screen: d.screen ?? null,
    }
    const info: DevicePresetInfo = {
      id,
      label: deviceType === 'desktop' ? identity.model : deviceLabel(identity.brand, identity.model, landscape),
      deviceType,
      playwrightDevice: key,
      viewportWidth: d.viewport.width,
      viewportHeight: d.viewport.height,
      userAgent: d.userAgent,
      supportedEngines: d.isMobile ? MOBILE_ENGINES : desktopEnginesFor(d),
      legacy,
    }
    out.push({ info: withMetadata(info, identity, emulation), emulation })
  }
  return out
}

// ---------------------------------------------------------------------------
// Custom descriptors (devices Playwright lacks)
// ---------------------------------------------------------------------------

/** Version string Playwright's bundled browser reports (e.g. Chrome "153.0.8010.12"), read from a descriptor UA. */
function detectVersion(pattern: RegExp, descriptorKey: string, fallback: string): string {
  return pattern.exec(requirePlaywrightDevice(descriptorKey).userAgent)?.[1] ?? fallback
}

const CHROME_VERSION = detectVersion(/Chrome\/([\d.]+)/, 'Desktop Chrome', '124.0.0.0')
const EDGE_VERSION = detectVersion(/Edg\/([\d.]+)/, 'Desktop Edge', CHROME_VERSION)

/** Chrome's frozen platform tokens: Windows 11 still reports "Windows NT 10.0", Chrome OS a fixed platform version. */
const WINDOWS_TOKEN = 'Windows NT 10.0; Win64; x64'
const MACOS_TOKEN = 'Macintosh; Intel Mac OS X 10_15_7'
const LINUX_TOKEN = 'X11; Linux x86_64'
const CHROMEOS_TOKEN = 'X11; CrOS x86_64 14541.0.0'

function chromeUserAgent(platformToken: string, mobile: boolean): string {
  const mobileToken = mobile ? ' Mobile' : ''
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION}${mobileToken} Safari/537.36`
}

function edgeUserAgent(platformToken: string): string {
  return `${chromeUserAgent(platformToken, false)} Edg/${EDGE_VERSION}`
}

interface DesktopSpec {
  id: DevicePresetId
  os: Extract<DeviceOs, 'windows' | 'macos' | 'linux' | 'chromeos'>
  /** Browser the user agent identifies as ("Chrome", "Edge"). */
  browser: string
  width: number
  height: number
  userAgent: string
  deviceScaleFactor?: number
  supportedEngines?: readonly BrowserEngine[]
}

function desktopPreset(spec: DesktopSpec): PresetDefinition {
  const { width, height } = spec
  const label = desktopLabel(spec.os, spec.browser, width, height)
  const emulation: EmulationDescriptor = { deviceScaleFactor: spec.deviceScaleFactor ?? 1, isMobile: false, hasTouch: false, screen: { width, height } }
  const info: DevicePresetInfo = {
    id: spec.id,
    label,
    deviceType: 'desktop',
    playwrightDevice: null,
    viewportWidth: width,
    viewportHeight: height,
    userAgent: spec.userAgent,
    supportedEngines: spec.supportedEngines ?? ALL_ENGINES,
    legacy: false,
  }
  return { info: withMetadata(info, { brand: 'Generic', model: label, landscape: false }, emulation), emulation }
}

interface AndroidSpec {
  id: DevicePresetId
  brand: DeviceBrand
  /** Marketing name without the brand, unless the brand is part of it ("OnePlus 12"). */
  model: string
  /** Model token as Chrome reports it in the UA (e.g. "SM-S911U", "CPH2583", "moto g power 5G - 2024"). */
  uaModel: string
  androidVersion: number
  /** Physical panel in CSS px (panel pixels ÷ scale factor). */
  screen: { width: number; height: number }
  deviceScaleFactor: number
  /** CSS px taken by the browser toolbar; the viewport is the screen minus this. */
  browserChromePx?: number
}

function androidPreset(spec: AndroidSpec): PresetDefinition {
  const chrome = spec.browserChromePx ?? 60
  const emulation: EmulationDescriptor = { deviceScaleFactor: spec.deviceScaleFactor, isMobile: true, hasTouch: true, screen: spec.screen }
  const info: DevicePresetInfo = {
    id: spec.id,
    label: deviceLabel(spec.brand, spec.model, false),
    deviceType: 'mobile',
    playwrightDevice: null,
    viewportWidth: spec.screen.width,
    viewportHeight: spec.screen.height - chrome,
    userAgent: chromeUserAgent(`Linux; Android ${spec.androidVersion}; ${spec.uaModel}`, true),
    supportedEngines: MOBILE_ENGINES,
    legacy: false,
  }
  return { info: withMetadata(info, { brand: spec.brand, model: spec.model, landscape: false }, emulation), emulation }
}

function customPresets(): PresetDefinition[] {
  const windowsChrome = chromeUserAgent(WINDOWS_TOKEN, false)
  const macChrome = chromeUserAgent(MACOS_TOKEN, false)
  const linuxChrome = chromeUserAgent(LINUX_TOKEN, false)
  return [
    // --- Desktop ---------------------------------------------------------------
    desktopPreset({ id: 'windows-desktop', os: 'windows', browser: 'Chrome', width: 1920, height: 1080, userAgent: windowsChrome }),
    // 1920×1080 CSS px at 2× → a 4K panel at 200 % scaling.
    desktopPreset({ id: 'windows-desktop-hidpi', os: 'windows', browser: 'Chrome', width: 1920, height: 1080, userAgent: windowsChrome, deviceScaleFactor: 2 }),
    desktopPreset({ id: 'windows-11-desktop-1366', os: 'windows', browser: 'Chrome', width: 1366, height: 768, userAgent: windowsChrome }),
    // 1536×864 CSS px is a 1920×1080 laptop panel at Windows' default 125 % scaling.
    desktopPreset({ id: 'windows-11-desktop-1536', os: 'windows', browser: 'Chrome', width: 1536, height: 864, userAgent: windowsChrome, deviceScaleFactor: 1.25 }),
    desktopPreset({ id: 'windows-11-desktop-2560', os: 'windows', browser: 'Chrome', width: 2560, height: 1440, userAgent: windowsChrome }),
    desktopPreset({ id: 'windows-desktop-edge', os: 'windows', browser: 'Edge', width: 1920, height: 1080, userAgent: edgeUserAgent(WINDOWS_TOKEN), supportedEngines: CHROMIUM_FAMILY_ENGINES }),
    desktopPreset({ id: 'linux-desktop', os: 'linux', browser: 'Chrome', width: 1920, height: 1080, userAgent: linuxChrome }),
    desktopPreset({ id: 'linux-desktop-1366', os: 'linux', browser: 'Chrome', width: 1366, height: 768, userAgent: linuxChrome }),
    desktopPreset({ id: 'macos-desktop', os: 'macos', browser: 'Chrome', width: 1440, height: 900, userAgent: macChrome }),
    // 13" MacBook Air default resolution (2560×1664 panel at 2×, menu bar excluded).
    desktopPreset({ id: 'macos-desktop-1512', os: 'macos', browser: 'Chrome', width: 1512, height: 982, userAgent: macChrome, deviceScaleFactor: 2 }),
    desktopPreset({ id: 'chromebook-1366', os: 'chromeos', browser: 'Chrome', width: 1366, height: 768, userAgent: chromeUserAgent(CHROMEOS_TOKEN, false) }),

    // --- Mobile (Chrome on Android) --------------------------------------------
    // Samsung flagships: FHD+ panels render 360 px wide at 3×, QHD+ panels 412 px wide at 3.5×.
    androidPreset({ id: 'galaxy-s21', brand: 'Samsung', model: 'Galaxy S21', uaModel: 'SM-G991U', androidVersion: 14, screen: { width: 360, height: 800 }, deviceScaleFactor: 3 }),
    androidPreset({ id: 'galaxy-s21-ultra', brand: 'Samsung', model: 'Galaxy S21 Ultra', uaModel: 'SM-G998U', androidVersion: 14, screen: { width: 412, height: 915 }, deviceScaleFactor: 3.5 }),
    androidPreset({ id: 'galaxy-s22', brand: 'Samsung', model: 'Galaxy S22', uaModel: 'SM-S901U', androidVersion: 14, screen: { width: 360, height: 780 }, deviceScaleFactor: 3 }),
    androidPreset({ id: 'galaxy-s22-ultra', brand: 'Samsung', model: 'Galaxy S22 Ultra', uaModel: 'SM-S908U', androidVersion: 14, screen: { width: 412, height: 883 }, deviceScaleFactor: 3.5 }),
    androidPreset({ id: 'galaxy-s23', brand: 'Samsung', model: 'Galaxy S23', uaModel: 'SM-S911U', androidVersion: 14, screen: { width: 360, height: 780 }, deviceScaleFactor: 3 }),
    androidPreset({ id: 'galaxy-s23-ultra', brand: 'Samsung', model: 'Galaxy S23 Ultra', uaModel: 'SM-S918U', androidVersion: 14, screen: { width: 412, height: 883 }, deviceScaleFactor: 3.5 }),
    androidPreset({ id: 'galaxy-s25', brand: 'Samsung', model: 'Galaxy S25', uaModel: 'SM-S931U', androidVersion: 15, screen: { width: 360, height: 780 }, deviceScaleFactor: 3 }),
    androidPreset({ id: 'galaxy-s25-ultra', brand: 'Samsung', model: 'Galaxy S25 Ultra', uaModel: 'SM-S938U', androidVersion: 15, screen: { width: 412, height: 891 }, deviceScaleFactor: 3.5 }),
    // Samsung A-series: 6.5–6.6" FHD+ panels at 2.625× → 412×915 CSS px.
    androidPreset({ id: 'galaxy-a15', brand: 'Samsung', model: 'Galaxy A15', uaModel: 'SM-A155M', androidVersion: 14, screen: { width: 412, height: 915 }, deviceScaleFactor: 2.625 }),
    androidPreset({ id: 'galaxy-a35', brand: 'Samsung', model: 'Galaxy A35', uaModel: 'SM-A356U', androidVersion: 14, screen: { width: 412, height: 915 }, deviceScaleFactor: 2.625 }),
    // Z Fold 5 inner display 1812×2176 at 2×; tablet-like toolbar height as in Playwright's Fold 6 descriptor.
    androidPreset({ id: 'galaxy-z-fold-5', brand: 'Samsung', model: 'Galaxy Z Fold 5', uaModel: 'SM-F946U', androidVersion: 14, screen: { width: 906, height: 1088 }, deviceScaleFactor: 2, browserChromePx: 76 }),
    androidPreset({ id: 'oneplus-12', brand: 'OnePlus', model: 'OnePlus 12', uaModel: 'CPH2583', androidVersion: 14, screen: { width: 412, height: 905 }, deviceScaleFactor: 3.5 }),
    androidPreset({ id: 'oneplus-nord-4', brand: 'OnePlus', model: 'OnePlus Nord 4', uaModel: 'CPH2661', androidVersion: 14, screen: { width: 413, height: 924 }, deviceScaleFactor: 3 }),
    androidPreset({ id: 'xiaomi-14', brand: 'Xiaomi', model: 'Xiaomi 14', uaModel: '23127PN0CG', androidVersion: 14, screen: { width: 400, height: 890 }, deviceScaleFactor: 3 }),
    androidPreset({ id: 'redmi-note-13', brand: 'Xiaomi', model: 'Redmi Note 13', uaModel: '23129RAA4G', androidVersion: 14, screen: { width: 393, height: 873 }, deviceScaleFactor: 2.75 }),
    // Motorola reports marketing names in the UA model token.
    androidPreset({ id: 'motorola-edge-50', brand: 'Motorola', model: 'Edge 50', uaModel: 'motorola edge 50', androidVersion: 14, screen: { width: 407, height: 904 }, deviceScaleFactor: 3 }),
    androidPreset({ id: 'moto-g-power-2024', brand: 'Motorola', model: 'Moto G Power (2024)', uaModel: 'moto g power 5G - 2024', androidVersion: 14, screen: { width: 412, height: 915 }, deviceScaleFactor: 2.625 }),
  ]
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

const LABEL_COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/** Desktop → mobile → tablet; current devices before legacy ones; then natural label order ("iPhone 8" before "iPhone 13"). */
function comparePresets(a: DevicePresetInfo, b: DevicePresetInfo): number {
  const byType = DEVICE_TYPES.indexOf(a.deviceType) - DEVICE_TYPES.indexOf(b.deviceType)
  if (byType !== 0) return byType
  const byLegacy = Number(a.legacy ?? false) - Number(b.legacy ?? false)
  if (byLegacy !== 0) return byLegacy
  return LABEL_COLLATOR.compare(a.label, b.label)
}

function buildCatalog(): Map<DevicePresetId, PresetDefinition> {
  const byId = new Map<DevicePresetId, PresetDefinition>()
  for (const definition of [...customPresets(), ...playwrightPresets()]) {
    const { id } = definition.info
    const existing = byId.get(id)
    if (existing) {
      throw new Error(
        `Duplicate device preset id "${id}" (${existing.info.playwrightDevice ?? 'custom'} vs ${definition.info.playwrightDevice ?? 'custom'}). ` +
          'Rename the custom descriptor in device-presets.ts.',
      )
    }
    byId.set(id, definition)
  }
  const missingCore = DEVICE_PRESET_IDS.filter((id) => !byId.has(id))
  if (missingCore.length > 0) {
    throw new Error(
      `Core device presets missing from the catalog: ${missingCore.join(', ')}. ` +
        'The installed playwright-core no longer ships a descriptor they rely on; update device-presets.ts.',
    )
  }
  // Link landscape variants to their portrait twin (some portrait descriptors are skipped below 320 px);
  // the twin's size class describes the device better than the toolbar-shortened landscape height.
  for (const [id, definition] of byId) {
    if (definition.info.orientation !== 'landscape' || definition.info.deviceType === 'desktop' || !id.endsWith('-landscape')) continue
    const portrait = byId.get(id.slice(0, -'-landscape'.length))
    if (!portrait) continue
    byId.set(id, { ...definition, info: { ...definition.info, landscapeOf: portrait.info.id, screenClass: portrait.info.screenClass ?? definition.info.screenClass } })
  }
  return byId
}

const DEFINITIONS = buildCatalog()

/** Every preset: desktop, mobile, then tablet; legacy devices last within each group; natural label order. */
export const DEVICE_PRESETS: readonly DevicePresetInfo[] = [...DEFINITIONS.values()].map((d) => d.info).sort(comparePresets)

function definition(id: string): PresetDefinition {
  const found = DEFINITIONS.get(id)
  if (!found) {
    throw new AppException('INVALID_INPUT', `Unknown device preset "${id.slice(0, 80)}". Pick a preset from the device catalog.`)
  }
  return found
}

/** Preset by id. Throws `INVALID_INPUT` for ids that are not in the catalog. */
export function getPreset(id: DevicePresetId): DevicePresetInfo {
  return definition(id).info
}

export function isDevicePresetId(value: string): boolean {
  return DEFINITIONS.has(value)
}

export interface PresetFilter {
  deviceType?: DeviceType
  /** Keep only presets the engine can emulate (`supportedEngines`). */
  engine?: BrowserEngine
  /** Include presets flagged `legacy`. Defaults to true for `listPresets` and false for `randomPreset`. */
  includeLegacy?: boolean
}

function matchesFilter(preset: DevicePresetInfo, filter: PresetFilter, includeLegacy: boolean): boolean {
  if (filter.deviceType !== undefined && preset.deviceType !== filter.deviceType) return false
  if (filter.engine !== undefined && !preset.supportedEngines.includes(filter.engine)) return false
  if (!includeLegacy && preset.legacy === true) return false
  return true
}

/** Presets matching the filter, in `DEVICE_PRESETS` order. Legacy devices are included unless `includeLegacy: false`. */
export function listPresets(filter: PresetFilter = {}): DevicePresetInfo[] {
  const includeLegacy = filter.includeLegacy ?? true
  return DEVICE_PRESETS.filter((preset) => matchesFilter(preset, filter, includeLegacy))
}

function describeFilter(filter: PresetFilter): string {
  const parts: string[] = []
  if (filter.deviceType !== undefined) parts.push(`device type "${filter.deviceType}"`)
  if (filter.engine !== undefined) parts.push(`engine "${filter.engine}"`)
  return parts.length > 0 ? parts.join(' and ') : 'the catalog'
}

/**
 * A uniformly random preset among those matching the filter. Legacy devices are
 * excluded unless `includeLegacy: true`. `random` must return a number in [0, 1)
 * (injectable for deterministic tests). Throws `INVALID_INPUT` when nothing
 * matches — e.g. a mobile preset on Firefox, which cannot emulate phones.
 */
export function randomPreset(filter: PresetFilter = {}, random: () => number = Math.random): DevicePresetInfo {
  const eligible = listPresets({ ...filter, includeLegacy: filter.includeLegacy ?? false })
  const first = eligible[0]
  if (!first) {
    const hint = filter.engine === 'firefox' && filter.deviceType !== 'desktop' ? ' Playwright Firefox cannot emulate phones or tablets — pick a desktop preset or another engine.' : ''
    throw new AppException('INVALID_INPUT', `No device preset matches ${describeFilter(filter)}.${hint}`)
  }
  const index = Math.min(eligible.length - 1, Math.max(0, Math.floor(random() * eligible.length)))
  return eligible[index] ?? first
}

// ---------------------------------------------------------------------------
// Context options
// ---------------------------------------------------------------------------

/**
 * User agent to emulate, or undefined to let the engine report its own.
 *
 * - An explicit profile user agent always wins.
 * - Mobile and tablet presets apply the descriptor UA on every engine: it is
 *   part of the device being emulated (Playwright's regular device emulation).
 * - Desktop presets force the preset UA **only on the bundled Chromium**: that build is
 *   a generic "Chrome for Testing" with no identity of its own, so a Windows/Linux/macOS
 *   Chrome UA (or the Edge descriptor UA) is the honest way to emulate a desktop Chrome.
 *   Every other engine keeps its native UA on desktop presets — an installed Opera,
 *   Brave, Vivaldi, Chrome or Edge is already the real browser and must identify as
 *   itself, and forcing a Chrome UA onto Firefox or WebKit would make a Gecko/WebKit
 *   engine claim to be Chrome, exactly the kind of mismatch a QA tester must not ship.
 */
export function resolveUserAgent(profile: Profile, preset: DevicePresetInfo): string | undefined {
  const custom = profile.userAgent?.trim() ?? ''
  if (custom.length > 0) return custom
  if (preset.deviceType === 'desktop' && profile.engine !== 'chromium') return undefined
  return preset.userAgent
}

/**
 * Build Playwright `BrowserContextOptions` for a profile.
 *
 * Profile values win over the preset: viewport always comes from the profile,
 * userAgent follows `resolveUserAgent`, and locale/timezone are profile fields
 * by definition. Screen size is only forwarded when the profile keeps the
 * preset viewport, so a custom viewport never reports a mismatched physical
 * screen.
 */
export function buildContextOptions(profile: Profile, preset: DevicePresetInfo): BrowserContextOptions {
  const { emulation } = definition(preset.id)
  const viewport = { width: profile.viewportWidth, height: profile.viewportHeight }
  const keepsPresetViewport = viewport.width === preset.viewportWidth && viewport.height === preset.viewportHeight
  const userAgent = resolveUserAgent(profile, preset)

  const options: BrowserContextOptions = {
    viewport,
    ...(userAgent !== undefined ? { userAgent } : {}),
    locale: profile.locale,
    timezoneId: profile.timezone,
    deviceScaleFactor: emulation.deviceScaleFactor,
    hasTouch: emulation.hasTouch,
    ignoreHTTPSErrors: false,
    acceptDownloads: false,
  }
  // Only set when true: Playwright Firefox rejects the option outright.
  if (emulation.isMobile) options.isMobile = true
  if (keepsPresetViewport && emulation.screen) options.screen = emulation.screen
  return options
}

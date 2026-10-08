import { describe, expect, it } from 'vitest'
import { devices } from 'playwright-core'
import { BROWSER_ENGINES, BROWSER_ENGINE_FAMILY, BROWSER_ENGINE_KIND, DEVICE_BRANDS, DEVICE_OS, DEVICE_PRESET_IDS, DEVICE_TYPES, SCREEN_CLASSES } from '../src/shared/types'
import type { BrowserEngine, CoreDevicePresetId, DevicePresetInfo, DeviceType, Profile } from '../src/shared/types'
import { AppException } from '../src/main/contracts'
import {
  CHROMIUM_FAMILY_ENGINES,
  DEVICE_PRESETS,
  brandAndModel,
  desktopLabel,
  deviceLabel,
  parseUserAgentOs,
  screenClassFor,
  MOBILE_ENGINES,
  buildContextOptions,
  getPreset,
  isDevicePresetId,
  listPresets,
  randomPreset,
  resolveUserAgent,
  toPresetId,
} from '../src/main/browser/device-presets'
import PREVIOUS_PRESET_IDS from './fixtures/device-preset-ids.json'

const baseProfile: Profile = {
  id: 'p1',
  name: 'Test',
  engine: 'chromium',
  deviceType: 'mobile',
  devicePreset: 'iphone-15',
  viewportWidth: 393,
  viewportHeight: 659,
  userAgent: null,
  locale: 'en-US',
  timezone: 'America/New_York',
  proxyMode: 'none',
  stickySessionId: null,
  formUrlOverride: null,
  notes: '',
  proxyPool: 'residential',
  target: null,
  stickyTtlMinutes: null,
  ephemeral: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

type PlaywrightDescriptor = { userAgent: string; viewport: { width: number; height: number }; isMobile: boolean }
const PLAYWRIGHT_DEVICES = devices as Record<string, PlaywrightDescriptor | undefined>

const EXPECTED_CORE_TYPES: Record<CoreDevicePresetId, DeviceType> = {
  'windows-desktop': 'desktop',
  'windows-desktop-hidpi': 'desktop',
  'linux-desktop': 'desktop',
  'macos-desktop': 'desktop',
  'macos-safari-desktop': 'desktop',
  'desktop-edge': 'desktop',
  'desktop-firefox': 'desktop',
  'iphone-13': 'mobile',
  'iphone-14': 'mobile',
  'iphone-15': 'mobile',
  'iphone-15-pro': 'mobile',
  'iphone-16': 'mobile',
  'iphone-16-pro': 'mobile',
  'iphone-16-pro-max': 'mobile',
  'iphone-16e': 'mobile',
  'iphone-17': 'mobile',
  'iphone-17-pro': 'mobile',
  'iphone-17-pro-max': 'mobile',
  'iphone-se-3': 'mobile',
  'pixel-7': 'mobile',
  'pixel-8': 'mobile',
  'pixel-8-pro': 'mobile',
  'pixel-9': 'mobile',
  'pixel-9-pro': 'mobile',
  'pixel-10': 'mobile',
  'galaxy-s22': 'mobile',
  'galaxy-s23': 'mobile',
  'galaxy-s24': 'mobile',
  'galaxy-a55': 'mobile',
  'galaxy-z-fold-7': 'mobile',
  'galaxy-z-flip-7': 'mobile',
  'ipad-gen-11': 'tablet',
  'ipad-mini': 'tablet',
  'ipad-pro-11': 'tablet',
  'galaxy-tab-s9': 'tablet',
}

/** Core ids that are read from a Playwright descriptor, with the descriptor key each one must dedupe onto. */
const CORE_PLAYWRIGHT_KEYS: Partial<Record<CoreDevicePresetId, string>> = {
  'macos-safari-desktop': 'Desktop Safari',
  'desktop-edge': 'Desktop Edge',
  'desktop-firefox': 'Desktop Firefox',
  'iphone-13': 'iPhone 13',
  'iphone-14': 'iPhone 14',
  'iphone-15': 'iPhone 15',
  'iphone-15-pro': 'iPhone 15 Pro',
  'iphone-16': 'iPhone 16',
  'iphone-16-pro': 'iPhone 16 Pro',
  'iphone-16-pro-max': 'iPhone 16 Pro Max',
  'iphone-16e': 'iPhone 16e',
  'iphone-17': 'iPhone 17',
  'iphone-17-pro': 'iPhone 17 Pro',
  'iphone-17-pro-max': 'iPhone 17 Pro Max',
  'iphone-se-3': 'iPhone SE (3rd gen)',
  'pixel-7': 'Pixel 7',
  'pixel-8': 'Pixel 8',
  'pixel-8-pro': 'Pixel 8 Pro',
  'pixel-9': 'Pixel 9',
  'pixel-9-pro': 'Pixel 9 Pro',
  'pixel-10': 'Pixel 10',
  'galaxy-s24': 'Galaxy S24',
  'galaxy-a55': 'Galaxy A55',
  'galaxy-z-fold-7': 'Galaxy Z Fold 7',
  'galaxy-z-flip-7': 'Galaxy Z Flip 7',
  'ipad-gen-11': 'iPad (gen 11)',
  'ipad-mini': 'iPad Mini',
  'ipad-pro-11': 'iPad Pro 11',
  'galaxy-tab-s9': 'Galaxy Tab S9',
}

const CUSTOM_CORE_IDS = ['windows-desktop', 'windows-desktop-hidpi', 'linux-desktop', 'macos-desktop', 'galaxy-s22', 'galaxy-s23'] as const

const CUSTOM_ANDROID_IDS = [
  'galaxy-s21',
  'galaxy-s21-ultra',
  'galaxy-s22',
  'galaxy-s22-ultra',
  'galaxy-s23',
  'galaxy-s23-ultra',
  'galaxy-s25',
  'galaxy-s25-ultra',
  'galaxy-a15',
  'galaxy-a35',
  'galaxy-z-fold-5',
  'oneplus-12',
  'oneplus-nord-4',
  'xiaomi-14',
  'redmi-note-13',
  'motorola-edge-50',
  'moto-g-power-2024',
] as const

const CUSTOM_DESKTOP_IDS = [
  'windows-desktop',
  'windows-desktop-hidpi',
  'windows-11-desktop-1366',
  'windows-11-desktop-1536',
  'windows-11-desktop-2560',
  'windows-desktop-edge',
  'linux-desktop',
  'linux-desktop-1366',
  'macos-desktop',
  'macos-desktop-1512',
  'chromebook-1366',
] as const

const LEGACY_IDS = ['iphone-6', 'iphone-8-plus', 'iphone-x', 'iphone-xr', 'iphone-se', 'nexus-5', 'nexus-7', 'nexus-10', 'blackberry-z30', 'blackberry-playbook', 'nokia-lumia-520', 'microsoft-lumia-950', 'galaxy-s-iii', 'galaxy-s5', 'galaxy-note-3', 'lg-optimus-l70', 'nokia-n9', 'kindle-fire-hdx', 'moto-g4', 'pixel-2', 'pixel-4'] as const
const CURRENT_IDS = ['iphone-15', 'iphone-se-3', 'iphone-11', 'iphone-12', 'pixel-5', 'pixel-7', 'galaxy-s8', 'galaxy-s9-plus', 'galaxy-s24', 'ipad-pro-11', 'desktop-chrome', 'windows-desktop'] as const

const TABLET_IDS = ['ipad-gen-5', 'ipad-gen-11', 'ipad-mini', 'ipad-pro-11', 'galaxy-tab-s4', 'galaxy-tab-s9', 'nexus-7', 'nexus-10', 'kindle-fire-hdx', 'blackberry-playbook', 'ipad-pro-11-landscape'] as const

const sorted = (engines: readonly BrowserEngine[]): BrowserEngine[] => [...engines].sort()
const ids = (presets: readonly DevicePresetInfo[]): string[] => presets.map((p) => p.id)
const profileFor = (preset: DevicePresetInfo, engine: BrowserEngine = 'chromium'): Profile => ({
  ...baseProfile,
  engine,
  deviceType: preset.deviceType,
  devicePreset: preset.id,
  viewportWidth: preset.viewportWidth,
  viewportHeight: preset.viewportHeight,
})

describe('DEVICE_PRESETS catalog', () => {
  it('holds at least 120 presets with unique kebab-case ids', () => {
    expect(DEVICE_PRESETS.length).toBeGreaterThanOrEqual(120)
    const all = ids(DEVICE_PRESETS)
    expect(new Set(all).size).toBe(all.length)
    for (const id of all) expect(id, id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    for (const id of all) expect(id.length, id).toBeLessThanOrEqual(80)
  })

  it('contains every core DevicePresetId with the expected device type', () => {
    expect(Object.keys(EXPECTED_CORE_TYPES).sort()).toEqual([...DEVICE_PRESET_IDS].sort())
    for (const id of DEVICE_PRESET_IDS) {
      expect(isDevicePresetId(id), id).toBe(true)
      expect(getPreset(id).deviceType, id).toBe(EXPECTED_CORE_TYPES[id])
    }
    for (const type of DEVICE_TYPES) expect(DEVICE_PRESETS.filter((p) => p.deviceType === type).length, type).toBeGreaterThanOrEqual(10)
  })

  it('has sane viewports, user agents and labels on every preset', () => {
    for (const preset of DEVICE_PRESETS) {
      expect(preset.viewportWidth, preset.id).toBeGreaterThanOrEqual(320)
      expect(preset.viewportHeight, preset.id).toBeGreaterThanOrEqual(320)
      expect(preset.userAgent, preset.id).toMatch(/^Mozilla\/5\.0/)
      expect(preset.label.length, preset.id).toBeGreaterThan(0)
      expect(preset.supportedEngines.length, preset.id).toBeGreaterThan(0)
      expect(typeof preset.legacy, preset.id).toBe('boolean')
    }
    // A HiDPI twin shares its label (the scale is a badge, not part of the name): label + scale is unique.
    const keys = DEVICE_PRESETS.map((p) => `${p.label}@${p.deviceScaleFactor}`)
    expect(new Set(keys).size, 'label + scale is unique').toBe(keys.length)
  })

  it('derives kebab-case ids from Playwright descriptor keys', () => {
    expect(toPresetId('iPhone 15 Pro Max')).toBe('iphone-15-pro-max')
    expect(toPresetId('Galaxy Z Fold 7 Cover')).toBe('galaxy-z-fold-7-cover')
    expect(toPresetId('iPad (gen 11)')).toBe('ipad-gen-11')
    expect(toPresetId('Desktop Chrome HiDPI')).toBe('desktop-chrome-hidpi')
    expect(toPresetId('Galaxy S9+')).toBe('galaxy-s9-plus')
    expect(toPresetId('Pixel 4a (5G) landscape')).toBe('pixel-4a-5g-landscape')
  })

  it('includes every Playwright descriptor with a launchable viewport exactly once, portrait and landscape', () => {
    const byDescriptor = new Map<string, DevicePresetInfo>()
    for (const preset of DEVICE_PRESETS) {
      if (preset.playwrightDevice === null) continue
      expect(byDescriptor.has(preset.playwrightDevice), `${preset.playwrightDevice} appears once`).toBe(false)
      byDescriptor.set(preset.playwrightDevice, preset)
    }
    for (const [key, descriptor] of Object.entries(PLAYWRIGHT_DEVICES)) {
      if (!descriptor) continue
      const launchable = descriptor.viewport.width >= 320 && descriptor.viewport.height >= 320
      const preset = byDescriptor.get(key)
      if (!launchable) {
        expect(preset, `${key} is below the 320 px profile minimum and must be skipped`).toBeUndefined()
        continue
      }
      expect(preset, key).toBeDefined()
      expect(preset?.userAgent).toBe(descriptor.userAgent)
      expect({ width: preset?.viewportWidth, height: preset?.viewportHeight }).toEqual(descriptor.viewport)
      if (key.endsWith(' landscape')) {
        expect(preset?.label, key).toContain('(landscape)')
        expect(preset?.id, key).toMatch(/-landscape$/)
      } else {
        expect(preset?.label, key).not.toContain('(landscape)')
      }
    }
    expect(byDescriptor.size).toBeGreaterThanOrEqual(190)
    // Concrete skipped descriptors (viewport side < 320 px).
    expect(isDevicePresetId('pixel-9-landscape')).toBe(false)
    expect(isDevicePresetId('galaxy-z-flip-6-cover')).toBe(false)
    // Concrete landscape presets.
    const landscape = getPreset('iphone-15-landscape')
    expect(landscape.label).toBe('Apple iPhone 15 (landscape)')
    expect(landscape.viewportWidth).toBeGreaterThan(landscape.viewportHeight)
    expect(landscape.deviceType).toBe('mobile')
  })

  it('dedupes core ids onto their Playwright descriptor and keeps the custom core descriptors custom', () => {
    for (const [id, key] of Object.entries(CORE_PLAYWRIGHT_KEYS) as Array<[CoreDevicePresetId, string]>) {
      const preset = getPreset(id)
      expect(preset.playwrightDevice, id).toBe(key)
      expect(DEVICE_PRESETS.filter((p) => p.playwrightDevice === key), key).toHaveLength(1)
      // The kebab-case twin must not exist as a second preset.
      if (toPresetId(key) !== id) expect(isDevicePresetId(toPresetId(key)), `${toPresetId(key)} duplicates ${id}`).toBe(false)
    }
    expect(getPreset('iphone-se-3-landscape').playwrightDevice).toBe('iPhone SE (3rd gen) landscape')
    expect(getPreset('macos-safari-desktop').playwrightDevice).toBe('Desktop Safari')
    for (const id of CUSTOM_CORE_IDS) expect(getPreset(id).playwrightDevice, id).toBeNull()
    expect(getPreset('galaxy-s23').userAgent).toMatch(/Android .*SM-S911U.*Chrome\/.*Mobile/)
  })

  it('labels devices "<Brand> <Model>" and desktops "<OS> · <Browser> · <W×H>", with no descriptor jargon', () => {
    expect(getPreset('pixel-7').label).toBe('Google Pixel 7')
    expect(getPreset('nexus-5').label).toBe('Google Nexus 5')
    expect(getPreset('galaxy-s24').label).toBe('Samsung Galaxy S24')
    expect(getPreset('galaxy-z-fold-7').label).toBe('Samsung Galaxy Z Fold 7')
    expect(getPreset('galaxy-z-fold-7-cover').label).toBe('Samsung Galaxy Z Fold 7 (cover screen)')
    expect(getPreset('galaxy-z-flip-7-cover').label).toBe('Samsung Galaxy Z Flip 7 (cover screen)')
    expect(getPreset('kindle-fire-hdx').label).toBe('Amazon Kindle Fire HDX')
    expect(getPreset('moto-g4').label).toBe('Motorola Moto G4')
    expect(getPreset('ipad-gen-5').label).toBe('Apple iPad (5th gen)')
    expect(getPreset('ipad-gen-11').label).toBe('Apple iPad (11th gen)')
    expect(getPreset('ipad-pro-11').label).toBe('Apple iPad Pro 11"')
    expect(getPreset('ipad-mini').label).toBe('Apple iPad mini')
    expect(getPreset('iphone-se').label).toBe('Apple iPhone SE (1st gen)')
    expect(getPreset('iphone-se-3').label).toBe('Apple iPhone SE (3rd gen)')
    expect(getPreset('iphone-6-landscape').label).toBe('Apple iPhone 6 (landscape)')
    expect(getPreset('oneplus-12').label).toBe('OnePlus 12')
    expect(getPreset('redmi-note-13').label).toBe('Xiaomi Redmi Note 13')
    expect(getPreset('blackberry-playbook').label).toBe('BlackBerry PlayBook')
    expect(getPreset('desktop-chrome').label).toBe('Windows · Chrome · 1280×720')
    expect(getPreset('desktop-chrome-hidpi').label).toBe('Windows · Chrome · 1280×720')
    expect(getPreset('desktop-edge').label).toBe('Windows · Edge · 1280×720')
    expect(getPreset('windows-desktop').label).toBe('Windows · Chrome · 1920×1080')
    expect(getPreset('windows-desktop-edge').label).toBe('Windows · Edge · 1920×1080')
    expect(getPreset('chromebook-1366').label).toBe('Chromebook · 1366×768')
    for (const preset of DEVICE_PRESETS) {
      expect(preset.label, preset.id).not.toMatch(/Playwright|descriptor|HiDPI|legacy|\bdes…/i)
      expect(preset.label, preset.id).not.toMatch(/\(Chrome OS\)|-style/)
    }
  })

  it('classifies tablets by descriptor family and keeps the unfolded Galaxy Z Fold a phone', () => {
    for (const id of TABLET_IDS) expect(getPreset(id).deviceType, id).toBe('tablet')
    for (const id of ['galaxy-z-fold-7', 'galaxy-z-fold-6', 'galaxy-z-fold-6-landscape', 'galaxy-z-fold-5', 'iphone-15', 'galaxy-a55'] as const) {
      expect(getPreset(id).deviceType, id).toBe('mobile')
    }
    for (const preset of DEVICE_PRESETS) {
      const options = buildContextOptions(profileFor(preset), preset)
      if (preset.deviceType === 'desktop') {
        expect(options.isMobile, preset.id).toBeUndefined()
        expect(options.hasTouch, preset.id).toBe(false)
      } else {
        expect(options.isMobile, preset.id).toBe(true)
        expect(options.hasTouch, preset.id).toBe(true)
      }
    }
  })

  it('flags legacy devices with the legacy flag only (the picker shows a badge; labels stay clean)', () => {
    for (const id of LEGACY_IDS) {
      const preset = getPreset(id)
      expect(preset.legacy, id).toBe(true)
      expect(preset.label, id).not.toContain('legacy')
    }
    for (const id of CURRENT_IDS) {
      const preset = getPreset(id)
      expect(preset.legacy, id).toBe(false)
      expect(preset.label, id).not.toContain('legacy')
    }
    const legacyCount = DEVICE_PRESETS.filter((p) => p.legacy).length
    expect(legacyCount).toBeGreaterThanOrEqual(40)
    expect(legacyCount).toBeLessThan(DEVICE_PRESETS.length / 2)
    // Legacy devices are only ever phones or tablets.
    for (const preset of DEVICE_PRESETS.filter((p) => p.legacy)) expect(preset.deviceType, preset.id).not.toBe('desktop')
  })

  it('orders presets desktop → mobile → tablet, legacy last within each group, labels in natural order', () => {
    const typeSequence = DEVICE_PRESETS.map((p) => p.deviceType).filter((t, i, arr) => i === 0 || arr[i - 1] !== t)
    expect(typeSequence).toEqual([...DEVICE_TYPES])
    for (const type of DEVICE_TYPES) {
      const group = DEVICE_PRESETS.filter((p) => p.deviceType === type)
      const firstLegacy = group.findIndex((p) => p.legacy)
      if (firstLegacy >= 0) expect(group.slice(firstLegacy).every((p) => p.legacy), type).toBe(true)
    }
    const mobile = ids(DEVICE_PRESETS.filter((p) => p.deviceType === 'mobile'))
    // Natural (numeric) order: "S8" before "S24", "Pixel 5" before "Pixel 10" — plain string order would invert both.
    expect(mobile.indexOf('galaxy-s8')).toBeLessThan(mobile.indexOf('galaxy-s24'))
    expect(mobile.indexOf('pixel-5')).toBeLessThan(mobile.indexOf('pixel-10'))
    // Legacy devices sort after every current device, however old their number looks.
    expect(mobile.indexOf('iphone-8')).toBeGreaterThan(mobile.indexOf('iphone-17-pro-max'))
    expect(mobile.indexOf('iphone-15')).toBeLessThan(mobile.indexOf('iphone-15-landscape'))
    expect(mobile.indexOf('iphone-15-landscape')).toBeLessThan(mobile.indexOf('iphone-15-plus'))
    expect(ids(DEVICE_PRESETS)[0]).toBe(ids(listPresets({ deviceType: 'desktop' }))[0])
  })

  it('resolves the specific lookups the launcher relies on', () => {
    const iphone = getPreset('iphone-17-pro-max')
    expect(iphone).toMatchObject({ playwrightDevice: 'iPhone 17 Pro Max', deviceType: 'mobile', viewportWidth: 440, viewportHeight: 763, legacy: false })
    const fold = getPreset('galaxy-z-fold-7')
    expect(fold).toMatchObject({ playwrightDevice: 'Galaxy Z Fold 7', deviceType: 'mobile', viewportWidth: 984, viewportHeight: 1016 })
    expect(buildContextOptions(profileFor(fold), fold).screen).toEqual({ width: 984, height: 1092 })
    const ipad = getPreset('ipad-pro-11')
    expect(ipad).toMatchObject({ playwrightDevice: 'iPad Pro 11', deviceType: 'tablet', viewportWidth: 834, viewportHeight: 1194 })
    const hidpi = getPreset('desktop-chrome-hidpi')
    expect(hidpi).toMatchObject({ playwrightDevice: 'Desktop Chrome HiDPI', deviceType: 'desktop', viewportWidth: 1280, viewportHeight: 720, legacy: false })
    expect(sorted(hidpi.supportedEngines)).toEqual(sorted(BROWSER_ENGINES))
    expect(buildContextOptions(profileFor(hidpi), hidpi)).toMatchObject({ deviceScaleFactor: 2, screen: { width: 1792, height: 1120 } })
  })

  it('ships the curated custom Android phones with realistic Chrome UAs', () => {
    for (const id of CUSTOM_ANDROID_IDS) {
      const preset = getPreset(id)
      expect(preset.playwrightDevice, id).toBeNull()
      expect(preset.deviceType, id).toBe('mobile')
      expect(preset.legacy, id).toBe(false)
      expect(preset.userAgent, id).toMatch(/^Mozilla\/5\.0 \(Linux; Android 1[3-9]; .+\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/[\d.]+ Mobile Safari\/537\.36$/)
      expect(sorted(preset.supportedEngines), id).toEqual(sorted(MOBILE_ENGINES))
      const options = buildContextOptions(profileFor(preset), preset)
      expect(options.isMobile, id).toBe(true)
      expect(options.deviceScaleFactor, id).toBeGreaterThanOrEqual(2)
      expect(options.screen?.height ?? 0, id).toBeGreaterThan(preset.viewportHeight)
    }
    expect(getPreset('galaxy-s25-ultra').userAgent).toContain('SM-S938U')
    expect(getPreset('oneplus-12').userAgent).toContain('CPH2583')
    expect(getPreset('moto-g-power-2024').userAgent).toContain('moto g power 5G - 2024')
    expect(getPreset('galaxy-z-fold-5').viewportWidth).toBe(906)
    // Same Chrome major version as Playwright's bundled Chromium.
    const chromeMajor = /Chrome\/(\d+)/.exec(PLAYWRIGHT_DEVICES['Desktop Chrome']?.userAgent ?? '')?.[1]
    expect(chromeMajor).toBeDefined()
    expect(getPreset('galaxy-s25').userAgent).toContain(`Chrome/${chromeMajor}.`)
  })

  it('ships the curated custom desktops', () => {
    for (const id of CUSTOM_DESKTOP_IDS) {
      const preset = getPreset(id)
      expect(preset.playwrightDevice, id).toBeNull()
      expect(preset.deviceType, id).toBe('desktop')
      expect(preset.legacy, id).toBe(false)
      expect(buildContextOptions(profileFor(preset), preset).screen, id).toEqual({ width: preset.viewportWidth, height: preset.viewportHeight })
    }
    expect(getPreset('windows-11-desktop-1366')).toMatchObject({ viewportWidth: 1366, viewportHeight: 768 })
    expect(getPreset('windows-11-desktop-1366').userAgent).toContain('Windows NT 10.0; Win64; x64')
    const w1536 = getPreset('windows-11-desktop-1536')
    expect(w1536).toMatchObject({ viewportWidth: 1536, viewportHeight: 864 })
    expect(buildContextOptions(profileFor(w1536), w1536).deviceScaleFactor).toBe(1.25)
    expect(getPreset('windows-11-desktop-2560')).toMatchObject({ viewportWidth: 2560, viewportHeight: 1440 })
    const mac = getPreset('macos-desktop-1512')
    expect(mac).toMatchObject({ viewportWidth: 1512, viewportHeight: 982 })
    expect(mac.label).toBe('macOS · Chrome · 1512×982')
    expect(mac.label.toLowerCase()).not.toContain('safari')
    expect(mac.userAgent).toMatch(/Macintosh.*Chrome\//)
    expect(buildContextOptions(profileFor(mac), mac).deviceScaleFactor).toBe(2)
    expect(mac.deviceScaleFactor).toBe(2)
    expect(getPreset('linux-desktop-1366').userAgent).toContain('X11; Linux x86_64')
    const edge = getPreset('windows-desktop-edge')
    expect(edge.userAgent).toMatch(/Windows NT 10\.0.*Chrome\/[\d.]+ Safari\/537\.36 Edg\/[\d.]+$/)
    expect(sorted(edge.supportedEngines)).toEqual(sorted(CHROMIUM_FAMILY_ENGINES))
    expect(edge.supportedEngines).not.toContain('firefox')
    expect(edge.supportedEngines).not.toContain('webkit')
    const chromebook = getPreset('chromebook-1366')
    expect(chromebook.userAgent).toMatch(/^Mozilla\/5\.0 \(X11; CrOS x86_64 [\d.]+\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/[\d.]+ Safari\/537\.36$/)
    expect(sorted(chromebook.supportedEngines)).toEqual(sorted(BROWSER_ENGINES))
  })

  it('gates engines by family: mobile/tablet → Chromium family + WebKit (never Firefox); plain desktops → every engine', () => {
    expect(sorted(CHROMIUM_FAMILY_ENGINES)).toEqual(sorted(BROWSER_ENGINES.filter((e) => BROWSER_ENGINE_FAMILY[e] === 'chromium')))
    expect(CHROMIUM_FAMILY_ENGINES).toHaveLength(8)
    expect(sorted(MOBILE_ENGINES)).toEqual(sorted([...CHROMIUM_FAMILY_ENGINES, 'webkit']))
    for (const preset of DEVICE_PRESETS) {
      if (preset.deviceType === 'mobile' || preset.deviceType === 'tablet') {
        expect(preset.supportedEngines, preset.id).not.toContain('firefox')
        expect(sorted(preset.supportedEngines), preset.id).toEqual(sorted(MOBILE_ENGINES))
        // Every installed Chromium-based browser can emulate a phone or tablet.
        for (const engine of BROWSER_ENGINES.filter((e) => BROWSER_ENGINE_KIND[e] === 'installed')) expect(preset.supportedEngines, `${preset.id}/${engine}`).toContain(engine)
      } else {
        for (const engine of preset.supportedEngines) expect(BROWSER_ENGINES, `${preset.id}/${engine}`).toContain(engine)
      }
    }
    for (const id of ['windows-desktop', 'windows-desktop-hidpi', 'linux-desktop', 'macos-desktop', 'desktop-chrome', 'desktop-chrome-hidpi'] as const) {
      expect(sorted(getPreset(id).supportedEngines), id).toEqual(sorted(BROWSER_ENGINES))
    }
  })

  it('restricts the descriptor-specific desktop presets to the engine they describe', () => {
    expect(getPreset('macos-safari-desktop').supportedEngines).toEqual(['webkit'])
    expect(getPreset('macos-safari-desktop').label).toBe('macOS · Safari (WebKit) · 1280×720')
    expect(getPreset('desktop-firefox').supportedEngines).toEqual(['firefox'])
    expect(getPreset('desktop-firefox').userAgent).toMatch(/Firefox\//)
    expect(getPreset('desktop-firefox-hidpi').supportedEngines).toEqual(['firefox'])
    expect(getPreset('desktop-firefox-hidpi').label).toBe('Windows · Firefox · 1280×720')
    expect(getPreset('desktop-firefox-hidpi').deviceScaleFactor).toBe(2)
    for (const id of ['desktop-edge', 'desktop-edge-hidpi'] as const) {
      expect(sorted(getPreset(id).supportedEngines), id).toEqual(sorted(CHROMIUM_FAMILY_ENGINES))
      expect(getPreset(id).supportedEngines, id).not.toContain('firefox')
      expect(getPreset(id).supportedEngines, id).not.toContain('webkit')
      expect(getPreset(id).userAgent, id).toMatch(/Edg\//)
    }
  })

  it('labels the macOS Chrome desktop as Chrome, never as Safari; HiDPI desktop scales 2×', () => {
    const mac = getPreset('macos-desktop')
    expect(mac.label).toBe('macOS · Chrome · 1440×900')
    expect(mac.label.toLowerCase()).not.toContain('safari')
    expect(mac.userAgent).toMatch(/Macintosh.*Chrome\//)
    expect(getPreset('windows-desktop').userAgent).toContain('Windows NT 10.0')
    expect(getPreset('linux-desktop').userAgent).toContain('Linux x86_64')
    const hidpi = getPreset('windows-desktop-hidpi')
    expect(hidpi.userAgent).toContain('Windows NT 10.0')
    expect({ width: hidpi.viewportWidth, height: hidpi.viewportHeight }).toEqual({ width: 1920, height: 1080 })
    const desktopProfile: Profile = { ...baseProfile, deviceType: 'desktop', devicePreset: 'windows-desktop-hidpi', viewportWidth: 1920, viewportHeight: 1080 }
    expect(buildContextOptions(desktopProfile, hidpi).deviceScaleFactor).toBe(2)
    expect(buildContextOptions(desktopProfile, getPreset('windows-desktop')).deviceScaleFactor).toBe(1)
  })

  it('getPreset throws INVALID_INPUT for unknown ids and isDevicePresetId guards them', () => {
    expect(isDevicePresetId('pixel-7')).toBe(true)
    expect(isDevicePresetId('ipad-mini')).toBe(true)
    expect(isDevicePresetId('iphone-6')).toBe(true)
    expect(isDevicePresetId('nokia-3310')).toBe(false)
    expect(isDevicePresetId('')).toBe(false)
    expect(isDevicePresetId('iPhone 15')).toBe(false)
    let caught: unknown
    try {
      getPreset('nokia-3310')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AppException)
    expect((caught as AppException).code).toBe('INVALID_INPUT')
    expect((caught as AppException).message).toContain('nokia-3310')
  })
})

describe('catalog metadata', () => {
  it('keeps every preset id stable (saved profiles reference them)', () => {
    expect(ids(DEVICE_PRESETS).sort()).toEqual([...PREVIOUS_PRESET_IDS].sort())
  })

  it('populates brand, model, OS, orientation, scale, touch and size class on every preset', () => {
    for (const preset of DEVICE_PRESETS) {
      expect(DEVICE_BRANDS, preset.id).toContain(preset.brand)
      expect(DEVICE_OS, preset.id).toContain(preset.os)
      expect(['portrait', 'landscape'], preset.id).toContain(preset.orientation)
      expect(SCREEN_CLASSES, preset.id).toContain(preset.screenClass)
      expect(preset.model?.length ?? 0, preset.id).toBeGreaterThan(0)
      expect(typeof preset.deviceScaleFactor, preset.id).toBe('number')
      expect(preset.hasTouch, preset.id).toBe(preset.deviceType !== 'desktop')
      expect(typeof preset.popular, preset.id).toBe('boolean')
      expect(preset.osVersion === null || typeof preset.osVersion === 'string', preset.id).toBe(true)
      expect(preset.landscapeOf === null || typeof preset.landscapeOf === 'string', preset.id).toBe(true)
      // The scale reported to the renderer is the one the context is built with.
      expect(buildContextOptions(profileFor(preset), preset).deviceScaleFactor, preset.id).toBe(preset.deviceScaleFactor)
      if (preset.deviceType === 'desktop') {
        expect(preset.brand, preset.id).toBe('Generic')
        expect(preset.releaseYear, preset.id).toBeNull()
      } else {
        expect(preset.brand, preset.id).not.toBe('Generic')
        expect(preset.releaseYear, preset.id).toBeGreaterThanOrEqual(2010)
        // "<Brand> <Model>": the label is built from the metadata.
        expect(preset.label, preset.id).toBe(deviceLabel(preset.brand ?? 'Generic', preset.model ?? '', preset.orientation === 'landscape'))
      }
    }
  })

  it('derives brand and marketing model from descriptor keys', () => {
    expect(brandAndModel('iPhone 15 Pro Max')).toEqual({ brand: 'Apple', model: 'iPhone 15 Pro Max' })
    expect(brandAndModel('iPad (gen 11)')).toEqual({ brand: 'Apple', model: 'iPad (11th gen)' })
    expect(brandAndModel('iPhone 13 Mini')).toEqual({ brand: 'Apple', model: 'iPhone 13 mini' })
    expect(brandAndModel('Galaxy Z Fold 7')).toEqual({ brand: 'Samsung', model: 'Galaxy Z Fold 7' })
    expect(brandAndModel('Galaxy Z Flip 7 Cover')).toEqual({ brand: 'Samsung', model: 'Galaxy Z Flip 7 (cover screen)' })
    expect(brandAndModel('Pixel 9 Pro')).toEqual({ brand: 'Google', model: 'Pixel 9 Pro' })
    expect(brandAndModel('Blackberry PlayBook')).toEqual({ brand: 'BlackBerry', model: 'PlayBook' })
    expect(brandAndModel('Microsoft Lumia 950')).toEqual({ brand: 'Microsoft', model: 'Lumia 950' })
    expect(brandAndModel('LG Optimus L70')).toEqual({ brand: 'LG', model: 'Optimus L70' })
    expect(deviceLabel('OnePlus', 'OnePlus 12', false)).toBe('OnePlus 12')
    expect(deviceLabel('Google', 'Pixel 9', true)).toBe('Google Pixel 9 (landscape)')
    expect(desktopLabel('windows', 'Edge', 1280, 720)).toBe('Windows · Edge · 1280×720')
    expect(desktopLabel('chromeos', 'Chrome', 1366, 768)).toBe('Chromebook · 1366×768')
  })

  it('parses OS and version from user agents', () => {
    expect(getPreset('iphone-15')).toMatchObject({ os: 'ios', osVersion: '17.5' })
    expect(getPreset('ipad-gen-11')).toMatchObject({ os: 'ipados', osVersion: '18.5' })
    expect(getPreset('pixel-9')).toMatchObject({ os: 'android', osVersion: '14' })
    expect(getPreset('galaxy-s25')).toMatchObject({ os: 'android', osVersion: '15' })
    expect(getPreset('nexus-5x')).toMatchObject({ os: 'android', osVersion: '8' })
    expect(getPreset('microsoft-lumia-950')).toMatchObject({ os: 'windows', osVersion: '10 Mobile' })
    expect(getPreset('kindle-fire-hdx')).toMatchObject({ os: 'android', osVersion: null })
    expect(getPreset('blackberry-z30')).toMatchObject({ os: 'other', osVersion: null })
    expect(getPreset('windows-desktop')).toMatchObject({ os: 'windows', osVersion: '10/11' })
    expect(getPreset('macos-desktop')).toMatchObject({ os: 'macos', osVersion: null })
    expect(getPreset('linux-desktop')).toMatchObject({ os: 'linux', osVersion: null })
    expect(getPreset('chromebook-1366')).toMatchObject({ os: 'chromeos', osVersion: null })
    expect(parseUserAgentOs('Mozilla/5.0 (iPhone; CPU iPhone OS 10_3_1 like Mac OS X)')).toEqual({ os: 'ios', osVersion: '10.3.1' })
    expect(parseUserAgentOs('Mozilla/5.0 (Linux; Android 7.1.1; Nexus 6)')).toEqual({ os: 'android', osVersion: '7.1.1' })
    expect(parseUserAgentOs('Mozilla/5.0 (compatible; MSIE 10.0; Windows Phone 8.0; Trident/6.0)')).toEqual({ os: 'windows', osVersion: 'Phone 8' })
  })

  it('links landscape variants to their portrait twin and shares its size class', () => {
    const landscape = DEVICE_PRESETS.filter((p) => p.deviceType !== 'desktop' && p.orientation === 'landscape')
    expect(landscape.length).toBeGreaterThan(50)
    for (const preset of landscape) {
      expect(preset.id, preset.id).toMatch(/-landscape$/)
      expect(preset.landscapeOf, preset.id).toBe(preset.id.replace(/-landscape$/, ''))
      const twin = getPreset(preset.landscapeOf ?? '')
      expect(twin.orientation, preset.id).toBe('portrait')
      expect(twin.screenClass, preset.id).toBe(preset.screenClass)
      expect(twin.model, preset.id).toBe(preset.model)
    }
    for (const preset of DEVICE_PRESETS.filter((p) => p.orientation === 'portrait')) expect(preset.landscapeOf, preset.id).toBeNull()
    expect(getPreset('iphone-15-landscape')).toMatchObject({ orientation: 'landscape', landscapeOf: 'iphone-15' })
    // Desktops are landscape screens but never "landscape variants".
    expect(getPreset('windows-desktop')).toMatchObject({ orientation: 'landscape', landscapeOf: null })
  })

  it('buckets screen sizes', () => {
    expect(screenClassFor('mobile', 360, 780)).toBe('compact')
    expect(screenClassFor('mobile', 393, 659)).toBe('regular')
    expect(screenClassFor('mobile', 430, 739)).toBe('large')
    expect(screenClassFor('tablet', 656, 944)).toBe('small')
    expect(screenClassFor('tablet', 834, 1194)).toBe('large')
    expect(screenClassFor('desktop', 1280, 720)).toBe('small')
    expect(screenClassFor('desktop', 1920, 1080)).toBe('large')
    expect(screenClassFor('desktop', 2560, 1440)).toBe('xl')
    expect(getPreset('iphone-16-pro-max').screenClass).toBe('large')
  })

  it('flags a curated popular set of current, portrait devices', () => {
    const popular = DEVICE_PRESETS.filter((p) => p.popular)
    expect(popular.length).toBeGreaterThanOrEqual(25)
    expect(popular.length).toBeLessThanOrEqual(40)
    for (const preset of popular) {
      expect(preset.legacy, preset.id).toBe(false)
      if (preset.deviceType !== 'desktop') expect(preset.orientation, preset.id).toBe('portrait')
      if (preset.deviceType !== 'desktop') expect(preset.releaseYear ?? 0, preset.id).toBeGreaterThanOrEqual(2018)
    }
    for (const type of DEVICE_TYPES) expect(popular.some((p) => p.deviceType === type), type).toBe(true)
    for (const id of ['iphone-16-pro', 'galaxy-s25', 'pixel-9', 'ipad-pro-11', 'windows-desktop', 'macos-desktop', 'linux-desktop'] as const) expect(getPreset(id).popular, id).toBe(true)
  })
})

describe('listPresets', () => {
  it('returns the whole catalog, legacy included, when unfiltered', () => {
    expect(listPresets()).toEqual([...DEVICE_PRESETS])
    expect(listPresets({})).toHaveLength(DEVICE_PRESETS.length)
  })

  it('filters by device type', () => {
    for (const type of DEVICE_TYPES) {
      const presets = listPresets({ deviceType: type })
      expect(presets.length, type).toBeGreaterThan(0)
      for (const preset of presets) expect(preset.deviceType, preset.id).toBe(type)
      expect(presets).toEqual(DEVICE_PRESETS.filter((p) => p.deviceType === type))
    }
  })

  it('filters by engine: Firefox only sees desktops it can run, WebKit never sees Edge/Firefox descriptors', () => {
    const firefox = listPresets({ engine: 'firefox' })
    expect(firefox.length).toBeGreaterThan(0)
    for (const preset of firefox) {
      expect(preset.deviceType, preset.id).toBe('desktop')
      expect(preset.supportedEngines, preset.id).toContain('firefox')
    }
    expect(ids(firefox)).toContain('desktop-firefox')
    expect(ids(firefox)).toContain('windows-desktop')
    expect(ids(firefox)).not.toContain('desktop-edge')
    expect(ids(firefox)).not.toContain('macos-safari-desktop')
    const webkit = ids(listPresets({ engine: 'webkit' }))
    expect(webkit).toContain('iphone-15')
    expect(webkit).toContain('macos-safari-desktop')
    expect(webkit).not.toContain('desktop-edge')
    expect(webkit).not.toContain('desktop-firefox')
    expect(webkit).not.toContain('windows-desktop-edge')
    const brave = ids(listPresets({ engine: 'brave' }))
    expect(brave).toContain('iphone-15')
    expect(brave).toContain('desktop-edge')
    expect(brave).not.toContain('macos-safari-desktop')
    expect(brave).not.toContain('desktop-firefox')
  })

  it('excludes legacy devices only when asked', () => {
    const withLegacy = listPresets({ deviceType: 'mobile' })
    const current = listPresets({ deviceType: 'mobile', includeLegacy: false })
    expect(current.length).toBeLessThan(withLegacy.length)
    expect(current.every((p) => !p.legacy)).toBe(true)
    expect(ids(withLegacy)).toContain('iphone-6')
    expect(ids(current)).not.toContain('iphone-6')
    expect(ids(current)).toContain('iphone-15')
    expect(listPresets({ includeLegacy: true })).toEqual([...DEVICE_PRESETS])
  })

  it('combines filters and returns an empty list for impossible combinations', () => {
    expect(listPresets({ deviceType: 'mobile', engine: 'firefox' })).toEqual([])
    expect(listPresets({ deviceType: 'tablet', engine: 'firefox' })).toEqual([])
    const tablets = listPresets({ deviceType: 'tablet', engine: 'webkit', includeLegacy: false })
    expect(tablets.length).toBeGreaterThan(0)
    expect(ids(tablets)).toContain('ipad-pro-11')
    expect(ids(tablets)).not.toContain('nexus-7')
  })
})

describe('randomPreset', () => {
  it('never returns a legacy device by default and respects device type and engine filters', () => {
    for (let i = 0; i < 300; i++) {
      expect(randomPreset().legacy).toBe(false)
      expect(randomPreset({ deviceType: 'tablet' })).toMatchObject({ deviceType: 'tablet', legacy: false })
      const mobile = randomPreset({ deviceType: 'mobile', engine: 'opera' })
      expect(mobile.deviceType).toBe('mobile')
      expect(mobile.supportedEngines).toContain('opera')
      expect(mobile.legacy).toBe(false)
      const firefox = randomPreset({ engine: 'firefox' })
      expect(firefox.deviceType).toBe('desktop')
      expect(firefox.supportedEngines).toContain('firefox')
    }
  })

  it('is uniform over the eligible set: every eligible preset is reachable and nothing else is', () => {
    const filter = { deviceType: 'mobile', engine: 'webkit' } as const
    const eligible = listPresets({ ...filter, includeLegacy: false })
    expect(eligible.length).toBeGreaterThan(20)
    const reached = new Set<string>()
    for (let k = 0; k < eligible.length; k++) reached.add(randomPreset(filter, () => (k + 0.5) / eligible.length).id)
    expect([...reached].sort()).toEqual(ids(eligible).sort())
    expect(randomPreset(filter, () => 0).id).toBe(eligible[0]?.id)
    expect(randomPreset(filter, () => 0.999999).id).toBe(eligible[eligible.length - 1]?.id)
    // Out-of-range generators are clamped instead of returning undefined.
    expect(randomPreset(filter, () => 1).id).toBe(eligible[eligible.length - 1]?.id)
  })

  it('can include legacy devices when asked', () => {
    const all = listPresets({ deviceType: 'mobile', includeLegacy: true })
    const legacyIndex = all.findIndex((p) => p.legacy)
    expect(legacyIndex).toBeGreaterThan(0)
    const picked = randomPreset({ deviceType: 'mobile', includeLegacy: true }, () => (legacyIndex + 0.5) / all.length)
    expect(picked.legacy).toBe(true)
    expect(picked.id).toBe(all[legacyIndex]?.id)
  })

  it('throws INVALID_INPUT when no preset matches', () => {
    let caught: unknown
    try {
      randomPreset({ deviceType: 'mobile', engine: 'firefox' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AppException)
    expect((caught as AppException).code).toBe('INVALID_INPUT')
    expect((caught as AppException).message).toMatch(/Firefox cannot emulate phones or tablets/)
  })
})

describe('buildContextOptions', () => {
  it('uses preset defaults when the profile has no overrides', () => {
    const preset = getPreset('iphone-15')
    const options = buildContextOptions(baseProfile, preset)
    expect(options.viewport).toEqual({ width: 393, height: 659 })
    expect(options.userAgent).toBe(preset.userAgent)
    expect(options.isMobile).toBe(true)
    expect(options.hasTouch).toBe(true)
    expect(options.deviceScaleFactor).toBe(3)
    expect(options.screen).toEqual({ width: 393, height: 852 })
    expect(options.locale).toBe('en-US')
    expect(options.timezoneId).toBe('America/New_York')
  })

  it('applies profile viewport, userAgent, locale and timezone overrides', () => {
    const preset = getPreset('windows-desktop')
    const options = buildContextOptions(
      {
        ...baseProfile,
        deviceType: 'desktop',
        devicePreset: 'windows-desktop',
        viewportWidth: 1366,
        viewportHeight: 768,
        userAgent: 'Custom/1.0',
        locale: 'de-DE',
        timezone: 'Europe/Berlin',
      },
      preset,
    )
    expect(options.viewport).toEqual({ width: 1366, height: 768 })
    expect(options.userAgent).toBe('Custom/1.0')
    expect(options.locale).toBe('de-DE')
    expect(options.timezoneId).toBe('Europe/Berlin')
    expect(options.isMobile).toBeUndefined()
    // Custom viewport: do not report the preset's physical screen size.
    expect(options.screen).toBeUndefined()
  })

  it('treats an empty/whitespace userAgent as "use preset"', () => {
    const preset = getPreset('pixel-7')
    const options = buildContextOptions({ ...baseProfile, devicePreset: 'pixel-7', userAgent: '   ' }, preset)
    expect(options.userAgent).toBe(preset.userAgent)
  })

  it('forces the desktop preset UA only on the bundled Chromium; every other engine keeps its native UA', () => {
    const desktop: Profile = { ...baseProfile, deviceType: 'desktop', devicePreset: 'windows-desktop', viewportWidth: 1920, viewportHeight: 1080 }
    const preset = getPreset('windows-desktop')
    expect(buildContextOptions({ ...desktop, engine: 'chromium' }, preset).userAgent).toBe(preset.userAgent)
    for (const engine of BROWSER_ENGINES.filter((e) => e !== 'chromium')) {
      expect(resolveUserAgent({ ...desktop, engine }, preset), engine).toBeUndefined()
      expect(buildContextOptions({ ...desktop, engine }, preset), engine).not.toHaveProperty('userAgent')
    }
    // An explicit profile UA always wins, on every engine.
    expect(buildContextOptions({ ...desktop, engine: 'firefox', userAgent: 'Custom/2.0' }, preset).userAgent).toBe('Custom/2.0')
    expect(buildContextOptions({ ...desktop, engine: 'brave', userAgent: 'Custom/3.0' }, preset).userAgent).toBe('Custom/3.0')
    // Other emulation stays in place for those engines.
    const ff = buildContextOptions({ ...desktop, engine: 'firefox' }, preset)
    expect(ff.viewport).toEqual({ width: 1920, height: 1080 })
    expect(ff.locale).toBe('en-US')
    expect(ff.screen).toEqual({ width: 1920, height: 1080 })
    // Descriptor-specific and generated desktops follow the same rule: WebKit/Firefox/installed browsers report themselves.
    const safari = getPreset('macos-safari-desktop')
    expect(resolveUserAgent({ ...desktop, engine: 'webkit', devicePreset: 'macos-safari-desktop' }, safari)).toBeUndefined()
    expect(buildContextOptions(profileFor(safari, 'webkit'), safari).deviceScaleFactor).toBe(2)
    expect(resolveUserAgent({ ...desktop, engine: 'firefox', devicePreset: 'desktop-firefox' }, getPreset('desktop-firefox'))).toBeUndefined()
    const edge = getPreset('windows-desktop-edge')
    expect(resolveUserAgent(profileFor(edge, 'msedge'), edge)).toBeUndefined()
    expect(resolveUserAgent(profileFor(edge, 'chromium'), edge)).toBe(edge.userAgent)
    const hidpi = getPreset('desktop-chrome-hidpi')
    expect(resolveUserAgent(profileFor(hidpi, 'chrome'), hidpi)).toBeUndefined()
    expect(resolveUserAgent(profileFor(hidpi, 'chromium'), hidpi)).toBe(hidpi.userAgent)
  })

  it('applies the descriptor UA and mobile emulation for mobile and tablet presets on every supported engine', () => {
    const iphone = getPreset('iphone-15')
    for (const engine of iphone.supportedEngines) {
      expect(buildContextOptions({ ...baseProfile, engine }, iphone).userAgent, engine).toBe(iphone.userAgent)
    }
    const ipad = getPreset('ipad-mini')
    for (const engine of ['chromium', 'webkit', 'opera', 'system-chromium'] as const) {
      const options = buildContextOptions(profileFor(ipad, engine), ipad)
      expect(options.userAgent, engine).toBe(ipad.userAgent)
      expect(options.isMobile, engine).toBe(true)
      expect(options.hasTouch, engine).toBe(true)
    }
    const tab = getPreset('galaxy-tab-s9')
    expect(buildContextOptions(profileFor(tab, 'brave'), tab)).toMatchObject({
      userAgent: tab.userAgent,
      isMobile: true,
      deviceScaleFactor: 2.5,
    })
    // Legacy and custom mobile presets go through the same path.
    const legacy = getPreset('nexus-5')
    expect(buildContextOptions(profileFor(legacy, 'vivaldi'), legacy)).toMatchObject({ userAgent: legacy.userAgent, isMobile: true, hasTouch: true })
    const s25 = getPreset('galaxy-s25')
    expect(buildContextOptions(profileFor(s25, 'webkit'), s25)).toMatchObject({ userAgent: s25.userAgent, isMobile: true, deviceScaleFactor: 3, screen: { width: 360, height: 780 } })
  })
})

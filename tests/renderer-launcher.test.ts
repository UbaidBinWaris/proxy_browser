import { describe, expect, it } from 'vitest'
import type { BrowserEngine, BrowserEngineInfo, DevicePresetInfo, LocationEntry, ProductKey } from '../src/shared/types'
import { BROWSER_ENGINES, BROWSER_ENGINE_FAMILY, BROWSER_ENGINE_KIND, BROWSER_ENGINE_LABELS, QuickLaunchInputSchema } from '../src/shared/types'
import {
  COUNTRY_MESSAGE,
  LAUNCHER_PREFS_KEY,
  LOCATION_REQUIRED_MESSAGE,
  START_URL_MESSAGE,
  TTL_MESSAGE,
  applyLauncherPrefs,
  buildQuickLaunchInput,
  compatibleEngines,
  compatiblePresets,
  defaultLauncherForm,
  firstLauncherError,
  launcherTarget,
  pickRandom,
  pickRandomDevice,
  pickRandomEngine,
  pickRandomPool,
  pickRandomPreset,
  prefsFromForm,
  presetMatchScore,
  randomAll,
  readLauncherPrefs,
  suggestProfileName,
  writeLauncherPrefs,
} from '../src/renderer/src/lib/launcherForm'
import type { LauncherFormState, PrefsStorage } from '../src/renderer/src/lib/launcherForm'
import { geoTargetFromEntry } from '../src/renderer/src/lib/targeting'

const MOBILE_ENGINES: readonly BrowserEngine[] = BROWSER_ENGINES.filter((e) => BROWSER_ENGINE_FAMILY[e] !== 'firefox')

const desktop: DevicePresetInfo = {
  id: 'windows-desktop',
  label: 'Windows desktop (Chrome)',
  deviceType: 'desktop',
  playwrightDevice: null,
  viewportWidth: 1920,
  viewportHeight: 1080,
  userAgent: 'Mozilla/5.0 (Windows)',
  supportedEngines: BROWSER_ENGINES,
}
const iphone: DevicePresetInfo = { ...desktop, id: 'iphone-15', label: 'iPhone 15', deviceType: 'mobile', viewportWidth: 393, viewportHeight: 852, supportedEngines: MOBILE_ENGINES }
const ipad: DevicePresetInfo = { ...iphone, id: 'ipad-mini', label: 'iPad Mini', deviceType: 'tablet', viewportWidth: 768, viewportHeight: 1024 }
const safariDesktop: DevicePresetInfo = { ...desktop, id: 'macos-safari-desktop', label: 'macOS Safari', supportedEngines: ['webkit'] }
const presets = [desktop, iphone, ipad, safariDesktop]

const engineInfo = (id: BrowserEngine, available: boolean): BrowserEngineInfo => ({
  id,
  label: BROWSER_ENGINE_LABELS[id],
  family: BROWSER_ENGINE_FAMILY[id],
  kind: BROWSER_ENGINE_KIND[id],
  available,
  executablePath: available ? `/usr/bin/${id}` : null,
  version: null,
  source: available ? 'detected' : 'not-found',
  note: '',
  installMethod: BROWSER_ENGINE_KIND[id] === 'bundled' ? 'bundled' : 'download-page',
  installNote: '',
  downloadUrl: null,
  managedInstall: false,
})
/** Chromium + Firefox available; WebKit missing; only Chrome among the installed browsers. */
const engines: BrowserEngineInfo[] = BROWSER_ENGINES.map((id) => engineInfo(id, id === 'chromium' || id === 'firefox' || id === 'chrome'))

const newark: LocationEntry = { kind: 'city', label: 'Newark, NJ', country: 'US', state: 'New Jersey', stateCode: 'NJ', city: 'Newark', zip: null, timezone: 'America/New_York' }
const newJersey: LocationEntry = { kind: 'state', label: 'New Jersey (NJ)', country: 'US', state: 'New Jersey', stateCode: 'NJ', city: null, zip: null, timezone: 'America/New_York' }

const form = (overrides: Partial<LauncherFormState> = {}): LauncherFormState => ({ ...defaultLauncherForm(), target: geoTargetFromEntry(newJersey), ...overrides })

/** Deterministic rng that returns the given values in order (clamped to [0, 1)). */
function sequence(...values: number[]): () => number {
  let index = 0
  return () => {
    const value = values[Math.min(index, values.length - 1)] ?? 0
    index += 1
    return value
  }
}

describe('launcher form → QuickLaunchInput', () => {
  it('starts from the settings defaults and remembers nothing without storage', () => {
    const fresh = defaultLauncherForm({ defaultProxyPool: 'mobile', defaultTargetCountry: 'US' })
    expect(fresh).toMatchObject({ pool: 'mobile', country: 'us', mode: 'state', sticky: true, engine: 'chromium', devicePreset: 'windows-desktop', target: null })
    expect(readLauncherPrefs(null)).toBeNull()
  })

  it('builds a valid sticky state launch and the schema accepts it as-is', () => {
    const result = buildQuickLaunchInput(form({ startUrl: ' https://forms.example.com/qa ', stickyTtlMinutes: ' 45 ' }))
    expect(result.errors).toBeNull()
    expect(result.input).toMatchObject({
      startUrl: 'https://forms.example.com/qa',
      engine: 'chromium',
      devicePreset: 'windows-desktop',
      proxyPool: 'residential',
      target: { mode: 'state', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: null, zip: null },
      sticky: true,
      stickyTtlMinutes: 45,
      locale: null,
      timezone: null,
      saveAsProfile: false,
      profileName: null,
      replaceActiveSession: false,
    })
    expect(QuickLaunchInputSchema.safeParse(result.input).success).toBe(true)
  })

  it('requires a location for state / city / zip modes but not for country mode or direct connections', () => {
    const missing = buildQuickLaunchInput(form({ target: null }))
    expect(missing.input).toBeNull()
    expect(missing.errors?.target).toBe(LOCATION_REQUIRED_MESSAGE)
    expect(firstLauncherError(missing.errors ?? {})).toBe('target')

    const country = buildQuickLaunchInput(form({ mode: 'country', target: null, country: 'US' }))
    expect(country.errors).toBeNull()
    expect(country.input?.target).toEqual({ mode: 'country', country: 'us', state: null, stateCode: null, city: null, zip: null })

    const badCountry = buildQuickLaunchInput(form({ mode: 'country', target: null, country: 'USA' }))
    expect(badCountry.errors?.country).toBe(COUNTRY_MESSAGE)

    const direct = buildQuickLaunchInput(form({ pool: 'none', target: null, stickyTtlMinutes: '20' }))
    expect(direct.errors).toBeNull()
    expect(direct.input).toMatchObject({ proxyPool: 'none', target: null, sticky: false, stickyTtlMinutes: null })
    expect(launcherTarget(form({ pool: 'none' }))).toBeNull()
  })

  it('re-stamps the picked entry with the current mode (a city pick narrowed to a ZIP request keeps city/state)', () => {
    const picked = geoTargetFromEntry({ ...newark, kind: 'zip', zip: '07102' }, 'zip')
    expect(picked).toEqual({ mode: 'zip', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: 'Newark', zip: '07102' })
    const result = buildQuickLaunchInput(form({ mode: 'zip', target: picked }))
    expect(result.input?.target?.zip).toBe('07102')
    const cityOnly = geoTargetFromEntry(newark, 'city')
    expect(cityOnly.zip).toBeNull()
    expect(cityOnly.city).toBe('Newark')
    expect(geoTargetFromEntry(newark, 'state')).toMatchObject({ mode: 'state', city: null, zip: null, stateCode: 'NJ' })
  })

  it('reports TTL, URL and profile name problems per field with human messages', () => {
    const result = buildQuickLaunchInput(form({ stickyTtlMinutes: '0', startUrl: 'ftp://x', saveAsProfile: true, profileName: 'x'.repeat(81) }))
    expect(result.input).toBeNull()
    expect(result.errors?.stickyTtlMinutes).toBe(TTL_MESSAGE)
    expect(result.errors?.startUrl).toBe(START_URL_MESSAGE)
    expect(result.errors?.profileName).toBeDefined()
    expect(firstLauncherError(result.errors ?? {})).toBe('stickyTtlMinutes')
    expect(buildQuickLaunchInput(form({ stickyTtlMinutes: '1441' })).errors?.stickyTtlMinutes).toBe(TTL_MESSAGE)
    expect(buildQuickLaunchInput(form({ stickyTtlMinutes: '12.5' })).errors?.stickyTtlMinutes).toBe(TTL_MESSAGE)
    // Rotating sessions never send a TTL even when one is typed.
    expect(buildQuickLaunchInput(form({ sticky: false, stickyTtlMinutes: '30' })).input).toMatchObject({ sticky: false, stickyTtlMinutes: null })
  })

  it('passes replaceActiveSession and the profile name only when saving as a profile', () => {
    const replace = buildQuickLaunchInput(form({ saveAsProfile: true, profileName: ' QA NJ ' }), { replaceActiveSession: true })
    expect(replace.input).toMatchObject({ replaceActiveSession: true, saveAsProfile: true, profileName: 'QA NJ' })
    const notSaved = buildQuickLaunchInput(form({ saveAsProfile: false, profileName: 'ignored' }))
    expect(notSaved.input?.profileName).toBeNull()
  })

  it('suggests a profile name from location, device and pool', () => {
    expect(suggestProfileName(form({ mode: 'city', target: geoTargetFromEntry(newark, 'city') }), iphone)).toBe('NJ · Newark · iPhone 15 · Residential')
    expect(suggestProfileName(form({ pool: 'none' }), desktop)).toBe('Direct · Windows desktop (Chrome)')
    expect(suggestProfileName(form({ pool: 'mobile', mode: 'country', target: null, country: 'us' }), null)).toBe('US · windows-desktop · Mobile')
    expect(suggestProfileName(form({ target: null }), desktop)).toBe('Windows desktop (Chrome) · Residential')
  })
})

describe('launcher preferences persistence', () => {
  function memoryStorage(initial: Record<string, string> = {}): PrefsStorage & { data: Record<string, string> } {
    const data = { ...initial }
    return {
      data,
      getItem: (key) => data[key] ?? null,
      setItem: (key, value) => {
        data[key] = value
      },
    }
  }

  it('round-trips pool, mode, engine, preset and sticky through storage', () => {
    const storage = memoryStorage()
    const current = form({ pool: 'mobile', mode: 'zip', engine: 'webkit', devicePreset: 'iphone-15', sticky: false, startUrl: 'https://not-persisted.example' })
    expect(writeLauncherPrefs(storage, prefsFromForm(current))).toBe(true)
    expect(Object.keys(storage.data)).toEqual([LAUNCHER_PREFS_KEY])
    expect(JSON.parse(storage.data[LAUNCHER_PREFS_KEY] ?? '{}')).toEqual({ providerId: 'dataimpulse', pool: 'mobile', mode: 'zip', engine: 'webkit', devicePreset: 'iphone-15', sticky: false })
    const restored = applyLauncherPrefs(defaultLauncherForm(), readLauncherPrefs(storage))
    expect(restored).toMatchObject({ pool: 'mobile', mode: 'zip', engine: 'webkit', devicePreset: 'iphone-15', sticky: false, startUrl: '', target: null })
  })

  it('ignores malformed or partially valid data instead of throwing', () => {
    expect(readLauncherPrefs(memoryStorage({ [LAUNCHER_PREFS_KEY]: 'not json' }))).toBeNull()
    expect(readLauncherPrefs(memoryStorage({ [LAUNCHER_PREFS_KEY]: JSON.stringify({ pool: 'Sat Ellite' }) }))).toBeNull()
    const partial = readLauncherPrefs(memoryStorage({ [LAUNCHER_PREFS_KEY]: JSON.stringify({ mode: 'city' }) }))
    expect(partial).toEqual({ mode: 'city' })
    expect(applyLauncherPrefs(defaultLauncherForm(), partial)).toMatchObject({ mode: 'city', pool: 'residential' })
    const throwing: PrefsStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(readLauncherPrefs(throwing)).toBeNull()
    expect(writeLauncherPrefs(throwing, { pool: 'none' })).toBe(false)
  })
})

describe('compatibility and random pickers', () => {
  it('lists only engines that are available and can emulate the preset', () => {
    expect(compatibleEngines(engines, desktop)).toEqual(['chromium', 'firefox', 'chrome'])
    expect(compatibleEngines(engines, iphone)).toEqual(['chromium', 'chrome'])
    expect(compatibleEngines(engines, safariDesktop)).toEqual([])
    // Unknown availability (status not loaded) only applies the preset rule.
    expect(compatibleEngines(null, iphone)).toEqual(MOBILE_ENGINES)
    expect(compatibleEngines(null, null)).toEqual(BROWSER_ENGINES)
  })

  it('hides mobile and tablet presets for Firefox and keeps everything for Chromium', () => {
    expect(compatiblePresets(presets, 'firefox').map((p) => p.id)).toEqual(['windows-desktop'])
    expect(compatiblePresets(presets, 'chromium').map((p) => p.id)).toEqual(['windows-desktop', 'iphone-15', 'ipad-mini'])
    expect(compatiblePresets(presets, 'webkit').map((p) => p.id)).toEqual(['windows-desktop', 'iphone-15', 'ipad-mini', 'macos-safari-desktop'])
    expect(compatiblePresets(presets, null)).toHaveLength(presets.length)
  })

  it('ranks device search results by label before incidental id/viewport matches', () => {
    const iphone11 = { ...iphone, id: 'iphone-11', label: 'iPhone 11', viewportWidth: 414, viewportHeight: 715 }
    const iphone15pro = { ...iphone, id: 'iphone-15-pro', label: 'iPhone 15 Pro' }
    // "15" only appears in iPhone 11's viewport (414x715): it still matches, but ranks last.
    expect(presetMatchScore(iphone, 'iphone 15')).toBe(0)
    expect(presetMatchScore(iphone15pro, 'iphone 15')).toBe(0)
    expect(presetMatchScore(iphone11, 'iphone 15')).toBe(3)
    expect(presetMatchScore(iphone15pro, 'pro')).toBe(1)
    expect(presetMatchScore(iphone15pro, 'pro iphone')).toBe(2)
    expect(presetMatchScore(ipad, 'tablet')).toBe(3)
    expect(presetMatchScore(desktop, 'pixel')).toBeNull()
    expect(presetMatchScore(desktop, '  ')).toBe(0)
    const ranked = [iphone11, iphone15pro, iphone]
      .map((preset) => ({ id: preset.id, score: presetMatchScore(preset, 'iPhone 15') }))
      .filter((entry) => entry.score !== null)
      .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
      .map((entry) => entry.id)
    expect(ranked).toEqual(['iphone-15-pro', 'iphone-15', 'iphone-11'])
  })

  it('pickRandom is uniform over the list and safe on empty input', () => {
    expect(pickRandom([], () => 0.5)).toBeNull()
    expect(pickRandom(['a', 'b', 'c'], () => 0)).toBe('a')
    expect(pickRandom(['a', 'b', 'c'], () => 0.999)).toBe('c')
    expect(pickRandom(['a', 'b', 'c'], () => 1)).toBe('c')
  })

  it('random pool draws only from configured pools and falls back to direct', () => {
    const configured: ProductKey[] = ['residential', 'mobile']
    expect(pickRandomPool(configured, () => 0)).toBe('residential')
    expect(pickRandomPool(configured, () => 0.9)).toBe('mobile')
    expect(pickRandomPool(['mobile'], () => 0.1)).toBe('mobile')
    expect(pickRandomPool([], () => 0.1)).toBe('none')
  })

  it('random engine respects availability and preset support; random preset respects the engine', () => {
    expect(pickRandomEngine(engines, iphone, () => 0.99)).toBe('chrome')
    expect(pickRandomEngine(engines, iphone, () => 0)).toBe('chromium')
    expect(pickRandomEngine(engines, safariDesktop)).toBeNull()
    expect(pickRandomPreset(presets, 'firefox', () => 0.7)?.id).toBe('windows-desktop')
    expect(pickRandomPreset(presets, 'webkit', () => 0.99)?.id).toBe('macos-safari-desktop')
    expect(pickRandomPreset([], 'chromium')).toBeNull()
  })

  it('random device never picks a preset nothing installed can run, and keeps the current engine when compatible', () => {
    // index 3 would be the WebKit-only desktop preset; it is excluded because WebKit is not installed.
    for (const roll of [0, 0.3, 0.6, 0.99]) {
      const pick = pickRandomDevice(presets, engines, 'chromium', () => roll)
      expect(pick).not.toBeNull()
      expect(pick?.preset.id).not.toBe('macos-safari-desktop')
      expect(pick?.engine).toBe('chromium')
      expect(pick?.preset.supportedEngines).toContain(pick?.engine)
    }
    // Firefox + a mobile pick → engine switches to a compatible installed one.
    const mobilePick = pickRandomDevice(presets, engines, 'firefox', sequence(0.4, 0.99))
    expect(mobilePick?.preset.id).toBe('iphone-15')
    expect(mobilePick?.engine).toBe('chrome')
    expect(pickRandomDevice([], engines, 'chromium')).toBeNull()
    expect(pickRandomDevice([safariDesktop], engines, 'chromium')).toBeNull()
  })

  it('random all picks pool → device → engine with every pair compatible', () => {
    for (let i = 0; i < 25; i++) {
      const result = randomAll({ configuredPools: ['residential', 'mobile'], presets, engines })
      expect(result).not.toBeNull()
      expect(['residential', 'mobile']).toContain(result?.pool)
      expect(result?.preset.supportedEngines).toContain(result?.engine)
      expect(engines.find((e) => e.id === result?.engine)?.available).toBe(true)
    }
    expect(randomAll({ configuredPools: [], presets, engines, rng: () => 0 })?.pool).toBe('none')
    expect(randomAll({ configuredPools: ['residential'], presets: [], engines })).toBeNull()
    expect(randomAll({ configuredPools: ['residential'], presets: [safariDesktop], engines })).toBeNull()
  })
})

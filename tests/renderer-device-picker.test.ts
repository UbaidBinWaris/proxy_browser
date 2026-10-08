import { describe, expect, it } from 'vitest'
import type { DevicePresetInfo } from '../src/shared/types'
import { DEVICE_PRESETS } from '../src/main/browser/device-presets'
import {
  DEFAULT_PICKER_FILTERS,
  FAVORITE_DEVICES_KEY,
  RECENT_DEVICES_KEY,
  cardTitle,
  deviceIconKind,
  engineShortName,
  facetCounts,
  filterDevices,
  formatScale,
  groupItems,
  incompatibilityReason,
  isFilterActive,
  osDisplay,
  parseStoredIds,
  presetDisplayName,
  presetModel,
  presetOs,
  presetSubline,
  pushRecent,
  randomFromFilters,
  randomPopular,
  readStoredIds,
  resetFilters,
  searchScore,
  sectionMembers,
  sortItems,
  toggleFavorite,
  toggleValue,
  writeStoredIds,
} from '../src/renderer/src/lib/devicePicker'
import type { KeyValueStorage, PickerContext, PickerFilters } from '../src/renderer/src/lib/devicePicker'

const NO_ENGINE: PickerContext = { engine: null, recent: [], favorites: [] }
const filters = (patch: Partial<PickerFilters> = {}): PickerFilters => ({ ...DEFAULT_PICKER_FILTERS, ...patch })
const visibleIds = (patch: Partial<PickerFilters>, ctx: PickerContext = NO_ENGINE): string[] => filterDevices(DEVICE_PRESETS, filters(patch), ctx).items.map((item) => item.preset.id)
const preset = (id: string): DevicePresetInfo => {
  const found = DEVICE_PRESETS.find((p) => p.id === id)
  if (!found) throw new Error(`no preset ${id}`)
  return found
}

/** Seeded linear-congruential RNG in [0, 1). */
function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value
    },
  }
}

describe('device picker: presentation helpers', () => {
  it('formats scale factors like the picker badges', () => {
    expect(formatScale(3)).toBe('3x')
    expect(formatScale(2.625)).toBe('2.6x')
    expect(formatScale(1.25)).toBe('1.25x')
    expect(formatScale(2.75)).toBe('2.75x')
    expect(formatScale(3.5)).toBe('3.5x')
    expect(formatScale(1)).toBe('1x')
  })

  it('builds the trigger name and sub-line from the metadata', () => {
    expect(presetDisplayName(preset('galaxy-a15'))).toBe('Samsung Galaxy A15')
    expect(presetSubline(preset('galaxy-a15'))).toBe('Android 14 · 412×855 @2.6x')
    expect(presetSubline(preset('iphone-15'))).toBe('iOS 17.5 · 393×659 @3x')
    expect(presetDisplayName(preset('iphone-15-landscape'))).toBe('Apple iPhone 15')
    expect(presetSubline(preset('iphone-15-landscape'))).toBe('iOS 17.5 · 734×343 @3x · Landscape')
    expect(presetDisplayName(preset('oneplus-12'))).toBe('OnePlus 12')
    expect(presetDisplayName(preset('windows-desktop'))).toBe('Windows · Chrome · 1920×1080')
    expect(presetSubline(preset('windows-desktop-hidpi'))).toBe('Windows 10/11 · 1920×1080 @2x')
    expect(osDisplay(preset('macos-desktop'))).toBe('macOS')
  })

  it('falls back to label / user agent when metadata is missing (older payloads)', () => {
    const bare: DevicePresetInfo = {
      id: 'x',
      label: 'Some Phone (landscape)',
      deviceType: 'mobile',
      playwrightDevice: null,
      viewportWidth: 800,
      viewportHeight: 400,
      userAgent: 'Mozilla/5.0 (Linux; Android 14; X) Chrome/1 Mobile',
      supportedEngines: ['chromium'],
    }
    expect(presetModel(bare)).toBe('Some Phone')
    expect(presetOs(bare)).toBe('android')
    expect(presetDisplayName(bare)).toBe('Some Phone')
    expect(presetSubline(bare)).toBe('Android · 800×400 @1x · Landscape')
  })

  it('picks the device icon by type and OS', () => {
    expect(deviceIconKind(preset('iphone-15'))).toBe('phone')
    expect(deviceIconKind(preset('ipad-mini'))).toBe('tablet')
    expect(deviceIconKind(preset('macos-desktop'))).toBe('laptop')
    expect(deviceIconKind(preset('chromebook-1366'))).toBe('laptop')
    expect(deviceIconKind(preset('windows-desktop'))).toBe('monitor')
    expect(deviceIconKind(preset('windows-11-desktop-1366'))).toBe('laptop')
  })

  it('explains engine incompatibility', () => {
    expect(engineShortName('firefox')).toBe('Firefox')
    expect(engineShortName('webkit')).toBe('WebKit')
    expect(engineShortName('brave')).toBe('Brave')
    expect(incompatibilityReason(preset('iphone-15'), 'firefox')).toBe("Firefox can't emulate mobile devices")
    expect(incompatibilityReason(preset('ipad-mini'), 'firefox')).toBe("Firefox can't emulate mobile devices")
    expect(incompatibilityReason(preset('macos-safari-desktop'), 'brave')).toBe("WebKit only — Brave can't emulate this preset")
    expect(incompatibilityReason(preset('desktop-edge'), 'webkit')).toBe("Chromium-based browsers only — WebKit can't emulate this preset")
    expect(incompatibilityReason(preset('iphone-15'), 'brave')).toBeNull()
    expect(incompatibilityReason(preset('iphone-15'), null)).toBeNull()
  })
})

describe('device picker: search', () => {
  it('ranks exact model matches first, then prefix, then substring, then word matches', () => {
    expect(searchScore(preset('pixel-9'), 'pixel 9')).toBe(0)
    expect(searchScore(preset('pixel-9-pro'), 'pixel 9')).toBe(1)
    expect(searchScore(preset('pixel-9-pro-xl'), 'Pixel 9')).toBe(1)
    expect(searchScore(preset('galaxy-z-fold-7'), 'fold')).toBe(2)
    expect(searchScore(preset('windows-desktop'), '1920')).toBe(2)
    expect(searchScore(preset('linux-desktop'), 'linux 1920')).toBe(3)
    expect(searchScore(preset('iphone-15'), '')).toBe(0)
    expect(searchScore(preset('iphone-15'), 'galaxy')).toBeNull()
  })

  it('"pixel 9" lists Pixel 9 before Pixel 9 Pro and Pro XL', () => {
    const ids = visibleIds({ query: 'pixel 9' })
    expect(ids[0]).toBe('pixel-9')
    expect(ids).toContain('pixel-9-pro')
    expect(ids.indexOf('pixel-9')).toBeLessThan(ids.indexOf('pixel-9-pro'))
    expect(ids.indexOf('pixel-9')).toBeLessThan(ids.indexOf('pixel-9-pro-xl'))
    // The legacy Pixel 2–4 and other models never match "pixel 9".
    expect(ids.every((id) => id.startsWith('pixel-9'))).toBe(true)
  })

  it('"ios 17" is an OS-version query (not "iPhone 17"), "fold" finds the foldables, "1920" the 1080p desktops', () => {
    const ios17 = visibleIds({ query: 'ios 17' })
    expect(ios17.length).toBeGreaterThan(0)
    for (const id of ios17) expect(preset(id).osVersion?.startsWith('17')).toBe(true)
    expect(ios17).not.toContain('iphone-17')
    expect(visibleIds({ query: 'android 16' }).every((id) => preset(id).osVersion === '16')).toBe(true)
    const folds = visibleIds({ query: 'fold' })
    expect(folds).toEqual(expect.arrayContaining(['galaxy-z-fold-7', 'galaxy-z-fold-6', 'galaxy-z-fold-5']))
    expect(folds.every((id) => id.includes('fold'))).toBe(true)
    const hd = visibleIds({ query: '1920' })
    expect(hd).toEqual(expect.arrayContaining(['windows-desktop', 'linux-desktop', 'windows-desktop-edge']))
    expect(hd.every((id) => preset(id).viewportWidth === 1920 || preset(id).viewportHeight === 1920)).toBe(true)
  })
})

describe('device picker: filters', () => {
  it('hides legacy devices and landscape variants by default; desktops ignore the orientation filter', () => {
    const ids = visibleIds({})
    expect(ids.some((id) => preset(id).legacy === true)).toBe(false)
    expect(ids.some((id) => preset(id).orientation === 'landscape' && preset(id).deviceType !== 'desktop')).toBe(false)
    expect(ids).toContain('windows-desktop')
    const withLegacy = visibleIds({ showLegacy: true })
    expect(withLegacy).toContain('iphone-6')
    expect(withLegacy.length).toBeGreaterThan(ids.length)
  })

  it('filters by orientation', () => {
    const landscape = visibleIds({ orientation: 'landscape', type: 'mobile' })
    expect(landscape.length).toBeGreaterThan(20)
    expect(landscape.every((id) => preset(id).orientation === 'landscape')).toBe(true)
    const both = visibleIds({ orientation: 'both', type: 'mobile' })
    expect(both).toEqual(expect.arrayContaining(['iphone-15', 'iphone-15-landscape']))
  })

  it('filters by type, brand (multi) and OS (multi)', () => {
    expect(visibleIds({ type: 'tablet' }).every((id) => preset(id).deviceType === 'tablet')).toBe(true)
    const samsungPhones = visibleIds({ type: 'mobile', brands: ['Samsung'] })
    expect(samsungPhones.length).toBeGreaterThan(10)
    expect(samsungPhones.every((id) => preset(id).brand === 'Samsung' && preset(id).deviceType === 'mobile')).toBe(true)
    const appleOrGoogle = visibleIds({ brands: ['Apple', 'Google'] })
    expect(new Set(appleOrGoogle.map((id) => preset(id).brand))).toEqual(new Set(['Apple', 'Google']))
    const desktops = visibleIds({ type: 'desktop', os: ['macos', 'linux'] })
    expect(new Set(desktops.map((id) => preset(id).os))).toEqual(new Set(['macos', 'linux']))
  })

  it('compatibility: hides presets the engine cannot emulate, or lists them disabled with a reason', () => {
    const firefox: PickerContext = { ...NO_ENGINE, engine: 'firefox' }
    const compatible = filterDevices(DEVICE_PRESETS, filters(), firefox)
    expect(compatible.items.every((item) => item.compatible && item.preset.deviceType === 'desktop')).toBe(true)
    const all = filterDevices(DEVICE_PRESETS, filters({ compatibleOnly: false }), firefox)
    const iphone = all.items.find((item) => item.preset.id === 'iphone-15')
    expect(iphone).toMatchObject({ compatible: false, reason: "Firefox can't emulate mobile devices" })
    expect(all.items.length).toBeGreaterThan(compatible.items.length)
    const brave: PickerContext = { ...NO_ENGINE, engine: 'brave' }
    expect(visibleIds({ type: 'desktop' }, brave)).not.toContain('macos-safari-desktop')
    expect(visibleIds({ type: 'desktop' }, brave)).not.toContain('desktop-firefox')
  })

  it('reports how many presets of the section the filters hide', () => {
    const result = filterDevices(DEVICE_PRESETS, filters({ type: 'tablet' }), NO_ENGINE)
    expect(result.sectionTotal).toBe(DEVICE_PRESETS.length)
    expect(result.hidden).toBe(DEVICE_PRESETS.length - result.items.length)
  })

  it('knows when filters are active and resets them, keeping sort and section', () => {
    expect(isFilterActive(filters())).toBe(false)
    expect(isFilterActive(filters({ sort: 'name', section: 'popular' }))).toBe(false)
    expect(isFilterActive(filters({ brands: ['Apple'] }))).toBe(true)
    expect(isFilterActive(filters({ query: ' x ' }))).toBe(true)
    expect(isFilterActive(filters({ compatibleOnly: false }))).toBe(true)
    expect(resetFilters(filters({ brands: ['Apple'], showLegacy: true, sort: 'newest', section: 'popular', query: 'x' }))).toEqual({ ...DEFAULT_PICKER_FILTERS, sort: 'newest', section: 'popular' })
    expect(toggleValue(['a', 'b'], 'a')).toEqual(['b'])
    expect(toggleValue(['a'], 'b')).toEqual(['a', 'b'])
  })
})

describe('device picker: facet counts', () => {
  it('counts each facet with the other filters applied', () => {
    const base = facetCounts(DEVICE_PRESETS, filters(), NO_ENGINE)
    expect(base.type.all).toBe(base.type.mobile + base.type.tablet + base.type.desktop)
    expect(base.type.all).toBe(filterDevices(DEVICE_PRESETS, filters(), NO_ENGINE).items.length)

    // Selecting Phones narrows the brand counts to phone brands (Generic = desktops disappears)…
    const phones = facetCounts(DEVICE_PRESETS, filters({ type: 'mobile' }), NO_ENGINE)
    expect(phones.brands.map((b) => b.value)).not.toContain('Generic')
    const samsungPhones = phones.brands.find((b) => b.value === 'Samsung')?.count ?? 0
    expect(samsungPhones).toBe(visibleIds({ type: 'mobile', brands: ['Samsung'] }).length)
    // …but the type counts ignore the type filter itself.
    expect(phones.type).toEqual(base.type)

    // Brand selection updates OS and type counts but not the brand chips' own counts.
    const samsung = facetCounts(DEVICE_PRESETS, filters({ type: 'mobile', brands: ['Samsung'] }), NO_ENGINE)
    expect(samsung.os.map((o) => o.value)).toEqual(['android'])
    expect(samsung.brands).toEqual(phones.brands)
    expect(samsung.type.tablet).toBe(visibleIds({ type: 'tablet', brands: ['Samsung'] }).length)

    // Legacy toggle changes the counts.
    const legacy = facetCounts(DEVICE_PRESETS, filters({ showLegacy: true }), NO_ENGINE)
    expect(legacy.type.all).toBeGreaterThan(base.type.all)
    expect(legacy.brands.map((b) => b.value)).toContain('Nokia')
    expect(base.brands.map((b) => b.value)).not.toContain('Nokia')
  })

  it('keeps a selected brand chip visible even when it has no matches, and counts sections', () => {
    const counts = facetCounts(DEVICE_PRESETS, filters({ type: 'desktop', brands: ['Apple'] }), NO_ENGINE)
    expect(counts.brands.find((b) => b.value === 'Apple')).toEqual({ value: 'Apple', count: 0 })
    const ctx: PickerContext = { engine: null, recent: ['iphone-15', 'pixel-9'], favorites: ['galaxy-s24'] }
    const sections = facetCounts(DEVICE_PRESETS, filters(), ctx).sections
    expect(sections).toMatchObject({ recent: 2, favorites: 1 })
    expect(sections.popular).toBe(DEVICE_PRESETS.filter((p) => p.popular).length)
  })
})

describe('device picker: sections, sorting and grouping', () => {
  it('Recent keeps recency order and shows explicit picks regardless of orientation / legacy filters', () => {
    const ctx: PickerContext = { engine: null, recent: ['iphone-6', 'pixel-9', 'iphone-15-landscape', 'gone-device'], favorites: [] }
    expect(sectionMembers(DEVICE_PRESETS, 'recent', ctx).map((p) => p.id)).toEqual(['iphone-6', 'pixel-9', 'iphone-15-landscape'])
    expect(visibleIds({ section: 'recent', sort: 'name' }, ctx)).toEqual(['iphone-6', 'pixel-9', 'iphone-15-landscape'])
    expect(visibleIds({ section: 'favorites' }, { ...ctx, favorites: ['galaxy-s24'] })).toEqual(['galaxy-s24'])
    expect(visibleIds({ section: 'popular' }).every((id) => preset(id).popular)).toBe(true)
  })

  it('sorts popular first, newest, by name and by screen size', () => {
    const popularFirst = visibleIds({ sort: 'popular' })
    const firstNonPopular = popularFirst.findIndex((id) => !preset(id).popular)
    expect(popularFirst.slice(firstNonPopular).every((id) => !preset(id).popular)).toBe(true)

    const newest = visibleIds({ sort: 'newest', type: 'mobile' })
    const years = newest.map((id) => preset(id).releaseYear ?? 0)
    expect(years).toEqual([...years].sort((a, b) => b - a))

    const byName = visibleIds({ sort: 'name', type: 'tablet' })
    expect(byName).toEqual([...byName].sort((a, b) => preset(a).label.localeCompare(preset(b).label, 'en', { numeric: true })))

    const bySize = visibleIds({ sort: 'screen', type: 'desktop' })
    const areas = bySize.map((id) => preset(id).viewportWidth * preset(id).viewportHeight)
    expect(areas).toEqual([...areas].sort((a, b) => a - b))
  })

  it('puts better search matches before the chosen sort', () => {
    const items = filterDevices(DEVICE_PRESETS, filters({ query: 'pixel 10', sort: 'name' }), NO_ENGINE).items
    expect(items[0]?.preset.id).toBe('pixel-10')
    const resorted = sortItems(items, 'screen')
    expect(resorted[0]?.score).toBe(0)
  })

  it('groups by brand (desktops by OS) in first-appearance order', () => {
    const items = filterDevices(DEVICE_PRESETS, filters({ sort: 'name' }), NO_ENGINE).items
    const groups = groupItems(items)
    const labels = groups.map((g) => g.label)
    expect(new Set(labels).size).toBe(labels.length)
    expect(labels).toEqual(expect.arrayContaining(['Apple', 'Samsung', 'Google', 'Windows', 'macOS', 'Linux']))
    expect(labels).not.toContain('Generic')
    for (const group of groups) for (const item of group.items) expect(item.preset.brand === group.label || item.preset.deviceType === 'desktop').toBe(true)
    expect(groups.reduce((sum, g) => sum + g.items.length, 0)).toBe(items.length)
    expect(groupItems(items, false, 'Recent')).toEqual([{ key: 'all', label: 'Recent', items }])
    expect(groupItems([], false)).toEqual([])
  })
})

describe('device picker: random picks', () => {
  it('Random device respects the current filters and engine compatibility', () => {
    const rng = seeded(7)
    for (let i = 0; i < 40; i++) {
      const pick = randomFromFilters(DEVICE_PRESETS, filters({ type: 'mobile', brands: ['Samsung'] }), NO_ENGINE, rng)
      expect(pick?.brand).toBe('Samsung')
      expect(pick?.deviceType).toBe('mobile')
      expect(pick?.legacy).toBe(false)
    }
    // Incompatible presets listed (compatibleOnly off) are never drawn.
    const firefox: PickerContext = { ...NO_ENGINE, engine: 'firefox' }
    for (let i = 0; i < 40; i++) expect(randomFromFilters(DEVICE_PRESETS, filters({ compatibleOnly: false }), firefox, rng)?.deviceType).toBe('desktop')
    expect(randomFromFilters(DEVICE_PRESETS, filters({ type: 'mobile' }), firefox, rng)).toBeNull()
    expect(randomFromFilters(DEVICE_PRESETS, filters({ query: 'no such device' }), NO_ENGINE, rng)).toBeNull()
  })

  it('Random popular draws popular, current, compatible devices only', () => {
    const rng = seeded(11)
    for (let i = 0; i < 40; i++) {
      const pick = randomPopular(DEVICE_PRESETS, { ...NO_ENGINE, engine: 'webkit' }, rng)
      expect(pick?.popular).toBe(true)
      expect(pick?.legacy).toBe(false)
      expect(pick?.supportedEngines).toContain('webkit')
    }
    expect(randomPopular([], NO_ENGINE)).toBeNull()
  })
})

describe('device picker: recent and favorites persistence', () => {
  it('keeps the last 8 picks, most recent first, without duplicates', () => {
    let recent: string[] = []
    for (const id of ['a', 'b', 'c', 'a', 'd', 'e', 'f', 'g', 'h', 'i']) recent = pushRecent(recent, id)
    expect(recent).toEqual(['i', 'h', 'g', 'f', 'e', 'd', 'a', 'c'])
    expect(toggleFavorite(['x'], 'y')).toEqual(['x', 'y'])
    expect(toggleFavorite(['x', 'y'], 'x')).toEqual(['y'])
  })

  it('parses stored ids defensively', () => {
    expect(parseStoredIds('["iphone-15","pixel-9","iphone-15"," ",3,null]')).toEqual(['iphone-15', 'pixel-9'])
    expect(parseStoredIds('{"a":1}')).toEqual([])
    expect(parseStoredIds('not json')).toEqual([])
    expect(parseStoredIds(null)).toEqual([])
    expect(parseStoredIds(JSON.stringify(['x'.repeat(81), 'ok']))).toEqual(['ok'])
  })

  it('round-trips through storage and survives a broken storage', () => {
    const storage = memoryStorage()
    expect(writeStoredIds(storage, RECENT_DEVICES_KEY, ['iphone-15', 'pixel-9'])).toBe(true)
    expect(readStoredIds(storage, RECENT_DEVICES_KEY)).toEqual(['iphone-15', 'pixel-9'])
    expect(readStoredIds(storage, FAVORITE_DEVICES_KEY)).toEqual([])
    const broken: KeyValueStorage = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(readStoredIds(broken, RECENT_DEVICES_KEY)).toEqual([])
    expect(writeStoredIds(broken, RECENT_DEVICES_KEY, ['a'])).toBe(false)
    expect(readStoredIds(null, RECENT_DEVICES_KEY)).toEqual([])
    expect(writeStoredIds(null, RECENT_DEVICES_KEY, ['a'])).toBe(false)
  })
})

describe('device picker: card titles', () => {
  it('uses the model for devices and drops the OS prefix for desktops', () => {
    expect(cardTitle(preset('iphone-15-pro'))).toBe('iPhone 15 Pro')
    expect(cardTitle(preset('windows-desktop'))).toBe('Chrome · 1920×1080')
    expect(cardTitle(preset('macos-safari-desktop'))).toBe('Safari (WebKit) · 1280×720')
    expect(cardTitle(preset('chromebook-1366'))).toBe('Chromebook · 1366×768')
  })
})

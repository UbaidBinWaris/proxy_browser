/**
 * Pure logic behind the device picker (unit-tested in tests/renderer-device-picker.test.ts):
 * filtering, facet counts, search ranking, sorting, grouping, random picks that respect the
 * filters, and the Recent / Favorites id lists persisted in localStorage.
 *
 * Every catalog preset carries brand/model/os/orientation metadata; the accessors below fall
 * back to values derived from the label and user agent so older payloads still work.
 */
import type { BrowserEngine, DeviceBrand, DeviceOrientation, DeviceOs, DevicePresetId, DevicePresetInfo, DeviceType } from '@shared/types'
import { BROWSER_ENGINE_FAMILY, BROWSER_ENGINE_LABELS, DEVICE_BRANDS, DEVICE_OS, DEVICE_OS_LABELS } from '@shared/types'

// ---------------------------------------------------------------------------
// Filter state
// ---------------------------------------------------------------------------

export type PickerTypeFilter = 'all' | DeviceType
export type OrientationFilter = DeviceOrientation | 'both'
export type PickerSort = 'popular' | 'newest' | 'name' | 'screen'
export type PickerSection = 'popular' | 'recent' | 'favorites' | 'all'

export interface PickerFilters {
  query: string
  type: PickerTypeFilter
  /** Empty = every brand. */
  brands: readonly DeviceBrand[]
  /** Empty = every OS. */
  os: readonly DeviceOs[]
  /** Applies to phones and tablets; desktops are always shown. */
  orientation: OrientationFilter
  showLegacy: boolean
  /** Hide presets the selected engine cannot emulate (when off they are listed, disabled). */
  compatibleOnly: boolean
  sort: PickerSort
  section: PickerSection
}

export const DEFAULT_PICKER_FILTERS: PickerFilters = {
  query: '',
  type: 'all',
  brands: [],
  os: [],
  orientation: 'portrait',
  showLegacy: false,
  compatibleOnly: true,
  sort: 'popular',
  section: 'all',
}

export const TYPE_FILTER_OPTIONS: ReadonlyArray<{ value: PickerTypeFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'mobile', label: 'Phones' },
  { value: 'tablet', label: 'Tablets' },
  { value: 'desktop', label: 'Desktop' },
]

export const ORIENTATION_OPTIONS: ReadonlyArray<{ value: OrientationFilter; label: string }> = [
  { value: 'portrait', label: 'Portrait' },
  { value: 'landscape', label: 'Landscape' },
  { value: 'both', label: 'Both' },
]

export const SORT_OPTIONS: ReadonlyArray<{ value: PickerSort; label: string }> = [
  { value: 'popular', label: 'Popular first' },
  { value: 'newest', label: 'Newest' },
  { value: 'name', label: 'Name' },
  { value: 'screen', label: 'Screen size' },
]

export const SECTION_LABELS: Record<PickerSection, string> = { popular: 'Popular', recent: 'Recent', favorites: 'Favorites', all: 'All devices' }
export const PICKER_SECTIONS: readonly PickerSection[] = ['popular', 'recent', 'favorites', 'all']

/** True when anything narrows the list beyond the defaults (the "Reset filters" link shows then). */
export function isFilterActive(filters: PickerFilters): boolean {
  const d = DEFAULT_PICKER_FILTERS
  return (
    filters.query.trim() !== '' ||
    filters.type !== d.type ||
    filters.brands.length > 0 ||
    filters.os.length > 0 ||
    filters.orientation !== d.orientation ||
    filters.showLegacy !== d.showLegacy ||
    filters.compatibleOnly !== d.compatibleOnly
  )
}

/** Back to the default filters, keeping the chosen sort order and section. */
export function resetFilters(filters: PickerFilters): PickerFilters {
  return { ...DEFAULT_PICKER_FILTERS, sort: filters.sort, section: filters.section }
}

/** Add or remove one value of a multi-select facet. */
export function toggleValue<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value]
}

// ---------------------------------------------------------------------------
// Metadata accessors (with fallbacks for presets that predate the metadata)
// ---------------------------------------------------------------------------

export function presetBrand(preset: DevicePresetInfo): DeviceBrand {
  return preset.brand ?? 'Generic'
}

export function presetModel(preset: DevicePresetInfo): string {
  return preset.model ?? preset.label.replace(/ \(landscape\)$/, '')
}

function osFromUserAgent(ua: string): DeviceOs {
  if (/\biPad\b/.test(ua)) return 'ipados'
  if (/\biPhone\b/.test(ua)) return 'ios'
  if (/\bWindows\b/.test(ua)) return 'windows'
  if (/\bAndroid\b/.test(ua)) return 'android'
  if (/\bCrOS\b/.test(ua)) return 'chromeos'
  if (/\bMacintosh\b/.test(ua)) return 'macos'
  if (/\bLinux\b|\bX11\b/.test(ua)) return 'linux'
  return 'other'
}

export function presetOs(preset: DevicePresetInfo): DeviceOs {
  return preset.os ?? osFromUserAgent(preset.userAgent)
}

export function presetOrientation(preset: DevicePresetInfo): DeviceOrientation {
  return preset.orientation ?? (preset.viewportWidth > preset.viewportHeight ? 'landscape' : 'portrait')
}

export function presetScale(preset: DevicePresetInfo): number {
  return preset.deviceScaleFactor ?? 1
}

/** True for a phone/tablet landscape variant (desktops are landscape screens, not variants). */
export function isLandscapeVariant(preset: DevicePresetInfo): boolean {
  return preset.deviceType !== 'desktop' && presetOrientation(preset) === 'landscape'
}

/** "<Brand> <Model>" without the landscape suffix: "Apple iPhone 15 Pro", "Windows · Chrome · 1920×1080". */
export function presetDisplayName(preset: DevicePresetInfo): string {
  const brand = presetBrand(preset)
  const model = presetModel(preset)
  if (brand === 'Generic' || model.startsWith(`${brand} `)) return model
  return `${brand} ${model}`
}

/** Card title: the model for phones/tablets; desktops drop the OS prefix (cards are grouped by OS). */
export function cardTitle(preset: DevicePresetInfo): string {
  if (preset.deviceType !== 'desktop') return presetModel(preset)
  return presetDisplayName(preset).replace(/^(Windows|macOS|Linux) · /, '')
}

/** "3x", "2.6x" (2.625), "1.25x". */
export function formatScale(scale: number): string {
  const hundredths = Math.round(scale * 100)
  if (hundredths % 100 === 0) return `${hundredths / 100}x`
  if (Number.isInteger(scale * 100) && hundredths % 10 !== 0) return `${(hundredths / 100).toFixed(2)}x`
  return `${(Math.round(scale * 10) / 10).toFixed(1).replace(/\.0$/, '')}x`
}

/** "Android 14", "iOS 17.5", "Windows 10/11", "macOS". */
export function osDisplay(preset: DevicePresetInfo): string {
  const version = preset.osVersion ?? null
  return version ? `${DEVICE_OS_LABELS[presetOs(preset)]} ${version}` : DEVICE_OS_LABELS[presetOs(preset)]
}

export function viewportLabel(preset: Pick<DevicePresetInfo, 'viewportWidth' | 'viewportHeight'>): string {
  return `${preset.viewportWidth}×${preset.viewportHeight}`
}

/** Muted line under the trigger: "Android 14 · 412×915 @2.6x" (+ " · Landscape"). */
export function presetSubline(preset: DevicePresetInfo): string {
  const parts = [osDisplay(preset), `${viewportLabel(preset)} @${formatScale(presetScale(preset))}`]
  if (isLandscapeVariant(preset)) parts.push('Landscape')
  return parts.join(' · ')
}

export type DeviceIconKind = 'phone' | 'tablet' | 'laptop' | 'monitor'

/** Phone / tablet by type; desktops are laptops for macOS, ChromeOS and laptop-sized Windows/Linux screens. */
export function deviceIconKind(preset: DevicePresetInfo): DeviceIconKind {
  if (preset.deviceType === 'mobile') return 'phone'
  if (preset.deviceType === 'tablet') return 'tablet'
  const os = presetOs(preset)
  if (os === 'macos' || os === 'chromeos') return 'laptop'
  return preset.viewportWidth <= 1536 ? 'laptop' : 'monitor'
}

/** Results are grouped by brand; desktops (all "Generic") by operating system instead. */
export function groupKeyOf(preset: DevicePresetInfo): string {
  return preset.deviceType === 'desktop' ? DEVICE_OS_LABELS[presetOs(preset)] : presetBrand(preset)
}

// ---------------------------------------------------------------------------
// Engine compatibility
// ---------------------------------------------------------------------------

/** "Brave", "Firefox", "WebKit", "Chromium" — the engine label without its qualifier. */
export function engineShortName(engine: BrowserEngine): string {
  return BROWSER_ENGINE_LABELS[engine].replace(/\s*\([^)]*\)\s*$/, '').split(' / ')[0]?.trim() ?? engine
}

/** Why the engine cannot emulate the preset (tooltip on disabled cards), or null when it can. */
export function incompatibilityReason(preset: DevicePresetInfo, engine: BrowserEngine | null | undefined): string | null {
  if (!engine || preset.supportedEngines.includes(engine)) return null
  const name = engineShortName(engine)
  if (preset.deviceType !== 'desktop' && BROWSER_ENGINE_FAMILY[engine] === 'firefox') return `${name} can't emulate mobile devices`
  const supported = preset.supportedEngines
  if (supported.length === 1 && supported[0]) return `${engineShortName(supported[0])} only — ${name} can't emulate this preset`
  if (supported.every((e) => BROWSER_ENGINE_FAMILY[e] === 'chromium')) return `Chromium-based browsers only — ${name} can't emulate this preset`
  return `${name} can't emulate this preset`
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Lower case, "×" as "x", punctuation as spaces. */
export function normaliseSearch(text: string): string {
  return text
    .toLowerCase()
    .replace(/×/g, 'x')
    .replace(/[^a-z0-9.+"]+/g, ' ')
    .trim()
}

/** "android", "ios 17", "android 14.1" — an OS name with an optional (short) version, not "linux 1920". */
const OS_QUERY = /^(ios|ipados|android|windows|macos|linux|chromeos)(?:\s+(\d{1,2}(?:\.\d+)*))?$/

const TYPE_WORDS: Record<DeviceType, string> = { mobile: 'phone mobile', tablet: 'tablet', desktop: 'desktop computer' }

/**
 * How well a preset matches the search text (lower is better), or null when it does not match:
 * 0 exact model / name, 1 model or name prefix (and OS-version queries such as "ios 17"),
 * 2 substring of model or name, 3 every word starts a token of brand/model/OS/viewport/type
 * (token prefixes, so "pixel 9" does not match the "…x921" viewport of a Pixel 8 Pro).
 */
export function searchScore(preset: DevicePresetInfo, rawQuery: string): number | null {
  const query = normaliseSearch(rawQuery)
  if (query === '') return 0
  const os = presetOs(preset)
  const osQuery = OS_QUERY.exec(query)
  if (osQuery) {
    // "android 14", "ios 17": an OS (and version prefix) filter, not a word soup that would also hit "iPhone 17".
    if (osQuery[1] !== os) return null
    const version = osQuery[2]
    if (!version) return 1
    return preset.osVersion && (preset.osVersion === version || preset.osVersion.startsWith(`${version}.`) || preset.osVersion.startsWith(`${version}/`)) ? 1 : null
  }
  const model = normaliseSearch(presetModel(preset))
  const name = normaliseSearch(presetDisplayName(preset))
  if (model === query || name === query) return 0
  if (model.startsWith(query) || name.startsWith(query)) return 1
  if (model.includes(query) || name.includes(query)) return 2
  const haystack = normaliseSearch(
    [
      name,
      DEVICE_OS_LABELS[os],
      osDisplay(preset),
      `${preset.viewportWidth}x${preset.viewportHeight}`,
      TYPE_WORDS[preset.deviceType],
      isLandscapeVariant(preset) ? 'landscape' : 'portrait',
      preset.legacy ? 'legacy' : '',
      preset.id,
    ].join(' '),
  )
  const tokens = haystack.split(' ')
  return query.split(' ').every((word) => tokens.some((token) => token.startsWith(word))) ? 3 : null
}

// ---------------------------------------------------------------------------
// Filtering, facets, sorting, grouping
// ---------------------------------------------------------------------------

export interface PickerContext {
  /** The selected browser engine (compatibility filter); null = no engine constraint. */
  engine: BrowserEngine | null
  /** Most recent first. */
  recent: readonly DevicePresetId[]
  favorites: readonly DevicePresetId[]
}

export interface PickerItem {
  preset: DevicePresetInfo
  /** Search rank (0 when there is no query). */
  score: number
  compatible: boolean
  /** Tooltip for an incompatible preset. */
  reason: string | null
}

type Facet = 'type' | 'brand' | 'os' | 'orientation'

/** The presets a section starts from (Recent and Favorites keep their stored order). */
export function sectionMembers(presets: readonly DevicePresetInfo[], section: PickerSection, ctx: PickerContext): DevicePresetInfo[] {
  if (section === 'all') return [...presets]
  if (section === 'popular') return presets.filter((p) => p.popular === true)
  const byId = new Map(presets.map((p) => [p.id, p]))
  const ids = section === 'recent' ? ctx.recent : ctx.favorites
  return ids.map((id) => byId.get(id)).filter((p): p is DevicePresetInfo => p !== undefined)
}

/** Explicit picks (Recent, Favorites) are shown whatever their orientation or age. */
function sectionIgnoresShapeFilters(section: PickerSection): boolean {
  return section === 'recent' || section === 'favorites'
}

function evaluate(preset: DevicePresetInfo, filters: PickerFilters, ctx: PickerContext, skip: Facet | null): PickerItem | null {
  if (skip !== 'type' && filters.type !== 'all' && preset.deviceType !== filters.type) return null
  if (skip !== 'brand' && filters.brands.length > 0 && !filters.brands.includes(presetBrand(preset))) return null
  if (skip !== 'os' && filters.os.length > 0 && !filters.os.includes(presetOs(preset))) return null
  const shapeFiltersApply = !sectionIgnoresShapeFilters(filters.section)
  if (shapeFiltersApply && skip !== 'orientation' && filters.orientation !== 'both' && preset.deviceType !== 'desktop' && presetOrientation(preset) !== filters.orientation) return null
  if (shapeFiltersApply && !filters.showLegacy && preset.legacy === true) return null
  const reason = incompatibilityReason(preset, ctx.engine)
  if (filters.compatibleOnly && reason !== null) return null
  const score = searchScore(preset, filters.query)
  if (score === null) return null
  return { preset, score, compatible: reason === null, reason }
}

const COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

function byName(a: DevicePresetInfo, b: DevicePresetInfo): number {
  return COLLATOR.compare(a.label, b.label)
}

function byNewest(a: DevicePresetInfo, b: DevicePresetInfo): number {
  const ya = a.releaseYear ?? null
  const yb = b.releaseYear ?? null
  if (ya !== yb) {
    if (ya === null) return 1
    if (yb === null) return -1
    return yb - ya
  }
  return byName(a, b)
}

function area(preset: DevicePresetInfo): number {
  return preset.viewportWidth * preset.viewportHeight
}

/** Comparator for a sort order (stable ties fall back to the natural label order). */
export function compareBySort(sort: PickerSort): (a: DevicePresetInfo, b: DevicePresetInfo) => number {
  switch (sort) {
    case 'popular':
      return (a, b) => Number(b.popular === true) - Number(a.popular === true) || byNewest(a, b)
    case 'newest':
      return byNewest
    case 'name':
      return byName
    case 'screen':
      return (a, b) => area(a) - area(b) || byName(a, b)
  }
}

/** Order results: best search match first, then the chosen sort. Recent keeps recency order. */
export function sortItems(items: readonly PickerItem[], sort: PickerSort, section: PickerSection = 'all'): PickerItem[] {
  if (section === 'recent') return [...items].sort((a, b) => a.score - b.score)
  const compare = compareBySort(sort)
  return [...items].sort((a, b) => a.score - b.score || compare(a.preset, b.preset))
}

export interface PickerResult {
  /** Visible items, sorted. */
  items: PickerItem[]
  /** Presets in the current section before any filter. */
  sectionTotal: number
  /** Presets of the section the filters hide. */
  hidden: number
}

/** Filter + sort the presets of the current section. */
export function filterDevices(presets: readonly DevicePresetInfo[], filters: PickerFilters, ctx: PickerContext): PickerResult {
  const members = sectionMembers(presets, filters.section, ctx)
  const items: PickerItem[] = []
  for (const preset of members) {
    const item = evaluate(preset, filters, ctx, null)
    if (item) items.push(item)
  }
  return { items: sortItems(items, filters.sort, filters.section), sectionTotal: members.length, hidden: members.length - items.length }
}

export interface FacetCount<V extends string> {
  value: V
  count: number
}

export interface FacetCounts {
  type: Record<PickerTypeFilter, number>
  /** Brands present under the other filters (plus any selected brand), in `DEVICE_BRANDS` order. */
  brands: FacetCount<DeviceBrand>[]
  os: FacetCount<DeviceOs>[]
  sections: Record<PickerSection, number>
}

/**
 * Counts per facet value, each computed with every *other* filter applied (classic faceting):
 * choosing "Samsung" updates the OS counts, while the brand chips keep showing what each brand would add.
 */
export function facetCounts(presets: readonly DevicePresetInfo[], filters: PickerFilters, ctx: PickerContext): FacetCounts {
  const members = sectionMembers(presets, filters.section, ctx)
  const type: Record<PickerTypeFilter, number> = { all: 0, mobile: 0, tablet: 0, desktop: 0 }
  const brandCounts = new Map<DeviceBrand, number>()
  const osCounts = new Map<DeviceOs, number>()
  for (const preset of members) {
    if (evaluate(preset, filters, ctx, 'type')) {
      type.all += 1
      type[preset.deviceType] += 1
    }
    if (evaluate(preset, filters, ctx, 'brand')) brandCounts.set(presetBrand(preset), (brandCounts.get(presetBrand(preset)) ?? 0) + 1)
    if (evaluate(preset, filters, ctx, 'os')) osCounts.set(presetOs(preset), (osCounts.get(presetOs(preset)) ?? 0) + 1)
  }
  const sections = {} as Record<PickerSection, number>
  for (const section of PICKER_SECTIONS) {
    const scoped = { ...filters, section }
    sections[section] = sectionMembers(presets, section, ctx).filter((preset) => evaluate(preset, scoped, ctx, null) !== null).length
  }
  return {
    type,
    brands: DEVICE_BRANDS.filter((brand) => (brandCounts.get(brand) ?? 0) > 0 || filters.brands.includes(brand)).map((brand) => ({ value: brand, count: brandCounts.get(brand) ?? 0 })),
    os: DEVICE_OS.filter((os) => (osCounts.get(os) ?? 0) > 0 || filters.os.includes(os)).map((os) => ({ value: os, count: osCounts.get(os) ?? 0 })),
    sections,
  }
}

export interface PickerGroup {
  key: string
  label: string
  items: PickerItem[]
}

/** Group sorted items by brand (desktops by OS) in first-appearance order; `grouped: false` returns one group. */
export function groupItems(items: readonly PickerItem[], grouped = true, singleLabel = 'Results'): PickerGroup[] {
  if (!grouped) return items.length > 0 ? [{ key: 'all', label: singleLabel, items: [...items] }] : []
  const groups = new Map<string, PickerGroup>()
  for (const item of items) {
    const key = groupKeyOf(item.preset)
    const group = groups.get(key)
    if (group) group.items.push(item)
    else groups.set(key, { key, label: key, items: [item] })
  }
  return [...groups.values()]
}

// ---------------------------------------------------------------------------
// Random picks
// ---------------------------------------------------------------------------

export type Rng = () => number

function pickOne<T>(items: readonly T[], rng: Rng): T | null {
  if (items.length === 0) return null
  return items[Math.min(items.length - 1, Math.max(0, Math.floor(rng() * items.length)))] ?? null
}

/** "Random device": a compatible preset among the ones the current filters show. */
export function randomFromFilters(presets: readonly DevicePresetInfo[], filters: PickerFilters, ctx: PickerContext, rng: Rng = Math.random): DevicePresetInfo | null {
  return pickOne(
    filterDevices(presets, filters, ctx).items.filter((item) => item.compatible),
    rng,
  )?.preset ?? null
}

/** "Random popular": a popular, current preset the engine can emulate (ignores the other filters). */
export function randomPopular(presets: readonly DevicePresetInfo[], ctx: PickerContext, rng: Rng = Math.random): DevicePresetInfo | null {
  return pickOne(
    presets.filter((p) => p.popular === true && p.legacy !== true && incompatibilityReason(p, ctx.engine) === null),
    rng,
  )
}

// ---------------------------------------------------------------------------
// Recent / Favorites persistence
// ---------------------------------------------------------------------------

export const RECENT_DEVICES_KEY = 'proxy-qa.devicePicker.recent'
export const FAVORITE_DEVICES_KEY = 'proxy-qa.devicePicker.favorites'
export const RECENT_LIMIT = 8
const STORED_LIMIT = 200

/** Most recent first, without duplicates, capped. */
export function pushRecent(recent: readonly DevicePresetId[], id: DevicePresetId, limit: number = RECENT_LIMIT): DevicePresetId[] {
  return [id, ...recent.filter((entry) => entry !== id)].slice(0, limit)
}

export function toggleFavorite(favorites: readonly DevicePresetId[], id: DevicePresetId): DevicePresetId[] {
  return toggleValue(favorites, id)
}

/** Ids from a stored JSON array; anything malformed is dropped (never throws). */
export function parseStoredIds(raw: string | null | undefined, limit: number = STORED_LIMIT): DevicePresetId[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: DevicePresetId[] = []
  for (const value of parsed) {
    if (typeof value !== 'string') continue
    const id = value.trim()
    if (id.length === 0 || id.length > 80 || out.includes(id)) continue
    out.push(id)
    if (out.length >= limit) break
  }
  return out
}

/** The slice of the Web Storage API the picker needs (injectable in tests). */
export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** `window.localStorage` when it exists and is usable, else null. */
export function browserStorage(): KeyValueStorage | null {
  try {
    const storage = (globalThis as { localStorage?: KeyValueStorage }).localStorage
    return storage ?? null
  } catch {
    return null
  }
}

export function readStoredIds(storage: KeyValueStorage | null, key: string): DevicePresetId[] {
  if (!storage) return []
  try {
    return parseStoredIds(storage.getItem(key))
  } catch {
    return []
  }
}

/** Persist best-effort: a full or blocked storage must never break picking a device. */
export function writeStoredIds(storage: KeyValueStorage | null, key: string, ids: readonly DevicePresetId[]): boolean {
  if (!storage) return false
  try {
    storage.setItem(key, JSON.stringify(ids.slice(0, STORED_LIMIT)))
    return true
  } catch {
    return false
  }
}

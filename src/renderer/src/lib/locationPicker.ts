/**
 * Pure helpers behind the location picker (unit-tested in tests/renderer-location-picker.test.ts):
 * two-line row text, query highlighting, the empty-state quick picks, the capped-results footer
 * and the Recent locations list persisted in localStorage.
 */
import type { GeoTarget, LocationEntry, LocationStats, TargetMode } from '@shared/types'
import type { KeyValueStorage } from './devicePicker'

export type PickerMode = Exclude<TargetMode, 'country'>

// ---------------------------------------------------------------------------
// Row text
// ---------------------------------------------------------------------------

export function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

function plural(count: number, one: string, many: string): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`
}

/** Main line of a result row: "New Jersey", "Newark", "07102". */
export function entryPrimary(entry: LocationEntry): string {
  switch (entry.kind) {
    case 'state':
      return entry.state
    case 'city':
      return entry.city ?? entry.label
    case 'zip':
      return entry.zip ?? entry.label
    case 'country':
      return entry.label
  }
}

/** Muted second line: "NJ · 593 cities · 597 ZIPs", "New Jersey · NJ · 12 ZIPs", "Newark, New Jersey". */
export function entrySecondary(entry: LocationEntry): string {
  switch (entry.kind) {
    case 'state': {
      const parts = [entry.stateCode]
      if (entry.cityCount !== undefined) parts.push(plural(entry.cityCount, 'city', 'cities'))
      if (entry.zipCount !== undefined) parts.push(plural(entry.zipCount, 'ZIP', 'ZIPs'))
      return parts.join(' · ')
    }
    case 'city': {
      const parts = [entry.state, entry.stateCode].filter((part) => part.trim() !== '')
      if (entry.zipCount !== undefined) parts.push(plural(entry.zipCount, 'ZIP', 'ZIPs'))
      return parts.join(' · ')
    }
    case 'zip':
      return [entry.city, entry.state].filter((part): part is string => !!part && part.trim() !== '').join(', ')
    case 'country':
      return 'Whole country'
  }
}

/** Compact value shown in the field once picked: "New Jersey", "Newark, NJ", "07102 · Newark, NJ". */
export function targetChipLabel(target: GeoTarget | null | undefined): string {
  if (!target) return ''
  switch (target.mode) {
    case 'state':
      return target.state ?? target.stateCode ?? ''
    case 'city':
      return [target.city, target.stateCode ?? target.state].filter((part): part is string => !!part).join(', ')
    case 'zip': {
      const place = [target.city, target.stateCode ?? target.state].filter((part): part is string => !!part).join(', ')
      return place ? `${target.zip ?? ''} · ${place}` : (target.zip ?? '')
    }
    case 'country':
      return target.country.toUpperCase()
  }
}

// ---------------------------------------------------------------------------
// Highlighting
// ---------------------------------------------------------------------------

export interface HighlightSegment {
  text: string
  match: boolean
}

/** One folded (lower-case, accent-free) character per input character, so indexes line up with the original. */
function fold(text: string): string {
  let out = ''
  for (const char of text) {
    const folded = char.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    out += folded.length === 1 ? folded : char.length === 1 ? char.toLowerCase() : ' '
  }
  return out
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const out: Array<[number, number]> = []
  for (const range of sorted) {
    const last = out[out.length - 1]
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else out.push([range[0], range[1]])
  }
  return out
}

/**
 * Split `text` into matched / unmatched segments for the query: the whole query when it occurs
 * (case- and accent-insensitive), otherwise the first occurrence of each word ("newark nj").
 */
export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const haystack = fold(text)
  const needle = fold(query).replace(/[^a-z0-9]+/g, ' ').trim()
  if (needle === '' || [...text].length !== text.length) return [{ text, match: false }]
  const ranges: Array<[number, number]> = []
  const whole = haystack.replace(/[^a-z0-9]/g, ' ').indexOf(needle)
  if (whole >= 0) ranges.push([whole, whole + needle.length])
  else {
    for (const word of needle.split(' ')) {
      const at = haystack.indexOf(word)
      if (at >= 0) ranges.push([at, at + word.length])
    }
  }
  if (ranges.length === 0) return [{ text, match: false }]
  const segments: HighlightSegment[] = []
  let cursor = 0
  for (const [start, end] of mergeRanges(ranges)) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false })
    segments.push({ text: text.slice(start, end), match: true })
    cursor = end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false })
  return segments
}

// ---------------------------------------------------------------------------
// Empty state: popular quick picks and the dataset hint
// ---------------------------------------------------------------------------

/** Most-tested states (by population and QA demand). */
export const POPULAR_STATE_CODES = ['CA', 'TX', 'FL', 'NY', 'NJ', 'IL', 'PA', 'OH', 'GA', 'NC'] as const

/** The ten largest US cities. */
export const POPULAR_CITIES: ReadonlyArray<{ city: string; stateCode: string }> = [
  { city: 'New York', stateCode: 'NY' },
  { city: 'Los Angeles', stateCode: 'CA' },
  { city: 'Chicago', stateCode: 'IL' },
  { city: 'Houston', stateCode: 'TX' },
  { city: 'Phoenix', stateCode: 'AZ' },
  { city: 'Philadelphia', stateCode: 'PA' },
  { city: 'San Antonio', stateCode: 'TX' },
  { city: 'San Diego', stateCode: 'CA' },
  { city: 'Dallas', stateCode: 'TX' },
  { city: 'Austin', stateCode: 'TX' },
]

/** Quick picks for an empty query: popular states (State mode) or cities (City mode); ZIP mode has none. */
export function popularEntries(mode: PickerMode, states: readonly LocationEntry[], stateFilter: string | null = null): LocationEntry[] {
  const byCode = new Map(states.map((state) => [state.stateCode, state]))
  if (mode === 'state') return POPULAR_STATE_CODES.map((code) => byCode.get(code)).filter((entry): entry is LocationEntry => entry !== undefined)
  if (mode === 'zip') return []
  return POPULAR_CITIES.filter((pick) => stateFilter === null || pick.stateCode === stateFilter).flatMap((pick) => {
    const state = byCode.get(pick.stateCode)
    if (!state) return []
    const entry: LocationEntry = {
      kind: 'city',
      label: `${pick.city}, ${pick.stateCode}`,
      country: state.country,
      state: state.state,
      stateCode: state.stateCode,
      city: pick.city,
      zip: null,
      timezone: state.timezone,
    }
    return [entry]
  })
}

/** "Type to search 51 states · 29,540 cities · 40,977 ZIPs". */
export function datasetHint(stats: LocationStats | null): string {
  if (!stats) return 'Type to search US states, cities and ZIP codes'
  return `Type to search ${plural(stats.states, 'state', 'states')} · ${plural(stats.cities, 'city', 'cities')} · ${plural(stats.zips, 'ZIP', 'ZIPs')}`
}

/** "50 of 2,341 · keep typing" when the page is capped; null when everything is shown. */
export function cappedFooter(shown: number, total: number): string | null {
  return total > shown ? `${formatCount(shown)} of ${formatCount(total)} · keep typing` : null
}

// ---------------------------------------------------------------------------
// Recent locations
// ---------------------------------------------------------------------------

export const RECENT_LOCATIONS_KEY = 'proxy-qa.locationPicker.recent'
export const RECENT_LOCATIONS_LIMIT = 12

export function locationKey(entry: Pick<LocationEntry, 'kind' | 'country' | 'stateCode' | 'city' | 'zip'>): string {
  return [entry.kind, entry.country, entry.stateCode, entry.city ?? '', entry.zip ?? ''].join('|')
}

export function targetKey(target: GeoTarget | null | undefined): string | null {
  if (!target) return null
  return [target.mode, target.country, target.stateCode ?? '', target.city ?? '', target.zip ?? ''].join('|')
}

/** Most recent first, deduplicated, capped. */
export function pushRecentLocation(recent: readonly LocationEntry[], entry: LocationEntry, limit: number = RECENT_LOCATIONS_LIMIT): LocationEntry[] {
  const key = locationKey(entry)
  return [entry, ...recent.filter((item) => locationKey(item) !== key)].slice(0, limit)
}

/** Recent entries for one mode (and state filter). */
export function recentForMode(recent: readonly LocationEntry[], mode: PickerMode, stateFilter: string | null = null): LocationEntry[] {
  return recent.filter((entry) => entry.kind === mode && (stateFilter === null || entry.stateCode === stateFilter))
}

const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
const isNullableText = (value: unknown, max: number): value is string | null => value === null || isText(value, max)

/** Stored recent entries; malformed rows are dropped (never throws). */
export function parseStoredLocations(raw: string | null | undefined, limit: number = RECENT_LOCATIONS_LIMIT): LocationEntry[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: LocationEntry[] = []
  for (const row of parsed) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    if (r.kind !== 'state' && r.kind !== 'city' && r.kind !== 'zip') continue
    if (!isText(r.label, 120) || !isText(r.country, 2) || !isText(r.state, 64) || !isText(r.stateCode, 2)) continue
    if (!isNullableText(r.city, 80) || !isNullableText(r.zip, 5) || !isNullableText(r.timezone, 64)) continue
    if (r.kind === 'zip' && !/^\d{5}$/.test(r.zip ?? '')) continue
    const entry: LocationEntry = { kind: r.kind, label: r.label, country: r.country, state: r.state, stateCode: r.stateCode, city: r.city, zip: r.zip, timezone: r.timezone }
    if (typeof r.cityCount === 'number') entry.cityCount = r.cityCount
    if (typeof r.zipCount === 'number') entry.zipCount = r.zipCount
    if (out.some((item) => locationKey(item) === locationKey(entry))) continue
    out.push(entry)
    if (out.length >= limit) break
  }
  return out
}

export function readStoredLocations(storage: KeyValueStorage | null): LocationEntry[] {
  if (!storage) return []
  try {
    return parseStoredLocations(storage.getItem(RECENT_LOCATIONS_KEY))
  } catch {
    return []
  }
}

export function writeStoredLocations(storage: KeyValueStorage | null, recent: readonly LocationEntry[]): boolean {
  if (!storage) return false
  try {
    storage.setItem(RECENT_LOCATIONS_KEY, JSON.stringify(recent.slice(0, RECENT_LOCATIONS_LIMIT)))
    return true
  } catch {
    return false
  }
}

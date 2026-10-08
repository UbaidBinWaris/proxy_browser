/**
 * Locations service: type-to-search over the bundled GeoNames US postal dataset
 * (states, cities, ZIP codes), random targets and the state → time zone map.
 *
 * The dataset (~41k rows) is parsed lazily on first use and indexed once:
 *   - states: the 50 states + DC (territories such as the Marshall Islands and
 *     the APO/FPO military rows are dropped);
 *   - cities: unique (place name, state) pairs, alphabetical;
 *   - zips:   unique 5-digit codes with their place, ascending.
 *
 * DataImpulse publishes the states it accepts (resources/geonames/dataimpulse-states.csv,
 * 50 entries — DC is not on it). `states()`/`search()` still offer DC because it
 * is a real location a tester may want; `random()` only ever picks from the
 * official list so a random target is always accepted by the gateway.
 *
 * Search is case- and diacritic-insensitive: prefix matches first, then
 * substring matches, each group alphabetical, so "new j" puts New Jersey first;
 * city prefix matches are ranked by size instead (exact name first), so "new" leads with New York.
 * "newark nj" / "newark, nj" narrows a city or ZIP search to one state, and so
 * does the explicit `stateCode` filter (the picker's "in: <state>" chip).
 *
 * State entries carry how many cities and ZIP codes they hold, city entries how
 * many ZIP codes (counted once while indexing) for the picker's secondary line.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { GeoTarget, LocationEntry, LocationQueryResult, LocationSearch, LocationStats, TargetMode } from '@shared/types'
import { LocationSearchSchema } from '@shared/types'

import { AppException } from '../contracts'
import type { LocationsService, Logger } from '../contracts'
import { encodeStateName } from '../proxy/targeting-text'
import { DATAIMPULSE_STATES_FILE, US_DATASET_FILE, parseDataImpulseStates, parseGeoNamesUs } from './geonames-loader'
import type { GeoNamesRow } from './geonames-loader'
import { US_STATE_TIMEZONES, timezoneForStateCode } from './us-state-timezones'

const SCOPE = 'locations'
export const US_COUNTRY = 'us'
export const US_COUNTRY_LABEL = 'United States (US)'

export interface LocationsServiceOptions {
  /** Directory holding US.txt and dataimpulse-states.csv. */
  dataDir: string
  logger: Logger
  /** File reader (tests may inject one); defaults to the real filesystem. */
  readFile?: (path: string) => string
  /** Random source in [0, 1); defaults to Math.random. */
  random?: () => number
}

interface StateRecord {
  entry: LocationEntry
  /** Normalised search key, e.g. "new jersey". */
  key: string
  /** DataImpulse encoding, e.g. "newjersey". */
  encoded: string
  /** On DataImpulse's official state list. */
  official: boolean
}

interface CityRecord {
  entry: LocationEntry
  key: string
  stateCode: string
}

interface ZipRecord {
  entry: LocationEntry
  zip: string
  /** Normalised place name, e.g. "newark". */
  key: string
  stateCode: string
}

interface Index {
  states: StateRecord[]
  statesByCode: Map<string, StateRecord>
  cities: CityRecord[]
  zips: ZipRecord[]
  official: Set<string>
}

/** Lower-case ASCII with punctuation removed and whitespace collapsed; the key both sides of a search are compared on. */
export function searchKey(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function stateLabel(name: string, code: string): string {
  return `${name} (${code})`
}

export function cityLabel(city: string, code: string): string {
  return `${city}, ${code}`
}

export function zipLabel(zip: string, city: string, code: string): string {
  return `${zip} — ${city}, ${code}`
}

/** The whole-country entry (DataImpulse `cr.us` only). */
export function unitedStatesEntry(): LocationEntry {
  return { kind: 'country', label: US_COUNTRY_LABEL, country: US_COUNTRY, state: '', stateCode: '', city: null, zip: null, timezone: null }
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** How many of `items` match the query key (prefix or substring) — the uncapped size of a `rankMatches` result. */
export function countMatches<T>(items: readonly T[], keyOf: (item: T) => string, query: string): number {
  if (query.length === 0) return items.length
  let count = 0
  for (const item of items) if (keyOf(item).includes(query)) count += 1
  return count
}

/**
 * Rank `items` for a query key: prefix matches first, then substring matches;
 * both groups keep the input order (callers pass alphabetically sorted lists).
 */
export function rankMatches<T>(items: readonly T[], keyOf: (item: T) => string, query: string, limit: number): T[] {
  if (query.length === 0) return items.slice(0, limit)
  const prefix: T[] = []
  const substring: T[] = []
  for (const item of items) {
    const key = keyOf(item)
    if (key.startsWith(query)) {
      prefix.push(item)
      if (prefix.length >= limit) break
    } else if (prefix.length + substring.length < limit && key.includes(query)) {
      substring.push(item)
    }
  }
  return [...prefix, ...substring].slice(0, limit)
}

/** Split "newark nj" / "newark, nj" into the place query and a state-code filter when the last token is a known code. */
export function splitStateSuffix(query: string, isState: (code: string) => boolean): { place: string; stateCode: string | null } {
  const match = /^(.*\S)\s+([a-z]{2})$/.exec(query)
  if (match && match[1] !== undefined && match[2] !== undefined && isState(match[2].toUpperCase())) {
    return { place: match[1], stateCode: match[2].toUpperCase() }
  }
  return { place: query, stateCode: null }
}

export function createLocationsService(opts: LocationsServiceOptions): LocationsService {
  const { logger } = opts
  const readFile = opts.readFile ?? ((path: string): string => readFileSync(path, 'utf8'))
  const random = opts.random ?? Math.random
  let index: Index | null = null

  const buildIndex = (): Index => {
    const startedAt = Date.now()
    const datasetPath = join(opts.dataDir, US_DATASET_FILE)
    let rows: GeoNamesRow[]
    try {
      rows = parseGeoNamesUs(readFile(datasetPath))
    } catch (err) {
      throw new AppException(
        'INTERNAL',
        'The US location dataset could not be loaded. Reinstall the application to restore resources/geonames/US.txt.',
        `${datasetPath}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    let official: Set<string>
    try {
      official = parseDataImpulseStates(readFile(join(opts.dataDir, DATAIMPULSE_STATES_FILE)))
    } catch (err) {
      logger.warn(SCOPE, 'DataImpulse state list missing; every state is treated as targetable', { error: err instanceof Error ? err.message : String(err) })
      official = new Set(Object.keys(US_STATE_TIMEZONES).map((code) => code.toLowerCase()))
    }

    const statesByCode = new Map<string, StateRecord>()
    const cityKeys = new Set<string>()
    const cities: CityRecord[] = []
    const zipSeen = new Set<string>()
    const zips: ZipRecord[] = []

    for (const row of rows) {
      // Only the 50 states + DC are targetable locations; territories and military codes are skipped.
      const timezone = timezoneForStateCode(row.stateCode)
      if (!timezone) continue
      if (!statesByCode.has(row.stateCode)) {
        const encoded = encodeStateName(row.stateName)
        statesByCode.set(row.stateCode, {
          entry: { kind: 'state', label: stateLabel(row.stateName, row.stateCode), country: US_COUNTRY, state: row.stateName, stateCode: row.stateCode, city: null, zip: null, timezone },
          key: searchKey(row.stateName),
          encoded,
          official: official.has(encoded),
        })
      }
      const cityKey = `${row.place}\u0000${row.stateCode}`
      if (!cityKeys.has(cityKey)) {
        cityKeys.add(cityKey)
        cities.push({
          entry: { kind: 'city', label: cityLabel(row.place, row.stateCode), country: US_COUNTRY, state: row.stateName, stateCode: row.stateCode, city: row.place, zip: null, timezone },
          key: searchKey(row.place),
          stateCode: row.stateCode,
        })
      }
      if (!zipSeen.has(row.zip)) {
        zipSeen.add(row.zip)
        zips.push({
          entry: { kind: 'zip', label: zipLabel(row.zip, row.place, row.stateCode), country: US_COUNTRY, state: row.stateName, stateCode: row.stateCode, city: row.place, zip: row.zip, timezone },
          zip: row.zip,
          key: searchKey(row.place),
          stateCode: row.stateCode,
        })
      }
    }

    // Counts for the picker's secondary lines ("593 cities · 597 ZIPs", "12 ZIPs").
    const citiesPerState = new Map<string, number>()
    for (const city of cities) citiesPerState.set(city.stateCode, (citiesPerState.get(city.stateCode) ?? 0) + 1)
    const zipsPerState = new Map<string, number>()
    const zipsPerCity = new Map<string, number>()
    for (const zip of zips) {
      zipsPerState.set(zip.stateCode, (zipsPerState.get(zip.stateCode) ?? 0) + 1)
      const cityKey = `${zip.entry.city ?? ''}\u0000${zip.stateCode}`
      zipsPerCity.set(cityKey, (zipsPerCity.get(cityKey) ?? 0) + 1)
    }
    for (const state of statesByCode.values()) {
      state.entry.cityCount = citiesPerState.get(state.entry.stateCode) ?? 0
      state.entry.zipCount = zipsPerState.get(state.entry.stateCode) ?? 0
    }
    for (const city of cities) city.entry.zipCount = zipsPerCity.get(`${city.entry.city ?? ''}\u0000${city.stateCode}`) ?? 0

    const states = [...statesByCode.values()].sort((a, b) => compareText(a.entry.state, b.entry.state))
    cities.sort((a, b) => compareText(a.key, b.key) || compareText(a.stateCode, b.stateCode))
    zips.sort((a, b) => compareText(a.zip, b.zip))

    const unofficial = states.filter((s) => !s.official).map((s) => s.entry.stateCode)
    logger.info(SCOPE, `US location dataset indexed: ${states.length} states, ${cities.length} cities, ${zips.length} ZIP codes`, {
      rows: rows.length,
      states: states.length,
      cities: cities.length,
      zips: zips.length,
      notOnDataImpulseList: unofficial,
      elapsedMs: Date.now() - startedAt,
    })
    return { states, statesByCode, cities, zips, official }
  }

  const getIndex = (): Index => {
    if (!index) index = buildIndex()
    return index
  }

  const pick = <T>(items: readonly T[], what: string): T => {
    if (items.length === 0) throw new AppException('NOT_FOUND', `No ${what} are available in the bundled location dataset.`)
    const position = Math.min(items.length - 1, Math.max(0, Math.floor(random() * items.length)))
    return items[position]!
  }

  const page = <T extends { entry: LocationEntry }>(items: readonly T[], keyOf: (item: T) => string, query: string, limit: number): LocationQueryResult => ({
    entries: rankMatches(items, keyOf, query, limit).map((item) => ({ ...item.entry })),
    total: countMatches(items, keyOf, query),
  })

  const searchCountry = (query: string): LocationQueryResult => {
    const entry = unitedStatesEntry()
    const hit = query.length === 0 || 'united states'.startsWith(query) || query === 'us' || query === 'usa' || 'united states of america'.includes(query)
    return hit ? { entries: [entry], total: 1 } : { entries: [], total: 0 }
  }

  const searchStates = (idx: Index, query: string, limit: number): LocationQueryResult => {
    const byCode = query.length === 2 ? idx.statesByCode.get(query.toUpperCase()) : undefined
    const ranked = rankMatches(idx.states, (s) => s.key, query, limit)
    const total = countMatches(idx.states, (s) => s.key, query)
    if (byCode && !ranked.includes(byCode)) return { entries: [byCode, ...ranked].slice(0, limit).map((s) => ({ ...s.entry })), total: total + 1 }
    return { entries: ranked.map((s) => ({ ...s.entry })), total }
  }

  /** Narrow a pool to one state: the explicit filter wins over a "newark nj" suffix. */
  const narrow = <T extends { stateCode: string }>(idx: Index, items: readonly T[], query: string, stateFilter: string | null): { pool: readonly T[]; place: string } => {
    const { place, stateCode } = splitStateSuffix(query, (code) => idx.statesByCode.has(code))
    if (stateFilter) {
      // "newark nj" with the NJ chip set is still "newark"; a different suffix stays part of the text.
      const text = stateCode === stateFilter ? place : query
      return { pool: items.filter((item) => item.stateCode === stateFilter), place: text }
    }
    return stateCode ? { pool: items.filter((item) => item.stateCode === stateCode), place } : { pool: items, place: query }
  }

  /**
   * Cities: exact name matches first, then the other prefix matches, each by size (ZIP count, so
   * "new" leads with New York and "philadelphia" with Philadelphia, PA), then substring matches
   * alphabetically.
   */
  const searchCities = (idx: Index, query: string, limit: number, stateFilter: string | null): LocationQueryResult => {
    const { pool, place } = narrow(idx, idx.cities, query, stateFilter)
    if (place.length === 0) return page(pool, (c) => c.key, place, limit)
    const prefix: CityRecord[] = []
    const substring: CityRecord[] = []
    for (const city of pool) {
      if (city.key.startsWith(place)) prefix.push(city)
      else if (city.key.includes(place)) substring.push(city)
    }
    const size = (c: CityRecord): number => c.entry.zipCount ?? 0
    prefix.sort((x, y) => Number(y.key === place) - Number(x.key === place) || size(y) - size(x) || compareText(x.key, y.key) || compareText(x.stateCode, y.stateCode))
    return { entries: [...prefix, ...substring].slice(0, limit).map((c) => ({ ...c.entry })), total: prefix.length + substring.length }
  }

  const searchZips = (idx: Index, query: string, limit: number, stateFilter: string | null): LocationQueryResult => {
    if (/^\d+$/.test(query)) {
      const pool = stateFilter ? idx.zips.filter((z) => z.stateCode === stateFilter) : idx.zips
      return page(pool, (z) => z.zip, query, limit)
    }
    const { pool, place } = narrow(idx, idx.zips, query, stateFilter)
    return page(pool, (z) => z.key, place, limit)
  }

  const query = (rawInput: LocationSearch): LocationQueryResult => {
    const parsed = LocationSearchSchema.safeParse(rawInput)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new AppException('INVALID_INPUT', `Invalid location search: ${issue ? `${issue.path.join('.') || 'input'}: ${issue.message}` : 'bad input'}`)
    }
    const { mode, limit } = parsed.data
    const text = searchKey(parsed.data.query)
    if (mode === 'country') return searchCountry(text)
    const idx = getIndex()
    const stateFilter = parsed.data.stateCode && idx.statesByCode.has(parsed.data.stateCode) ? parsed.data.stateCode : null
    if (parsed.data.stateCode && !stateFilter) throw new AppException('INVALID_INPUT', `Unknown US state code "${parsed.data.stateCode}".`)
    switch (mode) {
      case 'state':
        return searchStates(idx, text, limit)
      case 'city':
        return searchCities(idx, text, limit, stateFilter)
      case 'zip':
        return searchZips(idx, text, limit, stateFilter)
    }
  }

  /**
   * A random entry DataImpulse accepts. With `stateCode`, cities and ZIP codes come from that state
   * (and a state draw returns it); a state that is not on DataImpulse's list is refused.
   */
  const randomEntry = (mode: TargetMode, rawStateCode?: string | null): LocationEntry => {
    if (mode === 'country') return unitedStatesEntry()
    const idx = getIndex()
    const targetable = (code: string): boolean => idx.statesByCode.get(code)?.official === true
    const stateCode = rawStateCode ? rawStateCode.trim().toUpperCase() : null
    if (stateCode !== null) {
      const state = idx.statesByCode.get(stateCode)
      if (!state) throw new AppException('INVALID_INPUT', `Unknown US state code "${stateCode.slice(0, 8)}".`)
      if (!state.official) throw new AppException('INVALID_INPUT', `${state.entry.state} is not on DataImpulse's list of targetable states.`)
    }
    const inState = (code: string): boolean => (stateCode === null ? targetable(code) : code === stateCode)
    switch (mode) {
      case 'state':
        return { ...pick(idx.states.filter((s) => s.official && inState(s.entry.stateCode)), 'states').entry }
      case 'city':
        return { ...pick(idx.cities.filter((c) => inState(c.stateCode)), 'cities').entry }
      case 'zip':
        return { ...pick(idx.zips.filter((z) => inState(z.stateCode)), 'ZIP codes').entry }
    }
  }

  const stats = (): LocationStats => {
    const idx = getIndex()
    return { states: idx.states.length, cities: idx.cities.length, zips: idx.zips.length }
  }

  return {
    search: (input: LocationSearch) => query(input).entries,
    query,
    stats,
    random: randomEntry,
    states: () => getIndex().states.map((s) => ({ ...s.entry })),
    timezoneForState: (stateCode: string) => timezoneForStateCode(stateCode),
    toTarget: (entry: LocationEntry): GeoTarget => ({
      mode: entry.kind,
      country: (entry.country || US_COUNTRY).toLowerCase(),
      state: entry.kind === 'country' ? null : entry.state || null,
      stateCode: entry.kind === 'country' ? null : entry.stateCode ? entry.stateCode.toUpperCase() : null,
      city: entry.kind === 'city' || entry.kind === 'zip' ? entry.city : null,
      zip: entry.kind === 'zip' ? entry.zip : null,
    }),
  }
}

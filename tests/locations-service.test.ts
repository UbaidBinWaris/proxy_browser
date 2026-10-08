/**
 * Locations service against the real bundled dataset (resources/geonames).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import type { LocationEntry, LogEntry } from '../src/shared/types'
import type { LocationsService, Logger } from '../src/main/contracts'
import { DATAIMPULSE_STATES_FILE, parseDataImpulseStates, parseGeoNamesUs, resolveGeoNamesDir } from '../src/main/locations/geonames-loader'
import { createLocationsService, rankMatches, searchKey, splitStateSuffix, unitedStatesEntry } from '../src/main/locations/locations-service'
import { US_STATE_CODES, US_STATE_TIMEZONES, timezoneForStateCode } from '../src/main/locations/us-state-timezones'
import { encodeStateName } from '../src/main/proxy/providers/dataimpulse'

const DATA_DIR = join(process.cwd(), 'resources', 'geonames')

function fakeLogger(entries: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = []): Logger {
  return {
    info: (_s, message, meta) => void entries.push({ level: 'INFO', message, meta }),
    warn: (_s, message, meta) => void entries.push({ level: 'WARN', message, meta }),
    error: (_s, message, meta) => void entries.push({ level: 'ERROR', message, meta }),
    log: (level, _s, message, meta) => void entries.push({ level, message, meta }),
    onEntry: () => () => undefined,
    query: (): LogEntry[] => [],
    clear: () => undefined,
    registerSecret: () => undefined,
  }
}

function isValidTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

describe('geonames loader', () => {
  it('parses US.txt rows and drops military (no state) rows', () => {
    const rows = parseGeoNamesUs(readFileSync(join(DATA_DIR, 'US.txt'), 'utf8'))
    expect(rows.length).toBeGreaterThan(40_000)
    expect(rows.every((r) => /^\d{5}$/.test(r.zip) && r.stateCode.length === 2 && r.place.length > 0)).toBe(true)
    expect(rows.find((r) => r.zip === '07102')).toEqual({ zip: '07102', place: 'Newark', stateName: 'New Jersey', stateCode: 'NJ' })
    expect(parseGeoNamesUs('US\t09001\tAPO AA\t\t\t\t\t\t\t38.1\t15.6\t\nUS\t99553\tAkutan\tAlaska\tAK\tAleutians East\t013\t\t\t54.1\t-165.7\t1\n')).toEqual([
      { zip: '99553', place: 'Akutan', stateName: 'Alaska', stateCode: 'AK' },
    ])
  })

  it('parses the DataImpulse state list', () => {
    expect(parseDataImpulseStates('state.alabama\n# comment\n\nstate.New Jersey\n')).toEqual(new Set(['alabama', 'new jersey']))
    const official = parseDataImpulseStates(readFileSync(join(DATA_DIR, DATAIMPULSE_STATES_FILE), 'utf8'))
    expect(official.size).toBe(50)
  })

  it('resolves the dataset directory for development and packaged layouts', () => {
    expect(resolveGeoNamesDir({ isPackaged: false, resourcesPath: '/nowhere/resources', appPath: process.cwd() })).toBe(DATA_DIR)
    // A packaged build without the extra resource falls back to the app path (and vice versa).
    expect(resolveGeoNamesDir({ isPackaged: true, resourcesPath: '/nowhere/resources', appPath: process.cwd() })).toBe(DATA_DIR)
    expect(resolveGeoNamesDir({ isPackaged: true, resourcesPath: '/nowhere/resources', appPath: '/nowhere/app' })).toBe('/nowhere/resources/geonames')
  })
})

describe('search helpers', () => {
  it('searchKey normalises case, diacritics, punctuation and whitespace', () => {
    expect(searchKey("  'Ewa  Beach ")).toBe('ewa beach')
    expect(searchKey('São Paulo')).toBe('sao paulo')
    expect(searchKey("O'Brien")).toBe('o brien')
    expect(searchKey('NEW JERSEY')).toBe('new jersey')
  })

  it('rankMatches puts prefix matches before substring matches and honours the limit', () => {
    const items = ['ashland', 'highland', 'lakeland', 'land o lakes', 'landis']
    expect(rankMatches(items, (s) => s, 'land', 10)).toEqual(['land o lakes', 'landis', 'ashland', 'highland', 'lakeland'])
    expect(rankMatches(items, (s) => s, 'land', 3)).toEqual(['land o lakes', 'landis', 'ashland'])
    expect(rankMatches(items, (s) => s, '', 2)).toEqual(['ashland', 'highland'])
    expect(rankMatches(items, (s) => s, 'zzz', 5)).toEqual([])
  })

  it('splitStateSuffix recognises a trailing known state code', () => {
    const isState = (code: string): boolean => code === 'NJ' || code === 'TX'
    expect(splitStateSuffix('newark nj', isState)).toEqual({ place: 'newark', stateCode: 'NJ' })
    expect(splitStateSuffix('new york', isState)).toEqual({ place: 'new york', stateCode: null })
    expect(splitStateSuffix('nj', isState)).toEqual({ place: 'nj', stateCode: null })
  })
})

describe('createLocationsService (real dataset)', () => {
  let service: LocationsService
  let entries: Array<{ level: string; message: string; meta?: Record<string, unknown> }>
  let official: Set<string>

  beforeAll(() => {
    entries = []
    service = createLocationsService({ dataDir: DATA_DIR, logger: fakeLogger(entries) })
    official = parseDataImpulseStates(readFileSync(join(DATA_DIR, DATAIMPULSE_STATES_FILE), 'utf8'))
  })

  it('indexes the dataset once, lazily, and reports what it found', () => {
    expect(entries).toHaveLength(0)
    const states = service.states()
    expect(entries.filter((e) => e.message.includes('indexed'))).toHaveLength(1)
    service.states()
    expect(entries.filter((e) => e.message.includes('indexed'))).toHaveLength(1)
    expect(entries[0]?.meta).toMatchObject({ states: 51, notOnDataImpulseList: ['DC'] })
    expect(states).toHaveLength(51)
  })

  it('lists the 50 states + DC sorted by name with "Name (CODE)" labels and time zones', () => {
    const states = service.states()
    expect(states.map((s) => s.stateCode).sort()).toEqual([...US_STATE_CODES].sort())
    expect(states.map((s) => s.state)).toEqual([...states.map((s) => s.state)].sort())
    expect(states[0]).toEqual({ kind: 'state', label: 'Alabama (AL)', country: 'us', state: 'Alabama', stateCode: 'AL', city: null, zip: null, timezone: 'America/Chicago', cityCount: expect.any(Number), zipCount: expect.any(Number) })
    expect(states.find((s) => s.stateCode === 'NJ')).toMatchObject({ label: 'New Jersey (NJ)', timezone: 'America/New_York' })
    expect(states.find((s) => s.stateCode === 'DC')).toMatchObject({ label: 'District of Columbia (DC)' })
    expect(states.some((s) => s.stateCode === 'MH')).toBe(false)
  })

  it('every state in the dataset has a valid IANA time zone; every official DataImpulse state is in the dataset', () => {
    for (const state of service.states()) {
      const zone = service.timezoneForState(state.stateCode)
      expect(zone, state.stateCode).toBe(US_STATE_TIMEZONES[state.stateCode])
      expect(zone && isValidTimezone(zone), `${state.stateCode} ${zone}`).toBe(true)
      expect(state.timezone).toBe(zone)
    }
    expect(Object.values(US_STATE_TIMEZONES).every(isValidTimezone)).toBe(true)
    const encoded = new Set(service.states().map((s) => encodeStateName(s.state)))
    for (const value of official) expect(encoded.has(value), value).toBe(true)
    expect(service.timezoneForState('nj')).toBe('America/New_York')
    expect(service.timezoneForState('AZ')).toBe('America/Phoenix')
    expect(service.timezoneForState('HI')).toBe('Pacific/Honolulu')
    expect(service.timezoneForState('AK')).toBe('America/Anchorage')
    expect(service.timezoneForState('TX')).toBe('America/Chicago')
    expect(service.timezoneForState('PR')).toBeNull()
    expect(timezoneForStateCode('xx')).toBeNull()
  })

  it('state search: "new j" → New Jersey first, codes work, prefix before substring', () => {
    const newJ = service.search({ mode: 'state', query: 'new j', limit: 50 })
    expect(newJ[0]).toMatchObject({ kind: 'state', state: 'New Jersey', stateCode: 'NJ', label: 'New Jersey (NJ)' })
    expect(service.search({ mode: 'state', query: 'new', limit: 50 }).map((s) => s.state)).toEqual(['New Hampshire', 'New Jersey', 'New Mexico', 'New York'])
    expect(service.search({ mode: 'state', query: 'NJ', limit: 50 })[0]?.stateCode).toBe('NJ')
    expect(service.search({ mode: 'state', query: 'carolina', limit: 50 }).map((s) => s.stateCode)).toEqual(['NC', 'SC'])
    expect(service.search({ mode: 'state', query: 'Dakota', limit: 1 })).toHaveLength(1)
    expect(service.search({ mode: 'state', query: '', limit: 3 }).map((s) => s.stateCode)).toEqual(['AL', 'AK', 'AZ'])
    expect(service.search({ mode: 'state', query: 'zzzz', limit: 50 })).toEqual([])
  })

  it('city search: "newark" lists Newark cities first, "newark nj" narrows to New Jersey', () => {
    const newark = service.search({ mode: 'city', query: 'newark', limit: 50 })
    expect(newark.length).toBeGreaterThan(1)
    expect(newark[0]).toMatchObject({ kind: 'city', city: 'Newark', label: expect.stringMatching(/^Newark, [A-Z]{2}$/), zip: null })
    expect(newark.every((c) => c.city?.toLowerCase().includes('newark'))).toBe(true)
    const prefixCount = newark.filter((c) => c.city?.toLowerCase().startsWith('newark')).length
    expect(newark.slice(0, prefixCount).every((c) => c.city?.toLowerCase().startsWith('newark'))).toBe(true)

    const nj = service.search({ mode: 'city', query: 'newark nj', limit: 50 })
    expect(nj).toEqual([{ kind: 'city', label: 'Newark, NJ', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: 'Newark', zip: null, timezone: 'America/New_York', zipCount: expect.any(Number) }])
    expect(service.search({ mode: 'city', query: 'Newark, NJ', limit: 50 })).toEqual(nj)
    expect(service.search({ mode: 'city', query: 'ewa beach', limit: 5 })[0]).toMatchObject({ city: 'Ewa Beach', stateCode: 'HI' })
    expect(service.search({ mode: 'city', query: 'los ang', limit: 5 })[0]).toMatchObject({ city: 'Los Angeles', stateCode: 'CA' })
  })

  it('zip search: "0710" lists ZIPs by prefix with "ZIP — City, ST" labels; names search places', () => {
    const zips = service.search({ mode: 'zip', query: '0710', limit: 50 })
    // Prefix matches first (ascending), then the substring matches fill the rest of the limit.
    const prefix = zips.filter((z) => z.zip?.startsWith('0710'))
    expect(prefix.length).toBeGreaterThan(3)
    expect(zips.slice(0, prefix.length)).toEqual(prefix)
    expect(prefix.map((z) => z.zip)).toEqual([...prefix.map((z) => z.zip!)].sort())
    expect(zips.slice(prefix.length).every((z) => z.zip?.includes('0710') && !z.zip.startsWith('0710'))).toBe(true)
    expect(zips.find((z) => z.zip === '07102')).toEqual({
      kind: 'zip',
      label: '07102 — Newark, NJ',
      country: 'us',
      state: 'New Jersey',
      stateCode: 'NJ',
      city: 'Newark',
      zip: '07102',
      timezone: 'America/New_York',
    })
    expect(service.search({ mode: 'zip', query: '07102', limit: 5 })).toHaveLength(1)
    const byName = service.search({ mode: 'zip', query: 'newark nj', limit: 100 })
    expect(byName.length).toBeGreaterThan(5)
    expect(byName.every((z) => z.city === 'Newark' && z.stateCode === 'NJ')).toBe(true)
    expect(service.search({ mode: 'zip', query: '', limit: 2 }).map((z) => z.zip)).toEqual(['00501', '00544'])
  })

  it('country search and the whole-country entry', () => {
    expect(service.search({ mode: 'country', query: '', limit: 10 })).toEqual([unitedStatesEntry()])
    expect(service.search({ mode: 'country', query: 'unit', limit: 10 })).toHaveLength(1)
    expect(service.search({ mode: 'country', query: 'germany', limit: 10 })).toEqual([])
    expect(service.random('country')).toEqual(unitedStatesEntry())
  })

  it('validates the search input and caps the limit', () => {
    expect(() => service.search({ mode: 'planet' as never, query: '', limit: 10 })).toThrowError(/Invalid location search/)
    expect(() => service.search({ mode: 'state', query: 'x'.repeat(81), limit: 10 })).toThrowError(/Invalid location search/)
    expect(service.search({ mode: 'city', query: 'a', limit: 200 })).toHaveLength(200)
    // Omitted limit defaults to 50 through the shared schema.
    expect(service.search({ mode: 'city', query: 'a' } as never)).toHaveLength(50)
  })

  it('random() is uniform over the index and only ever picks states DataImpulse accepts', () => {
    const draws = [0, 0.1, 0.25, 0.5, 0.75, 0.999999]
    for (const kind of ['state', 'city', 'zip'] as const) {
      const picked: LocationEntry[] = []
      for (const value of draws) {
        const svc = createLocationsService({ dataDir: DATA_DIR, logger: fakeLogger(), random: () => value })
        picked.push(svc.random(kind))
      }
      expect(picked.every((e) => e.kind === kind)).toBe(true)
      expect(picked.every((e) => official.has(encodeStateName(e.state))), kind).toBe(true)
      expect(new Set(picked.map((e) => e.label)).size).toBeGreaterThan(1)
      if (kind === 'zip') expect(picked.every((e) => /^\d{5}$/.test(e.zip ?? '') && e.city !== null)).toBe(true)
      if (kind === 'city') expect(picked.every((e) => e.city !== null && e.zip === null)).toBe(true)
    }
    const first = createLocationsService({ dataDir: DATA_DIR, logger: fakeLogger(), random: () => 0 })
    expect(first.random('state')).toMatchObject({ state: 'Alabama' })
    const dc = service.states().find((s) => s.stateCode === 'DC')!
    expect(official.has(encodeStateName(dc.state))).toBe(false)
  })

  it('counts cities and ZIP codes per state and ZIP codes per city, consistently with the index', () => {
    const states = service.states()
    const stats = service.stats()
    expect(stats.states).toBe(51)
    expect(states.reduce((sum, s) => sum + (s.cityCount ?? 0), 0)).toBe(stats.cities)
    expect(states.reduce((sum, s) => sum + (s.zipCount ?? 0), 0)).toBe(stats.zips)
    const nj = states.find((s) => s.stateCode === 'NJ')!
    expect(nj.cityCount).toBe(service.query({ mode: 'city', query: '', stateCode: 'NJ', limit: 1 }).total)
    expect(nj.zipCount).toBe(service.query({ mode: 'zip', query: '', stateCode: 'NJ', limit: 1 }).total)
    const newark = service.search({ mode: 'city', query: 'newark nj', limit: 1 })[0]!
    expect(newark.zipCount).toBe(service.search({ mode: 'zip', query: 'newark nj', limit: 200 }).filter((z) => z.city === 'Newark').length)
    expect(newark.zipCount).toBeGreaterThan(5)
    // Entries are copies: callers cannot corrupt the index.
    newark.zipCount = -1
    expect(service.search({ mode: 'city', query: 'newark nj', limit: 1 })[0]?.zipCount).toBeGreaterThan(5)
  })

  it('query() returns the capped page and the uncapped total; stateCode filters cities and ZIP codes', () => {
    const all = service.query({ mode: 'city', query: 'new', limit: 50 })
    expect(all.entries).toHaveLength(50)
    expect(all.total).toBeGreaterThan(50)
    const nj = service.query({ mode: 'city', query: 'new', limit: 50, stateCode: 'nj' })
    expect(nj.entries.length).toBeGreaterThan(0)
    expect(nj.entries.every((e) => e.stateCode === 'NJ')).toBe(true)
    expect(nj.total).toBeLessThan(all.total)
    expect(nj.entries[0]?.city?.toLowerCase().startsWith('new')).toBe(true)
    // The explicit filter and a matching "… nj" suffix agree; a different suffix stays search text.
    expect(service.query({ mode: 'city', query: 'newark nj', limit: 50, stateCode: 'NJ' }).entries.map((e) => e.label)).toEqual(['Newark, NJ'])
    expect(service.query({ mode: 'city', query: 'newark de', limit: 50, stateCode: 'NJ' }).total).toBe(0)
    const zips = service.query({ mode: 'zip', query: '07', limit: 10, stateCode: 'NJ' })
    expect(zips.entries.every((e) => e.stateCode === 'NJ' && e.zip?.startsWith('07'))).toBe(true)
    expect(service.query({ mode: 'zip', query: '9', limit: 10, stateCode: 'NJ' }).entries.every((e) => e.stateCode === 'NJ')).toBe(true)
    // State searches ignore the filter; unknown codes are rejected.
    expect(service.query({ mode: 'state', query: 'new', limit: 50, stateCode: 'NJ' }).total).toBe(4)
    expect(() => service.query({ mode: 'city', query: '', limit: 5, stateCode: 'XX' })).toThrowError(/Unknown US state code/)
    expect(() => service.query({ mode: 'city', query: '', limit: 5, stateCode: 'N1' })).toThrowError(/Invalid location search/)
    expect(service.query({ mode: 'country', query: '', limit: 5 })).toEqual({ entries: [unitedStatesEntry()], total: 1 })
  })

  it('city search ranks exact name matches by size: Philadelphia, PA before the small Philadelphias', () => {
    const results = service.search({ mode: 'city', query: 'philadelphia', limit: 50 })
    expect(results[0]).toMatchObject({ city: 'Philadelphia', stateCode: 'PA' })
    const exact = results.filter((e) => e.city === 'Philadelphia')
    expect(results.slice(0, exact.length)).toEqual(exact)
    const sizes = exact.map((e) => e.zipCount ?? 0)
    expect(sizes).toEqual([...sizes].sort((x, y) => y - x))
    expect(service.search({ mode: 'city', query: 'springfield', limit: 50 })[0]?.zipCount).toBeGreaterThan(1)
    // Prefix matches lead with the big cities.
    expect(service.search({ mode: 'city', query: 'new', limit: 5 })[0]).toMatchObject({ city: 'New York', stateCode: 'NY' })
    expect(service.query({ mode: 'city', query: 'new', limit: 5 }).total).toBe(service.query({ mode: 'city', query: 'new', limit: 200 }).total)
  })

  it('random() with a state keeps cities and ZIP codes in that state and refuses states DataImpulse does not target', () => {
    for (const value of [0, 0.5, 0.999999]) {
      const svc = createLocationsService({ dataDir: DATA_DIR, logger: fakeLogger(), random: () => value })
      expect(svc.random('city', 'NJ')).toMatchObject({ kind: 'city', stateCode: 'NJ' })
      expect(svc.random('zip', 'tx')).toMatchObject({ kind: 'zip', stateCode: 'TX' })
      expect(svc.random('state', 'NJ')).toMatchObject({ kind: 'state', stateCode: 'NJ' })
    }
    expect(() => service.random('city', 'DC')).toThrowError(/not on DataImpulse/)
    expect(() => service.random('city', 'XX')).toThrowError(/Unknown US state code/)
    expect(service.random('city', null).kind).toBe('city')
  })

  it('toTarget builds the GeoTarget for every entry kind', () => {
    expect(service.toTarget(service.states().find((s) => s.stateCode === 'NJ')!)).toEqual({ mode: 'state', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: null, zip: null })
    const newark = service.search({ mode: 'city', query: 'newark nj', limit: 1 })[0]!
    expect(service.toTarget(newark)).toEqual({ mode: 'city', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: 'Newark', zip: null })
    const zip = service.search({ mode: 'zip', query: '07102', limit: 1 })[0]!
    expect(service.toTarget(zip)).toEqual({ mode: 'zip', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: 'Newark', zip: '07102' })
    expect(service.toTarget(unitedStatesEntry())).toEqual({ mode: 'country', country: 'us', state: null, stateCode: null, city: null, zip: null })
  })

  it('fails with an actionable INTERNAL error when the dataset is missing', () => {
    const broken = createLocationsService({ dataDir: '/nowhere', logger: fakeLogger() })
    expect(() => broken.states()).toThrowError(/US location dataset could not be loaded/)
  })
})

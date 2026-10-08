import { describe, expect, it } from 'vitest'
import type { GeoTarget, LocationEntry } from '../src/shared/types'
import {
  POPULAR_CITIES,
  POPULAR_STATE_CODES,
  RECENT_LOCATIONS_KEY,
  cappedFooter,
  datasetHint,
  entryPrimary,
  entrySecondary,
  highlightSegments,
  locationKey,
  parseStoredLocations,
  popularEntries,
  pushRecentLocation,
  readStoredLocations,
  recentForMode,
  targetChipLabel,
  targetKey,
  writeStoredLocations,
} from '../src/renderer/src/lib/locationPicker'
import type { KeyValueStorage } from '../src/renderer/src/lib/devicePicker'

const nj: LocationEntry = { kind: 'state', label: 'New Jersey (NJ)', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: null, zip: null, timezone: 'America/New_York', cityCount: 593, zipCount: 597 }
const newark: LocationEntry = { kind: 'city', label: 'Newark, NJ', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: 'Newark', zip: null, timezone: 'America/New_York', zipCount: 12 }
const zip07102: LocationEntry = { kind: 'zip', label: '07102 — Newark, NJ', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: 'Newark', zip: '07102', timezone: 'America/New_York' }

const stateEntry = (state: string, stateCode: string, timezone = 'America/New_York'): LocationEntry => ({ kind: 'state', label: `${state} (${stateCode})`, country: 'us', state, stateCode, city: null, zip: null, timezone })

describe('location picker: row text', () => {
  it('formats the primary and secondary lines per kind', () => {
    expect([entryPrimary(nj), entrySecondary(nj)]).toEqual(['New Jersey', 'NJ · 593 cities · 597 ZIPs'])
    expect([entryPrimary(newark), entrySecondary(newark)]).toEqual(['Newark', 'New Jersey · NJ · 12 ZIPs'])
    expect([entryPrimary(zip07102), entrySecondary(zip07102)]).toEqual(['07102', 'Newark, New Jersey'])
    expect(entrySecondary({ ...newark, zipCount: 1 })).toBe('New Jersey · NJ · 1 ZIP')
    expect(entrySecondary({ ...nj, cityCount: 2341, zipCount: 1 })).toBe('NJ · 2,341 cities · 1 ZIP')
    // Entries without counts (popular quick picks) leave them out.
    const { zipCount: _omit, ...bare } = newark
    expect(entrySecondary(bare)).toBe('New Jersey · NJ')
  })

  it('shows a compact chip once picked', () => {
    const target = (patch: Partial<GeoTarget>): GeoTarget => ({ mode: 'city', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: 'Newark', zip: null, ...patch })
    expect(targetChipLabel(target({}))).toBe('Newark, NJ')
    expect(targetChipLabel(target({ mode: 'state', city: null }))).toBe('New Jersey')
    expect(targetChipLabel(target({ mode: 'zip', zip: '07102' }))).toBe('07102 · Newark, NJ')
    expect(targetChipLabel(null)).toBe('')
  })
})

describe('location picker: highlight', () => {
  it('marks the matched substring case-insensitively', () => {
    expect(highlightSegments('New Jersey', 'jer')).toEqual([
      { text: 'New ', match: false },
      { text: 'Jer', match: true },
      { text: 'sey', match: false },
    ])
    expect(highlightSegments('Newark', 'newark')).toEqual([{ text: 'Newark', match: true }])
    expect(highlightSegments('07102', '071')).toEqual([
      { text: '071', match: true },
      { text: '02', match: false },
    ])
  })

  it('ignores accents, falls back to per-word matches and handles misses', () => {
    expect(highlightSegments('Cañon City', 'canon')).toEqual([
      { text: 'Cañon', match: true },
      { text: ' City', match: false },
    ])
    expect(highlightSegments('Newark', 'newark nj')).toEqual([{ text: 'Newark', match: true }])
    expect(highlightSegments('San Antonio', 'antonio san')).toEqual([
      { text: 'San', match: true },
      { text: ' ', match: false },
      { text: 'Antonio', match: true },
    ])
    expect(highlightSegments('Austin', 'zzz')).toEqual([{ text: 'Austin', match: false }])
    expect(highlightSegments('Austin', '  ')).toEqual([{ text: 'Austin', match: false }])
  })
})

describe('location picker: start state', () => {
  const states = [stateEntry('California', 'CA', 'America/Los_Angeles'), stateEntry('Texas', 'TX', 'America/Chicago'), stateEntry('New York', 'NY'), stateEntry('New Jersey', 'NJ'), stateEntry('Arizona', 'AZ', 'America/Phoenix'), stateEntry('Illinois', 'IL', 'America/Chicago'), stateEntry('Pennsylvania', 'PA')]

  it('lists popular states and cities in a fixed order', () => {
    expect(POPULAR_STATE_CODES).toEqual(['CA', 'TX', 'FL', 'NY', 'NJ', 'IL', 'PA', 'OH', 'GA', 'NC'])
    expect(POPULAR_CITIES.map((c) => c.city)).toEqual(['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix', 'Philadelphia', 'San Antonio', 'San Diego', 'Dallas', 'Austin'])
    // Only states that are loaded are offered.
    expect(popularEntries('state', states).map((s) => s.stateCode)).toEqual(['CA', 'TX', 'NY', 'NJ', 'IL', 'PA'])
    const cities = popularEntries('city', states)
    expect(cities[0]).toEqual({ kind: 'city', label: 'New York, NY', country: 'us', state: 'New York', stateCode: 'NY', city: 'New York', zip: null, timezone: 'America/New_York' })
    expect(cities.map((c) => c.city)).toEqual(['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix', 'Philadelphia', 'San Antonio', 'San Diego', 'Dallas', 'Austin'])
    expect(popularEntries('city', states, 'TX').map((c) => c.city)).toEqual(['Houston', 'San Antonio', 'Dallas', 'Austin'])
    expect(popularEntries('zip', states)).toEqual([])
    expect(popularEntries('state', [])).toEqual([])
  })

  it('describes the dataset and capped result pages', () => {
    expect(datasetHint({ states: 51, cities: 29540, zips: 40977 })).toBe('Type to search 51 states · 29,540 cities · 40,977 ZIPs')
    expect(datasetHint(null)).toBe('Type to search US states, cities and ZIP codes')
    expect(cappedFooter(50, 2341)).toBe('50 of 2,341 · keep typing')
    expect(cappedFooter(12, 12)).toBeNull()
  })
})

describe('location picker: recent locations', () => {
  it('keeps the most recent first without duplicates and filters per mode / state', () => {
    let recent: LocationEntry[] = []
    recent = pushRecentLocation(recent, newark)
    recent = pushRecentLocation(recent, nj)
    recent = pushRecentLocation(recent, { ...newark })
    expect(recent.map(locationKey)).toEqual([locationKey(newark), locationKey(nj)])
    for (let i = 0; i < 20; i++) recent = pushRecentLocation(recent, { ...zip07102, zip: String(10000 + i), label: `${10000 + i}` })
    expect(recent).toHaveLength(12)
    expect(recentForMode([newark, nj, zip07102], 'city')).toEqual([newark])
    expect(recentForMode([newark, nj, zip07102], 'zip', 'TX')).toEqual([])
    expect(targetKey({ mode: 'city', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: 'Newark', zip: null })).toBe(locationKey(newark))
    expect(targetKey(null)).toBeNull()
  })

  it('round-trips through storage and drops malformed rows', () => {
    const data: Record<string, string> = {}
    const storage: KeyValueStorage = { getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) }
    expect(writeStoredLocations(storage, [newark, zip07102])).toBe(true)
    expect(readStoredLocations(storage)).toEqual([newark, zip07102])
    data[RECENT_LOCATIONS_KEY] = JSON.stringify([newark, { kind: 'zip', zip: 'abc' }, { ...zip07102, zip: '1234' }, 'x', null, { ...nj, kind: 'country' }, newark])
    expect(readStoredLocations(storage)).toEqual([newark])
    expect(parseStoredLocations('nope')).toEqual([])
    expect(parseStoredLocations('{"kind":"city"}')).toEqual([])
    const broken: KeyValueStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('full')
      },
    }
    expect(readStoredLocations(broken)).toEqual([])
    expect(writeStoredLocations(broken, [newark])).toBe(false)
    expect(readStoredLocations(null)).toEqual([])
  })
})

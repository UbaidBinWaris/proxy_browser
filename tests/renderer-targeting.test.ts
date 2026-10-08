import { describe, expect, it } from 'vitest'
import type { GeoTarget, LocationEntry } from '../src/shared/types'
import {
  TARGET_MATCH_META,
  TARGET_MODE_LABELS,
  countryTarget,
  deriveTargetMatch,
  describeTarget,
  encodePlaceName,
  formatLocationLabel,
  geoTargetFromEntry,
  locationAttemptsLabel,
  locationPolicySummary,
  normalisePostalCode,
  policyPlaceLabel,
  poolLabel,
  poolShortLabel,
  resolveTargetMatch,
  targetLabel,
  targetMatchSentence,
  timezoneForState,
} from '../src/renderer/src/lib/targeting'
import { connectionKindForRecord } from '../src/renderer/src/lib/launch'
import { dataImpulseDialect } from '../src/main/proxy/providers/dataimpulse'

/** The provider as the renderer receives it from proxy.providers() (capabilities, no credentials). */
const dataimpulse = { id: 'dataimpulse', displayName: 'DataImpulse', capabilities: dataImpulseDialect.capabilities }
import { shortId } from '../src/renderer/src/lib/utils'

const state: LocationEntry = { kind: 'state', label: '', country: 'US', state: 'New Jersey', stateCode: 'NJ', city: null, zip: null, timezone: 'America/New_York' }
const city: LocationEntry = { ...state, kind: 'city', city: 'Newark' }
const zip: LocationEntry = { ...city, kind: 'zip', zip: '07102' }
const hawaii: LocationEntry = { ...state, kind: 'city', state: 'Hawaii', stateCode: 'HI', city: "'Ewa Beach", timezone: 'Pacific/Honolulu' }

const nj: GeoTarget = geoTargetFromEntry(state)
const newark: GeoTarget = geoTargetFromEntry(city)
const newarkZip: GeoTarget = geoTargetFromEntry(zip)
const us: GeoTarget = countryTarget('US')

const ip = (overrides: Partial<{ country: string | null; countryCode: string | null; region: string | null; city: string | null; postalCode: string | null }> = {}) => ({
  country: 'United States',
  countryCode: 'US',
  region: 'New Jersey',
  city: 'Newark',
  ...overrides,
})

describe('location labels (old-tool style)', () => {
  it('formats states, cities and ZIPs like the previous launcher', () => {
    expect(formatLocationLabel(state)).toBe('New Jersey (NJ)')
    expect(formatLocationLabel(city)).toBe('Newark, New Jersey')
    expect(formatLocationLabel(hawaii)).toBe("'Ewa Beach, Hawaii")
    expect(formatLocationLabel(zip)).toBe('07102 - Newark, NJ')
    expect(formatLocationLabel({ kind: 'country', country: 'us', state: '', stateCode: '', city: null, zip: null })).toBe('US')
    expect(formatLocationLabel({ ...state, stateCode: '' })).toBe('New Jersey')
    expect(formatLocationLabel({ ...zip, city: null })).toBe('07102 - NJ')
  })

  it('labels a stored GeoTarget the same way and gives an empty string for null', () => {
    expect(targetLabel(nj)).toBe('New Jersey (NJ)')
    expect(targetLabel(newark)).toBe('Newark, New Jersey')
    expect(targetLabel(newarkZip)).toBe('07102 - Newark, NJ')
    expect(targetLabel(us)).toBe('US')
    expect(targetLabel(null)).toBe('')
  })

  it('summarises targets compactly for tables', () => {
    expect(describeTarget(null)).toBe('—')
    expect(describeTarget(us)).toBe('US')
    expect(describeTarget(nj)).toBe('NJ')
    expect(describeTarget(newark)).toBe('NJ · Newark')
    expect(describeTarget(newarkZip)).toBe('NJ · Newark · 07102')
    expect(describeTarget({ ...nj, stateCode: null })).toBe('New Jersey')
    expect(describeTarget({ ...nj, state: null, stateCode: null })).toBe('US')
  })

  it('maps modes and pools to labels', () => {
    expect(TARGET_MODE_LABELS).toEqual({ country: 'Country', state: 'State', city: 'City', zip: 'ZIP' })
    expect(poolLabel('residential', dataimpulse)).toBe('DataImpulse Residential')
    expect(poolLabel('mobile', dataimpulse)).toBe('DataImpulse Mobile')
    // Without the provider (still loading) the product key is shown readably.
    expect(poolLabel('mobile')).toBe('Mobile')
    expect(poolLabel('none')).toBe('Direct (no proxy)')
    expect(poolLabel(null)).toBe('—')
    expect(poolShortLabel('mobile', dataimpulse)).toBe('Mobile')
    expect(poolShortLabel('none')).toBe('Direct (no proxy)')
    expect(poolShortLabel(undefined)).toBe('—')
  })

  it('builds targets from entries, normalising the country and dropping fields above the mode', () => {
    expect(nj).toEqual({ mode: 'state', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: null, zip: null })
    expect(geoTargetFromEntry(zip, 'country')).toEqual({ mode: 'country', country: 'us', state: null, stateCode: null, city: null, zip: null })
    expect(countryTarget(' DE ')).toEqual({ mode: 'country', country: 'de', state: null, stateCode: null, city: null, zip: null })
    expect(timezoneForState([state, hawaii], 'hi')).toBe('Pacific/Honolulu')
    expect(timezoneForState([state], 'TX')).toBeNull()
    expect(timezoneForState([state], null)).toBeNull()
  })

  it('encodes place names the way the provider expects', () => {
    expect(encodePlaceName('New Jersey', 'remove-spaces')).toBe('newjersey')
    expect(encodePlaceName('New  Jersey ', 'underscore')).toBe('new_jersey')
    expect(encodePlaceName('New Jersey', 'keep')).toBe('new jersey')
    expect(encodePlaceName('Texas', 'remove-spaces')).toBe('texas')
  })
})

describe('target match derivation', () => {
  it('is unknown without a target, an IP or comparable fields', () => {
    expect(deriveTargetMatch(null, ip())).toBe('unknown')
    expect(deriveTargetMatch(nj, null)).toBe('unknown')
    expect(deriveTargetMatch(nj, ip({ countryCode: null, country: null }))).toBe('unknown')
    expect(deriveTargetMatch(nj, ip({ region: null }))).toBe('unknown')
  })

  it('matches by country, state (name or code) and city, and flags partial city matches', () => {
    expect(deriveTargetMatch(us, ip({ region: 'Texas', city: 'Austin' }))).toBe('match')
    expect(deriveTargetMatch(us, ip({ countryCode: 'CA', country: 'Canada' }))).toBe('mismatch')
    expect(deriveTargetMatch(nj, ip())).toBe('match')
    expect(deriveTargetMatch(nj, ip({ region: 'NJ' }))).toBe('match')
    expect(deriveTargetMatch(nj, ip({ region: 'Texas' }))).toBe('mismatch')
    expect(deriveTargetMatch(newark, ip())).toBe('match')
    expect(deriveTargetMatch(newark, ip({ city: 'Jersey City' }))).toBe('partial')
    expect(deriveTargetMatch(newark, ip({ city: null }))).toBe('partial')
    expect(deriveTargetMatch(newark, ip({ region: 'New York', city: 'Newark' }))).toBe('mismatch')
    // ZIPs are verified exactly against the exit IP's postal code; the right city alone is only partial.
    expect(deriveTargetMatch(newarkZip, ip({ postalCode: '07102' }))).toBe('match')
    expect(deriveTargetMatch(newarkZip, ip({ postalCode: '07102-4321', region: 'NJ' }))).toBe('match')
    expect(deriveTargetMatch(newarkZip, ip())).toBe('partial')
    expect(deriveTargetMatch(newarkZip, ip({ postalCode: '07103' }))).toBe('partial')
    expect(deriveTargetMatch(newarkZip, ip({ city: 'Elizabeth', postalCode: '07201' }))).toBe('partial')
    expect(deriveTargetMatch(newarkZip, ip({ region: 'New York', city: 'New York', postalCode: '10118' }))).toBe('mismatch')
    expect(deriveTargetMatch(newarkZip, ip({ region: null, postalCode: '07102' }))).toBe('match')
    expect(deriveTargetMatch({ ...newarkZip, state: null, stateCode: null }, ip({ postalCode: '07104' }))).toBe('partial')
    // City targets ignore the postal code.
    expect(deriveTargetMatch(newark, ip({ postalCode: '07103' }))).toBe('match')
  })

  it('tolerates a missing country code by comparing the country name (US aliases included)', () => {
    expect(deriveTargetMatch(nj, ip({ countryCode: null, country: 'United States' }))).toBe('match')
    expect(deriveTargetMatch(nj, ip({ countryCode: null, country: 'United States of America' }))).toBe('match')
    expect(deriveTargetMatch(nj, ip({ countryCode: null, country: 'Canada' }))).toBe('mismatch')
    expect(deriveTargetMatch(countryTarget('de'), ip({ countryCode: null, country: 'DE' }))).toBe('match')
  })

  it('prefers the recorded verdict and only derives when it is missing or unknown', () => {
    expect(resolveTargetMatch('mismatch', newark, ip())).toBe('mismatch')
    expect(resolveTargetMatch(null, newark, ip())).toBe('match')
    expect(resolveTargetMatch('unknown', newark, ip({ city: 'Hoboken' }))).toBe('partial')
    expect(resolveTargetMatch('unknown', newark, null)).toBe('unknown')
    expect(resolveTargetMatch(null, null, null)).toBe('unknown')
  })

  it('maps verdicts to badge tones with an explicit label each', () => {
    expect(TARGET_MATCH_META.match).toEqual({ label: 'Match', variant: 'success' })
    expect(TARGET_MATCH_META.partial).toEqual({ label: 'Partial', variant: 'warning' })
    expect(TARGET_MATCH_META.mismatch).toEqual({ label: 'Mismatch', variant: 'destructive' })
    expect(TARGET_MATCH_META.unknown).toEqual({ label: 'Unverified', variant: 'muted' })
  })

  it('writes the requested/got sentence for each verdict', () => {
    expect(targetMatchSentence(nj, ip(), 'match')).toBe('Requested New Jersey · Got New Jersey ✓')
    expect(targetMatchSentence(newark, ip({ city: 'Jersey City' }), 'partial')).toBe('Requested Newark · Got Jersey City (same state)')
    expect(targetMatchSentence(newark, ip({ region: 'New York', city: 'Albany' }), 'partial')).toBe('Requested Newark · Got Albany (same country)')
    expect(targetMatchSentence(nj, ip({ region: 'Texas' }), 'mismatch')).toBe('Requested New Jersey · Got Texas ✗')
    expect(targetMatchSentence(newarkZip, ip({ city: 'Newark', postalCode: '07102' }), 'match')).toBe('Requested 07102 (Newark) · Got 07102 (Newark) ✓')
    expect(targetMatchSentence(newarkZip, ip({ city: 'Newark', postalCode: '07103' }), 'partial')).toBe('Requested 07102 (Newark) · Got 07103 (Newark) (same state)')
    expect(targetMatchSentence(newarkZip, ip({ city: 'Newark' }), 'partial')).toBe('Requested 07102 (Newark) · Got Newark (same state)')
    expect(targetMatchSentence(us, ip(), 'match')).toBe('Requested US · Got US ✓')
    expect(targetMatchSentence(nj, null, 'unknown')).toBe('Requested New Jersey · Location not verified yet')
    expect(targetMatchSentence(nj, ip({ region: null }), 'unknown')).toBe('Requested New Jersey · Got United States (not comparable)')
    expect(targetMatchSentence(null, ip(), 'match')).toBeNull()
  })
})

describe('run/session record helpers', () => {
  it('derives the connection kind from the recorded pool when the profile is unknown', () => {
    expect(connectionKindForRecord({ proxyPool: null, proxySessionId: null })).toBe('direct')
    expect(connectionKindForRecord({ proxyPool: 'residential', proxySessionId: 'ql-1' })).toBe('sticky')
    expect(connectionKindForRecord({ proxyPool: 'mobile', proxySessionId: null })).toBe('rotating')
    // A known profile mode wins over the record.
    expect(connectionKindForRecord({ proxyPool: 'residential', proxySessionId: null }, 'none')).toBe('direct')
    expect(connectionKindForRecord({ proxyPool: null, proxySessionId: 'x' }, 'sticky')).toBe('sticky')
  })

  it('shortens ids for the sessions table', () => {
    expect(shortId('0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0')).toBe('0f1e2d3c')
    expect(shortId('abc')).toBe('abc')
    expect(shortId('abcdefghijkl', 4)).toBe('abcd')
  })
})

describe('location re-roll helpers', () => {
  it('normalises postal codes like the main process', () => {
    expect(normalisePostalCode('07102')).toBe('07102')
    expect(normalisePostalCode('07102-1234')).toBe('07102')
    expect(normalisePostalCode(' m5h ')).toBe('M5H')
    expect(normalisePostalCode(null)).toBe('')
  })

  it('names the place each policy asks for', () => {
    expect(policyPlaceLabel(newarkZip, 'exact')).toBe('ZIP 07102')
    expect(policyPlaceLabel(newarkZip, 'state')).toBe('New Jersey')
    expect(policyPlaceLabel(newark, 'exact')).toBe('Newark, NJ')
    expect(policyPlaceLabel(nj, 'exact')).toBe('New Jersey')
    expect(policyPlaceLabel(us, 'state')).toBe('US')
  })

  it('summarises the active policy for the "Will connect as" strip', () => {
    const base = { pool: 'residential' as const, sticky: true, target: nj, policy: 'state' as const, attempts: 3 }
    expect(locationPolicySummary(base)).toBe('Re-rolls the session (up to 3 attempts) if the exit IP is outside New Jersey.')
    expect(locationPolicySummary({ ...base, target: newarkZip })).toBe('Re-rolls the session (up to 3 attempts) if the exit IP is outside New Jersey.')
    expect(locationPolicySummary({ ...base, target: newarkZip, policy: 'exact', attempts: 4 })).toBe('Re-rolls the session (up to 4 attempts) if the exit IP is not in ZIP 07102.')
    expect(locationPolicySummary({ ...base, target: newark, policy: 'exact' })).toBe('Re-rolls the session (up to 3 attempts) if the exit IP is not in Newark, NJ.')
    expect(locationPolicySummary({ ...base, target: us, policy: 'exact' })).toBe('Re-rolls the session (up to 3 attempts) if the exit IP is outside US.')
    expect(locationPolicySummary({ ...base, policy: 'off' })).toMatch(/^Location match is off/)
    expect(locationPolicySummary({ ...base, attempts: 1 })).toMatch(/never re-rolled/)
    expect(locationPolicySummary({ ...base, sticky: false })).toMatch(/^Rotating session: .*never re-rolled/)
    expect(locationPolicySummary({ ...base, pool: 'none' })).toBeNull()
    expect(locationPolicySummary({ ...base, target: null })).toBeNull()
  })

  it('labels the attempt only when the session was re-rolled', () => {
    expect(locationAttemptsLabel({ locationAttempts: 2, locationMaxAttempts: 3 })).toBe('attempt 2 of 3')
    expect(locationAttemptsLabel({ locationAttempts: 3, locationMaxAttempts: 3 })).toBe('attempt 3 of 3')
    expect(locationAttemptsLabel({ locationAttempts: 1, locationMaxAttempts: 3 })).toBeNull()
    // Never claims fewer attempts allowed than were made.
    expect(locationAttemptsLabel({ locationAttempts: 2, locationMaxAttempts: 1 })).toBe('attempt 2 of 2')
    expect(locationAttemptsLabel(null)).toBeNull()
  })
})

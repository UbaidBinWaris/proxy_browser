import type { GeoTarget, IpInfo, LocationEntry, LocationMatchPolicy, ProductKey, TargetMatch, TargetMode } from '@shared/types'
import { TARGET_MODES } from '@shared/types'
import { productLabelFor, providerProductLabel } from './providers'
import type { ProviderLike } from './providers'
import type { StatusTone } from './security'

// ---------------------------------------------------------------------------
// Products ("pools")
// ---------------------------------------------------------------------------

/** What the launcher lets the user pick: a product of the selected provider, or a direct connection. */
export type PoolChoice = ProductKey | 'none'

export const DIRECT_LABEL = 'Direct (no proxy)'

/** The launcher's choices for a provider: its products in capability order, then a direct connection. */
export function poolChoicesFor(provider: Pick<ProviderLike, 'capabilities'> | null | undefined): PoolChoice[] {
  return [...(provider?.capabilities.products.map((product) => product.key) ?? []), 'none']
}

/** Full label ("DataImpulse Residential"), "Direct (no proxy)" for none, em dash when unknown. */
export function poolLabel(pool: PoolChoice | null | undefined, provider?: Pick<ProviderLike, 'displayName' | 'capabilities'> | null): string {
  if (pool === null || pool === undefined) return '—'
  if (pool === 'none') return DIRECT_LABEL
  return providerProductLabel(provider, pool)
}

/** Compact label for radios, badges and table cells ("Residential", "Direct (no proxy)"). */
export function poolShortLabel(pool: PoolChoice | null | undefined, provider?: Pick<ProviderLike, 'capabilities'> | null): string {
  if (pool === null || pool === undefined) return '—'
  if (pool === 'none') return DIRECT_LABEL
  return productLabelFor(provider, pool)
}

// ---------------------------------------------------------------------------
// Target modes & labels
// ---------------------------------------------------------------------------

export const TARGET_MODE_LABELS: Record<TargetMode, string> = { country: 'Country', state: 'State', city: 'City', zip: 'ZIP' }

export const TARGET_MODE_OPTIONS: ReadonlyArray<{ value: TargetMode; label: string }> = TARGET_MODES.map((mode) => ({ value: mode, label: TARGET_MODE_LABELS[mode] }))

/**
 * Old-tool label for a dataset entry:
 * state → "New Jersey (NJ)", city → "Newark, New Jersey", zip → "07102 - Newark, NJ", country → "US".
 */
export function formatLocationLabel(entry: Pick<LocationEntry, 'kind' | 'country' | 'state' | 'stateCode' | 'city' | 'zip'>): string {
  switch (entry.kind) {
    case 'state':
      return entry.stateCode ? `${entry.state} (${entry.stateCode})` : entry.state
    case 'city':
      return [entry.city, entry.state].filter((part): part is string => !!part && part.trim().length > 0).join(', ')
    case 'zip': {
      const place = [entry.city, entry.stateCode || entry.state].filter((part): part is string => !!part && part.trim().length > 0).join(', ')
      return entry.zip ? (place ? `${entry.zip} - ${place}` : entry.zip) : place
    }
    case 'country':
      return entry.country.toUpperCase()
  }
}

/** The same label style for a stored GeoTarget (no dataset entry at hand). Empty string for null. */
export function targetLabel(target: GeoTarget | null | undefined): string {
  if (!target) return ''
  return formatLocationLabel({
    kind: target.mode,
    country: target.country,
    state: target.state ?? '',
    stateCode: target.stateCode ?? '',
    city: target.city,
    zip: target.zip,
  })
}

/** Compact summary for tables: "NJ · Newark · 07102", "NJ · Newark", "NJ", "US"; em dash for null. */
export function describeTarget(target: GeoTarget | null | undefined): string {
  if (!target) return '—'
  const state = target.stateCode ?? target.state
  const parts: Array<string | null> =
    target.mode === 'country'
      ? [target.country.toUpperCase()]
      : target.mode === 'state'
        ? [state]
        : target.mode === 'city'
          ? [state, target.city]
          : [state, target.city, target.zip]
  const filtered = parts.filter((part): part is string => !!part && part.trim().length > 0)
  return filtered.length > 0 ? filtered.join(' · ') : target.country.toUpperCase()
}

/** A GeoTarget for a plain country request (no state/city/zip). */
export function countryTarget(country: string): GeoTarget {
  return { mode: 'country', country: country.trim().toLowerCase(), state: null, stateCode: null, city: null, zip: null }
}

/** Turn a dataset entry into the GeoTarget the launcher/profile stores. `mode` defaults to the entry's kind. */
export function geoTargetFromEntry(entry: LocationEntry, mode: TargetMode = entry.kind): GeoTarget {
  const state = entry.state.trim().length > 0 ? entry.state : null
  const stateCode = entry.stateCode.trim().length === 2 ? entry.stateCode.toUpperCase() : null
  return {
    mode,
    country: entry.country.trim().toLowerCase(),
    state: mode === 'country' ? null : state,
    stateCode: mode === 'country' ? null : stateCode,
    city: mode === 'city' || mode === 'zip' ? entry.city : null,
    zip: mode === 'zip' ? entry.zip : null,
  }
}

/** IANA timezone for a state code from the states list (null when unknown). */
export function timezoneForState(states: readonly LocationEntry[], stateCode: string | null | undefined): string | null {
  if (!stateCode) return null
  const code = stateCode.toUpperCase()
  return states.find((entry) => entry.stateCode.toUpperCase() === code)?.timezone ?? null
}

/**
 * How a multi-word place is written in the provider targeting string for a provider `encoding`
 * option ('remove-spaces', 'underscore', 'keep'); unknown values use 'remove-spaces'.
 */
export function encodePlaceName(name: string, encoding: string | undefined): string {
  const collapsed = name.trim().toLowerCase().replace(/\s+/g, ' ')
  switch (encoding) {
    case 'underscore':
      return collapsed.replace(/ /g, '_')
    case 'keep':
      return collapsed
    default:
      return collapsed.replace(/ /g, '')
  }
}

// ---------------------------------------------------------------------------
// Verified-vs-requested comparison
// ---------------------------------------------------------------------------

export interface TargetMatchMeta {
  label: string
  variant: StatusTone
}

export const TARGET_MATCH_META: Record<TargetMatch, TargetMatchMeta> = {
  match: { label: 'Match', variant: 'success' },
  partial: { label: 'Partial', variant: 'warning' },
  mismatch: { label: 'Mismatch', variant: 'destructive' },
  unknown: { label: 'Unverified', variant: 'muted' },
}

/** What a verdict is computed from: an IpInfo, or the same fields recorded on a run (postal code optional for old callers). */
export type VerifiedLocation = Pick<IpInfo, 'country' | 'countryCode' | 'region' | 'city'> & { postalCode?: string | null }

/** 5-digit ZIP of "07102" / "07102-1234"; the trimmed upper-case value otherwise; '' when empty. Mirrors the main process. */
export function normalisePostalCode(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim()
  const zip = /^(\d{5})(?:[-\s]?\d{4})?$/.exec(trimmed)
  return zip?.[1] ?? trimmed.toUpperCase()
}

function normalise(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

function stateMatches(target: GeoTarget, ip: VerifiedLocation): boolean {
  const region = normalise(ip.region)
  if (region === '') return false
  return (target.state !== null && region === normalise(target.state)) || (target.stateCode !== null && region === normalise(target.stateCode))
}

function countryMatches(target: GeoTarget, ip: VerifiedLocation): boolean | null {
  const code = normalise(ip.countryCode)
  if (code !== '') return code === normalise(target.country)
  // Without a country code only the name is available; compare loosely and treat an empty name as unknown.
  const name = normalise(ip.country)
  if (name === '') return null
  return name === normalise(target.country) || (normalise(target.country) === 'us' && (name === 'unitedstates' || name === 'unitedstatesofamerica'))
}

/**
 * Compare the requested location with the verified exit IP when the main process has not recorded a verdict.
 * - `unknown`: no target, no IP or no comparable fields.
 * - `mismatch`: country differs, or (state/city/zip modes) the state differs.
 * - `partial`: city requested, same state but a different (or unknown) city; ZIP requested, same state but a
 *   different (or unreported) postal code.
 * - `match`: every requested level agrees; a ZIP is verified exactly against the IP's postal code.
 */
export function deriveTargetMatch(target: GeoTarget | null | undefined, ip: VerifiedLocation | null | undefined): TargetMatch {
  if (!target || !ip) return 'unknown'
  const country = countryMatches(target, ip)
  if (country === null) return 'unknown'
  if (!country) return 'mismatch'
  if (target.mode === 'country') return 'match'
  const wantZip = target.mode === 'zip' ? normalisePostalCode(target.zip) : ''
  if (wantZip !== '' && normalisePostalCode(ip.postalCode) === wantZip) return 'match'
  if (target.state === null && target.stateCode === null) {
    if (wantZip !== '') return 'partial'
    return normalise(ip.region) === '' ? 'unknown' : 'match'
  }
  if (normalise(ip.region) === '') return 'unknown'
  if (!stateMatches(target, ip)) return 'mismatch'
  if (target.mode === 'state') return 'match'
  if (wantZip !== '') return 'partial'
  if (target.city === null) return 'match'
  const city = normalise(ip.city)
  if (city === '') return 'partial'
  return city === normalise(target.city) ? 'match' : 'partial'
}

/** Prefer the verdict recorded by the main process; derive one from the IP otherwise. */
export function resolveTargetMatch(recorded: TargetMatch | null | undefined, target: GeoTarget | null | undefined, ip: VerifiedLocation | null | undefined): TargetMatch {
  if (recorded && recorded !== 'unknown') return recorded
  const derived = deriveTargetMatch(target, ip)
  return derived === 'unknown' ? (recorded ?? 'unknown') : derived
}

function requestedLabel(target: GeoTarget): string {
  switch (target.mode) {
    case 'country':
      return target.country.toUpperCase()
    case 'state':
      return target.state ?? target.stateCode ?? target.country.toUpperCase()
    case 'city':
      return target.city ?? target.state ?? target.country.toUpperCase()
    case 'zip':
      return target.zip ? (target.city ? `${target.zip} (${target.city})` : target.zip) : (target.city ?? target.country.toUpperCase())
  }
}

function verifiedLabel(mode: TargetMode, ip: VerifiedLocation): string {
  const first = (...values: Array<string | null>): string => values.find((value): value is string => !!value && value.trim().length > 0) ?? 'unknown location'
  switch (mode) {
    case 'country':
      return first(ip.countryCode ? ip.countryCode.toUpperCase() : null, ip.country)
    case 'state':
      return first(ip.region, ip.country)
    case 'city':
      return first(ip.city, ip.region, ip.country)
    case 'zip': {
      const postal = ip.postalCode?.trim() ?? ''
      const place = first(ip.city, ip.region, ip.country)
      if (postal === '') return place
      return place === 'unknown location' ? postal : `${postal} (${place})`
    }
  }
}

/**
 * One-line verdict shown next to the verified location, e.g.
 * "Requested New Jersey · Got New Jersey ✓", "Requested Newark · Got Jersey City (same state)",
 * "Requested Texas · Got Ohio ✗". Null when nothing was requested.
 */
export function targetMatchSentence(target: GeoTarget | null | undefined, ip: VerifiedLocation | null | undefined, match: TargetMatch): string | null {
  if (!target) return null
  const requested = requestedLabel(target)
  if (!ip) return `Requested ${requested} · Location not verified yet`
  const got = verifiedLabel(target.mode, ip)
  switch (match) {
    case 'match':
      return `Requested ${requested} · Got ${got} ✓`
    case 'partial':
      return `Requested ${requested} · Got ${got} (${stateMatches(target, ip) ? 'same state' : 'same country'})`
    case 'mismatch':
      return `Requested ${requested} · Got ${got} ✗`
    case 'unknown':
      return `Requested ${requested} · Got ${got} (not comparable)`
  }
}

// ---------------------------------------------------------------------------
// Location re-roll (settings.locationMatchPolicy / locationMatchAttempts)
// ---------------------------------------------------------------------------

/** Place the policy asks for, in words: "New Jersey" (same state), "Newark, NJ" / "ZIP 07102" (exact). Mirrors the main process. */
export function policyPlaceLabel(target: GeoTarget, policy: LocationMatchPolicy): string {
  const country = target.country.toUpperCase()
  const stateLabel = target.state ?? target.stateCode ?? country
  const stateShort = target.stateCode ?? target.state
  if (target.mode === 'country') return country
  if (policy !== 'exact' || target.mode === 'state') return stateLabel
  if (target.mode === 'city') return target.city ? (stateShort ? `${target.city}, ${stateShort}` : target.city) : stateLabel
  return target.zip ? `ZIP ${target.zip}` : (target.city ?? stateLabel)
}

export interface LocationPolicyContext {
  pool: PoolChoice
  /** Sticky session requested (a rotating session cannot keep an IP, so it is never re-rolled). */
  sticky: boolean
  target: GeoTarget | null
  policy: LocationMatchPolicy
  attempts: number
}

/**
 * One line for the launcher's "Will connect as" strip describing what happens when the exit IP lands
 * outside the requested location, e.g. "Re-rolls the session (up to 3 attempts) if the exit IP is outside New Jersey".
 * Null for a direct connection or a request without a target.
 */
export function locationPolicySummary({ pool, sticky, target, policy, attempts }: LocationPolicyContext): string | null {
  if (pool === 'none' || !target) return null
  if (!sticky) return 'Rotating session: the exit IP is checked once and never re-rolled (a rotating session cannot keep an IP).'
  if (policy === 'off') return 'Location match is off: the first exit IP is used wherever it is (Settings → Advanced → Targeting).'
  if (attempts <= 1) return 'Location match allows 1 attempt: the exit IP is checked but never re-rolled (Settings → Advanced → Targeting).'
  const place = policyPlaceLabel(target, policy)
  const condition = policy === 'exact' && target.mode !== 'country' && target.mode !== 'state' ? `is not in ${place}` : `is outside ${place}`
  return `Re-rolls the session (up to ${attempts} attempts) if the exit IP ${condition}.`
}

/** "attempt 2 of 3" when the location policy needed more than one sticky session; null otherwise. */
export function locationAttemptsLabel(record: { locationAttempts: number; locationMaxAttempts: number } | null | undefined): string | null {
  if (!record || record.locationAttempts <= 1) return null
  return `attempt ${record.locationAttempts} of ${Math.max(record.locationAttempts, record.locationMaxAttempts)}`
}

/**
 * Small pure helpers shared by the community dialects (Bright Data, Oxylabs,
 * Decodo, IPRoyal). Nothing here encodes a provider's syntax: each dialect file
 * owns its parameter names and separators and cites the docs they come from.
 *
 * - Place-name words: ASCII, lower-case, apostrophes dropped, every other
 *   non-alphanumeric run is a word break ("Coeur d'Alene" → coeur dalene,
 *   "Winston-Salem" → winston salem, "St. Louis" → st louis). Dialects join the
 *   words with their documented joiner ('' or '_').
 * - Session ids: the profile charset ([A-Za-z0-9_-], up to 64) is wider than
 *   what dash- or underscore-separated parameter syntaxes can carry, so the
 *   dialects map ids to alphanumerics deterministically (`toAlphanumericSession`)
 *   or to a fixed-length token (`toFixedLengthSession`).
 */
import { AppException } from '../../contracts'
import type { GeoTarget, TargetMode } from '../../../shared/types'

const APOSTROPHES = /['‘’ʻʼ`]/g
const ALPHANUMERIC = /^[a-zA-Z0-9]+$/

/** Lower-case ASCII words of a place name (see the file header for the rules). */
export function placeWords(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(APOSTROPHES, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
}

/** Deterministic lower-case base-36 digest of `input`, exactly `length` characters (length ≤ 14). */
export function hashBase36(input: string, length: number): string {
  // Two 32-bit FNV-1a variants (different offset bases) give ~64 bits.
  let a = 0x811c9dc5
  let b = 0x01000193 ^ 0x5bd1e995
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ code, 0x01000193) >>> 0
    b = (b ^ (b >>> 13)) >>> 0
  }
  return (a.toString(36).padStart(7, '0') + b.toString(36).padStart(7, '0')).slice(0, length)
}

/** Profile name → alphanumeric slug ("QA Tester #1 (NY)" → "qatester1ny"); empty when nothing is left. */
function alphanumericSlug(profileName: string): string {
  return placeWords(profileName).join('')
}

/**
 * A session id the provider can carry when only letters and digits are safe.
 * Kept verbatim when it already is alphanumeric and short enough; otherwise its
 * alphanumerics plus a 6-character digest of the original, so "qa-1" and "qa1"
 * still pin different exit IPs.
 */
export function toAlphanumericSession(sessionId: string, maxLength: number): string {
  if (ALPHANUMERIC.test(sessionId) && sessionId.length <= maxLength) return sessionId
  const digest = hashBase36(sessionId, 6)
  return sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, maxLength - digest.length) + digest
}

/** Deterministic alphanumeric session id for a profile: "profile<slug>", at most `maxLength`. */
export function createAlphanumericSession(profileName: string, maxLength: number): string {
  return `profile${alphanumericSlug(profileName) || 'default'}`.slice(0, maxLength)
}

/**
 * Next alphanumeric session id: an alphanumeric current id is kept and `r<N>`
 * appended or incremented (the stem is shortened only to fit); anything else
 * starts again from the profile's id. Always differs from `current`.
 */
export function rotateAlphanumericSession(current: string | null, profileName: string, maxLength: number): string {
  const base = current && ALPHANUMERIC.test(current) && current.length <= maxLength ? current : createAlphanumericSession(profileName, maxLength)
  const match = /^(.*)r(\d{1,6})$/.exec(base)
  const stem = match ? (match[1] ?? '') : base
  const round = match ? Number.parseInt(match[2] ?? '1', 10) + 1 : 2
  const suffix = `r${round}`
  const next = stem.slice(0, maxLength - suffix.length) + suffix
  if (next !== current) return next
  return base.slice(0, maxLength - 6) + hashBase36(`${base}#rotate`, 6)
}

/** A session id of exactly `length` alphanumerics: kept when it already is one, otherwise a digest of it. */
export function toFixedLengthSession(sessionId: string, length: number): string {
  return ALPHANUMERIC.test(sessionId) && sessionId.length === length ? sessionId : hashBase36(sessionId, length)
}

/** Deterministic fixed-length session id for a profile. */
export function createFixedLengthSession(profileName: string, length: number): string {
  return hashBase36(`profile:${alphanumericSlug(profileName) || 'default'}`, length)
}

/** Next fixed-length session id, derived from the current one; always differs from it. */
export function rotateFixedLengthSession(current: string | null, profileName: string, length: number): string {
  const base = current ?? createFixedLengthSession(profileName, length)
  for (let round = 1; ; round += 1) {
    const next = hashBase36(`${base}#${round}`, length)
    if (next !== current) return next
  }
}

/** A session lifetime in whole minutes within the provider's documented range; null when none was requested. */
export function clampTtlMinutes(ttlMinutes: number | null, range: { min: number; max: number }): number | null {
  if (ttlMinutes === null || !Number.isFinite(ttlMinutes) || ttlMinutes <= 0) return null
  return Math.min(range.max, Math.max(range.min, Math.trunc(ttlMinutes)))
}

/** Throws INVALID_INPUT when a US-only parameter is requested for another country. */
export function requireUnitedStates(target: GeoTarget, providerName: string, feature: string): void {
  if (target.country.trim().toLowerCase() !== 'us') {
    throw new AppException('INVALID_INPUT', `${providerName} supports ${feature} targeting in the United States only.`, `country=${target.country}`)
  }
}

/** The target's USPS state code in lower case; INVALID_INPUT when the target does not carry one. */
export function requireStateCode(target: GeoTarget, providerName: string): string {
  const code = target.stateCode?.trim().toLowerCase()
  if (!code || !/^[a-z]{2}$/.test(code)) {
    throw new AppException('INVALID_INPUT', `${providerName} state targeting needs the two-letter state code. Pick the state from the location list.`, `state=${target.state ?? ''}`)
  }
  return code
}

/**
 * The most precise level a target can actually be sent at: its mode, stepped down
 * (zip → city → state → country) while the field that level needs is missing.
 */
export function effectiveTargetMode(target: GeoTarget): TargetMode {
  const order: TargetMode[] = ['zip', 'city', 'state', 'country']
  const has: Record<TargetMode, boolean> = {
    zip: Boolean(target.zip),
    city: Boolean(target.city),
    state: Boolean(target.state || target.stateCode),
    country: true,
  }
  return order.slice(order.indexOf(target.mode)).find((mode) => has[mode]) ?? 'country'
}

/** The proxy server URL for a gateway host and port. */
export function gatewayServer(credentials: { host: string; port: number }): string {
  return `http://${credentials.host}:${credentials.port}`
}

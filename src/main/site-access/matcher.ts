/**
 * Pure matching logic for site access tokens (no Electron, no Playwright, no I/O).
 *
 * v1 matching is EXACT origin only: a request gets a token's header when the request URL's origin
 * (scheme + host + port, as normalised by the WHATWG URL parser: lower-case host, punycode IDN,
 * default port elided) is one of the token's listed origins. The path is ignored. There are no
 * wildcards, no subdomain matching and no scheme upgrades.
 */
import { parseSiteAccessOrigin } from '@shared/site-access'

/** A token ready to apply: enabled, with its decrypted value (lives in main-process memory only). */
export interface SiteAccessRule {
  id: string
  name: string
  /** Normalised origins (`parseSiteAccessOrigin`). */
  origins: readonly string[]
  headerName: string
  headerValue: string
}

/** One token applied to one request. */
export interface SiteAccessApplication {
  tokenId: string
  tokenName: string
  origin: string
}

export interface SiteAccessMatch {
  /** Lower-case header name → value. */
  headers: Record<string, string>
  applied: SiteAccessApplication[]
}

export interface SiteAccessMatcher {
  /** Headers to add to a request for `url`, or null when no token applies to its origin. */
  match(url: string | URL): SiteAccessMatch | null
  /** Every origin some token applies to. */
  readonly origins: ReadonlySet<string>
}

/** Origin of a request URL when it is an http(s) URL; null for anything else (data:, blob:, about:, invalid). */
export function requestOrigin(url: string | URL): string | null {
  let parsed: URL
  try {
    parsed = typeof url === 'string' ? new URL(url) : url
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  return parsed.origin
}

/** Normalise a list of origins; invalid entries are dropped (stored tokens were validated on save). */
export function normalizeOrigins(origins: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of origins) {
    const parsed = parseSiteAccessOrigin(raw)
    if (parsed.ok && !out.includes(parsed.origin)) out.push(parsed.origin)
  }
  return out
}

export function createSiteAccessMatcher(rules: readonly SiteAccessRule[]): SiteAccessMatcher {
  const byOrigin = new Map<string, SiteAccessRule[]>()
  for (const rule of rules) {
    for (const origin of normalizeOrigins(rule.origins)) {
      const list = byOrigin.get(origin) ?? []
      list.push(rule)
      byOrigin.set(origin, list)
    }
  }
  return {
    origins: new Set(byOrigin.keys()),
    match(url) {
      const origin = requestOrigin(url)
      if (!origin) return null
      const matching = byOrigin.get(origin)
      if (!matching || matching.length === 0) return null
      const headers: Record<string, string> = {}
      const applied: SiteAccessApplication[] = []
      for (const rule of matching) {
        const key = rule.headerName.toLowerCase()
        // Save-time validation forbids two tokens sending the same header to one origin; first wins regardless.
        if (key in headers) continue
        headers[key] = rule.headerValue
        applied.push({ tokenId: rule.id, tokenName: rule.name, origin })
      }
      return { headers, applied }
    },
  }
}

export interface SiteAccessConflictCandidate {
  id: string
  name: string
  origins: readonly string[]
  headerName: string
}

/**
 * Two tokens that would send the same header name to the same origin are ambiguous: report each
 * clash as an actionable message (empty when there is none). Disabled tokens count too, so enabling
 * one later can never create an ambiguity.
 */
export function findSiteAccessConflicts(tokens: readonly SiteAccessConflictCandidate[]): string[] {
  const seen = new Map<string, SiteAccessConflictCandidate>()
  const problems: string[] = []
  for (const token of tokens) {
    for (const origin of normalizeOrigins(token.origins)) {
      const key = `${origin}\n${token.headerName.toLowerCase()}`
      const other = seen.get(key)
      if (other && other.id !== token.id) {
        problems.push(`"${token.name}" and "${other.name}" both send ${token.headerName} to ${origin}. Remove the origin from one of them.`)
        continue
      }
      seen.set(key, token)
    }
  }
  return problems
}

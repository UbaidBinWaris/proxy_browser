/**
 * Site access tokens — shared contract (renderer + main).
 *
 * The operator configures their OWN site / WAF to allowlist requests carrying a secret header;
 * this app attaches that header only to the exact origins the operator lists. It is an
 * allowlisting aid for the operator's own QA traffic, never a way to evade someone else's bot
 * protection: the header name is operator-defined and checked against a deny-list (no identity,
 * cookie, IP-forwarding or browser-controlled headers), and it is never sent to any other origin.
 *
 * The secret value is write-only: the renderer sends it on save and only ever receives a masked
 * preview back.
 */
import { z } from 'zod'

export const SITE_ACCESS_MAX_ORIGINS = 20
export const SITE_ACCESS_MAX_VALUE_LENGTH = 4096
export const SITE_ACCESS_MAX_NAME_LENGTH = 120
export const SITE_ACCESS_MAX_HEADER_NAME_LENGTH = 128

/** Hosts allowed over plain http (local staging only). */
export const SITE_ACCESS_LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]']

/**
 * Header names that may never carry a token (compared case-insensitively). Besides the
 * connection/identity headers the browser owns, this blocks client-IP and user-agent headers so the
 * feature cannot be used to spoof who or where the client is.
 */
export const SITE_ACCESS_DENIED_HEADERS: readonly string[] = [
  'host',
  'cookie',
  'cookie2',
  'set-cookie',
  'authorization',
  'proxy-authorization',
  'content-length',
  'content-type',
  'content-encoding',
  'transfer-encoding',
  'te',
  'trailer',
  'connection',
  'keep-alive',
  'upgrade',
  'expect',
  'origin',
  'referer',
  'user-agent',
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'date',
  'dnt',
  'via',
  'forwarded',
  'x-real-ip',
  'x-client-ip',
  'true-client-ip',
  'cf-connecting-ip',
]
/** Prefixes that may never carry a token: browser-controlled and proxy / IP-forwarding headers. */
export const SITE_ACCESS_DENIED_HEADER_PREFIXES: readonly string[] = ['sec-', 'proxy-', 'x-forwarded-']

/** RFC 9110 `token` characters. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
/** Visible ASCII with inner spaces; no leading/trailing whitespace, no control characters. */
const HEADER_VALUE_PATTERN = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/

/** Why `name` cannot be used as a site access header, or null when it can. */
export function siteAccessHeaderNameProblem(name: string): string | null {
  if (name.length === 0) return 'Enter a header name.'
  if (name.length > SITE_ACCESS_MAX_HEADER_NAME_LENGTH) return `Use at most ${SITE_ACCESS_MAX_HEADER_NAME_LENGTH} characters.`
  if (!HEADER_NAME_PATTERN.test(name)) return 'Use letters, digits and - _ . only (an HTTP header name, e.g. X-QA-Access).'
  const lower = name.toLowerCase()
  if (SITE_ACCESS_DENIED_HEADERS.includes(lower) || SITE_ACCESS_DENIED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix)))
    return `"${name}" is controlled by the browser or identifies the client and cannot carry a token. Use a custom header such as X-QA-Access.`
  return null
}

/** Why `value` cannot be sent as a header value, or null when it can. */
export function siteAccessHeaderValueProblem(value: string): string | null {
  if (value.length === 0) return 'Enter the secret value.'
  if (value.length > SITE_ACCESS_MAX_VALUE_LENGTH) return `Use at most ${SITE_ACCESS_MAX_VALUE_LENGTH} characters.`
  if (!HEADER_VALUE_PATTERN.test(value)) return 'Use printable ASCII characters without leading or trailing spaces.'
  return null
}

export type OriginParse = { ok: true; origin: string } | { ok: false; error: string }

/**
 * Normalise one origin the operator typed: scheme + host + port only (case, IDN and the default
 * port are normalised by the URL parser). https is required; http is accepted only for loopback
 * hosts (local staging). A path other than "/", a query, a fragment, credentials or wildcards are
 * rejected so the operator always sees exactly what matches.
 */
export function parseSiteAccessOrigin(raw: string): OriginParse {
  const input = raw.trim()
  if (input.length === 0) return { ok: false, error: 'Enter an origin such as https://ubaidbinwaris.com.' }
  if (input.includes('*')) return { ok: false, error: `"${input}": wildcards are not supported; list each exact origin.` }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { ok: false, error: `"${input}" is not a valid origin. Use the form https://host[:port].` }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return { ok: false, error: `"${input}": only https origins are supported.` }
  if (url.protocol === 'http:' && !SITE_ACCESS_LOOPBACK_HOSTS.includes(url.hostname))
    return { ok: false, error: `"${input}": plain http is allowed only for localhost and 127.0.0.1. Use https.` }
  if (url.username || url.password) return { ok: false, error: `"${input}": remove the user name and password.` }
  if (url.pathname !== '/' || url.search || url.hash)
    return { ok: false, error: `"${input}": enter the origin only (scheme, host and optional port), without a path, query or fragment.` }
  if (!url.hostname) return { ok: false, error: `"${input}" has no host.` }
  return { ok: true, origin: url.origin }
}

const OriginListSchema = z
  .array(z.string().max(2048))
  .min(1, 'List at least one origin.')
  .max(SITE_ACCESS_MAX_ORIGINS, `List at most ${SITE_ACCESS_MAX_ORIGINS} origins.`)
  .transform((origins, ctx) => {
    const normalized: string[] = []
    for (const [index, raw] of origins.entries()) {
      const parsed = parseSiteAccessOrigin(raw)
      if (!parsed.ok) {
        ctx.addIssue({ code: 'custom', message: parsed.error, path: [index] })
        continue
      }
      if (normalized.includes(parsed.origin)) {
        ctx.addIssue({ code: 'custom', message: `${parsed.origin} is listed twice.`, path: [index] })
        continue
      }
      normalized.push(parsed.origin)
    }
    return normalized
  })

const HeaderNameSchema = z
  .string()
  .trim()
  .superRefine((name, ctx) => {
    const problem = siteAccessHeaderNameProblem(name)
    if (problem) ctx.addIssue({ code: 'custom', message: problem })
  })

const HeaderValueSchema = z.string().superRefine((value, ctx) => {
  const problem = siteAccessHeaderValueProblem(value)
  if (problem) ctx.addIssue({ code: 'custom', message: problem })
})

/**
 * What the renderer sends on save. `headerValue` is required for a new token; on an update an
 * omitted or empty value keeps the stored secret.
 */
export const SiteAccessTokenInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(SITE_ACCESS_MAX_NAME_LENGTH),
  origins: OriginListSchema,
  headerName: HeaderNameSchema,
  headerValue: z.union([z.literal(''), HeaderValueSchema]).optional(),
  enabled: z.boolean().default(true),
})
export type SiteAccessTokenInput = z.input<typeof SiteAccessTokenInputSchema>
export type SiteAccessTokenParsed = z.output<typeof SiteAccessTokenInputSchema>

/** What the renderer gets back: never the secret, only a masked preview. */
export interface SiteAccessTokenSummary {
  id: string
  name: string
  origins: string[]
  headerName: string
  enabled: boolean
  /** e.g. "••••••••3f9a"; never the value itself. */
  valuePreview: string
  /** False when the stored value cannot be decrypted on this device (re-enter it). */
  valueAvailable: boolean
  updatedAt: string
}

export interface SiteAccessStatus {
  /** False when no usable OS keychain exists (tokens can be neither saved nor applied). */
  available: boolean
  /** Why tokens are unavailable, when they are. */
  reason: string | null
  tokens: SiteAccessTokenSummary[]
}

/** Masked preview of a secret: only the last 4 characters of a long value are ever shown. */
export function maskSiteAccessValue(value: string): string {
  const dots = '••••••••'
  return value.length >= 16 ? `${dots}${value.slice(-4)}` : dots
}

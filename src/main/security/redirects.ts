/**
 * Shared, mostly pure helpers for handling HTTP redirects manually inside Playwright routes.
 *
 * Playwright routes only the FIRST request of an HTTP redirect chain, and a header added with
 * `route.continue/fallback({ headers })` is re-sent by every engine on redirect hops. Both the site
 * access token adapter (src/main/site-access/attach.ts) and the QA navigation guard
 * (src/main/qa/navigation.ts) therefore fetch documents with `maxRedirects: 0` and, when a redirect
 * may be followed, fulfill the request with a tiny "trampoline" page that makes the BROWSER start a
 * fresh navigation to the next URL. That navigation is routed again from scratch, so every hop is
 * checked (origin allowlist, site access matching) as if it were the first request.
 */

/** Redirect statuses that carry a Location the browser would follow. */
export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * A minimal document that replaces itself with `target` (script first, meta refresh when scripts are
 * disabled). `target` must already be an absolute http(s) URL. `location.replace` keeps the
 * trampoline out of the session history, like a real redirect.
 */
export function redirectTrampoline(target: string): string {
  const script = JSON.stringify(target).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  const attribute = escapeHtmlAttribute(target)
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${attribute}"><script>location.replace(${script})</script></head><body></body></html>`
}

/** Fulfill options for a trampoline (spread into `route.fulfill`). */
export function trampolineResponse(target: string): { status: number; contentType: string; headers: Record<string, string>; body: string } {
  return { status: 200, contentType: 'text/html; charset=utf-8', headers: { 'cache-control': 'no-store' }, body: redirectTrampoline(target) }
}

/** Resolve a Location header against the URL that answered with it; null for unparsable or non-web targets. */
export function resolveRedirectTarget(location: string, base: string): URL | null {
  let target: URL
  try {
    target = new URL(location, base)
  } catch {
    return null
  }
  return target.protocol === 'https:' || target.protocol === 'http:' ? target : null
}

/** Most document redirects a QA navigation follows before it is stopped as a loop. */
export const MAX_DOCUMENT_REDIRECTS = 10

export type DocumentRedirectDecision =
  /** The browser performs a fresh GET navigation to `target` (served through a trampoline). */
  | { kind: 'navigate'; target: URL }
  /** 307/308 of a non-GET request within the same origin: re-send the same method and body to `target`. */
  | { kind: 'replay'; target: URL }
  | {
      kind: 'block'
      reason: 'disabled' | 'invalid-location' | 'unapproved-origin' | 'hop-limit' | 'cross-origin-method'
      message: string
      target: URL | null
    }

export interface DocumentRedirectInput {
  status: number
  location: string
  /** The URL that answered with the redirect. */
  requestUrl: string
  /** Method of the request that answered with the redirect. */
  method: string
  allowedOrigins: readonly string[]
  /** Redirects already followed in this chain (0 for the first redirect). */
  hops: number
  followRedirects?: boolean
  maxRedirects?: number
}

export const REDIRECTS_DISABLED_MESSAGE =
  'HTTP document redirects are blocked for this scenario (follow redirects is off). Use the final URL or an explicit navigation step.'

/**
 * Decide what to do with one document redirect, in this order: policy, Location validity, origin
 * allowlist, hop limit, then method semantics (301/302/303 become a GET like in every browser;
 * 307/308 keep method and body, which is only done within the same origin).
 */
export function decideDocumentRedirect(input: DocumentRedirectInput): DocumentRedirectDecision {
  const target = resolveRedirectTarget(input.location, input.requestUrl)
  if (input.followRedirects === false) return { kind: 'block', reason: 'disabled', message: REDIRECTS_DISABLED_MESSAGE, target }
  if (!target)
    return { kind: 'block', reason: 'invalid-location', message: `An HTTP ${input.status} redirect to an invalid or non-web URL was blocked.`, target: null }
  if (!input.allowedOrigins.includes(target.origin))
    return {
      kind: 'block',
      reason: 'unapproved-origin',
      message: `Navigation to an unapproved origin (${target.origin}) was blocked (HTTP ${input.status} redirect).`,
      target,
    }
  const max = input.maxRedirects ?? MAX_DOCUMENT_REDIRECTS
  if (input.hops >= max)
    return { kind: 'block', reason: 'hop-limit', message: `Stopped after ${max} HTTP redirects (redirect loop or too many hops).`, target }
  const method = input.method.toUpperCase()
  if ((input.status === 307 || input.status === 308) && method !== 'GET' && method !== 'HEAD') {
    if (target.origin !== new URL(input.requestUrl).origin)
      return {
        kind: 'block',
        reason: 'cross-origin-method',
        message: `An HTTP ${input.status} redirect of a ${method} request to another origin (${target.origin}) was blocked: the request body is only re-sent within the same origin.`,
        target,
      }
    return { kind: 'replay', target }
  }
  return { kind: 'navigate', target }
}

/** Key for matching a trampoline's follow-up navigation (requests never carry the fragment). */
export function redirectKey(url: string | URL): string {
  const copy = new URL(url)
  copy.hash = ''
  return copy.href
}

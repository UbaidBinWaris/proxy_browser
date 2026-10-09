import type { Request, Route } from 'playwright-core'
import { decideDocumentRedirect, isRedirectStatus, redirectKey, trampolineResponse } from '../security/redirects'

/** One document redirect the guard saw. URLs are raw: redact them before storing as evidence. */
export interface NavigationRedirectEvent {
  /** The navigation request the guard was handling when the redirect arrived. */
  request: Request
  status: number
  /** URL that answered with the redirect. */
  from: string
  /** Resolved Location; null when it could not be parsed or is not http(s). */
  to: string | null
  followed: boolean
  /**
   * How a followed hop continues: `trampoline` = the browser starts a fresh navigation to `to` (routed
   * and checked again from scratch); `replay` = a same-origin 307/308 re-sent inside this route with
   * the same method and body (the document keeps the original URL).
   */
  via?: 'trampoline' | 'replay'
  /** Why the hop was blocked. */
  message?: string
}

export interface NavigationGuardOptions {
  /** Follow redirects whose every hop stays within the approved origins (default true). */
  followRedirects?: boolean
  maxRedirects?: number
  onRedirect?: (event: NavigationRedirectEvent) => void
  /**
   * Body to send instead of the intercepted one (for example multipart file parts the engine left empty,
   * see upload-body.ts); undefined keeps the browser's body. Never changes the URL or headers.
   */
  requestBody?: (request: Request) => Buffer | null | undefined
}

/** Trampoline targets awaiting their follow-up navigation are bounded, oldest dropped first. */
const MAX_PENDING_CHAINS = 64

/**
 * Context route that keeps document navigation on the approved origins.
 *
 * Playwright routes only the first request of an HTTP redirect chain, so documents are fetched with
 * `maxRedirects: 0` and every redirect is decided here (src/main/security/redirects.ts): a hop to an
 * approved origin is followed through a trampoline — a fresh browser navigation that is routed and
 * checked again, receives the cookies set by the 3xx (same cookie jar), and gets a site access
 * header only if its own origin is token-listed — while a hop to an unapproved origin is aborted
 * before any request reaches it. The guard never adds or forwards headers to another origin itself.
 */
export function navigationGuard(
  allowedOrigins: string[],
  timeoutMs: number,
  onBlocked: (message: string) => void,
  options: NavigationGuardOptions = {},
): (route: Route) => Promise<void> {
  // Redirect target → redirects already followed in that chain, so hop limits span trampolines.
  const pending = new Map<string, number>()
  return async (route: Route): Promise<void> => {
    const request = route.request()
    if (!request.isNavigationRequest()) {
      // fallback (not continue): with no other route this continues the request unchanged, and it lets an
      // earlier-registered handler (site access tokens, src/main/site-access/attach.ts) perform it safely.
      await route.fallback()
      return
    }
    const origin = new URL(request.url()).origin
    if (!allowedOrigins.includes(origin)) {
      onBlocked(`Navigation to an unapproved origin (${origin}) was blocked.`)
      await route.abort('blockedbyclient')
      return
    }
    const key = redirectKey(request.url())
    const method = request.method()
    let hops = 0
    if (method === 'GET' && pending.has(key)) {
      hops = pending.get(key) ?? 0
      pending.delete(key)
    }
    let url = request.url()
    let replayUrl: string | undefined
    const body = method === 'GET' || method === 'HEAD' ? undefined : (options.requestBody?.(request) ?? undefined)
    try {
      for (;;) {
        // Same proxy, cookie jar and headers as the browser request (including a site access header the page
        // decorator added for this origin). A replay changes only the URL, and only within the same origin.
        const response = await route.fetch({ maxRedirects: 0, timeout: timeoutMs, ...(replayUrl ? { url: replayUrl } : {}), ...(body ? { postData: body } : {}) })
        try {
          const location = response.headers()['location']
          if (!isRedirectStatus(response.status()) || !location) {
            await route.fulfill({ response })
            return
          }
          const status = response.status()
          const decision = decideDocumentRedirect({
            status,
            location,
            requestUrl: url,
            method,
            allowedOrigins,
            hops,
            ...(options.followRedirects === undefined ? {} : { followRedirects: options.followRedirects }),
            ...(options.maxRedirects === undefined ? {} : { maxRedirects: options.maxRedirects }),
          })
          const to = decision.target?.href ?? null
          if (decision.kind === 'block') {
            options.onRedirect?.({ request, status, from: url, to, followed: false, message: decision.message })
            onBlocked(decision.message)
            await route.abort('blockedbyclient')
            return
          }
          hops += 1
          if (decision.kind === 'replay') {
            options.onRedirect?.({ request, status, from: url, to, followed: true, via: 'replay' })
            url = decision.target.href
            replayUrl = url
            continue
          }
          pending.set(redirectKey(decision.target), hops)
          while (pending.size > MAX_PENDING_CHAINS) pending.delete(pending.keys().next().value as string)
          options.onRedirect?.({ request, status, from: url, to, followed: true, via: 'trampoline' })
          await route.fulfill(trampolineResponse(decision.target.href))
          return
        } finally {
          await response.dispose().catch(() => undefined)
        }
      }
    } catch {
      await route.abort('failed').catch(() => undefined)
    }
  }
}

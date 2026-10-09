/**
 * Playwright adapter: attaches site access headers to exactly the requests whose origin a token
 * lists — and to nothing else.
 *
 * Why not `setExtraHTTPHeaders` or a `'**\/*'` route that adds the header everywhere: both would
 * send the secret to every third-party host the page loads. Here only requests matching the pure
 * matcher (exact origin) are ever handled; every other request is left untouched.
 *
 * Redirect safety (verified per engine by tests/site-access-browser.test.ts): when a header is
 * added with `route.continue({ headers })` or `route.fallback({ headers })`, Chromium, Firefox AND
 * WebKit all re-send that header on the redirect hop — a 302 from an allowlisted origin to another
 * origin leaks the secret. Playwright also does not route redirect hops. So a tokenized request is
 * never handed back to the browser with the header; instead it is performed by Playwright's request
 * client (`route.fetch`, same proxy and cookie jar as the context) with `maxRedirects: 0` and the
 * response is fulfilled:
 *
 * - a non-redirect response is fulfilled as-is;
 * - a document redirect is fulfilled with a tiny "trampoline" page that replaces itself with the
 *   Location (http/https only). That is a NEW navigation, routed again from scratch: it gets the
 *   header only if its own origin is listed. 307/308 redirects of non-GET documents cannot be
 *   replayed that way and are blocked;
 * - a sub-resource redirect is fulfilled as the original 3xx (Chromium/Firefox then follow it as a
 *   browser request that never carried the header); WebKit refuses to fulfill a 3xx, so there the
 *   sub-resource is failed instead of followed.
 *
 * Composition with other routes (the QA navigation guard): handlers run in reverse registration
 * order, so a context route registered at context creation runs LAST. The terminal handler above is
 * registered there; other handlers must `route.fallback()` to reach it (the guard does). In addition a
 * page-level "decorator" on every page adds the header as a fallback override BEFORE any context
 * route, so a handler that performs the request itself (the guard fetches documents with redirects
 * disabled and follows approved ones through the shared trampoline in src/main/security/redirects.ts)
 * sends it too. The decorator never continues a request on its own.
 *
 * Not covered (fail closed — the header is simply absent): requests answered by a service worker
 * (Playwright does not route them), WebSockets, and the very first request of a popup in a QA run.
 * Routing disables the HTTP cache of a context, so nothing is registered when no token is enabled.
 */
import type { BrowserContext, Page, Request, Route } from 'playwright-core'
import { emptyFileParts, multipartBoundary, restoreMultipartFiles } from '../security/multipart-files'
import { installFileCapture } from './file-capture'
import type { FileCapture } from './file-capture'
import { createSiteAccessMatcher } from './matcher'
import type { SiteAccessApplication, SiteAccessMatcher, SiteAccessRule } from './matcher'
import { isRedirectStatus, redirectTrampoline, trampolineResponse } from '../security/redirects'

// The trampoline lives in the shared redirect module (also used by the QA navigation guard).
export { redirectTrampoline }

/** Upper bound for one tokenized request performed through `route.fetch`. */
export const SITE_ACCESS_FETCH_TIMEOUT_MS = 60_000

export interface AttachSiteAccessOptions {
  /** Called once per (token, origin) the first time the header is actually sent in this context. */
  onApplied?: (application: SiteAccessApplication) => void
  /** Called when a tokenized redirect is blocked instead of followed. */
  onBlocked?: (message: string) => void
  fetchTimeoutMs?: number
}

/**
 * Attach the given (enabled, decrypted) tokens to a context. Resolves once routing is in place;
 * returns at once without touching the context when there is nothing to apply.
 */
/**
 * The body to send for a multipart upload whose file bytes the browser left out: refilled from the
 * files kept on the page (file-capture.ts). null = send the request unchanged; 'unavailable' = some
 * chosen file's bytes are not available, so sending would upload an empty file.
 */
async function uploadBody(request: Request, capture: FileCapture): Promise<Buffer | null | 'unavailable'> {
  const contentType = request.headers()['content-type']
  if (!multipartBoundary(contentType)) return null
  const body = request.postDataBuffer()
  const missing = emptyFileParts(contentType, body)
  if (missing.length === 0) return null
  let origin: string
  try {
    origin = new URL(request.frame().url()).origin
  } catch {
    return 'unavailable'
  }
  const files = await capture.files(origin, missing)
  // A file that really is empty was kept with zero bytes: nothing to restore for it.
  if (missing.some((name) => !files.has(name))) return 'unavailable'
  return restoreMultipartFiles(contentType, body, files)
}

export async function attachSiteAccessRules(context: BrowserContext, rules: readonly SiteAccessRule[], options: AttachSiteAccessOptions = {}): Promise<void> {
  if (rules.length === 0) return
  const matcher: SiteAccessMatcher = createSiteAccessMatcher(rules)
  if (matcher.origins.size === 0) return
  const timeout = options.fetchTimeoutMs ?? SITE_ACCESS_FETCH_TIMEOUT_MS
  // Playwright's WebKit refuses to fulfill a 3xx; Chromium and Firefox follow a fulfilled 3xx themselves.
  const engine = context.browser()?.browserType().name()
  const canFulfillRedirect = engine === 'chromium' || engine === 'firefox'
  const reported = new Set<string>()
  const predicate = (url: URL): boolean => matcher.match(url) !== null
  // Keep files picked on token-listed origins so multipart uploads can be forwarded with their bytes.
  const capture = await installFileCapture(context, matcher.origins)

  const report = (applied: readonly SiteAccessApplication[]): void => {
    for (const application of applied) {
      const key = `${application.tokenId}\n${application.origin}`
      if (reported.has(key)) continue
      reported.add(key)
      options.onApplied?.(application)
    }
  }

  const terminal = async (route: Route): Promise<void> => {
    const request = route.request()
    const match = matcher.match(request.url())
    if (!match) {
      await route.fallback()
      return
    }
    // request.headers() already includes the page decorator's override; re-applying is idempotent.
    const headers = { ...request.headers(), ...match.headers }
    const upload = await uploadBody(request, capture)
    if (upload === 'unavailable') {
      options.onBlocked?.(
        'A file upload to a site access origin was blocked: the browser did not expose the file contents (files over 25 MB are not kept). Upload it without the token, or use a smaller file.',
      )
      await route.abort('failed').catch(() => undefined)
      return
    }
    let response: Awaited<ReturnType<Route['fetch']>>
    try {
      response = await route.fetch({ headers, maxRedirects: 0, timeout, ...(upload ? { postData: upload } : {}) })
    } catch {
      await route.abort('failed').catch(() => undefined)
      return
    }
    try {
      report(match.applied)
      const location = response.headers()['location']
      if (!isRedirectStatus(response.status()) || !location) {
        await route.fulfill({ response })
        return
      }
      let target: URL | null = null
      try {
        target = new URL(location, request.url())
      } catch {
        target = null
      }
      if (!target || (target.protocol !== 'https:' && target.protocol !== 'http:')) {
        options.onBlocked?.('A redirect from a site access origin to a non-web URL was blocked.')
        await route.abort('blockedbyclient')
        return
      }
      if (request.isNavigationRequest()) {
        const method = request.method()
        if ((response.status() === 307 || response.status() === 308) && method !== 'GET' && method !== 'HEAD') {
          options.onBlocked?.(`A ${response.status()} redirect of a ${method} request from a site access origin was blocked (the request body cannot be re-sent safely).`)
          await route.abort('blockedbyclient')
          return
        }
        // A fresh navigation: routed again from scratch, so it carries the header only if its own origin is listed.
        await route.fulfill(trampolineResponse(target.href))
        return
      }
      if (canFulfillRedirect) {
        // The browser follows this 3xx itself with its own request, which never carried the header.
        await route.fulfill({ response })
        return
      }
      // WebKit cannot fulfill a redirect status: fail the sub-resource instead of following it.
      options.onBlocked?.('A sub-resource redirect from a site access origin was blocked (WebKit cannot follow it without re-sending the header).')
      await route.abort('failed')
    } catch {
      // The page or context went away mid-request; never leave the route pending.
      await route.abort('failed').catch(() => undefined)
    } finally {
      await response.dispose().catch(() => undefined)
    }
  }

  const decorator = async (route: Route): Promise<void> => {
    const match = matcher.match(route.request().url())
    if (!match) {
      await route.fallback()
      return
    }
    report(match.applied)
    await route.fallback({ headers: { ...route.request().headers(), ...match.headers } })
  }

  const decorate = (page: Page): void => {
    void page.route(predicate, decorator).catch(() => undefined)
  }

  await context.route(predicate, terminal)
  context.on('page', decorate)
  await Promise.all(context.pages().map((page) => page.route(predicate, decorator)))
}

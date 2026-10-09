/**
 * Per-page navigation state for the QA executor: the status of the page's current document, and
 * waiting until a main-frame navigation or a redirect chain the guard is following has reached its
 * final document (or was blocked or failed, which fails the waiting step).
 *
 * A followed redirect is served as a trampoline page that starts a fresh navigation, so "the
 * navigation finished" is not enough: the chain ends only when the main frame commits the URL the
 * last followed hop pointed to. Navigation requests still waiting for their response are tracked too,
 * so a step whose click starts a navigation without Playwright waiting for it (for example from a
 * timer) still ends on the final page. `assertStatus` additionally allows a short grace period for a
 * navigation an action scheduled but the browser has not started yet.
 */
import type { Frame, Page, Request, Response } from 'playwright-core'
import type { NavigationRedirectEvent } from './navigation'
import { redirectKey } from '../security/redirects'

/** How long `assertStatus` waits for a navigation the previous action may have scheduled. */
export const NAVIGATION_GRACE_MS = 500

export const REDIRECT_TIMEOUT_MESSAGE = 'A followed redirect did not reach its final page in time.'

export interface PageTracker {
  /** Status of the latest main-frame document (a trampoline reports the 3xx it replaces). */
  lastStatus(): number | null
  /** Feed a redirect hop the guard decided for one of this page's main-frame requests. */
  redirect(event: NavigationRedirectEvent): void
  /** Called when an action step ends; `settle({ graceMs })` then waits for a navigation it scheduled. */
  markAction(): void
  /**
   * Wait (≤ timeoutMs) until no main-frame navigation is in flight and no followed redirect chain is
   * pending, then for the final document's DOM. Throws when a hop was blocked, a redirected navigation
   * failed, or a chain did not finish in time.
   */
  settle(timeoutMs: number, signal: AbortSignal, options?: { graceMs?: number }): Promise<void>
  dispose(): void
}

export function trackPage(page: Page): PageTracker {
  let lastStatus: number | null = null
  let pendingRedirect: string | null = null
  let redirectFailure: string | null = null
  const inflight = new Set<Request>()
  let navigations = 0
  let actionMark: number | null = null
  const trampolineStatus = new WeakMap<Request, number>()
  let waiters: Array<() => void> = []
  const wake = (): void => {
    const pending = waiters
    waiters = []
    for (const resolve of pending) resolve()
  }
  const isMainFrame = (request: Request): boolean => {
    try {
      return request.isNavigationRequest() && request.frame() === page.mainFrame()
    } catch {
      return false
    }
  }
  const endRedirect = (failure: string | null): void => {
    pendingRedirect = null
    if (failure) redirectFailure = failure
    wake()
  }
  const onRequest = (request: Request): void => {
    if (!isMainFrame(request)) return
    inflight.add(request)
    navigations += 1
    wake()
  }
  const onResponse = (response: Response): void => {
    const request = response.request()
    if (!request.isNavigationRequest() || response.frame() !== page.mainFrame()) return
    // A trampoline stands in for the 3xx it replaces; the final document's status overwrites it.
    lastStatus = trampolineStatus.get(request) ?? response.status()
    inflight.delete(request)
    wake()
  }
  const onFailed = (request: Request): void => {
    if (!isMainFrame(request)) return
    inflight.delete(request)
    if (pendingRedirect !== null && redirectKey(request.url()) === pendingRedirect)
      endRedirect(`A redirected navigation failed (${request.failure()?.errorText ?? 'network error'}).`)
    wake()
  }
  const onFrameNavigated = (frame: Frame): void => {
    if (pendingRedirect !== null && frame === page.mainFrame() && redirectKey(frame.url()) === pendingRedirect)
      endRedirect(null)
  }
  const onClose = (): void => {
    inflight.clear()
    pendingRedirect = null
    wake()
  }
  page.on('request', onRequest)
  page.on('response', onResponse)
  page.on('requestfailed', onFailed)
  page.on('framenavigated', onFrameNavigated)
  page.on('close', onClose)

  /** Resolves true on any state change, false on timeout or abort. */
  const changed = (ms: number, signal: AbortSignal): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), Math.max(0, ms))
      const onAbort = (): void => finish(false)
      function finish(value: boolean): void {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      waiters.push(() => finish(true))
    })

  return {
    lastStatus: () => lastStatus,
    redirect(event) {
      if (!isMainFrame(event.request)) return
      if (!event.followed) endRedirect(event.message ?? 'A redirect was blocked.')
      else if (event.via === 'trampoline' && event.to) {
        trampolineStatus.set(event.request, event.status)
        pendingRedirect = redirectKey(event.to)
        wake()
      }
    },
    markAction() {
      actionMark = navigations
    },
    async settle(timeoutMs, signal, options = {}) {
      const deadline = Date.now() + timeoutMs
      const mark = actionMark
      actionMark = null
      const graceMs = options.graceMs ?? 0
      if (graceMs > 0 && mark !== null && navigations === mark && !page.isClosed()) {
        const until = Math.min(deadline, Date.now() + graceMs)
        while (navigations === mark && inflight.size === 0 && pendingRedirect === null && Date.now() < until)
          await changed(until - Date.now(), signal)
      }
      let waited = false
      while (inflight.size > 0 || pendingRedirect !== null) {
        signal.throwIfAborted()
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          if (pendingRedirect !== null) {
            pendingRedirect = null
            throw new Error(REDIRECT_TIMEOUT_MESSAGE)
          }
          // A slow document without a redirect: the next step's own waits apply.
          break
        }
        waited = true
        await changed(remaining, signal)
      }
      signal.throwIfAborted()
      if (waited && !redirectFailure && !page.isClosed())
        await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs })
      if (redirectFailure) {
        const message = redirectFailure
        redirectFailure = null
        throw new Error(message)
      }
    },
    dispose() {
      page.off('request', onRequest)
      page.off('response', onResponse)
      page.off('requestfailed', onFailed)
      page.off('framenavigated', onFrameNavigated)
      page.off('close', onClose)
      onClose()
    },
  }
}

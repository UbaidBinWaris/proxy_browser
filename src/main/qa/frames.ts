/**
 * Action steps inside iframes: the executor resolves a step's frame path (iframe selectors, outermost
 * first) to a Playwright Frame, checking at every level that the frame shows an approved origin. A frame
 * from an unapproved origin never loads (the navigation guard aborts it), and a step targeting it fails
 * with a message that says why instead of timing out on a missing element.
 */
import type { Frame, Page } from 'playwright-core'

export type FrameVerdict =
  | { status: 'approved' }
  | { status: 'unapproved'; origin: string }
  /** Still loading, or its document failed (e.g. an error page). */
  | { status: 'not-loaded' }

const webOrigin = (url: string): string | null => {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null
  } catch {
    return null
  }
}

/**
 * Pure: may steps act inside a frame showing `documentUrl`, whose iframe element has `src`?
 * about:blank / about:srcdoc documents inherit the (already checked) parent's origin, unless the
 * iframe points at a web URL that has not loaded yet or was blocked.
 */
export function judgeFrame(documentUrl: string, src: string, allowedOrigins: readonly string[]): FrameVerdict {
  const documentOrigin = webOrigin(documentUrl)
  if (documentOrigin)
    return allowedOrigins.includes(documentOrigin) ? { status: 'approved' } : { status: 'unapproved', origin: documentOrigin }
  const srcOrigin = webOrigin(src)
  if (srcOrigin && !allowedOrigins.includes(srcOrigin)) return { status: 'unapproved', origin: srcOrigin }
  if (!srcOrigin && (documentUrl === '' || documentUrl === 'about:blank' || documentUrl === 'about:srcdoc'))
    return { status: 'approved' }
  return { status: 'not-loaded' }
}

export function unapprovedFrameMessage(selector: string, origin: string): string {
  return `The frame ${selector} is on an unapproved origin (${origin}), so steps cannot run inside it. Approve that origin only if it is your own test site.`
}

export function frameNotLoadedMessage(selector: string): string {
  return `The frame ${selector} did not load an approved page in time.`
}

/** The frame a step's frame path points to, within the step's time budget. */
export async function resolveFrame(
  page: Page,
  path: readonly string[],
  allowedOrigins: readonly string[],
  budgetMs: number,
): Promise<{ frame: Frame; remainingMs: number }> {
  const deadline = Date.now() + budgetMs
  // Playwright treats timeout 0 as "no timeout", so an exhausted budget must stay positive.
  const left = (): number => Math.max(1, deadline - Date.now())
  let root: Page | Frame = page
  for (const selector of path) {
    const handle = await root.locator(selector).elementHandle({ timeout: left() })
    try {
      const frame = await handle.contentFrame()
      if (!frame) throw new Error(`${selector} is not a frame element.`)
      for (;;) {
        const src = await handle
          .evaluate((element) => (element instanceof HTMLIFrameElement || element instanceof HTMLFrameElement ? element.src : ''))
          .catch(() => '')
        const verdict = judgeFrame(frame.url(), src, allowedOrigins)
        if (verdict.status === 'approved') break
        if (verdict.status === 'unapproved') throw new Error(unapprovedFrameMessage(selector, verdict.origin))
        if (Date.now() >= deadline) throw new Error(frameNotLoadedMessage(selector))
        await frame.waitForLoadState('domcontentloaded', { timeout: Math.min(left(), 500) }).catch(() => undefined)
        await new Promise((resolve) => setTimeout(resolve, Math.min(left(), 100)))
      }
      root = frame
    } finally {
      await handle.dispose().catch(() => undefined)
    }
  }
  return { frame: root as Frame, remainingMs: left() }
}

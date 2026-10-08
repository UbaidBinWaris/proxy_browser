/**
 * `proxyqa://screenshot/<encodeURIComponent(absolutePath)>` resolution.
 *
 * The renderer shows screenshots through this scheme instead of `file:`. Only
 * files inside the configured screenshot directory are served; anything else
 * (traversal, symlinks escaping the folder, other hosts) is refused.
 */
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

export const SCREENSHOT_SCHEME = 'proxyqa'
export const SCREENSHOT_HOST = 'screenshot'

export type ScreenshotRequest =
  | { kind: 'ok'; path: string }
  | { kind: 'forbidden'; reason: string }
  | { kind: 'bad-request'; reason: string }

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function safeRealpath(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

/**
 * Decide whether a request URL may be served from `screenshotDir`.
 * Pure apart from a realpath lookup used to defeat symlink escapes.
 */
export function resolveScreenshotRequest(rawUrl: string, screenshotDir: string): ScreenshotRequest {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { kind: 'bad-request', reason: 'Malformed URL' }
  }
  if (url.protocol !== `${SCREENSHOT_SCHEME}:` || url.hostname !== SCREENSHOT_HOST) {
    return { kind: 'bad-request', reason: 'Unsupported scheme or host' }
  }

  let decoded: string
  try {
    decoded = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  } catch {
    return { kind: 'bad-request', reason: 'Path is not valid percent-encoding' }
  }
  if (decoded.length === 0 || decoded.includes('\0')) {
    return { kind: 'bad-request', reason: 'Empty or invalid path' }
  }
  if (!isAbsolute(decoded)) {
    return { kind: 'forbidden', reason: 'Only absolute paths are accepted' }
  }

  const root = resolve(screenshotDir)
  const requested = resolve(decoded)
  if (!isInside(root, requested)) {
    return { kind: 'forbidden', reason: 'Path is outside the screenshot folder' }
  }

  const realRoot = safeRealpath(root) ?? root
  const realRequested = safeRealpath(requested)
  if (realRequested !== null && !isInside(realRoot, realRequested)) {
    return { kind: 'forbidden', reason: 'Path resolves outside the screenshot folder' }
  }

  return { kind: 'ok', path: realRequested ?? requested }
}

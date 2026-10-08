/**
 * Headless smoke launch used to verify an install: launch the engine with
 * `headless: true` (no window on any OS) → new context → about:blank → close,
 * within a time budget. Chromium-family launches carry a unique
 * `--proxy-qa-session=verify-<uuid>` marker so a browser that hangs and will
 * not close (Vivaldi under automation) can still be found and terminated.
 *
 * The bundled Chromium is launched through the 'chromium' channel: that runs
 * the full Chromium build in new-headless mode, so the separate headless-shell
 * download (deleted from bundled builds) is not needed.
 */
import { randomUUID } from 'node:crypto'

import { chromium, firefox, webkit } from 'playwright-core'
import type { Browser, BrowserType, LaunchOptions } from 'playwright-core'

import type { BrowserEngineFamily, BrowserEngineInfo } from '@shared/types'

import type { Logger } from '../contracts'
import { webkitLaunchEnv } from '../browser/browsers-path'
import { shortErrorText } from '../browser/error-mapping'
import { withTimeout } from '../util/timeout'
import type { ProcessToolkit } from '../system/processes'
import { sessionMarkerArg, sessionRootPids } from '../system/processes'

const SCOPE = 'tasks'
export const SMOKE_TIMEOUT_MS = 30_000
const CLOSE_BUDGET_MS = 5_000

export interface SmokeResult {
  ok: boolean
  detail: string | null
  durationMs: number
}

export type SmokeLauncher = (info: BrowserEngineInfo, options: { timeoutMs?: number; signal?: AbortSignal }) => Promise<SmokeResult>

export interface SmokeLauncherDeps {
  logger: Logger
  /** Directory of bundled WebKit host libraries (Linux), or null. */
  webkitLibsDir?: string | null
  /** Used to terminate a hung Chromium-family browser by its marker. */
  toolkit?: Pick<ProcessToolkit, 'listMarked' | 'killTree'>
  browserTypes?: Record<BrowserEngineFamily, Pick<BrowserType, 'launch'>>
  now?: () => number
}

/** Launch options for the smoke test (pure, unit-tested). */
export function smokeLaunchOptions(info: BrowserEngineInfo, markerId: string, timeoutMs: number, webkitLibsDir: string | null): LaunchOptions {
  const options: LaunchOptions = { headless: true, timeout: timeoutMs }
  if (info.family === 'chromium') options.args = [sessionMarkerArg(markerId)]
  if (info.kind === 'installed' && info.executablePath) options.executablePath = info.executablePath
  else if (info.id === 'chromium') options.channel = 'chromium'
  if (info.family === 'webkit' && webkitLibsDir) options.env = webkitLaunchEnv(webkitLibsDir)
  return options
}

export function createSmokeLauncher(deps: SmokeLauncherDeps): SmokeLauncher {
  const types = deps.browserTypes ?? { chromium, firefox, webkit }
  const now = deps.now ?? Date.now
  const webkitLibsDir = deps.webkitLibsDir ?? null

  const killMarked = async (markerId: string): Promise<void> => {
    if (!deps.toolkit) return
    try {
      const roots = sessionRootPids(await deps.toolkit.listMarked(), markerId)
      for (const pid of roots) await deps.toolkit.killTree(pid)
      if (roots.length > 0) deps.logger.info(SCOPE, `Terminated the hung verification browser (${roots.join(', ')})`, { pids: roots })
    } catch (err) {
      deps.logger.warn(SCOPE, `Could not terminate the verification browser: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return async (info, options) => {
    const timeoutMs = options.timeoutMs ?? SMOKE_TIMEOUT_MS
    const started = now()
    const markerId = `verify-${randomUUID()}`
    const held: { browser: Browser | null; timer: ReturnType<typeof setTimeout> | null } = { browser: null, timer: null }
    const work = (async (): Promise<void> => {
      const browser = (await types[info.family].launch(smokeLaunchOptions(info, markerId, timeoutMs, webkitLibsDir))) as Browser
      held.browser = browser
      const context = await browser.newContext()
      const page = await context.newPage()
      await page.goto('about:blank')
      await context.close()
      await browser.close()
      held.browser = null
    })()
    const deadline = new Promise<never>((_resolve, reject) => {
      held.timer = setTimeout(() => reject(new Error(`did not open a page within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs)
    })
    const aborted = new Promise<never>((_resolve, reject) => {
      if (options.signal?.aborted) reject(new Error('cancelled'))
      options.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    })
    try {
      await Promise.race([work, deadline, aborted])
      return { ok: true, detail: null, durationMs: now() - started }
    } catch (err) {
      work.catch(() => undefined)
      if (held.browser) await withTimeout(held.browser.close(), CLOSE_BUDGET_MS, 'Closing the verification browser').catch(() => undefined)
      if (info.family === 'chromium') await killMarked(markerId)
      const detail = shortErrorText(err, [])
      return { ok: false, detail, durationMs: now() - started }
    } finally {
      if (held.timer) clearTimeout(held.timer)
    }
  }
}

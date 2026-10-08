/**
 * Site access tokens — the module's public interface.
 *
 * The rest of the app only ever sees `SiteAccess` (create once in the composition root, unlock after
 * Electron is ready) and the narrow `SiteAccessAttacher` it hands to browser-context creators:
 *
 *   await siteAccess?.attach(context, (note) => record(note))
 *
 * Removing the feature = deleting this folder, src/shared/site-access.ts, the renderer section and
 * the one-line call sites (see docs/ARCHITECTURE.md → Site access tokens).
 */
import type { BrowserContext } from 'playwright-core'
import type { Logger } from '../contracts'
import { attachSiteAccessRules } from './attach'
import { createSiteAccessStore } from './store'
import type { SiteAccessEncryption, SiteAccessStore } from './store'

export { SITE_ACCESS_FILE_NAME } from './store'
export type { SiteAccessEncryption, SiteAccessStore } from './store'
export { siteAccessHandlers } from './ipc'

/** Evidence line for one token applied to one origin. Never contains the value. */
export function siteAccessNote(tokenName: string, origin: string): string {
  return `site access token "${tokenName}" applied to ${origin}`
}

/** What browser-context creators depend on: one call per new context. */
export interface SiteAccessAttacher {
  /**
   * Route the currently enabled tokens into `context` (a snapshot: edits apply to the next launch).
   * `onNote` receives one evidence line per (token, origin) the first time the header is sent.
   */
  attach(context: BrowserContext, onNote?: (note: string) => void): Promise<void>
  /** True while any enabled token would be sent. Traces record raw request headers, so callers skip them then. */
  hasActiveRules?(): boolean
}

/** Evidence line recorded when a requested trace is skipped because a token value would be written into it. */
export const TRACE_SKIPPED_NOTE =
  'Trace capture skipped: site access tokens are enabled, and traces record raw request headers including token values.'

/** A requested trace is skipped while any token is active, so no token value is written into a trace file. */
export function shouldSkipTrace(captureTrace: boolean | undefined, siteAccess: SiteAccessAttacher | undefined): boolean {
  return !!captureTrace && !!siteAccess?.hasActiveRules?.()
}

export interface SiteAccess extends SiteAccessAttacher {
  store: SiteAccessStore
  unlock(encryption: SiteAccessEncryption | null): void
}

export function createSiteAccess(options: { file: string; logger: Logger }): SiteAccess {
  const store = createSiteAccessStore(options)
  return {
    store,
    unlock: (encryption) => store.unlock(encryption),
    hasActiveRules: () => store.activeRules().length > 0,
    attach: (context, onNote) =>
      attachSiteAccessRules(context, store.activeRules(), {
        onApplied: ({ tokenName, origin }) => onNote?.(siteAccessNote(tokenName, origin)),
        onBlocked: (message) => options.logger.warn('site-access', message),
      }),
  }
}

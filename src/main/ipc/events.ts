/**
 * Forward main-process events (logger, browser manager, proxy manager,
 * browser provisioner install watcher, background tasks, credential vault) to the renderer
 * through the broadcaster.
 */
import { EVENTS } from '@shared/ipc'

import type { BrowserManager, BrowserProvisioner, CredentialVault, Logger, ProxyManager, TaskManager } from '../contracts'
import type { Broadcast } from './broadcast'

export interface EventForwardingDeps {
  logger: Logger
  browser: BrowserManager
  proxy: ProxyManager
  vault: CredentialVault
  provisioner: BrowserProvisioner
  tasks: TaskManager
  broadcast: Broadcast
}

/** Subscribe to every event source; returns a function that unsubscribes all. */
export function forwardEvents(deps: EventForwardingDeps): () => void {
  const unsubscribers = [
    deps.logger.onEntry((entry) => deps.broadcast(EVENTS.logEntry, entry)),
    deps.browser.onSessionUpdate((session) => deps.broadcast(EVENTS.sessionUpdate, session)),
    deps.browser.onRunUpdate((run) => deps.broadcast(EVENTS.runUpdate, run)),
    deps.browser.onNetworkEntry((entry) => deps.broadcast(EVENTS.networkEntry, entry)),
    deps.proxy.onSessionUpdate((session) => deps.broadcast(EVENTS.proxySessionUpdate, session)),
    deps.provisioner.onWatchUpdate((update) => deps.broadcast(EVENTS.browserWatch, update)),
    deps.tasks.onUpdate((tasks) => deps.broadcast(EVENTS.tasksUpdate, tasks)),
    // The vault emits the credentials; only the credential-free status ever leaves the main process.
    deps.vault.onChange(() => {
      void deps.vault
        .status()
        .then((status) => deps.broadcast(EVENTS.securityUpdate, status))
        .catch((err: unknown) => {
          deps.logger.warn('ipc', 'Could not compute the security status after a vault change', { error: err instanceof Error ? err.message : String(err) })
        })
    }),
  ]
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe()
  }
}

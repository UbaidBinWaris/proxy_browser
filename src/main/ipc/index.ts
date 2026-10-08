import { desktopHandlers } from './desktop'
/**
 * IPC entry point: registers one handler per channel in `IPC` and wires event
 * forwarding. `registerIpcHandlers` refuses to start if any declared channel
 * is left without a handler, so the renderer can never invoke a dead channel.
 */
import { IPC } from '@shared/ipc'

import { AppException } from '../contracts'
import { appHandlers } from './app'
import { browserHandlers, browsersHandlers } from './browser'
import { dashboardHandlers } from './dashboard'
import type { IpcDeps } from './deps'
import { forwardEvents } from './events'
import { registerSpecs } from './handle'
import type { HandlerSpec, IpcRegistrar } from './handle'
import { launcherHandlers } from './launcher'
import { locationHandlers } from './locations'
import { logHandlers } from './logs'
import { profileHandlers } from './profiles'
import { proxyHandlers } from './proxy'
import { runHandlers } from './runs'
import { securityHandlers } from './security'
import { settingsHandlers } from './settings'
import { setupHandlers } from './setup'
import { taskHandlers } from './tasks'
import { qaHandlers } from './qa'

export type { IpcDeps } from './deps'
export type { Broadcast } from './broadcast'
export { createBroadcaster } from './broadcast'

/** Every invoke channel declared in the shared contract. */
export function allIpcChannels(): string[] {
  return Object.values(IPC).flatMap((group) => Object.values(group))
}

/** Build the complete handler list (exported for tests). */
export function buildHandlerSpecs(deps: IpcDeps): HandlerSpec[] {
  return [
    ...appHandlers(deps),
    ...desktopHandlers(deps),
    ...profileHandlers(deps),
    ...proxyHandlers(deps),
    ...browserHandlers(deps),
    ...browsersHandlers(deps),
    ...runHandlers(deps),
    ...settingsHandlers(deps),
    ...logHandlers(deps),
    ...dashboardHandlers(deps),
    ...securityHandlers(deps),
    ...setupHandlers(deps),
    ...locationHandlers(deps),
    ...launcherHandlers(deps),
    ...taskHandlers(deps),
    ...qaHandlers(deps),
  ]
}

/**
 * Register all handlers on `registrar` (Electron's `ipcMain` in production) and
 * start forwarding events. Returns a disposer that removes everything.
 */
export function registerIpcHandlers(deps: IpcDeps, registrar: IpcRegistrar): () => void {
  const specs = buildHandlerSpecs(deps)
  const covered = new Set(specs.map((s) => s.channel))
  const missing = allIpcChannels().filter((channel) => !covered.has(channel))
  if (missing.length > 0) {
    throw new AppException('INTERNAL', `IPC channels without a handler: ${missing.join(', ')}`)
  }

  const unregister = registerSpecs(registrar, specs, { logger: deps.logger, sanitize: deps.sanitize })
  const stopForwarding = forwardEvents(deps)
  deps.logger.info('ipc', 'IPC handlers registered', { channels: specs.length })

  return () => {
    stopForwarding()
    unregister()
  }
}

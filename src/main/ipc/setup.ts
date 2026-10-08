/**
 * First-run setup state: what still needs attention and whether the setup
 * flow has been completed once on this installation.
 */
import { IPC } from '@shared/ipc'
import type { SetupStatus, SetupStep } from '@shared/types'

import type { IpcDeps } from './deps'
import { NoArgs, spec } from './handle'
import type { HandlerSpec } from './handle'

const LOG_SCOPE = 'setup'

/**
 * Chromium is the minimum browser; proxy credentials (of any registered
 * provider) are required for every proxy mode. `proxy` describes the default
 * provider. Builds that bundle the browsers never have a pending 'browsers'
 * step: nothing can (or needs to) be installed.
 */
export async function buildSetupStatus(deps: IpcDeps): Promise<SetupStatus> {
  const [browsers, security] = await Promise.all([deps.provisioner.status(), deps.vault.status()])
  const proxy = deps.proxy.getConfigStatus()
  const state = deps.install.get()
  const pending: SetupStep[] = []
  if (browsers.source !== 'bundled' && !browsers.chromium) pending.push('browsers')
  if (!deps.proxy.providers().some((provider) => provider.status.configured)) pending.push('credentials')
  return {
    firstRun: state.setupCompletedAt === null,
    completedAt: state.setupCompletedAt,
    appVersion: deps.app.getVersion(),
    browsers,
    security,
    proxy,
    pending,
  }
}

export function setupHandlers(deps: IpcDeps): HandlerSpec[] {
  return [
    spec(IPC.setup.status, NoArgs, () => buildSetupStatus(deps)),
    spec(IPC.setup.complete, NoArgs, async (): Promise<SetupStatus> => {
      if (deps.install.get().setupCompletedAt === null) {
        const completedAt = new Date().toISOString()
        deps.install.update({ setupCompletedAt: completedAt })
        deps.logger.info(LOG_SCOPE, 'First-run setup completed', { completedAt })
      }
      return buildSetupStatus(deps)
    }),
  ]
}

/**
 * Quick Launch channels. The input is validated against QuickLaunchInputSchema
 * at the boundary; the launcher validates again (it is also used directly).
 */
import { z } from 'zod'

import { IPC } from '@shared/ipc'
import { QuickLaunchInputSchema } from '@shared/types'

import type { IpcDeps } from './deps'
import { NoArgs, spec } from './handle'
import type { HandlerSpec } from './handle'

const QuickLaunchArgs = z.tuple([QuickLaunchInputSchema])

export function launcherHandlers(deps: IpcDeps): HandlerSpec[] {
  return [
    spec(IPC.launcher.preview, QuickLaunchArgs, ([input]) => deps.launcher.preview(input)),
    spec(IPC.launcher.quickLaunch, QuickLaunchArgs, ([input]) => deps.launcher.quickLaunch(input)),
    spec(IPC.launcher.closeAll, NoArgs, () => deps.launcher.closeAll()),
  ]
}

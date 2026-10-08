/**
 * Background task channels (browser installs / uninstalls): list, cancel, retry, clear finished.
 */
import { IPC } from '@shared/ipc'

import type { IpcDeps } from './deps'
import { IdArg, NoArgs, spec } from './handle'
import type { HandlerSpec } from './handle'

export function taskHandlers(deps: IpcDeps): HandlerSpec[] {
  return [
    spec(IPC.tasks.list, NoArgs, () => deps.tasks.list()),
    spec(IPC.tasks.cancel, IdArg, ([taskId]) => deps.tasks.cancel(taskId)),
    spec(IPC.tasks.retry, IdArg, ([taskId]) => deps.tasks.retry(taskId)),
    spec(IPC.tasks.clearFinished, NoArgs, () => deps.tasks.clearFinished()),
  ]
}

import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

import { IPC } from '@shared/ipc'
import type { AppInfo } from '@shared/types'

import { AppException } from '../contracts'
import type { IpcDeps } from './deps'
import { IdArg, NoArgs, spec } from './handle'
import type { HandlerSpec } from './handle'

/** True when `candidate` resolves to `root` or somewhere beneath it. */
export function isInsideDirectory(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function appHandlers(deps: IpcDeps): HandlerSpec[] {
  return [
    spec(IPC.app.getInfo, NoArgs, (): AppInfo => ({
      version: deps.app.getVersion(),
      platform: deps.app.platform,
      userDataPath: deps.paths.userData,
      dataPath: deps.paths.data,
      isPackaged: deps.app.isPackaged,
    })),

    spec(IPC.app.openPath, IdArg, ([target]): void => {
      const allowedRoots = [deps.paths.data, deps.db.settings.get().screenshotDir]
      if (!isAbsolute(target) || !allowedRoots.some((root) => isInsideDirectory(root, target))) {
        throw new AppException(
          'INVALID_INPUT',
          'Only files inside the application data folder or the screenshot folder can be revealed.',
        )
      }
      if (!existsSync(target)) {
        throw new AppException('NOT_FOUND', 'That file no longer exists on disk.', target)
      }
      deps.shell.showItemInFolder(resolve(target))
    }),
  ]
}

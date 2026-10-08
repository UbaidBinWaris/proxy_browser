import { z } from 'zod'

import { IPC } from '@shared/ipc'
import { LogLevelSchema } from '@shared/types'

import type { IpcDeps } from './deps'
import { NoArgs, spec } from './handle'
import type { HandlerSpec } from './handle'

export const LOGS_LIST_MAX = 10000

export const LogQueryArgSchema = z
  .object({
    level: LogLevelSchema.optional(),
    scope: z.string().trim().max(128).optional(),
    search: z.string().max(512).optional(),
    limit: z.int().min(1).max(LOGS_LIST_MAX).optional(),
  })
  .optional()

const ListArgs = z.tuple([LogQueryArgSchema])

export function logHandlers(deps: IpcDeps): HandlerSpec[] {
  return [
    spec(IPC.logs.list, ListArgs, ([query]) => deps.logger.query(query)),
    spec(IPC.logs.clear, NoArgs, (): void => {
      deps.logger.clear()
      deps.logger.info('logs', 'Log history cleared by user')
    }),
  ]
}

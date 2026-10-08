import { z } from 'zod'

import { IPC } from '@shared/ipc'
import { TestRunPatchSchema } from '@shared/types'

import { AppException } from '../contracts'
import type { IpcDeps } from './deps'
import { IdArg, IdSchema, spec } from './handle'
import type { HandlerSpec } from './handle'

export const RUNS_LIST_MAX = 5000

const ListArgs = z.tuple([z.int().min(1).max(RUNS_LIST_MAX).optional()])
const UpdateArgs = z.tuple([IdSchema, TestRunPatchSchema])

export function runHandlers(deps: IpcDeps): HandlerSpec[] {
  return [
    spec(IPC.runs.list, ListArgs, ([limit]) => deps.db.testRuns.list(limit)),
    spec(IPC.runs.get, IdArg, ([id]) => {
      const run = deps.db.testRuns.get(id)
      if (!run) throw new AppException('NOT_FOUND', 'That test run no longer exists. It may have been deleted.', id)
      return run
    }),
    spec(IPC.runs.update, UpdateArgs, ([id, patch]) => deps.db.testRuns.patch(id, patch)),
    spec(IPC.runs.delete, IdArg, ([id]): void => deps.db.testRuns.delete(id)),
    spec(IPC.runs.network, IdArg, ([runId]) => deps.db.network.listByRun(runId)),
  ]
}

import { z } from 'zod'

import { IPC } from '@shared/ipc'
import { ProfileInputSchema } from '@shared/types'

import type { IpcDeps } from './deps'
import { IdArg, IdSchema, NoArgs, spec } from './handle'
import type { HandlerSpec } from './handle'

const CreateArgs = z.tuple([ProfileInputSchema])
const UpdateArgs = z.tuple([IdSchema, ProfileInputSchema])

export function profileHandlers(deps: IpcDeps): HandlerSpec[] {
  return [
    spec(IPC.profiles.list, NoArgs, () => deps.profiles.list()),
    spec(IPC.profiles.get, IdArg, ([id]) => deps.profiles.get(id)),
    spec(IPC.profiles.create, CreateArgs, ([input]) => deps.profiles.create(input)),
    spec(IPC.profiles.update, UpdateArgs, ([id, input]) => deps.profiles.update(id, input)),
    spec(IPC.profiles.duplicate, IdArg, ([id]) => deps.profiles.duplicate(id)),
    spec(IPC.profiles.delete, IdArg, ([id]): void => deps.profiles.delete(id)),
    spec(IPC.profiles.presets, NoArgs, () => deps.profiles.presets()),
  ]
}

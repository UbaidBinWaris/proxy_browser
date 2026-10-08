/**
 * Location search channels over the bundled GeoNames US dataset. Inputs are
 * validated with the shared schemas; the service itself re-validates the
 * search input so direct callers get the same errors.
 */
import { z } from 'zod'

import { IPC } from '@shared/ipc'
import { LocationSearchSchema, StateCodeSchema, TargetModeSchema } from '@shared/types'

import type { IpcDeps } from './deps'
import { NoArgs, spec } from './handle'
import type { HandlerSpec } from './handle'

const SearchArgs = z.tuple([LocationSearchSchema])
const RandomArgs = z.union([z.tuple([TargetModeSchema]), z.tuple([TargetModeSchema, StateCodeSchema.nullable()])])

export function locationHandlers(deps: IpcDeps): HandlerSpec[] {
  return [
    spec(IPC.locations.search, SearchArgs, ([input]) => deps.locations.search(input)),
    spec(IPC.locations.query, SearchArgs, ([input]) => deps.locations.query(input)),
    spec(IPC.locations.stats, NoArgs, () => deps.locations.stats()),
    spec(IPC.locations.random, RandomArgs, ([mode, stateCode]) => deps.locations.random(mode, stateCode ?? null)),
    spec(IPC.locations.states, NoArgs, () => deps.locations.states()),
  ]
}

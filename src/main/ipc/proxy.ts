import { z } from 'zod'

import { IPC } from '@shared/ipc'
import { ProxyPoolSchema } from '@shared/types'

import type { IpcDeps } from './deps'
import { IdArg, IdSchema, NoArgs, NullableIdArg, spec } from './handle'
import type { HandlerSpec } from './handle'

/** Profile id (null = raw gateway) and, for the gateway, an optional pool overriding the default pool. */
const TestArgs = z.union([z.tuple([IdSchema.nullable()]), z.tuple([IdSchema.nullable(), ProxyPoolSchema])])

export function proxyHandlers(deps: IpcDeps): HandlerSpec[] {
  const resolveProfile = (profileId: string | null) => (profileId === null ? null : deps.profiles.get(profileId))

  return [
    spec(IPC.proxy.getConfigStatus, NoArgs, () => deps.proxy.getConfigStatus()),
    spec(IPC.proxy.testConnection, TestArgs, ([profileId, pool]) =>
      pool === undefined || profileId !== null ? deps.proxy.testConnection(resolveProfile(profileId)) : deps.proxy.testConnection(null, pool),
    ),
    spec(IPC.proxy.getCurrentIp, NullableIdArg, ([profileId]) => deps.proxy.getCurrentIp(resolveProfile(profileId))),
    spec(IPC.proxy.listSessions, NoArgs, () => deps.proxy.listSessions()),
    spec(IPC.proxy.rotateSession, IdArg, ([profileId]) => deps.proxy.rotateSession(deps.profiles.get(profileId))),
  ]
}

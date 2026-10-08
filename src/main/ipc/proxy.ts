import { z } from 'zod'

import { IPC } from '@shared/ipc'
import { ProductKeySchema, ProviderIdSchema } from '@shared/types'

import type { IpcDeps } from './deps'
import { IdArg, IdSchema, NoArgs, NullableIdArg, spec } from './handle'
import type { HandlerSpec } from './handle'

/** Profile id (null = raw gateway) and, for the gateway, an optional product and provider overriding the defaults. */
const TestArgs = z.union([
  z.tuple([IdSchema.nullable()]),
  z.tuple([IdSchema.nullable(), ProductKeySchema]),
  z.tuple([IdSchema.nullable(), ProductKeySchema, ProviderIdSchema]),
])
/** Optional provider id (default: settings.defaultProviderId). */
const ConfigStatusArgs = z.union([z.tuple([]), z.tuple([ProviderIdSchema])])

export function proxyHandlers(deps: IpcDeps): HandlerSpec[] {
  const resolveProfile = (profileId: string | null) => (profileId === null ? null : deps.profiles.get(profileId))

  return [
    spec(IPC.proxy.providers, NoArgs, () => deps.proxy.providers()),
    spec(IPC.proxy.getConfigStatus, ConfigStatusArgs, ([providerId]) => deps.proxy.getConfigStatus(providerId)),
    spec(IPC.proxy.testConnection, TestArgs, ([profileId, pool, providerId]) =>
      pool === undefined || profileId !== null ? deps.proxy.testConnection(resolveProfile(profileId)) : deps.proxy.testConnection(null, pool, providerId),
    ),
    spec(IPC.proxy.getCurrentIp, NullableIdArg, ([profileId]) => deps.proxy.getCurrentIp(resolveProfile(profileId))),
    spec(IPC.proxy.listSessions, NoArgs, () => deps.proxy.listSessions()),
    spec(IPC.proxy.rotateSession, IdArg, ([profileId]) => deps.proxy.rotateSession(deps.profiles.get(profileId))),
  ]
}

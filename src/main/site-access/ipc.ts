/**
 * IPC handlers for the `siteAccess` namespace. Nothing returned here ever contains a header value:
 * every response is a `SiteAccessStatus` / `SiteAccessTokenSummary` with a masked preview.
 */
import { z } from 'zod'
import { IPC } from '@shared/ipc'
import { AppException } from '../contracts'
import { IdArg, IdSchema, NoArgs, spec } from '../ipc/handle'
import type { HandlerSpec } from '../ipc/handle'
import type { SiteAccessStore } from './store'

/** Arguments are validated in depth by the store (SiteAccessTokenInputSchema) so its messages reach the user. */
const SaveArgs = z.tuple([z.unknown(), IdSchema.optional()])

export function siteAccessHandlers(store: SiteAccessStore | undefined): HandlerSpec[] {
  const required = (): SiteAccessStore => {
    if (!store) throw new AppException('INTERNAL', 'Site access tokens are unavailable.')
    return store
  }
  return [
    spec(IPC.siteAccess.status, NoArgs, () => required().status()),
    spec(IPC.siteAccess.save, SaveArgs, ([input, id]) => required().save(input, id)),
    spec(IPC.siteAccess.setEnabled, z.tuple([IdSchema, z.boolean()]), ([id, enabled]) => required().setEnabled(id, enabled)),
    spec(IPC.siteAccess.delete, IdArg, ([id]) => required().remove(id)),
  ]
}

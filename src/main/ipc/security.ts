/**
 * Credential vault channels. Inputs carrying a password are validated here and
 * handed straight to the vault/provider; they are never logged and never echoed
 * back — every response is a `SecurityStatus` or a credential-free
 * `ProxyTestResult`.
 *
 * Partial updates (Manage keys window) are merged with the stored vault entry
 * inside this process, so the renderer can rotate a password without ever
 * seeing or retyping the stored username.
 */
import { dirname } from 'node:path'

import { z } from 'zod'

import { IPC } from '@shared/ipc'
import { ProxyCredentialsInputSchema, ProxyCredentialsUpdateSchema, ProxyPoolSchema } from '@shared/types'

import { mergeCredentialsUpdate } from '../security/credentials-merge'
import type { IpcDeps } from './deps'
import { NoArgs, spec } from './handle'
import type { HandlerSpec } from './handle'

const CredentialsArgs = z.tuple([ProxyCredentialsInputSchema])
const UpdateArgs = z.tuple([ProxyCredentialsUpdateSchema])
const RevealArgs = z.tuple([z.enum(['key', 'vault'])])
/** The pool to clear; omitted by older callers → residential. */
const ClearArgs = z.tuple([ProxyPoolSchema.optional().default('residential')])

export function securityHandlers(deps: IpcDeps): HandlerSpec[] {
  return [
    spec(IPC.security.status, NoArgs, () => deps.vault.status()),
    spec(IPC.security.testCredentials, CredentialsArgs, ([input]) => deps.proxy.testCredentials(input)),
    spec(IPC.security.saveCredentials, CredentialsArgs, ([input]) => deps.vault.save(input)),
    spec(IPC.security.updateCredentials, UpdateArgs, ([update]) => deps.vault.save(mergeCredentialsUpdate(deps.vault.get(update.pool), update))),
    spec(IPC.security.testCredentialsPartial, UpdateArgs, ([update]) => deps.proxy.testCredentials(mergeCredentialsUpdate(deps.vault.get(update.pool), update))),
    spec(IPC.security.clearCredentials, ClearArgs, ([pool]) => deps.vault.clear(pool)),
    spec(IPC.security.rotateKey, NoArgs, () => deps.vault.rotateKey()),
    // Only the two vault directories can ever be revealed, never an arbitrary path.
    spec(IPC.security.revealLocations, RevealArgs, ([which]): void => {
      deps.shell.showItemInFolder(dirname(which === 'key' ? deps.vault.keyPath : deps.vault.vaultPath))
    }),
    spec(IPC.security.openKeysWindow, NoArgs, (): void => deps.windows.openKeysWindow()),
    spec(IPC.security.closeKeysWindow, NoArgs, (): void => deps.windows.closeKeysWindow()),
  ]
}

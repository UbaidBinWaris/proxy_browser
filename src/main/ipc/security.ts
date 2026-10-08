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
import { ProductKeySchema, ProviderIdSchema, ProxyCredentialsInputSchema, ProxyCredentialsUpdateSchema } from '@shared/types'
import type { ProxyCredentialsData, ProxyCredentialsUpdate } from '@shared/types'

import { mergeCredentialsUpdate, parseCredentialsUpdate } from '../security/credentials-merge'
import { AppException } from '../contracts'
import type { IpcDeps } from './deps'
import { NoArgs, spec } from './handle'
import type { HandlerSpec } from './handle'

const CredentialsArgs = z.tuple([ProxyCredentialsInputSchema])
const UpdateArgs = z.tuple([ProxyCredentialsUpdateSchema])
const RevealArgs = z.tuple([z.enum(['key', 'vault'])])
/** The provider and product to clear. */
const ClearArgs = z.tuple([ProviderIdSchema, ProductKeySchema])

export function securityHandlers(deps: IpcDeps): HandlerSpec[] {
  /**
   * Refuse credentials for a provider this build does not have, or a product it does not offer,
   * before anything touches the vault (INVALID_INPUT naming them).
   */
  const requireOffered = (input: Pick<ProxyCredentialsData, 'providerId' | 'pool'>): void => {
    const provider = deps.proxy.providers().find((candidate) => candidate.id === input.providerId)
    if (!provider) throw new AppException('INVALID_INPUT', `Unknown proxy provider "${input.providerId}".`)
    if (!provider.capabilities.products.some((product) => product.key === input.pool)) {
      throw new AppException('INVALID_INPUT', `${provider.displayName} does not offer a "${input.pool}" product.`)
    }
  }
  const merged = (raw: ProxyCredentialsUpdate): ProxyCredentialsData => {
    const update = parseCredentialsUpdate(raw)
    requireOffered(update)
    return mergeCredentialsUpdate(deps.vault.get(update.providerId, update.pool), update)
  }
  return [
    spec(IPC.security.status, NoArgs, () => deps.vault.status()),
    spec(IPC.security.testCredentials, CredentialsArgs, ([input]) => {
      requireOffered(input)
      return deps.proxy.testCredentials(input)
    }),
    spec(IPC.security.saveCredentials, CredentialsArgs, ([input]) => {
      requireOffered(input)
      return deps.vault.save(input)
    }),
    spec(IPC.security.updateCredentials, UpdateArgs, ([update]) => deps.vault.save(merged(update))),
    spec(IPC.security.testCredentialsPartial, UpdateArgs, ([update]) => deps.proxy.testCredentials(merged(update))),
    spec(IPC.security.clearCredentials, ClearArgs, ([providerId, product]) => deps.vault.clear(providerId, product)),
    spec(IPC.security.rotateKey, NoArgs, () => deps.vault.rotateKey()),
    // Only the two vault directories can ever be revealed, never an arbitrary path.
    spec(IPC.security.revealLocations, RevealArgs, ([which]): void => {
      deps.shell.showItemInFolder(dirname(which === 'key' ? deps.vault.keyPath : deps.vault.vaultPath))
    }),
    spec(IPC.security.openKeysWindow, NoArgs, (): void => deps.windows.openKeysWindow()),
    spec(IPC.security.closeKeysWindow, NoArgs, (): void => deps.windows.closeKeysWindow()),
  ]
}

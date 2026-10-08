/**
 * Encrypted, per-device store of site access tokens.
 *
 * Same protection model as custom QA gateways (src/main/qa/gateways.ts): the secret header value is
 * encrypted with Electron `safeStorage` (Windows DPAPI, GNOME Keyring / libsecret, KWallet). When no
 * usable keychain exists (Linux `basic_text` / unknown backends are refused by the caller exactly as
 * for gateways) the store is read-only-empty: nothing can be saved and nothing is applied.
 *
 * Storage: one JSON file (`site-access-tokens.json`, owner-only, atomic writes) next to the database.
 * Names, origins and header names are kept in clear so the list renders without decrypting; the
 * value is stored only as safeStorage ciphertext. The file is NOT part of QA configuration backups,
 * suite/scenario exports or the CI runner: every device is configured on its own.
 *
 * Every decrypted or newly saved value is registered with the log redactor at once. The value never
 * leaves this module except as an applied header (see attach.ts) — summaries carry a masked preview.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import { SiteAccessTokenInputSchema, maskSiteAccessValue } from '@shared/site-access'
import type { SiteAccessStatus, SiteAccessTokenSummary } from '@shared/site-access'
import { AppException } from '../contracts'
import type { Logger } from '../contracts'
import { writeFileAtomicSync } from '../util/atomic-file'
import { findSiteAccessConflicts, normalizeOrigins } from './matcher'
import type { SiteAccessRule } from './matcher'

export const SITE_ACCESS_FILE_NAME = 'site-access-tokens.json'
const SCOPE = 'site-access'

/** The subset of Electron's `safeStorage` this store needs (a fake in tests). */
export interface SiteAccessEncryption {
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export const UNAVAILABLE_REASON =
  'Site access tokens need an available OS keychain (Windows DPAPI, GNOME Keyring / libsecret or KWallet). Install or unlock a keyring and restart the app.'

const StoredTokenSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  origins: z.array(z.string()),
  headerName: z.string(),
  enabled: z.boolean(),
  /** base64 safeStorage ciphertext of the header value. */
  encryptedValue: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
type StoredToken = z.infer<typeof StoredTokenSchema>
const StoreFileSchema = z.object({ version: z.literal(1), tokens: z.array(StoredTokenSchema) })

export interface SiteAccessStoreOptions {
  file: string
  logger: Logger
  now?: () => Date
}

export interface SiteAccessStore {
  /** Provide the keychain once Electron is ready (null = no usable keychain), then load and decrypt. */
  unlock(encryption: SiteAccessEncryption | null): void
  status(): SiteAccessStatus
  save(raw: unknown, id?: string): SiteAccessTokenSummary
  setEnabled(id: string, enabled: boolean): SiteAccessTokenSummary
  remove(id: string): void
  /** Enabled tokens whose value decrypts, ready to apply (main-process memory only). */
  activeRules(): SiteAccessRule[]
}

export function createSiteAccessStore(options: SiteAccessStoreOptions): SiteAccessStore {
  const { file, logger } = options
  const now = options.now ?? (() => new Date())
  let encryption: SiteAccessEncryption | null = null
  let unlocked = false
  let tokens: StoredToken[] = []
  /** Decrypted values by token id (absent when the ciphertext cannot be decrypted on this device). */
  const values = new Map<string, string>()

  const decrypt = (token: StoredToken): void => {
    values.delete(token.id)
    if (!encryption) return
    try {
      const value = encryption.decryptString(Buffer.from(token.encryptedValue, 'base64'))
      logger.registerSecret(value)
      values.set(token.id, value)
    } catch {
      logger.warn(SCOPE, `Site access token "${token.name}" could not be decrypted on this device; re-enter its value.`, { tokenId: token.id })
    }
  }

  const read = (): StoredToken[] => {
    if (!existsSync(file)) return []
    try {
      return StoreFileSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).tokens
    } catch (err) {
      logger.warn(SCOPE, 'The site access token file is unreadable; no tokens are applied until it is saved again.', { error: err })
      return []
    }
  }

  const write = (next: StoredToken[]): void => {
    writeFileAtomicSync(file, JSON.stringify({ version: 1, tokens: next }, null, 2))
    tokens = next
  }

  const requireEncryption = (): SiteAccessEncryption => {
    if (!encryption) throw new AppException('VAULT_ERROR', UNAVAILABLE_REASON)
    return encryption
  }

  const find = (id: string): StoredToken => {
    const token = tokens.find((candidate) => candidate.id === id)
    if (!token) throw new AppException('NOT_FOUND', 'This site access token no longer exists.')
    return token
  }

  const summary = (token: StoredToken): SiteAccessTokenSummary => {
    const value = values.get(token.id)
    return {
      id: token.id,
      name: token.name,
      origins: [...token.origins],
      headerName: token.headerName,
      enabled: token.enabled,
      valuePreview: value === undefined ? 'Unavailable on this device' : maskSiteAccessValue(value),
      valueAvailable: value !== undefined,
      updatedAt: token.updatedAt,
    }
  }

  const assertNoConflicts = (next: StoredToken[]): void => {
    const conflicts = findSiteAccessConflicts(next)
    if (conflicts.length > 0) throw new AppException('INVALID_INPUT', conflicts[0]!, conflicts.slice(1).join(' ') || undefined)
  }

  return {
    unlock(next) {
      encryption = next
      unlocked = true
      tokens = read()
      for (const token of tokens) decrypt(token)
      logger.info(SCOPE, `site access tokens: ${tokens.length} saved, ${tokens.filter((token) => token.enabled).length} enabled`, {
        keychain: encryption !== null,
      })
    },

    status() {
      return {
        available: unlocked && encryption !== null,
        reason: unlocked && encryption !== null ? null : UNAVAILABLE_REASON,
        tokens: tokens.map(summary),
      }
    },

    save(raw, id) {
      const crypto = requireEncryption()
      const input = SiteAccessTokenInputSchema.parse(raw)
      const existing = id ? find(id) : null
      const newValue = input.headerValue ? input.headerValue : null
      if (!existing && newValue === null) throw new AppException('INVALID_INPUT', 'Enter the secret header value.')
      if (existing && newValue === null && !values.has(existing.id))
        throw new AppException('INVALID_INPUT', 'The saved value cannot be decrypted on this device. Enter the secret header value again.')
      if (newValue !== null) logger.registerSecret(newValue)
      const at = now().toISOString()
      const token: StoredToken = {
        id: existing?.id ?? randomUUID(),
        name: input.name,
        origins: normalizeOrigins(input.origins),
        headerName: input.headerName,
        enabled: input.enabled,
        encryptedValue: newValue === null ? existing!.encryptedValue : crypto.encryptString(newValue).toString('base64'),
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
      }
      const next = existing ? tokens.map((candidate) => (candidate.id === token.id ? token : candidate)) : [...tokens, token]
      assertNoConflicts(next)
      write(next)
      if (newValue !== null) values.set(token.id, newValue)
      logger.info(SCOPE, `Site access token "${token.name}" ${existing ? 'updated' : 'added'}`, {
        tokenId: token.id,
        origins: token.origins,
        headerName: token.headerName,
        enabled: token.enabled,
        valueChanged: newValue !== null,
      })
      return summary(token)
    },

    setEnabled(id, enabled) {
      requireEncryption()
      const token = { ...find(id), enabled, updatedAt: now().toISOString() }
      write(tokens.map((candidate) => (candidate.id === id ? token : candidate)))
      logger.info(SCOPE, `Site access token "${token.name}" ${enabled ? 'enabled' : 'disabled'}`, { tokenId: id })
      return summary(token)
    },

    remove(id) {
      const token = find(id)
      write(tokens.filter((candidate) => candidate.id !== id))
      values.delete(id)
      logger.info(SCOPE, `Site access token "${token.name}" deleted`, { tokenId: id })
    },

    activeRules() {
      if (!encryption) return []
      return tokens.flatMap((token) => {
        const value = values.get(token.id)
        return token.enabled && value !== undefined
          ? [{ id: token.id, name: token.name, origins: [...token.origins], headerName: token.headerName, headerValue: value }]
          : []
      })
    },
  }
}

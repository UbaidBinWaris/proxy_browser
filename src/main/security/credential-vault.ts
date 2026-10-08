/**
 * Encrypted, per-machine proxy credential vault (implements `CredentialVault`).
 *
 * Files
 *   <keys>/<installId>.key              WrappedKey JSON (0600) — the random
 *                                       256-bit vault key wrapped by the OS
 *                                       keychain or the machine-derived key
 *   <vault>/proxy-credentials.vault     VaultBlob JSON (0600) — AES-256-GCM
 *   <vault>/proxy-credentials.vault.v2.bak
 *                                       the pre-v3 vault file, copied verbatim
 *                                       (still encrypted) before the one-time
 *                                       rewrite in the v3 format
 *   <userData>/install.json             installId + setup/health bookkeeping
 *                                       (owned by `InstallStateStore`)
 *
 * Payload (decrypted), v3 — one entry per provider product:
 *   { v: 3, providers: { [providerId]: { products: { [productKey]:
 *       { host, port, username, password, sessionTemplate, extras } } } } }
 * `extras` holds provider-specific credential fields (e.g. a zone); they are
 * inside the encrypted payload exactly like the password.
 *
 * Earlier payloads are migrated on load into `providers.dataimpulse` (the only
 * provider before v3):
 *   v2      { v: 2, pools: { residential?: Credentials, mobile?: Credentials } }
 *   legacy  a single credential object (→ the residential product)
 * Before the file is rewritten, the original is copied to `<name>.v2.bak`
 * (atomic, same directory, same permissions) because older builds cannot read
 * v3. If the copy or the rewrite fails, the original file and the backup are
 * left untouched, the decrypted credentials stay usable in memory, status()
 * reports the problem and every later write first retries the backup — a
 * VAULT_ERROR naming the backup path is raised instead of overwriting a v2 file
 * that has no backup.
 *
 * Rules
 *   - Decrypted credentials live in main-process memory only.
 *   - Startup never throws for a bad vault: an undecryptable vault yields
 *     `decryptOk: false`, a warning, and `get() === null` for every product.
 *   - Every write is atomic (temp file + rename) and `save()` reads its own
 *     output back before reporting success.
 *   - `rotateKey()` writes the new key beside the old one, re-encrypts, then
 *     swaps; an interrupted rotation is recovered on the next start.
 *   - Every product's password (and `user:pass`) is registered with the logger
 *     the moment it is known, and so is every extra field the provider declares
 *     secret (all extras when no declaration is available).
 */
import { existsSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { z } from 'zod'

import { DEFAULT_PROVIDER_ID, ProductKeySchema, ProviderIdSchema, ProxyCredentialsInputSchema } from '@shared/types'
import type { CredentialSource, ProductKey, ProviderId, ProxyCredentialsData, ProxyCredentialsInput, ProxyStatus, SecurityStatus } from '@shared/types'

import { maskUsername } from '../config/env'
import { AppException } from '../contracts'
import type { AppPaths, CredentialVault, Logger, StoredProxyCredentials } from '../contracts'
import { PRIVATE_FILE_MODE, writeFileAtomicSync } from '../util/atomic-file'
import type { WriteFileAtomicOptions } from '../util/atomic-file'
import { decryptJson, encryptJson, generateKey, parseVaultBlob, parseWrappedKey } from './crypto'
import type { MachineIdentity, VaultBlob, WrappedKey } from './crypto'
import type { InstallStateStore } from './install-state'
import { NO_KEY_LABEL, createMachineDerivedWrapper } from './key-wrapper'
import type { KeyWrapperBackend } from './key-wrapper'

export const VAULT_FILE_NAME = 'proxy-credentials.vault'
export const KEY_FILE_SUFFIX = '.key'
/** Sibling of the key file while a rotation is in flight. */
export const ROTATING_KEY_SUFFIX = '.key.rotating'
/** Suffix of the copy of a pre-v3 vault file, taken before it is rewritten in the v3 format. */
export const VAULT_BACKUP_SUFFIX = '.v2.bak'
/** Version tag of the per-provider payload. */
export const VAULT_PAYLOAD_VERSION = 3 as const
export const UNDECRYPTABLE_WARNING = 'Vault could not be decrypted with the current key — re-enter the proxy credentials'
export const PERMISSIONS_WARNING = 'Key or vault file is readable by other users on this machine — restrict it to the owner (chmod 600)'
export const VERIFY_FAILED_MESSAGE = 'Credentials were written but could not be verified. Nothing was saved.'

const SCOPE = 'security.vault'
/** Provider every pre-v3 vault entry belongs to. */
const LEGACY_PROVIDER: ProviderId = DEFAULT_PROVIDER_ID
/** Product of a legacy single-credential vault. */
const LEGACY_PRODUCT: ProductKey = 'residential'

/** Payload versions the vault can read; 1 is the single-credential shape. */
export type VaultPayloadVersion = 1 | 2 | typeof VAULT_PAYLOAD_VERSION

export interface CredentialVaultOptions {
  paths: Pick<AppPaths, 'vault' | 'keys'>
  logger: Logger
  /** Backend for new and rotated keys. */
  wrapper: KeyWrapperBackend
  /** Used to unwrap keys written by the machine-derived backend when `wrapper` is the OS keychain. */
  machine: MachineIdentity
  install: InstallStateStore
  /** Where the proxy providers' active credentials come from. Defaults to 'vault' when the vault holds credentials, else 'none'. */
  activeSource?: () => CredentialSource
  /**
   * Extra credential field keys a provider declares secret (from its capabilities). They are
   * registered with the logger as soon as they are known. Without this option every extra value
   * is treated as secret.
   */
  secretExtraKeys?: (providerId: ProviderId) => readonly string[]
  now?: () => Date
  platform?: NodeJS.Platform
  /** Atomic file writer (tests inject failures). */
  writeFileAtomic?: (path: string, data: string | Buffer, options?: WriteFileAtomicOptions) => void
}

/** One product's stored credentials (defensive: the file may come from another version). */
const StoredCredentialsSchema = z.object({
  host: z.string().min(1),
  port: z.int().min(1).max(65535),
  username: z.string().min(1),
  password: z.string().min(1),
  sessionTemplate: z.string().nullable(),
})

const StoredProductSchema = StoredCredentialsSchema.extend({
  extras: z.record(z.string(), z.string()).default({}),
})

/** Current payload: credentials per provider product. */
const ProvidersPayloadSchema = z.object({
  v: z.literal(VAULT_PAYLOAD_VERSION),
  providers: z.record(ProviderIdSchema, z.object({ products: z.record(ProductKeySchema, StoredProductSchema) })),
})
export type VaultPayload = z.infer<typeof ProvidersPayloadSchema>

/** v2 payload (DataImpulse pools only). */
const PoolsPayloadSchema = z.object({
  v: z.literal(2),
  pools: z.record(ProductKeySchema, StoredCredentialsSchema),
})

/** Vaults written before pools existed held exactly one credential object (residential plan). */
const LegacyPayloadSchema = StoredCredentialsSchema

/** In-memory vault contents: provider → product → credentials, in insertion order. */
export type VaultEntries = Map<ProviderId, Map<ProductKey, StoredProxyCredentials>>
type Listener = (credentials: StoredProxyCredentials[]) => void

interface LoadedKey {
  key: Buffer
  descriptor: WrappedKey
  raw: string
}

interface DecryptedVault {
  entries: VaultEntries
  blob: VaultBlob
  /** Payload version found in the file; anything below the current one must be rewritten. */
  version: VaultPayloadVersion
}

function detail(err: unknown): string {
  return err instanceof AppException ? `${err.message}${err.detail ? ` (${err.detail})` : ''}` : err instanceof Error ? err.message : String(err)
}

function extrasEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
}

export function credentialsEqual(a: StoredProxyCredentials, b: StoredProxyCredentials): boolean {
  return (
    a.providerId === b.providerId &&
    a.pool === b.pool &&
    a.host === b.host &&
    a.port === b.port &&
    a.username === b.username &&
    a.password === b.password &&
    a.sessionTemplate === b.sessionTemplate &&
    extrasEqual(a.extras, b.extras)
  )
}

/** Normalise validated UI input into the stored shape (empty template → no override, empty extras dropped). */
export function toProxyCredentials(input: ProxyCredentialsData): StoredProxyCredentials {
  const template = input.sessionTemplate?.trim()
  const extras: Record<string, string> = {}
  for (const [key, value] of Object.entries(input.extras)) if (value !== '') extras[key] = value
  return {
    providerId: input.providerId,
    pool: input.pool,
    host: input.host,
    port: input.port,
    username: input.username,
    password: input.password,
    sessionTemplate: template ? template : null,
    extras,
  }
}

function copyEntry(entry: StoredProxyCredentials): StoredProxyCredentials {
  return { ...entry, extras: { ...entry.extras } }
}

/** Every entry as a list: providers in insertion order, products in insertion order. */
export function entriesToList(entries: VaultEntries): StoredProxyCredentials[] {
  return [...entries.values()].flatMap((products) => [...products.values()].map(copyEntry))
}

function cloneEntries(entries: VaultEntries): VaultEntries {
  return new Map([...entries].map(([provider, products]) => [provider, new Map([...products].map(([key, entry]) => [key, copyEntry(entry)]))]))
}

function withEntry(entries: VaultEntries, entry: StoredProxyCredentials): VaultEntries {
  const next = cloneEntries(entries)
  const products = next.get(entry.providerId) ?? new Map<ProductKey, StoredProxyCredentials>()
  products.set(entry.pool, copyEntry(entry))
  next.set(entry.providerId, products)
  return next
}

function withoutEntry(entries: VaultEntries, providerId: ProviderId, product: ProductKey): VaultEntries {
  const next = cloneEntries(entries)
  const products = next.get(providerId)
  if (!products) return next
  products.delete(product)
  if (products.size === 0) next.delete(providerId)
  return next
}

function entriesEqual(a: VaultEntries, b: VaultEntries): boolean {
  const left = entriesToList(a)
  const right = entriesToList(b)
  if (left.length !== right.length) return false
  return left.every((entry) => {
    const other = b.get(entry.providerId)?.get(entry.pool)
    return other !== undefined && credentialsEqual(entry, other)
  })
}

/** `{ dataimpulse: ['residential', 'mobile'] }` for the status. */
export function configuredProductsOf(entries: VaultEntries): Record<ProviderId, ProductKey[]> {
  const configured: Record<ProviderId, ProductKey[]> = {}
  for (const [provider, products] of entries) if (products.size > 0) configured[provider] = [...products.keys()]
  return configured
}

/**
 * Decrypted payload → entries. Accepts the current per-provider shape (v3), the per-pool shape
 * (v2) and the legacy single-credential shape; the latter two map to the DataImpulse provider.
 */
export function parseVaultPayload(payload: unknown): { entries: VaultEntries; version: VaultPayloadVersion } {
  const current = ProvidersPayloadSchema.safeParse(payload)
  if (current.success) {
    const entries: VaultEntries = new Map()
    for (const [providerId, provider] of Object.entries(current.data.providers)) {
      const products = new Map<ProductKey, StoredProxyCredentials>()
      for (const [pool, stored] of Object.entries(provider.products)) products.set(pool, { providerId, pool, ...stored, extras: { ...stored.extras } })
      if (products.size > 0) entries.set(providerId, products)
    }
    return { entries, version: VAULT_PAYLOAD_VERSION }
  }
  const v2 = PoolsPayloadSchema.safeParse(payload)
  if (v2.success) {
    const products = new Map<ProductKey, StoredProxyCredentials>()
    for (const [pool, stored] of Object.entries(v2.data.pools)) products.set(pool, { providerId: LEGACY_PROVIDER, pool, ...stored, extras: {} })
    return { entries: products.size > 0 ? new Map([[LEGACY_PROVIDER, products]]) : new Map(), version: 2 }
  }
  const legacy = LegacyPayloadSchema.safeParse(payload)
  if (legacy.success) {
    const entry: StoredProxyCredentials = { providerId: LEGACY_PROVIDER, pool: LEGACY_PRODUCT, ...legacy.data, extras: {} }
    return { entries: new Map([[LEGACY_PROVIDER, new Map([[LEGACY_PRODUCT, entry]])]]), version: 1 }
  }
  throw new AppException('VAULT_ERROR', 'The vault decrypted but does not contain proxy credentials.', current.error.issues[0]?.message)
}

/** Entries → the v3 payload that is encrypted into the vault blob. */
export function toVaultPayload(entries: VaultEntries): VaultPayload {
  const providers: VaultPayload['providers'] = {}
  for (const [providerId, products] of entries) {
    if (products.size === 0) continue
    const stored: VaultPayload['providers'][string]['products'] = {}
    for (const [pool, entry] of products) {
      stored[pool] = {
        host: entry.host,
        port: entry.port,
        username: entry.username,
        password: entry.password,
        sessionTemplate: entry.sessionTemplate,
        extras: { ...entry.extras },
      }
    }
    providers[providerId] = { products: stored }
  }
  return { v: VAULT_PAYLOAD_VERSION, providers }
}

export async function createCredentialVault(opts: CredentialVaultOptions): Promise<CredentialVault> {
  const { logger, install, wrapper } = opts
  const platform = opts.platform ?? process.platform
  const now = opts.now ?? ((): Date => new Date())
  const writeAtomic = opts.writeFileAtomic ?? writeFileAtomicSync
  const machineWrapper = wrapper.backend === 'machine-derived' ? wrapper : createMachineDerivedWrapper(opts.machine)
  const installId = install.get().installId
  const keyPath = join(opts.paths.keys, `${installId}${KEY_FILE_SUFFIX}`)
  const rotatingKeyPath = join(opts.paths.keys, `${installId}${ROTATING_KEY_SUFFIX}`)
  const vaultPath = join(opts.paths.vault, VAULT_FILE_NAME)
  const backupPath = `${vaultPath}${VAULT_BACKUP_SUFFIX}`
  const listeners = new Set<Listener>()

  let loaded: LoadedKey | null = null
  /** Set when a key file exists but cannot be used (unknown format, keychain gone, …). */
  let keyProblem: string | null = null
  let entries: VaultEntries = new Map()
  /** Payload version of the file on disk (null: no file, or not decryptable). Below v3 the file must be backed up before any rewrite. */
  let diskVersion: VaultPayloadVersion | null = null
  /** Set while a pre-v3 file could not be migrated; reported by status(). */
  let migrationProblem: string | null = null
  const hasCredentials = (): boolean => entriesToList(entries).length > 0
  const activeSource = opts.activeSource ?? ((): CredentialSource => (hasCredentials() ? 'vault' : 'none'))

  // --- helpers -----------------------------------------------------------------

  const wrapperFor = (backend: WrappedKey['backend']): KeyWrapperBackend | null => {
    if (backend === wrapper.backend) return wrapper
    if (backend === 'machine-derived') return machineWrapper
    return null
  }

  const registerSecrets = (creds: VaultEntries): void => {
    for (const entry of entriesToList(creds)) {
      logger.registerSecret(entry.password)
      logger.registerSecret(`${entry.username}:${entry.password}`)
      const secretKeys = opts.secretExtraKeys ? new Set(opts.secretExtraKeys(entry.providerId)) : null
      for (const [key, value] of Object.entries(entry.extras)) {
        if (value.length > 0 && (secretKeys === null || secretKeys.has(key))) logger.registerSecret(value)
      }
    }
  }

  const emit = (): void => {
    const snapshot = entriesToList(entries)
    for (const listener of listeners) {
      try {
        listener(snapshot.map(copyEntry))
      } catch (err) {
        logger.error(SCOPE, 'Vault change listener threw', { error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  const readJson = (path: string, what: string): { raw: string; parsed: unknown } => {
    const raw = readFileSync(path, 'utf8')
    try {
      return { raw, parsed: JSON.parse(raw) as unknown }
    } catch {
      throw new AppException('VAULT_ERROR', `The ${what} file is not valid JSON.`, path)
    }
  }

  const unwrapKeyFile = async (path: string): Promise<LoadedKey> => {
    const { raw, parsed } = readJson(path, 'vault key')
    const descriptor = parseWrappedKey(parsed)
    if (descriptor.installId !== installId) {
      throw new AppException('VAULT_ERROR', 'The vault key file belongs to a different installation.', `key installId=${descriptor.installId}`)
    }
    const backend = wrapperFor(descriptor.backend)
    if (!backend) {
      throw new AppException(
        'VAULT_ERROR',
        `The vault key is protected by ${descriptor.backendLabel}, which is not available on this system right now.`,
        `key backend=${descriptor.backend}, active backend=${wrapper.backend}`,
      )
    }
    const key = await backend.unwrap(Buffer.from(descriptor.data, 'base64'), { installId })
    return { key, descriptor, raw }
  }

  const writeKeyFile = async (path: string, key: Buffer): Promise<LoadedKey> => {
    const data = await wrapper.wrap(key, { installId })
    const descriptor: WrappedKey = {
      v: 1,
      backend: wrapper.backend,
      backendLabel: wrapper.label,
      installId,
      createdAt: now().toISOString(),
      data: data.toString('base64'),
    }
    const raw = `${JSON.stringify(descriptor, null, 2)}\n`
    writeFileAtomicSync(path, raw, { mode: PRIVATE_FILE_MODE, platform })
    return { key, descriptor, raw }
  }

  const readVaultBlob = (): VaultBlob => {
    const blob = parseVaultBlob(readJson(vaultPath, 'vault').parsed)
    if (blob.installId !== installId) {
      throw new AppException('VAULT_ERROR', 'The vault belongs to a different installation.', `vault installId=${blob.installId}`)
    }
    return blob
  }

  const decryptVault = (key: Buffer): DecryptedVault => {
    const blob = readVaultBlob()
    const parsed = parseVaultPayload(decryptJson(key, blob))
    return { entries: parsed.entries, blob, version: parsed.version }
  }

  const writeVault = (key: Buffer, next: VaultEntries): void => {
    const blob = encryptJson(key, toVaultPayload(next), installId, now())
    writeAtomic(vaultPath, `${JSON.stringify(blob, null, 2)}\n`, { mode: PRIVATE_FILE_MODE, platform })
  }

  const fileModeOk = (path: string): boolean => {
    if (platform === 'win32' || !existsSync(path)) return true
    return (statSync(path).mode & 0o077) === 0
  }

  const restoreVault = (previous: Buffer | null): void => {
    if (previous) writeAtomic(vaultPath, previous, { mode: PRIVATE_FILE_MODE, platform })
    else if (existsSync(vaultPath)) unlinkSync(vaultPath)
  }

  const migrationError = (cause: unknown): AppException =>
    new AppException(
      'VAULT_ERROR',
      `The credential vault could not be upgraded to the current format. The original vault file and its backup ${backupPath} were left untouched.`,
      detail(cause),
    )

  /**
   * Copy the pre-v3 vault file, byte for byte, to `<name>.v2.bak` (atomic, same directory, same
   * permissions) and verify the copy. A different backup that already exists (e.g. from an earlier
   * downgrade) is moved aside first instead of being overwritten. No-op once the file is v3.
   */
  const ensureLegacyBackup = (): void => {
    if (diskVersion === null || diskVersion === VAULT_PAYLOAD_VERSION || !existsSync(vaultPath)) return
    try {
      const original = readFileSync(vaultPath)
      if (existsSync(backupPath)) {
        if (readFileSync(backupPath).equals(original)) return
        const aside = `${backupPath}.${now().getTime()}`
        renameSync(backupPath, aside)
        logger.warn(SCOPE, 'An older vault backup was moved aside before a new one was taken', { movedTo: aside })
      }
      const mode = platform === 'win32' ? PRIVATE_FILE_MODE : statSync(vaultPath).mode & 0o777
      writeAtomic(backupPath, original, { mode, platform })
      if (!readFileSync(backupPath).equals(original)) throw new Error('the backup copy does not match the vault file')
      logger.info(SCOPE, `Backed up the v${diskVersion === 1 ? '1 (single-credential)' : '2'} vault before upgrading it`, { backupPath })
    } catch (err) {
      throw migrationError(err)
    }
  }

  /** Returns a usable key, creating a fresh one when none can be loaded (an unusable key file is moved aside). */
  const ensureUsableKey = async (): Promise<Buffer> => {
    if (loaded) return loaded.key
    if (existsSync(keyPath)) {
      const aside = `${keyPath}.unusable-${now().getTime()}`
      renameSync(keyPath, aside)
      logger.warn(SCOPE, 'Replacing an unusable vault key file; the previous one was moved aside', { movedTo: aside, reason: keyProblem })
    }
    loaded = await writeKeyFile(keyPath, generateKey())
    keyProblem = null
    logger.info(SCOPE, 'Created a new vault key', { backend: loaded.descriptor.backend, label: loaded.descriptor.backendLabel })
    return loaded.key
  }

  /**
   * Write `next`, read it back and verify it; on any problem the previous file
   * bytes are restored and a VAULT_ERROR is thrown. A pre-v3 file is backed up
   * first (or nothing is written). The in-memory state is only updated by the
   * caller after this returns.
   */
  const commitVault = (key: Buffer, next: VaultEntries): void => {
    ensureLegacyBackup()
    const previous = existsSync(vaultPath) ? readFileSync(vaultPath) : null
    try {
      // Atomic: a failed write leaves the previous file as it was.
      writeVault(key, next)
    } catch (err) {
      logger.error(SCOPE, 'Vault write failed; the previous file is unchanged', { error: detail(err) })
      throw diskVersion !== null && diskVersion !== VAULT_PAYLOAD_VERSION
        ? migrationError(err)
        : new AppException('VAULT_ERROR', 'The credentials could not be written to the vault. Nothing was saved.', detail(err))
    }
    let verified: DecryptedVault
    try {
      verified = decryptVault(key)
    } catch (err) {
      restoreVault(previous)
      logger.error(SCOPE, 'Vault write could not be verified; previous contents restored', { error: detail(err) })
      throw new AppException('VAULT_ERROR', VERIFY_FAILED_MESSAGE, detail(err))
    }
    if (verified.version !== VAULT_PAYLOAD_VERSION || !entriesEqual(verified.entries, next)) {
      restoreVault(previous)
      logger.error(SCOPE, 'Vault read-back does not match what was written; previous contents restored')
      throw new AppException('VAULT_ERROR', VERIFY_FAILED_MESSAGE, 'read-back mismatch')
    }
    diskVersion = VAULT_PAYLOAD_VERSION
    migrationProblem = null
  }

  /** Rewrite a pre-v3 file in the v3 format (backup first). Failures leave both files untouched. */
  const migrateVaultFile = (key: Buffer, from: VaultPayloadVersion): void => {
    try {
      commitVault(key, entries)
    } catch (err) {
      // ensureLegacyBackup already names the backup; anything else (write, read-back) is wrapped the same way.
      const error = err instanceof AppException && err.message.includes(backupPath) ? err : migrationError(err)
      migrationProblem = error.message
      // Both files are as they were: the rewrite never replaced the original (or restored it).
      logger.error(SCOPE, error.message, { error: error.detail ?? null, backupPath, fromVersion: from })
      throw error
    }
    logger.info(
      SCOPE,
      from === 1
        ? 'Migrated the single-credential vault into the per-provider format (dataimpulse/residential)'
        : 'Migrated the per-pool vault into the per-provider format (dataimpulse)',
      { backupPath, fromVersion: from, providers: Object.keys(configuredProductsOf(entries)) },
    )
  }

  // --- startup -----------------------------------------------------------------

  const initialize = async (): Promise<void> => {
    if (existsSync(keyPath)) {
      try {
        loaded = await unwrapKeyFile(keyPath)
      } catch (err) {
        keyProblem = detail(err)
        logger.warn(SCOPE, 'Vault key file exists but could not be used', { keyPath, error: keyProblem })
      }
    } else {
      try {
        loaded = await writeKeyFile(keyPath, generateKey())
        logger.info(SCOPE, 'Created a new vault key', { backend: loaded.descriptor.backend, label: loaded.descriptor.backendLabel, keyPath })
      } catch (err) {
        keyProblem = detail(err)
        logger.error(SCOPE, 'Could not create the vault key', { keyPath, error: keyProblem })
      }
    }

    const vaultPresent = existsSync(vaultPath)

    // Interrupted rotation: the vault may already be encrypted with the pending key.
    if (existsSync(rotatingKeyPath)) {
      let promoted = false
      try {
        const pending = await unwrapKeyFile(rotatingKeyPath)
        if (vaultPresent) {
          decryptVault(pending.key)
          renameSync(rotatingKeyPath, keyPath)
          loaded = pending
          keyProblem = null
          promoted = true
          logger.warn(SCOPE, 'Recovered an interrupted key rotation: the pending key decrypts the vault and is now active')
        }
      } catch {
        // The pending key is not the one the vault needs; discard it below.
      }
      if (!promoted) {
        try {
          unlinkSync(rotatingKeyPath)
        } catch {
          // Already gone.
        }
      }
    }

    if (vaultPresent && loaded) {
      let decrypted: DecryptedVault | null = null
      try {
        decrypted = decryptVault(loaded.key)
      } catch (err) {
        entries = new Map()
        logger.warn(SCOPE, 'Vault present but undecryptable', { vaultPath, error: detail(err) })
      }
      if (decrypted) {
        entries = decrypted.entries
        diskVersion = decrypted.version
        registerSecrets(entries)
        if (decrypted.version !== VAULT_PAYLOAD_VERSION) {
          // One-time migration into the per-provider shape; the credentials stay usable even if it fails.
          try {
            migrateVaultFile(loaded.key, decrypted.version)
          } catch {
            // Logged and reported by status(); every later write retries the backup first.
          }
        }
      }
    }
  }

  await initialize()

  // --- public API --------------------------------------------------------------

  const status = async (): Promise<SecurityStatus> => {
    const keyPresent = existsSync(keyPath)
    const vaultPresent = existsSync(vaultPath)
    const warnings: string[] = []
    const state = install.get()

    if (keyProblem) warnings.push(`Vault key problem: ${keyProblem}`)
    if (migrationProblem) warnings.push(migrationProblem)
    if (loaded && keyPresent) {
      try {
        if (readFileSync(keyPath, 'utf8') !== loaded.raw) warnings.push('The vault key file changed on disk since it was loaded — restart the app to reload it')
      } catch {
        warnings.push('The vault key file could not be read')
      }
    }

    let decryptOk = loaded !== null
    let vaultUpdatedAt: string | null = null
    if (vaultPresent) {
      if (!loaded) {
        decryptOk = false
      } else {
        try {
          vaultUpdatedAt = decryptVault(loaded.key).blob.updatedAt
        } catch {
          decryptOk = false
        }
      }
      if (!decryptOk) warnings.push(UNDECRYPTABLE_WARNING)
    }

    const permissionsOk = fileModeOk(keyPath) && fileModeOk(vaultPath)
    if (!permissionsOk) warnings.push(PERMISSIONS_WARNING)

    if (loaded && loaded.descriptor.backend === 'machine-derived' && wrapper.backend === 'os-keychain') {
      warnings.push(`The vault key is protected by a machine-derived key although ${wrapper.label} is available — rotate the key to upgrade`)
    }

    return {
      source: activeSource(),
      configuredProducts: configuredProductsOf(entries),
      keyBackend: loaded?.descriptor.backend ?? 'none',
      keyBackendLabel: loaded?.descriptor.backendLabel ?? (keyPresent ? 'unreadable key file' : NO_KEY_LABEL),
      keyPath,
      vaultPath,
      keyPresent,
      vaultPresent,
      decryptOk,
      permissionsOk,
      installId,
      keyCreatedAt: loaded?.descriptor.createdAt ?? null,
      vaultUpdatedAt,
      lastCheckedAt: now().toISOString(),
      lastProxyTestAt: state.lastProxyTestAt,
      lastProxyTestStatus: state.lastProxyTestStatus,
      warnings,
    }
  }

  const save = async (input: ProxyCredentialsInput): Promise<SecurityStatus> => {
    const parsed = ProxyCredentialsInputSchema.safeParse(input)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new AppException('INVALID_INPUT', issue ? `${issue.path.map(String).join('.') || 'credentials'}: ${issue.message}` : 'Invalid credentials.')
    }
    const entry = toProxyCredentials(parsed.data)
    const next = withEntry(entries, entry)
    registerSecrets(next)

    const key = await ensureUsableKey()
    commitVault(key, next)

    entries = next
    logger.info(SCOPE, `Proxy credentials saved to encrypted vault (${entry.providerId} ${entry.pool})`, {
      providerId: entry.providerId,
      pool: entry.pool,
      host: entry.host,
      port: entry.port,
      username: maskUsername(entry.username),
      templateOverride: entry.sessionTemplate !== null,
      extraFields: Object.keys(entry.extras),
      configuredProducts: configuredProductsOf(entries),
      backend: loaded?.descriptor.backend ?? 'none',
    })
    emit()
    return status()
  }

  const clear = async (providerId: ProviderId, product: ProductKey): Promise<SecurityStatus> => {
    const had = entries.get(providerId)?.has(product) ?? false
    const next = withoutEntry(entries, providerId, product)
    if (entriesToList(next).length === 0) {
      // Nothing left to protect: drop the file (the key is kept for the next save). A pre-v3 file is backed up first.
      ensureLegacyBackup()
      if (existsSync(vaultPath)) unlinkSync(vaultPath)
      diskVersion = null
      migrationProblem = null
    } else if (had) {
      commitVault(await ensureUsableKey(), next)
    }
    entries = next
    logger.info(
      SCOPE,
      had ? `Proxy credentials for ${providerId} ${product} removed from the vault` : `Vault held no ${providerId} ${product} credentials; nothing to clear`,
      { providerId, pool: product, configuredProducts: configuredProductsOf(entries) },
    )
    emit()
    return status()
  }

  const rotateKey = async (): Promise<SecurityStatus> => {
    const vaultPresent = existsSync(vaultPath)
    if (vaultPresent && !hasCredentials()) {
      throw new AppException(
        'VAULT_ERROR',
        'The vault cannot be decrypted with the current key, so it cannot be re-encrypted. Re-enter the credentials or clear the vault first.',
      )
    }
    if (hasCredentials()) ensureLegacyBackup()
    const previousVault = vaultPresent ? readFileSync(vaultPath) : null
    let pending: LoadedKey
    let vaultRewritten = false
    try {
      pending = await writeKeyFile(rotatingKeyPath, generateKey())
      if (hasCredentials()) {
        vaultRewritten = true
        writeVault(pending.key, entries)
        const verified = decryptVault(pending.key).entries
        if (!entriesEqual(verified, entries)) throw new AppException('VAULT_ERROR', 'read-back mismatch after re-encryption')
      }
      renameSync(rotatingKeyPath, keyPath)
    } catch (err) {
      try {
        if (vaultRewritten) restoreVault(previousVault)
      } finally {
        if (existsSync(rotatingKeyPath)) unlinkSync(rotatingKeyPath)
      }
      logger.error(SCOPE, 'Key rotation failed; previous key and vault kept', { error: detail(err) })
      throw new AppException('VAULT_ERROR', 'Key rotation failed. The previous key and vault were kept.', detail(err))
    }
    loaded = pending
    keyProblem = null
    if (vaultRewritten) {
      diskVersion = VAULT_PAYLOAD_VERSION
      migrationProblem = null
    }
    logger.info(SCOPE, 'Vault key rotated', { backend: pending.descriptor.backend, label: pending.descriptor.backendLabel, reEncrypted: hasCredentials() })
    return status()
  }

  return {
    get: (providerId: ProviderId, product: ProductKey) => {
      const entry = entries.get(providerId)?.get(product)
      return entry ? copyEntry(entry) : null
    },
    getAll: () => entriesToList(entries),
    status,
    save,
    clear,
    rotateKey,
    recordProxyTest: (proxyStatus: ProxyStatus, at: string) => {
      install.update({ lastProxyTestAt: at, lastProxyTestStatus: proxyStatus })
    },
    onChange: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    keyPath,
    vaultPath,
    backupPath,
  }
}

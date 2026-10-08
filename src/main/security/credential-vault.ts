/**
 * Encrypted, per-machine proxy credential vault (implements `CredentialVault`).
 *
 * Files
 *   <keys>/<installId>.key              WrappedKey JSON (0600) — the random
 *                                       256-bit vault key wrapped by the OS
 *                                       keychain or the machine-derived key
 *   <vault>/proxy-credentials.vault     VaultBlob JSON (0600) — AES-256-GCM
 *   <userData>/install.json             installId + setup/health bookkeeping
 *                                       (owned by `InstallStateStore`)
 *
 * Payload (decrypted) — one entry per DataImpulse pool:
 *   { v: 2, pools: { residential?: Credentials, mobile?: Credentials } }
 * A vault written by an earlier version holds a single credential object (the
 * previous shape); it is migrated into `pools.residential` on load and the file
 * is rewritten in the new shape once.
 *
 * Rules
 *   - Decrypted credentials live in main-process memory only.
 *   - Startup never throws for a bad vault: an undecryptable vault yields
 *     `decryptOk: false`, a warning, and `get() === null` for every pool.
 *   - Every write is atomic (temp file + rename) and `save()` reads its own
 *     output back before reporting success.
 *   - `rotateKey()` writes the new key beside the old one, re-encrypts, then
 *     swaps; an interrupted rotation is recovered on the next start.
 *   - Every pool's password (and `user:pass`) is registered with the logger the
 *     moment it is known.
 */
import { existsSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { z } from 'zod'

import { PROXY_POOLS, ProxyCredentialsInputSchema, ProxyPoolSchema } from '@shared/types'
import type { CredentialSource, ProxyCredentialsInput, ProxyPool, ProxyStatus, SecurityStatus } from '@shared/types'

import { maskUsername } from '../config/env'
import { AppException } from '../contracts'
import type { AppPaths, CredentialVault, Logger, ProxyCredentials } from '../contracts'
import { PRIVATE_FILE_MODE, writeFileAtomicSync } from '../util/atomic-file'
import { decryptJson, encryptJson, generateKey, parseVaultBlob, parseWrappedKey } from './crypto'
import type { MachineIdentity, VaultBlob, WrappedKey } from './crypto'
import type { InstallStateStore } from './install-state'
import { NO_KEY_LABEL, createMachineDerivedWrapper } from './key-wrapper'
import type { KeyWrapperBackend } from './key-wrapper'

export const VAULT_FILE_NAME = 'proxy-credentials.vault'
export const KEY_FILE_SUFFIX = '.key'
/** Sibling of the key file while a rotation is in flight. */
export const ROTATING_KEY_SUFFIX = '.key.rotating'
/** Version tag of the per-pool payload. */
export const VAULT_PAYLOAD_VERSION = 2 as const
export const UNDECRYPTABLE_WARNING = 'Vault could not be decrypted with the current key — re-enter the proxy credentials'
export const PERMISSIONS_WARNING = 'Key or vault file is readable by other users on this machine — restrict it to the owner (chmod 600)'
export const VERIFY_FAILED_MESSAGE = 'Credentials were written but could not be verified. Nothing was saved.'

const SCOPE = 'security.vault'

export interface CredentialVaultOptions {
  paths: Pick<AppPaths, 'vault' | 'keys'>
  logger: Logger
  /** Backend for new and rotated keys. */
  wrapper: KeyWrapperBackend
  /** Used to unwrap keys written by the machine-derived backend when `wrapper` is the OS keychain. */
  machine: MachineIdentity
  install: InstallStateStore
  /** Where the proxy provider's active credentials come from. Defaults to 'vault' when the vault holds credentials, else 'none'. */
  activeSource?: () => CredentialSource
  now?: () => Date
  platform?: NodeJS.Platform
}

/** One pool's stored credentials (defensive: the file may come from another version). */
const StoredCredentialsSchema = z.object({
  host: z.string().min(1),
  port: z.int().min(1).max(65535),
  username: z.string().min(1),
  password: z.string().min(1),
  sessionTemplate: z.string().nullable(),
})
type StoredCredentials = z.infer<typeof StoredCredentialsSchema>

/** Current payload: credentials per pool. */
const PoolsPayloadSchema = z.object({
  v: z.literal(VAULT_PAYLOAD_VERSION),
  pools: z.partialRecord(ProxyPoolSchema, StoredCredentialsSchema),
})
type PoolsPayload = z.infer<typeof PoolsPayloadSchema>

/** Vaults written before pools existed held exactly one credential object (residential plan). */
const LegacyPayloadSchema = StoredCredentialsSchema

type Pools = Partial<Record<ProxyPool, ProxyCredentials>>
type Listener = (credentials: ProxyCredentials[]) => void

interface LoadedKey {
  key: Buffer
  descriptor: WrappedKey
  raw: string
}

interface DecryptedVault {
  pools: Pools
  blob: VaultBlob
  /** True when the file still has the single-credential shape and must be rewritten. */
  legacy: boolean
}

function detail(err: unknown): string {
  return err instanceof AppException ? `${err.message}${err.detail ? ` (${err.detail})` : ''}` : err instanceof Error ? err.message : String(err)
}

export function credentialsEqual(a: ProxyCredentials, b: ProxyCredentials): boolean {
  return (
    a.pool === b.pool &&
    a.host === b.host &&
    a.port === b.port &&
    a.username === b.username &&
    a.password === b.password &&
    a.sessionTemplate === b.sessionTemplate
  )
}

/** Normalise validated UI input into the stored shape (empty template → no override). */
export function toProxyCredentials(input: ProxyCredentialsInput): ProxyCredentials {
  const template = input.sessionTemplate?.trim()
  return { pool: input.pool, host: input.host, port: input.port, username: input.username, password: input.password, sessionTemplate: template ? template : null }
}

/** Pools in `PROXY_POOLS` order as a list. */
export function poolsToList(pools: Pools): ProxyCredentials[] {
  return PROXY_POOLS.flatMap((pool) => {
    const entry = pools[pool]
    return entry ? [{ ...entry }] : []
  })
}

function poolsEqual(a: Pools, b: Pools): boolean {
  return PROXY_POOLS.every((pool) => {
    const left = a[pool]
    const right = b[pool]
    if (!left || !right) return left === undefined && right === undefined
    return credentialsEqual(left, right)
  })
}

/** Decrypted payload → pools. Accepts the current per-pool shape and the legacy single-credential shape. */
export function parseVaultPayload(payload: unknown): { pools: Pools; legacy: boolean } {
  const current = PoolsPayloadSchema.safeParse(payload)
  if (current.success) {
    const pools: Pools = {}
    for (const pool of PROXY_POOLS) {
      const stored: StoredCredentials | undefined = current.data.pools[pool]
      if (stored) pools[pool] = { pool, ...stored }
    }
    return { pools, legacy: false }
  }
  const legacy = LegacyPayloadSchema.safeParse(payload)
  if (legacy.success) return { pools: { residential: { pool: 'residential', ...legacy.data } }, legacy: true }
  throw new AppException('VAULT_ERROR', 'The vault decrypted but does not contain proxy credentials.', current.error.issues[0]?.message)
}

/** Pools → the payload that is encrypted into the vault blob. */
export function toVaultPayload(pools: Pools): PoolsPayload {
  const stored: PoolsPayload['pools'] = {}
  for (const pool of PROXY_POOLS) {
    const entry = pools[pool]
    if (!entry) continue
    stored[pool] = { host: entry.host, port: entry.port, username: entry.username, password: entry.password, sessionTemplate: entry.sessionTemplate }
  }
  return { v: VAULT_PAYLOAD_VERSION, pools: stored }
}

export async function createCredentialVault(opts: CredentialVaultOptions): Promise<CredentialVault> {
  const { logger, install, wrapper } = opts
  const platform = opts.platform ?? process.platform
  const now = opts.now ?? ((): Date => new Date())
  const machineWrapper = wrapper.backend === 'machine-derived' ? wrapper : createMachineDerivedWrapper(opts.machine)
  const installId = install.get().installId
  const keyPath = join(opts.paths.keys, `${installId}${KEY_FILE_SUFFIX}`)
  const rotatingKeyPath = join(opts.paths.keys, `${installId}${ROTATING_KEY_SUFFIX}`)
  const vaultPath = join(opts.paths.vault, VAULT_FILE_NAME)
  const listeners = new Set<Listener>()

  let loaded: LoadedKey | null = null
  /** Set when a key file exists but cannot be used (unknown format, keychain gone, …). */
  let keyProblem: string | null = null
  let pools: Pools = {}
  const hasCredentials = (): boolean => poolsToList(pools).length > 0
  const activeSource = opts.activeSource ?? ((): CredentialSource => (hasCredentials() ? 'vault' : 'none'))

  // --- helpers -----------------------------------------------------------------

  const wrapperFor = (backend: WrappedKey['backend']): KeyWrapperBackend | null => {
    if (backend === wrapper.backend) return wrapper
    if (backend === 'machine-derived') return machineWrapper
    return null
  }

  const registerSecrets = (creds: Pools): void => {
    for (const entry of poolsToList(creds)) {
      logger.registerSecret(entry.password)
      logger.registerSecret(`${entry.username}:${entry.password}`)
    }
  }

  const emit = (): void => {
    const snapshot = poolsToList(pools)
    for (const listener of listeners) {
      try {
        listener(snapshot.map((entry) => ({ ...entry })))
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
    return { pools: parsed.pools, blob, legacy: parsed.legacy }
  }

  const writeVault = (key: Buffer, next: Pools): void => {
    const blob = encryptJson(key, toVaultPayload(next), installId, now())
    writeFileAtomicSync(vaultPath, `${JSON.stringify(blob, null, 2)}\n`, { mode: PRIVATE_FILE_MODE, platform })
  }

  const fileModeOk = (path: string): boolean => {
    if (platform === 'win32' || !existsSync(path)) return true
    return (statSync(path).mode & 0o077) === 0
  }

  const restoreVault = (previous: Buffer | null): void => {
    if (previous) writeFileAtomicSync(vaultPath, previous, { mode: PRIVATE_FILE_MODE, platform })
    else if (existsSync(vaultPath)) unlinkSync(vaultPath)
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
   * bytes are restored and a VAULT_ERROR is thrown. The in-memory state is only
   * updated by the caller after this returns.
   */
  const commitVault = (key: Buffer, next: Pools): void => {
    const previous = existsSync(vaultPath) ? readFileSync(vaultPath) : null
    writeVault(key, next)
    let verified: Pools
    try {
      verified = decryptVault(key).pools
    } catch (err) {
      restoreVault(previous)
      logger.error(SCOPE, 'Vault write could not be verified; previous contents restored', { error: detail(err) })
      throw new AppException('VAULT_ERROR', VERIFY_FAILED_MESSAGE, detail(err))
    }
    if (!poolsEqual(verified, next)) {
      restoreVault(previous)
      logger.error(SCOPE, 'Vault read-back does not match what was written; previous contents restored')
      throw new AppException('VAULT_ERROR', VERIFY_FAILED_MESSAGE, 'read-back mismatch')
    }
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
      try {
        const decrypted = decryptVault(loaded.key)
        pools = decrypted.pools
        registerSecrets(pools)
        if (decrypted.legacy) {
          // One-time migration of the single-credential vault into the per-pool shape.
          try {
            commitVault(loaded.key, pools)
            logger.info(SCOPE, 'Migrated the single-credential vault into the per-pool format (residential)')
          } catch (err) {
            logger.warn(SCOPE, 'Could not rewrite the legacy vault in the per-pool format; it will be retried on the next save', { error: detail(err) })
          }
        }
      } catch (err) {
        pools = {}
        logger.warn(SCOPE, 'Vault present but undecryptable', { vaultPath, error: detail(err) })
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
      configuredPools: poolsToList(pools).map((entry) => entry.pool),
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
    const next: Pools = { ...pools, [entry.pool]: entry }
    registerSecrets(next)

    const key = await ensureUsableKey()
    commitVault(key, next)

    pools = next
    logger.info(SCOPE, `Proxy credentials saved to encrypted vault (${entry.pool} pool)`, {
      pool: entry.pool,
      host: entry.host,
      port: entry.port,
      username: maskUsername(entry.username),
      templateOverride: entry.sessionTemplate !== null,
      configuredPools: poolsToList(pools).map((c) => c.pool),
      backend: loaded?.descriptor.backend ?? 'none',
    })
    emit()
    return status()
  }

  const clear = async (pool: ProxyPool): Promise<SecurityStatus> => {
    const had = pools[pool] !== undefined
    const next: Pools = { ...pools }
    delete next[pool]
    if (poolsToList(next).length === 0) {
      // Nothing left to protect: drop the file (the key is kept for the next save).
      if (existsSync(vaultPath)) unlinkSync(vaultPath)
    } else if (had) {
      commitVault(await ensureUsableKey(), next)
    }
    pools = next
    logger.info(SCOPE, had ? `Proxy credentials for the ${pool} pool removed from the vault` : `Vault held no ${pool} credentials; nothing to clear`, {
      pool,
      configuredPools: poolsToList(pools).map((c) => c.pool),
    })
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
    const previousVault = vaultPresent ? readFileSync(vaultPath) : null
    let pending: LoadedKey
    let vaultRewritten = false
    try {
      pending = await writeKeyFile(rotatingKeyPath, generateKey())
      if (hasCredentials()) {
        vaultRewritten = true
        writeVault(pending.key, pools)
        const verified = decryptVault(pending.key).pools
        if (!poolsEqual(verified, pools)) throw new AppException('VAULT_ERROR', 'read-back mismatch after re-encryption')
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
    logger.info(SCOPE, 'Vault key rotated', { backend: pending.descriptor.backend, label: pending.descriptor.backendLabel, reEncrypted: hasCredentials() })
    return status()
  }

  return {
    get: (pool: ProxyPool) => {
      const entry = pools[pool]
      return entry ? { ...entry } : null
    },
    getAll: () => poolsToList(pools),
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
  }
}

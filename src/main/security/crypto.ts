/**
 * Pure cryptographic primitives for the credential vault. No filesystem, no
 * Electron — everything here is deterministic given its inputs (apart from
 * the random IVs/keys) so it can be unit-tested directly.
 *
 *   - Vault blobs: AES-256-GCM, 12-byte random IV, 16-byte tag, with the
 *     header `{ v, alg, installId }` bound as additional authenticated data so
 *     a blob cannot be moved between installations or re-labelled.
 *   - Machine-derived key: scrypt(N=2^15, r=8, p=1) over the machine id and
 *     the OS username, salted with sha256(installId). Used to wrap the vault
 *     key when no OS keychain is available.
 *   - Wrapped-key file format (`WrappedKey`) shared by both key backends.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto'

import { z } from 'zod'

import type { KeyBackend } from '@shared/types'

import { AppException } from '../contracts'

export const VAULT_FORMAT_VERSION = 1 as const
export const VAULT_ALGORITHM = 'aes-256-gcm' as const
export const KEY_LENGTH = 32
export const IV_LENGTH = 12
export const TAG_LENGTH = 16

/** scrypt cost for the machine-derived key. 128 * N * r = 32 MiB, so maxmem is raised above Node's default. */
export const MACHINE_KEY_SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const

/** Inputs that identify "this user on this machine" for the fallback key. */
export interface MachineIdentity {
  machineId: string
  username: string
}

export interface VaultBlob {
  v: typeof VAULT_FORMAT_VERSION
  alg: typeof VAULT_ALGORITHM
  installId: string
  /** base64 */
  iv: string
  /** base64 */
  tag: string
  /** base64 */
  ciphertext: string
  updatedAt: string
}

/** Key backends that can actually protect a key (the 'none' state never reaches disk). */
export type StoredKeyBackend = Exclude<KeyBackend, 'none'>

export interface WrappedKey {
  v: 1
  backend: StoredKeyBackend
  backendLabel: string
  installId: string
  createdAt: string
  /** base64 of the backend-specific wrapped bytes. */
  data: string
}

export interface EncryptedBytes {
  iv: Buffer
  tag: Buffer
  ciphertext: Buffer
}

const Base64Schema = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, 'not base64')

export const VaultBlobSchema = z.object({
  v: z.literal(VAULT_FORMAT_VERSION),
  alg: z.literal(VAULT_ALGORITHM),
  installId: z.string().min(1),
  iv: Base64Schema.min(1),
  tag: Base64Schema.min(1),
  ciphertext: Base64Schema,
  updatedAt: z.string().min(1),
})

export const WrappedKeySchema = z.object({
  v: z.literal(1),
  backend: z.enum(['os-keychain', 'machine-derived']),
  backendLabel: z.string().min(1),
  installId: z.string().min(1),
  createdAt: z.string().min(1),
  data: Base64Schema.min(1),
})

function vaultError(message: string, detail?: string): AppException {
  return new AppException('VAULT_ERROR', message, detail)
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH) {
    throw vaultError('The vault key has an unexpected size.', `expected ${KEY_LENGTH} bytes, got ${Buffer.isBuffer(key) ? key.length : typeof key}`)
  }
}

/** Fresh random 256-bit vault key. */
export function generateKey(): Buffer {
  return randomBytes(KEY_LENGTH)
}

/** Additional authenticated data bound to every vault blob: the header fields in canonical order. */
export function vaultAad(header: Pick<VaultBlob, 'v' | 'alg' | 'installId'>): Buffer {
  return Buffer.from(JSON.stringify({ v: header.v, alg: header.alg, installId: header.installId }), 'utf8')
}

export function encryptBytes(key: Buffer, plaintext: Buffer, aad: Buffer): EncryptedBytes {
  assertKey(key)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(VAULT_ALGORITHM, key, iv, { authTagLength: TAG_LENGTH })
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { iv, tag: cipher.getAuthTag(), ciphertext }
}

/** Throws `VAULT_ERROR` when the key is wrong, the data was tampered with or the AAD does not match. */
export function decryptBytes(key: Buffer, encrypted: EncryptedBytes, aad: Buffer): Buffer {
  assertKey(key)
  if (encrypted.iv.length !== IV_LENGTH || encrypted.tag.length !== TAG_LENGTH) {
    throw vaultError('Vault data is malformed.', `iv=${encrypted.iv.length} tag=${encrypted.tag.length}`)
  }
  const decipher = createDecipheriv(VAULT_ALGORITHM, key, encrypted.iv, { authTagLength: TAG_LENGTH })
  decipher.setAAD(aad)
  decipher.setAuthTag(encrypted.tag)
  try {
    return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()])
  } catch {
    throw vaultError('Vault could not be decrypted with the current key (integrity check failed).')
  }
}

/** Serialise `value` as JSON and encrypt it into a self-describing blob. */
export function encryptJson(key: Buffer, value: unknown, installId: string, now: Date = new Date()): VaultBlob {
  const header = { v: VAULT_FORMAT_VERSION, alg: VAULT_ALGORITHM, installId } as const
  const { iv, tag, ciphertext } = encryptBytes(key, Buffer.from(JSON.stringify(value), 'utf8'), vaultAad(header))
  return {
    ...header,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    updatedAt: now.toISOString(),
  }
}

/** Decrypt a blob produced by `encryptJson`. Throws `VAULT_ERROR` on any integrity or format problem. */
export function decryptJson(key: Buffer, blob: VaultBlob): unknown {
  const plaintext = decryptBytes(
    key,
    { iv: Buffer.from(blob.iv, 'base64'), tag: Buffer.from(blob.tag, 'base64'), ciphertext: Buffer.from(blob.ciphertext, 'base64') },
    vaultAad(blob),
  )
  try {
    return JSON.parse(plaintext.toString('utf8')) as unknown
  } catch {
    throw vaultError('Vault contents are not valid JSON after decryption.')
  }
}

/** Validate raw (parsed JSON) file contents as a vault blob. */
export function parseVaultBlob(raw: unknown): VaultBlob {
  const result = VaultBlobSchema.safeParse(raw)
  if (!result.success) throw vaultError('The vault file has an unknown format.', result.error.issues[0]?.message)
  return result.data
}

/** Validate raw (parsed JSON) file contents as a wrapped key. */
export function parseWrappedKey(raw: unknown): WrappedKey {
  const result = WrappedKeySchema.safeParse(raw)
  if (!result.success) throw vaultError('The vault key file has an unknown format.', result.error.issues[0]?.message)
  return result.data
}

/**
 * Deterministic per-user, per-machine, per-installation key. Only as strong
 * as the secrecy of the machine id, hence "reduced protection" in the UI.
 */
export function deriveMachineKey(installId: string, extra: MachineIdentity): Promise<Buffer> {
  const salt = createHash('sha256').update(installId, 'utf8').digest()
  const password = Buffer.from(`${extra.machineId}\n${extra.username}`, 'utf8')
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, MACHINE_KEY_SCRYPT, (err, derived) => {
      if (err) reject(err)
      else resolve(derived)
    })
  })
}

/** Constant-size serialisation of `EncryptedBytes` for the wrapped-key payload: iv | tag | ciphertext. */
export function packEncrypted(encrypted: EncryptedBytes): Buffer {
  return Buffer.concat([encrypted.iv, encrypted.tag, encrypted.ciphertext])
}

export function unpackEncrypted(packed: Buffer): EncryptedBytes {
  if (packed.length < IV_LENGTH + TAG_LENGTH + 1) throw vaultError('Wrapped key data is too short.')
  return {
    iv: packed.subarray(0, IV_LENGTH),
    tag: packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH),
    ciphertext: packed.subarray(IV_LENGTH + TAG_LENGTH),
  }
}

/**
 * Key wrapping backends for the vault key.
 *
 *   os-keychain      Electron `safeStorage` (Windows DPAPI, macOS Keychain,
 *                    libsecret / KWallet on Linux). Used ONLY when encryption is
 *                    available and, on Linux, the selected backend is a real
 *                    keyring: `basic_text` is a hard-coded key (no protection)
 *                    and `unknown` cannot be trusted either.
 *   machine-derived  AES-256-GCM under `deriveMachineKey(installId, machine)`.
 *                    Works everywhere but only hides the key from someone who
 *                    does not also have the machine id — reported to the user
 *                    as reduced protection.
 *
 * `safeStorage` is injected through `SafeStorageLike`, so none of this needs
 * Electron at test time.
 */
import type { KeyBackend } from '@shared/types'

import { AppException } from '../contracts'
import { KEY_LENGTH, decryptBytes, deriveMachineKey, encryptBytes, packEncrypted, unpackEncrypted } from './crypto'
import type { MachineIdentity, StoredKeyBackend } from './crypto'

export interface KeyWrapContext {
  installId: string
}

export interface KeyWrapperBackend {
  readonly backend: StoredKeyBackend
  /** Human label shown in the UI, e.g. "Windows DPAPI (current user)". */
  readonly label: string
  wrap(key: Buffer, ctx: KeyWrapContext): Promise<Buffer>
  unwrap(data: Buffer, ctx: KeyWrapContext): Promise<Buffer>
}

/** Structural subset of Electron's `safeStorage` (Linux-only `getSelectedStorageBackend` is optional). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
  getSelectedStorageBackend?(): string
}

export const MACHINE_DERIVED_LABEL = 'machine-derived key (no OS keychain found — reduced protection)'
export const NO_KEY_LABEL = 'no key yet'

/** Linux safeStorage backends that provide real protection. */
const TRUSTED_LINUX_BACKENDS: Record<string, string> = {
  gnome_libsecret: 'GNOME Keyring / libsecret',
  kwallet: 'KWallet',
  kwallet5: 'KWallet',
  kwallet6: 'KWallet',
}

export interface SafeStorageAssessment {
  usable: boolean
  label: string
  /** Raw Linux backend name, null elsewhere. */
  linuxBackend: string | null
  /** Why it is not usable (for the startup log), null when usable. */
  reason: string | null
}

/** Decide whether `safeStorage` may protect the key on this platform and how to label it. */
export function assessSafeStorage(safeStorage: SafeStorageLike | null, platform: NodeJS.Platform): SafeStorageAssessment {
  if (!safeStorage) return { usable: false, label: MACHINE_DERIVED_LABEL, linuxBackend: null, reason: 'safeStorage unavailable' }
  let available: boolean
  try {
    available = safeStorage.isEncryptionAvailable()
  } catch (err) {
    return { usable: false, label: MACHINE_DERIVED_LABEL, linuxBackend: null, reason: `isEncryptionAvailable threw: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!available) return { usable: false, label: MACHINE_DERIVED_LABEL, linuxBackend: null, reason: 'safeStorage.isEncryptionAvailable() is false' }

  if (platform === 'win32') return { usable: true, label: 'Windows DPAPI (current user)', linuxBackend: null, reason: null }
  if (platform === 'darwin') return { usable: true, label: 'macOS Keychain', linuxBackend: null, reason: null }

  let linuxBackend: string
  try {
    linuxBackend = safeStorage.getSelectedStorageBackend?.() ?? 'unknown'
  } catch {
    linuxBackend = 'unknown'
  }
  const trusted = TRUSTED_LINUX_BACKENDS[linuxBackend]
  if (trusted) return { usable: true, label: trusted, linuxBackend, reason: null }
  return {
    usable: false,
    label: MACHINE_DERIVED_LABEL,
    linuxBackend,
    reason: `safeStorage backend "${linuxBackend}" does not protect the key (basic_text is a hard-coded key)`,
  }
}

/** Wrapper over Electron safeStorage; returns null when the assessment says it must not be used. */
export function createSafeStorageWrapper(safeStorage: SafeStorageLike | null, platform: NodeJS.Platform): KeyWrapperBackend | null {
  const assessment = assessSafeStorage(safeStorage, platform)
  if (!assessment.usable || !safeStorage) return null
  return {
    backend: 'os-keychain',
    label: assessment.label,
    wrap: async (key) => safeStorage.encryptString(key.toString('base64')),
    unwrap: async (data) => {
      let plain: string
      try {
        plain = safeStorage.decryptString(data)
      } catch (err) {
        throw new AppException('VAULT_ERROR', `The OS keychain (${assessment.label}) could not unwrap the vault key.`, err instanceof Error ? err.message : String(err))
      }
      const key = Buffer.from(plain, 'base64')
      if (key.length !== KEY_LENGTH) throw new AppException('VAULT_ERROR', 'The unwrapped vault key has an unexpected size.')
      return key
    },
  }
}

const WRAPPED_KEY_AAD_PREFIX = 'proxy-qa-browser:wrapped-key:v1:'

/** AES-256-GCM under the scrypt machine key; derived keys are cached per installId (scrypt is deliberately slow). */
export function createMachineDerivedWrapper(machine: MachineIdentity): KeyWrapperBackend {
  const derived = new Map<string, Promise<Buffer>>()
  const keyFor = (installId: string): Promise<Buffer> => {
    let pending = derived.get(installId)
    if (!pending) {
      pending = deriveMachineKey(installId, machine)
      derived.set(installId, pending)
    }
    return pending
  }
  const aadFor = (installId: string): Buffer => Buffer.from(`${WRAPPED_KEY_AAD_PREFIX}${installId}`, 'utf8')
  return {
    backend: 'machine-derived',
    label: MACHINE_DERIVED_LABEL,
    wrap: async (key, ctx) => packEncrypted(encryptBytes(await keyFor(ctx.installId), key, aadFor(ctx.installId))),
    unwrap: async (data, ctx) => {
      const key = decryptBytes(await keyFor(ctx.installId), unpackEncrypted(data), aadFor(ctx.installId))
      if (key.length !== KEY_LENGTH) throw new AppException('VAULT_ERROR', 'The unwrapped vault key has an unexpected size.')
      return key
    },
  }
}

export interface KeyWrapperSelection {
  /** Backend used for new/rotated keys. */
  primary: KeyWrapperBackend
  /** Always available; unwraps keys written by the machine-derived backend when `primary` is the keychain. */
  machine: KeyWrapperBackend
  assessment: SafeStorageAssessment
}

export function selectKeyWrapper(opts: { safeStorage: SafeStorageLike | null; platform: NodeJS.Platform; machine: MachineIdentity }): KeyWrapperSelection {
  const machine = createMachineDerivedWrapper(opts.machine)
  const assessment = assessSafeStorage(opts.safeStorage, opts.platform)
  const keychain = createSafeStorageWrapper(opts.safeStorage, opts.platform)
  return { primary: keychain ?? machine, machine, assessment }
}

/** Human label for a backend when no key file describes it yet. */
export function backendLabelFor(backend: KeyBackend, selection: KeyWrapperSelection): string {
  if (backend === 'none') return NO_KEY_LABEL
  if (backend === 'machine-derived') return MACHINE_DERIVED_LABEL
  return selection.primary.backend === 'os-keychain' ? selection.primary.label : 'OS keychain (currently unavailable)'
}

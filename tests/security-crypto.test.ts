/**
 * Pure crypto primitives, key wrapping backends and the machine identity
 * readers — none of this touches Electron or the real host.
 */
import { describe, expect, it } from 'vitest'

import { AppException } from '../src/main/contracts'
import {
  IV_LENGTH,
  KEY_LENGTH,
  TAG_LENGTH,
  decryptJson,
  deriveMachineKey,
  encryptBytes,
  encryptJson,
  generateKey,
  packEncrypted,
  parseVaultBlob,
  parseWrappedKey,
  unpackEncrypted,
  vaultAad,
} from '../src/main/security/crypto'
import type { VaultBlob } from '../src/main/security/crypto'
import {
  MACHINE_DERIVED_LABEL,
  assessSafeStorage,
  createMachineDerivedWrapper,
  createSafeStorageWrapper,
  selectKeyWrapper,
} from '../src/main/security/key-wrapper'
import type { SafeStorageLike } from '../src/main/security/key-wrapper'
import { readMachineIdentity } from '../src/main/security/machine-identity'

const INSTALL_ID = '6f1c1c62-2b8e-4b57-9c8a-3a1b2c3d4e5f'
const MACHINE = { machineId: 'abcdef0123456789abcdef0123456789', username: 'tester' }
const payload = { host: 'gw.dataimpulse.com', port: 823, username: 'acme__cr.us', password: 'Sup3r$ecret', sessionTemplate: null }

/** Flip one bit in a base64 field of a blob. */
function tamper(blob: VaultBlob, field: 'ciphertext' | 'tag' | 'iv'): VaultBlob {
  const bytes = Buffer.from(blob[field], 'base64')
  bytes[0] = (bytes[0] ?? 0) ^ 0x01
  return { ...blob, [field]: bytes.toString('base64') }
}

/** Deterministic, reversible stand-in for safeStorage (byte-wise NOT). */
function fakeSafeStorage(overrides: Partial<SafeStorageLike> = {}): SafeStorageLike {
  const flip = (b: Buffer): Buffer => Buffer.from(b.map((x) => x ^ 0xff))
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => flip(Buffer.from(plain, 'utf8')),
    decryptString: (enc) => flip(enc).toString('utf8'),
    getSelectedStorageBackend: () => 'gnome_libsecret',
    ...overrides,
  }
}

describe('vault crypto', () => {
  it('generates 32-byte keys that differ', () => {
    const a = generateKey()
    const b = generateKey()
    expect(a).toHaveLength(KEY_LENGTH)
    expect(a.equals(b)).toBe(false)
  })

  it('encrypts JSON into a self-describing blob and decrypts it back', () => {
    const key = generateKey()
    const now = new Date('2026-10-03T12:00:00.000Z')
    const blob = encryptJson(key, payload, INSTALL_ID, now)
    expect(blob).toMatchObject({ v: 1, alg: 'aes-256-gcm', installId: INSTALL_ID, updatedAt: now.toISOString() })
    expect(Buffer.from(blob.iv, 'base64')).toHaveLength(IV_LENGTH)
    expect(Buffer.from(blob.tag, 'base64')).toHaveLength(TAG_LENGTH)
    expect(JSON.stringify(blob)).not.toContain(payload.password)
    expect(JSON.stringify(blob)).not.toContain(payload.username)
    expect(decryptJson(key, parseVaultBlob(JSON.parse(JSON.stringify(blob))))).toEqual(payload)
  })

  it('uses a fresh IV per encryption', () => {
    const key = generateKey()
    const a = encryptJson(key, payload, INSTALL_ID)
    const b = encryptJson(key, payload, INSTALL_ID)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })

  it('detects tampering of ciphertext, tag and iv', () => {
    const key = generateKey()
    const blob = encryptJson(key, payload, INSTALL_ID)
    for (const field of ['ciphertext', 'tag', 'iv'] as const) {
      expect(() => decryptJson(key, tamper(blob, field)), field).toThrowError(AppException)
      try {
        decryptJson(key, tamper(blob, field))
      } catch (err) {
        expect((err as AppException).code).toBe('VAULT_ERROR')
      }
    }
  })

  it('binds the header as AAD: moving a blob to another installation fails', () => {
    const key = generateKey()
    const blob = encryptJson(key, payload, INSTALL_ID)
    expect(() => decryptJson(key, { ...blob, installId: 'other-install' })).toThrowError(/could not be decrypted/)
    expect(vaultAad(blob).toString()).toBe(JSON.stringify({ v: 1, alg: 'aes-256-gcm', installId: INSTALL_ID }))
  })

  it('rejects the wrong key', () => {
    const blob = encryptJson(generateKey(), payload, INSTALL_ID)
    expect(() => decryptJson(generateKey(), blob)).toThrowError(/could not be decrypted/)
  })

  it('rejects malformed blobs and keys', () => {
    expect(() => parseVaultBlob({ v: 2, alg: 'aes-256-gcm', installId: 'x', iv: 'AA==', tag: 'AA==', ciphertext: '', updatedAt: 'now' })).toThrowError(/unknown format/)
    expect(() => parseVaultBlob({ v: 1, alg: 'aes-128-gcm', installId: 'x', iv: 'AA==', tag: 'AA==', ciphertext: '', updatedAt: 'now' })).toThrowError(/unknown format/)
    expect(() => parseWrappedKey({ v: 1, backend: 'plaintext', backendLabel: 'x', installId: 'x', createdAt: 'x', data: 'AA==' })).toThrowError(/unknown format/)
    expect(() => encryptBytes(Buffer.alloc(16), Buffer.from('x'), Buffer.alloc(0))).toThrowError(/unexpected size/)
  })

  it('packs and unpacks iv | tag | ciphertext', () => {
    const key = generateKey()
    const encrypted = encryptBytes(key, Buffer.from('hello'), Buffer.from('aad'))
    const packed = packEncrypted(encrypted)
    expect(packed).toHaveLength(IV_LENGTH + TAG_LENGTH + 5)
    const unpacked = unpackEncrypted(packed)
    expect(unpacked.iv.equals(encrypted.iv)).toBe(true)
    expect(unpacked.tag.equals(encrypted.tag)).toBe(true)
    expect(unpacked.ciphertext.equals(encrypted.ciphertext)).toBe(true)
    expect(() => unpackEncrypted(Buffer.alloc(IV_LENGTH + TAG_LENGTH))).toThrowError(/too short/)
  })
})

describe('deriveMachineKey', () => {
  it('is deterministic for the same install + machine + user and 32 bytes long', async () => {
    const a = await deriveMachineKey(INSTALL_ID, MACHINE)
    const b = await deriveMachineKey(INSTALL_ID, MACHINE)
    expect(a).toHaveLength(KEY_LENGTH)
    expect(a.equals(b)).toBe(true)
  })

  it('changes when any input changes', async () => {
    const base = await deriveMachineKey(INSTALL_ID, MACHINE)
    expect((await deriveMachineKey('other-install', MACHINE)).equals(base)).toBe(false)
    expect((await deriveMachineKey(INSTALL_ID, { ...MACHINE, machineId: 'ffff' })).equals(base)).toBe(false)
    expect((await deriveMachineKey(INSTALL_ID, { ...MACHINE, username: 'someone-else' })).equals(base)).toBe(false)
  })
})

describe('assessSafeStorage', () => {
  it('falls back to the machine-derived key when safeStorage is missing or unavailable', () => {
    expect(assessSafeStorage(null, 'linux')).toMatchObject({ usable: false, label: MACHINE_DERIVED_LABEL })
    expect(assessSafeStorage(fakeSafeStorage({ isEncryptionAvailable: () => false }), 'win32')).toMatchObject({ usable: false, label: MACHINE_DERIVED_LABEL })
  })

  it('refuses the Linux basic_text and unknown backends (hard-coded key = no protection)', () => {
    for (const backend of ['basic_text', 'unknown']) {
      const result = assessSafeStorage(fakeSafeStorage({ getSelectedStorageBackend: () => backend }), 'linux')
      expect(result.usable, backend).toBe(false)
      expect(result.linuxBackend).toBe(backend)
      expect(result.reason).toMatch(/does not protect/)
    }
    expect(assessSafeStorage(fakeSafeStorage({ getSelectedStorageBackend: undefined }), 'linux').usable).toBe(false)
  })

  it('labels real keyrings per platform', () => {
    expect(assessSafeStorage(fakeSafeStorage(), 'linux')).toMatchObject({ usable: true, label: 'GNOME Keyring / libsecret', linuxBackend: 'gnome_libsecret' })
    expect(assessSafeStorage(fakeSafeStorage({ getSelectedStorageBackend: () => 'kwallet5' }), 'linux')).toMatchObject({ usable: true, label: 'KWallet' })
    expect(assessSafeStorage(fakeSafeStorage({ getSelectedStorageBackend: () => 'kwallet6' }), 'linux')).toMatchObject({ usable: true, label: 'KWallet' })
    expect(assessSafeStorage(fakeSafeStorage(), 'win32')).toMatchObject({ usable: true, label: 'Windows DPAPI (current user)' })
    expect(assessSafeStorage(fakeSafeStorage(), 'darwin')).toMatchObject({ usable: true, label: 'macOS Keychain' })
  })
})

describe('key wrappers', () => {
  it('safeStorage wrapper round-trips a key and reports os-keychain', async () => {
    const wrapper = createSafeStorageWrapper(fakeSafeStorage(), 'win32')
    expect(wrapper?.backend).toBe('os-keychain')
    expect(wrapper?.label).toBe('Windows DPAPI (current user)')
    const key = generateKey()
    const wrapped = await wrapper!.wrap(key, { installId: INSTALL_ID })
    expect(wrapped.equals(key)).toBe(false)
    expect((await wrapper!.unwrap(wrapped, { installId: INSTALL_ID })).equals(key)).toBe(true)
  })

  it('safeStorage wrapper is not created for basic_text and surfaces decrypt failures as VAULT_ERROR', async () => {
    expect(createSafeStorageWrapper(fakeSafeStorage({ getSelectedStorageBackend: () => 'basic_text' }), 'linux')).toBeNull()
    const broken = createSafeStorageWrapper(
      fakeSafeStorage({
        decryptString: () => {
          throw new Error('keyring locked')
        },
      }),
      'darwin',
    )
    await expect(broken!.unwrap(Buffer.from('x'), { installId: INSTALL_ID })).rejects.toMatchObject({ code: 'VAULT_ERROR' })
  })

  it('machine-derived wrapper round-trips and is bound to the installId', async () => {
    const wrapper = createMachineDerivedWrapper(MACHINE)
    expect(wrapper.backend).toBe('machine-derived')
    expect(wrapper.label).toBe(MACHINE_DERIVED_LABEL)
    const key = generateKey()
    const wrapped = await wrapper.wrap(key, { installId: INSTALL_ID })
    expect(wrapped.includes(key)).toBe(false)
    expect((await wrapper.unwrap(wrapped, { installId: INSTALL_ID })).equals(key)).toBe(true)
    await expect(wrapper.unwrap(wrapped, { installId: 'other' })).rejects.toMatchObject({ code: 'VAULT_ERROR' })
    await expect(createMachineDerivedWrapper({ ...MACHINE, username: 'intruder' }).unwrap(wrapped, { installId: INSTALL_ID })).rejects.toMatchObject({
      code: 'VAULT_ERROR',
    })
  })

  it('selectKeyWrapper prefers a trusted keychain and otherwise the machine-derived backend', () => {
    const keychain = selectKeyWrapper({ safeStorage: fakeSafeStorage(), platform: 'linux', machine: MACHINE })
    expect(keychain.primary.backend).toBe('os-keychain')
    expect(keychain.machine.backend).toBe('machine-derived')
    const fallback = selectKeyWrapper({ safeStorage: fakeSafeStorage({ getSelectedStorageBackend: () => 'basic_text' }), platform: 'linux', machine: MACHINE })
    expect(fallback.primary.backend).toBe('machine-derived')
    expect(fallback.assessment.reason).toMatch(/basic_text/)
    expect(selectKeyWrapper({ safeStorage: null, platform: 'win32', machine: MACHINE }).primary.backend).toBe('machine-derived')
  })
})

describe('readMachineIdentity', () => {
  const username = (): string => 'tester'
  const hostname = (): string => 'qa-host'
  const noExec = async (): Promise<string> => {
    throw new Error('exec disabled')
  }

  it('reads /etc/machine-id on Linux and falls back to the dbus copy', async () => {
    const primary = await readMachineIdentity({
      platform: 'linux',
      readFile: async (path) => (path === '/etc/machine-id' ? 'abc123\n' : ''),
      exec: noExec,
      hostname,
      username,
    })
    expect(primary).toEqual({ machineId: 'abc123', username: 'tester', source: 'machine-id' })

    const dbus = await readMachineIdentity({
      platform: 'linux',
      readFile: async (path) => {
        if (path === '/var/lib/dbus/machine-id') return 'dbus-id'
        throw new Error('ENOENT')
      },
      exec: noExec,
      hostname,
      username,
    })
    expect(dbus).toMatchObject({ machineId: 'dbus-id', source: 'machine-id' })
  })

  it('falls back to the hostname when no source is readable', async () => {
    const result = await readMachineIdentity({
      platform: 'linux',
      readFile: async () => {
        throw new Error('ENOENT')
      },
      exec: noExec,
      hostname,
      username,
    })
    expect(result).toEqual({ machineId: 'qa-host', username: 'tester', source: 'hostname' })
  })

  it('parses the Windows MachineGuid and the macOS IOPlatformUUID', async () => {
    const windows = await readMachineIdentity({
      platform: 'win32',
      exec: async (file) => {
        expect(file).toBe('reg')
        return '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    4C4C4544-0032-4A10-8054-B4C04F443632\r\n\r\n'
      },
      hostname,
      username,
    })
    expect(windows).toMatchObject({ machineId: '4c4c4544-0032-4a10-8054-b4c04f443632', source: 'registry' })

    const mac = await readMachineIdentity({
      platform: 'darwin',
      exec: async (file) => {
        expect(file).toBe('ioreg')
        return '+-o MacBookPro  <class IOPlatformExpertDevice>\n  {\n    "IOPlatformUUID" = "A1B2C3D4-E5F6-4A5B-8C9D-0E1F2A3B4C5D"\n  }\n'
      },
      hostname,
      username,
    })
    expect(mac).toMatchObject({ machineId: 'a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d', source: 'ioreg' })

    const failed = await readMachineIdentity({ platform: 'win32', exec: noExec, hostname, username })
    expect(failed).toMatchObject({ machineId: 'qa-host', source: 'hostname' })
  })
})

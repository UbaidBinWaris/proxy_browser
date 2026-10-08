/**
 * Credential vault against real temp directories. A fake keychain wrapper
 * keeps most cases fast; the machine-derived backend is exercised end-to-end
 * in its own cases.
 *
 * `node:fs` is wrapped so one case can corrupt the vault file between the
 * write and the read-back (the "written but could not be verified" path);
 * everything else goes straight to the real module.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProxyCredentialsInput } from '../src/shared/types'
import { AppException } from '../src/main/contracts'
import { writeFileAtomicSync } from '../src/main/util/atomic-file'
import { ProxyCredentialsInputSchema } from '../src/shared/types'
import type { CredentialVault, Logger, StoredProxyCredentials } from '../src/main/contracts'
import { decryptJson, encryptJson, generateKey, parseVaultBlob, parseWrappedKey } from '../src/main/security/crypto'
import type { WrappedKey } from '../src/main/security/crypto'
import {
  PERMISSIONS_WARNING,
  UNDECRYPTABLE_WARNING,
  VAULT_FILE_NAME,
  VAULT_PAYLOAD_VERSION,
  entriesToList,
  VERIFY_FAILED_MESSAGE,
  createCredentialVault,
  parseVaultPayload,
  toVaultPayload,
} from '../src/main/security/credential-vault'
import type { CredentialVaultOptions, VaultEntries, VaultPayload } from '../src/main/security/credential-vault'
import { createInstallStateStore } from '../src/main/security/install-state'
import type { InstallStateStore } from '../src/main/security/install-state'
import { createMachineDerivedWrapper } from '../src/main/security/key-wrapper'
import type { KeyWrapperBackend } from '../src/main/security/key-wrapper'

/**
 * `corruptRead`: path whose next read is corrupted. `unlessEquals`: content that
 * passes through untouched (the pre-write snapshot `save()` takes for restore),
 * so only the post-write read-back is affected.
 */
const fsHooks = vi.hoisted(() => ({ corruptRead: null as string | null, unlessEquals: null as string | null }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    const result = Reflect.apply(actual.readFileSync, actual, args) as string | Buffer
    const path = args[0]
    if (fsHooks.corruptRead !== null && String(path) === fsHooks.corruptRead && result.toString() !== fsHooks.unlessEquals) {
      fsHooks.corruptRead = null
      fsHooks.unlessEquals = null
      const text = result.toString()
      // Flip a character inside the ciphertext so the GCM tag no longer verifies.
      const corrupted = text.replace(/"ciphertext": "([A-Za-z0-9+/])/, (_m, c: string) => `"ciphertext": "${c === 'A' ? 'B' : 'A'}`)
      return typeof result === 'string' ? corrupted : Buffer.from(corrupted)
    }
    return result
  }) as typeof actual.readFileSync
  return { ...actual, readFileSync }
})

const PASSWORD = 'Vault-P@ssw0rd-123'
const MOBILE_PASSWORD = 'Mobile-P@ss-456'
const USERNAME = 'acme_login__cr.us'
const MOBILE_USERNAME = 'acme_mobile_login'
const MACHINE = { machineId: 'machine-aaaa-bbbb', username: 'tester' }

const input = { pool: 'residential', host: 'gw.dataimpulse.com', port: 823, username: USERNAME, password: PASSWORD, sessionTemplate: null } satisfies ProxyCredentialsInput
const stored: StoredProxyCredentials = { ...input, providerId: 'dataimpulse', extras: {}, sessionTemplate: null }
const mobileInput = { pool: 'mobile', host: 'gw.dataimpulse.com', port: 823, username: MOBILE_USERNAME, password: MOBILE_PASSWORD, sessionTemplate: null } satisfies ProxyCredentialsInput
const mobileStored: StoredProxyCredentials = { ...mobileInput, providerId: 'dataimpulse', extras: {}, sessionTemplate: null }

/** In-memory vault entries for one DataImpulse product (the shape `toVaultPayload` takes). */
const entriesOf = (...list: StoredProxyCredentials[]): VaultEntries => {
  const entries: VaultEntries = new Map()
  for (const entry of list) {
    const products = entries.get(entry.providerId) ?? new Map<string, StoredProxyCredentials>()
    products.set(entry.pool, entry)
    entries.set(entry.providerId, products)
  }
  return entries
}

interface CapturingLogger extends Logger {
  entries: Array<{ level: string; scope: string; message: string; meta?: Record<string, unknown> }>
  secrets: string[]
}

function makeLogger(): CapturingLogger {
  const entries: CapturingLogger['entries'] = []
  const secrets: string[] = []
  const push = (level: string) => (scope: string, message: string, meta?: Record<string, unknown>) => void entries.push({ level, scope, message, meta })
  return {
    entries,
    secrets,
    info: push('INFO'),
    warn: push('WARN'),
    error: push('ERROR'),
    log: (level, scope, message, meta) => void entries.push({ level, scope, message, meta }),
    onEntry: () => () => undefined,
    query: () => [],
    clear: () => undefined,
    registerSecret: (value) => void secrets.push(value),
  }
}

/** Reversible stand-in for an OS keychain. `failWrapAfter` makes later wraps throw (rotation failure path). */
function fakeKeychain(opts: { label?: string; failWrapAfter?: number } = {}): KeyWrapperBackend & { wraps: number } {
  const marker = Buffer.from('FAKE-KEYCHAIN:')
  const self = {
    wraps: 0,
    backend: 'os-keychain' as const,
    label: opts.label ?? 'Fake Keychain',
    wrap: async (key: Buffer): Promise<Buffer> => {
      self.wraps += 1
      if (opts.failWrapAfter !== undefined && self.wraps > opts.failWrapAfter) throw new Error('keychain refused')
      return Buffer.concat([marker, key])
    },
    unwrap: async (data: Buffer): Promise<Buffer> => {
      if (!data.subarray(0, marker.length).equals(marker)) throw new Error('not wrapped by this keychain')
      return data.subarray(marker.length)
    },
  }
  return self
}

interface World {
  root: string
  paths: { vault: string; keys: string }
  install: InstallStateStore
  logger: CapturingLogger
}

function makeWorld(root: string): World {
  const paths = { vault: join(root, 'vault'), keys: join(root, 'keys') }
  mkdirSync(paths.vault, { recursive: true, mode: 0o700 })
  mkdirSync(paths.keys, { recursive: true, mode: 0o700 })
  return { root, paths, install: createInstallStateStore({ userData: root, appVersion: '1.0.0' }), logger: makeLogger() }
}

async function openVault(world: World, wrapper: KeyWrapperBackend, extra: { machine?: typeof MACHINE; now?: () => Date } = {}): Promise<CredentialVault> {
  return createCredentialVault({ paths: world.paths, logger: world.logger, wrapper, machine: extra.machine ?? MACHINE, install: world.install, now: extra.now })
}

function readKeyFile(path: string): WrappedKey {
  return parseWrappedKey(JSON.parse(readFileSync(path, 'utf8')))
}

/** The raw vault key behind the fake keychain wrapper. */
function rawKeyOf(keyPath: string): Buffer {
  return Buffer.from(readKeyFile(keyPath).data, 'base64').subarray('FAKE-KEYCHAIN:'.length)
}

const posix = process.platform !== 'win32'

describe('vault payload shapes', () => {
  const plain = { host: 'gw', port: 1, username: 'u', password: 'p', sessionTemplate: null }

  it('reads the per-provider v3 payload, the per-pool v2 payload and the legacy single-credential payload', () => {
    expect(VAULT_PAYLOAD_VERSION).toBe(3)
    const v3 = parseVaultPayload({ v: 3, providers: { dataimpulse: { products: { mobile: plain } }, acme: { products: { residential: { ...plain, extras: { zone: 'z1' } } } } } })
    expect(v3.version).toBe(3)
    expect(entriesToList(v3.entries)).toEqual([
      { providerId: 'dataimpulse', pool: 'mobile', ...plain, extras: {} },
      { providerId: 'acme', pool: 'residential', ...plain, extras: { zone: 'z1' } },
    ])
    // v2: every pool is a DataImpulse product.
    const v2 = parseVaultPayload({ v: 2, pools: { residential: plain, mobile: { ...plain, username: 'm' } } })
    expect(v2.version).toBe(2)
    expect(entriesToList(v2.entries)).toEqual([
      { providerId: 'dataimpulse', pool: 'residential', ...plain, extras: {} },
      { providerId: 'dataimpulse', pool: 'mobile', ...plain, username: 'm', extras: {} },
    ])
    // Legacy: one credential object → DataImpulse residential.
    const legacy = parseVaultPayload({ host: 'gw', port: 823, username: 'u', password: 'p', sessionTemplate: '{username}{sep}sid.{session}' })
    expect(legacy.version).toBe(1)
    expect(entriesToList(legacy.entries)).toEqual([{ providerId: 'dataimpulse', pool: 'residential', host: 'gw', port: 823, username: 'u', password: 'p', sessionTemplate: '{username}{sep}sid.{session}', extras: {} }])
    expect(() => parseVaultPayload({ v: 9 })).toThrowError(/does not contain proxy credentials/)
    expect(toVaultPayload(entriesOf(stored))).toEqual({
      v: VAULT_PAYLOAD_VERSION,
      providers: { dataimpulse: { products: { residential: { host: stored.host, port: stored.port, username: stored.username, password: stored.password, sessionTemplate: null, extras: {} } } } },
    })
  })
})

describe('createCredentialVault', () => {
  let root: string
  let world: World

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'proxy-qa-vault-'))
    world = makeWorld(root)
  })

  afterEach(() => {
    fsHooks.corruptRead = null
    fsHooks.unlessEquals = null
    rmSync(root, { recursive: true, force: true })
  })

  it('first run: creates install.json and a wrapped key, no vault, healthy status', async () => {
    const vault = await openVault(world, fakeKeychain())
    const installState = JSON.parse(readFileSync(join(root, 'install.json'), 'utf8')) as { installId: string; setupCompletedAt: string | null }
    expect(installState.installId).toMatch(/^[0-9a-f-]{36}$/)
    expect(installState.setupCompletedAt).toBeNull()

    expect(vault.keyPath).toBe(join(world.paths.keys, `${installState.installId}.key`))
    expect(vault.vaultPath).toBe(join(world.paths.vault, VAULT_FILE_NAME))
    expect(existsSync(vault.keyPath)).toBe(true)
    expect(existsSync(vault.vaultPath)).toBe(false)
    expect(vault.get('dataimpulse', 'residential')).toBeNull()
    expect(vault.get('dataimpulse', 'mobile')).toBeNull()
    expect(vault.getAll()).toEqual([])

    const key = readKeyFile(vault.keyPath)
    expect(key).toMatchObject({ v: 1, backend: 'os-keychain', backendLabel: 'Fake Keychain', installId: installState.installId })
    if (posix) expect(statSync(vault.keyPath).mode & 0o777).toBe(0o600)

    const status = await vault.status()
    expect(status).toMatchObject({
      source: 'none',
      configuredProducts: {},
      keyBackend: 'os-keychain',
      keyBackendLabel: 'Fake Keychain',
      keyPresent: true,
      vaultPresent: false,
      decryptOk: true,
      permissionsOk: true,
      installId: installState.installId,
      vaultUpdatedAt: null,
      lastProxyTestAt: null,
      lastProxyTestStatus: null,
      warnings: [],
    })
    expect(status.keyCreatedAt).toBe(key.createdAt)
    expect(Date.parse(status.lastCheckedAt)).not.toBeNaN()
  })

  it('save → get → status, emits onChange, registers secrets, never writes plaintext', async () => {
    const vault = await openVault(world, fakeKeychain())
    const changes: StoredProxyCredentials[][] = []
    vault.onChange((c) => changes.push(c))

    const status = await vault.save(input)
    expect(vault.get('dataimpulse', 'residential')).toEqual(stored)
    expect(vault.get('dataimpulse', 'mobile')).toBeNull()
    expect(vault.getAll()).toEqual([stored])
    expect(changes).toEqual([[stored]])
    expect(status).toMatchObject({ source: 'vault', configuredProducts: { dataimpulse: ['residential'] }, vaultPresent: true, decryptOk: true, permissionsOk: true, warnings: [] })
    expect(status.vaultUpdatedAt).not.toBeNull()
    if (posix) expect(statSync(vault.vaultPath).mode & 0o777).toBe(0o600)

    const vaultText = readFileSync(vault.vaultPath, 'utf8')
    expect(vaultText).not.toContain(PASSWORD)
    expect(vaultText).not.toContain(USERNAME)
    expect(JSON.parse(vaultText)).toMatchObject({ v: 1, alg: 'aes-256-gcm' })
    expect(readFileSync(vault.keyPath, 'utf8')).not.toContain(PASSWORD)
    expect(readFileSync(join(root, 'install.json'), 'utf8')).not.toContain(PASSWORD)

    expect(world.logger.secrets).toContain(PASSWORD)
    expect(world.logger.secrets).toContain(`${USERNAME}:${PASSWORD}`)
    const saved = world.logger.entries.find((e) => e.message.startsWith('Proxy credentials saved to encrypted vault'))
    expect(saved?.meta).toMatchObject({ pool: 'residential', host: 'gw.dataimpulse.com', port: 823, username: 'ac****us', configuredProducts: { dataimpulse: ['residential'] } })
    expect(JSON.stringify(world.logger.entries)).not.toContain(PASSWORD)
    expect(JSON.stringify(world.logger.entries)).not.toContain(USERNAME)
  })

  it('stores pools independently: saving mobile keeps residential, clearing one pool keeps the other', async () => {
    const vault = await openVault(world, fakeKeychain())
    const changes: StoredProxyCredentials[][] = []
    vault.onChange((c) => changes.push(c))
    await vault.save(input)
    const both = await vault.save(mobileInput)
    expect(both.configuredProducts).toEqual({ dataimpulse: ['residential', 'mobile'] })
    expect(vault.getAll()).toEqual([stored, mobileStored])
    expect(vault.get('dataimpulse', 'mobile')).toEqual(mobileStored)
    expect(world.logger.secrets).toContain(MOBILE_PASSWORD)
    expect(world.logger.secrets).toContain(`${MOBILE_USERNAME}:${MOBILE_PASSWORD}`)
    const vaultText = readFileSync(vault.vaultPath, 'utf8')
    expect(vaultText).not.toContain(MOBILE_PASSWORD)
    expect(vaultText).not.toContain(MOBILE_USERNAME)

    // Overwriting one pool replaces only that pool.
    await vault.save({ ...input, username: 'acme_v2' })
    expect(vault.get('dataimpulse', 'residential')?.username).toBe('acme_v2')
    expect(vault.get('dataimpulse', 'mobile')).toEqual(mobileStored)

    const afterClear = await vault.clear('dataimpulse', 'residential')
    expect(afterClear).toMatchObject({ configuredProducts: { dataimpulse: ['mobile'] }, vaultPresent: true, source: 'vault' })
    expect(vault.get('dataimpulse', 'residential')).toBeNull()
    expect(vault.get('dataimpulse', 'mobile')).toEqual(mobileStored)
    expect(changes.at(-1)).toEqual([mobileStored])

    const reopened = await openVault(makeWorld(root), fakeKeychain())
    expect(reopened.getAll()).toEqual([mobileStored])

    // Clearing the last pool removes the file; clearing an absent pool is a no-op that still emits.
    const gone = await reopened.clear('dataimpulse', 'mobile')
    expect(gone).toMatchObject({ configuredProducts: {}, vaultPresent: false, keyPresent: true, source: 'none' })
    expect(existsSync(reopened.vaultPath)).toBe(false)
    const noop = await reopened.clear('dataimpulse', 'mobile')
    expect(noop.configuredProducts).toEqual({})
  })

  it('migrates a legacy single-credential vault into providers.dataimpulse (residential), backs it up and rewrites the file once', async () => {
    const first = await openVault(world, fakeKeychain())
    const installId = world.install.get().installId
    // Write a vault exactly as the previous version did: one credential object, no pools.
    const legacyPayload = { host: input.host, port: input.port, username: input.username, password: input.password, sessionTemplate: '{username}{sep}sid.{session}' }
    const legacyBlob = encryptJson(rawKeyOf(first.keyPath), legacyPayload, installId, new Date('2026-01-01T00:00:00Z'))
    writeFileSync(first.vaultPath, JSON.stringify(legacyBlob))
    const legacyMode = statSync(first.vaultPath).mode & 0o777

    const again = makeWorld(root)
    const migrated = await openVault(again, fakeKeychain())
    expect(migrated.get('dataimpulse', 'residential')).toEqual({ ...stored, sessionTemplate: '{username}{sep}sid.{session}' })
    expect(migrated.get('dataimpulse', 'mobile')).toBeNull()
    expect(again.logger.secrets).toContain(PASSWORD)
    expect(again.logger.entries.some((e) => /Migrated the single-credential vault/.test(e.message))).toBe(true)

    const rewritten = parseVaultBlob(JSON.parse(readFileSync(migrated.vaultPath, 'utf8')))
    expect(rewritten.updatedAt).not.toBe(legacyBlob.updatedAt)
    const payload = decryptJson(rawKeyOf(migrated.keyPath), rewritten) as VaultPayload
    expect(payload.v).toBe(VAULT_PAYLOAD_VERSION)
    expect(Object.keys(payload.providers)).toEqual(['dataimpulse'])
    expect(Object.keys(payload.providers.dataimpulse?.products ?? {})).toEqual(['residential'])
    // The legacy file was copied verbatim before the rewrite (older builds cannot read v3).
    expect(readFileSync(migrated.backupPath, 'utf8')).toBe(JSON.stringify(legacyBlob))
    // Same directory, same permissions as the file it copies.
    expect(migrated.backupPath).toBe(`${migrated.vaultPath}.v2.bak`)
    if (posix) expect(statSync(migrated.backupPath).mode & 0o777).toBe(legacyMode)
    expect(JSON.stringify(payload)).toContain(PASSWORD) // the decrypted payload, never the file
    expect(readFileSync(migrated.vaultPath, 'utf8')).not.toContain(PASSWORD)

    // Second start: no migration happens again.
    const third = makeWorld(root)
    const stable = await openVault(third, fakeKeychain())
    expect(stable.getAll()).toHaveLength(1)
    expect(third.logger.entries.some((e) => /Migrated/.test(e.message))).toBe(false)
    expect(await stable.status()).toMatchObject({ configuredProducts: { dataimpulse: ['residential'] }, decryptOk: true, warnings: [] })
  })

  it('rejects invalid input (including a template without placeholders and an unknown pool) before touching disk', async () => {
    const vault = await openVault(world, fakeKeychain())
    await expect(vault.save({ ...input, password: '' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(vault.save({ ...input, sessionTemplate: '{username}-static' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(vault.save({ ...input, pool: 'Data Center' as never })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(existsSync(vault.vaultPath)).toBe(false)
    expect(ProxyCredentialsInputSchema.safeParse({ ...input, sessionTemplate: '' }).success).toBe(true)
    // The pool defaults to residential for callers that predate pools.
    const { pool: _pool, ...withoutPool } = input
    expect(ProxyCredentialsInputSchema.parse(withoutPool).pool).toBe('residential')
    const withTemplate = await vault.save({ ...input, sessionTemplate: '  {username}{sep}sid.{session} ' })
    expect(withTemplate.decryptOk).toBe(true)
    expect(vault.get('dataimpulse', 'residential')?.sessionTemplate).toBe('{username}{sep}sid.{session}')
    await vault.save({ ...input, sessionTemplate: '' })
    expect(vault.get('dataimpulse', 'residential')?.sessionTemplate).toBeNull()
  })

  it('restart with the same files restores the credentials', async () => {
    const first = await openVault(world, fakeKeychain())
    await first.save(input)

    const again = makeWorld(root)
    const second = await openVault(again, fakeKeychain())
    expect(second.get('dataimpulse', 'residential')).toEqual(stored)
    expect(await second.status()).toMatchObject({ vaultPresent: true, decryptOk: true, configuredProducts: { dataimpulse: ['residential'] }, warnings: [] })
    expect(again.logger.secrets).toContain(PASSWORD)
    expect(again.install.get().installId).toBe(world.install.get().installId)
  })

  it('wrong key: decryptOk false, warning, get() null, no throw at startup', async () => {
    const first = await openVault(world, fakeKeychain())
    await first.save(input)

    const keychain = fakeKeychain()
    const rogue = { ...readKeyFile(first.keyPath), data: (await keychain.wrap(generateKey(), { installId: 'x' })).toString('base64') }
    writeFileSync(first.keyPath, JSON.stringify(rogue))

    const again = makeWorld(root)
    const second = await openVault(again, keychain)
    expect(second.get('dataimpulse', 'residential')).toBeNull()
    expect(second.getAll()).toEqual([])
    const status = await second.status()
    expect(status).toMatchObject({ keyPresent: true, vaultPresent: true, decryptOk: false, source: 'none', configuredProducts: {} })
    expect(status.warnings).toContain(UNDECRYPTABLE_WARNING)
    expect(again.logger.secrets).not.toContain(PASSWORD)
    await expect(second.rotateKey()).rejects.toMatchObject({ code: 'VAULT_ERROR' })
    expect(await second.save(input)).toMatchObject({ decryptOk: true, source: 'vault' })
  })

  it('tampered vault file: decryptOk false and warning, key still fine', async () => {
    const vault = await openVault(world, fakeKeychain())
    await vault.save(input)
    const blob = JSON.parse(readFileSync(vault.vaultPath, 'utf8')) as { ciphertext: string }
    const bytes = Buffer.from(blob.ciphertext, 'base64')
    bytes[0] = (bytes[0] ?? 0) ^ 0xff
    writeFileSync(vault.vaultPath, JSON.stringify({ ...blob, ciphertext: bytes.toString('base64') }))

    const again = makeWorld(root)
    const reopened = await openVault(again, fakeKeychain())
    expect(reopened.get('dataimpulse', 'residential')).toBeNull()
    const status = await reopened.status()
    expect(status.decryptOk).toBe(false)
    expect(status.keyPresent).toBe(true)
    expect(status.warnings).toEqual([UNDECRYPTABLE_WARNING])
  })

  it('clear() of the only pool removes the vault file, keeps the key and emits an empty list', async () => {
    const vault = await openVault(world, fakeKeychain())
    await vault.save(input)
    const changes: StoredProxyCredentials[][] = []
    vault.onChange((c) => changes.push(c))
    const keyBefore = readFileSync(vault.keyPath, 'utf8')

    const status = await vault.clear('dataimpulse', 'residential')
    expect(existsSync(vault.vaultPath)).toBe(false)
    expect(readFileSync(vault.keyPath, 'utf8')).toBe(keyBefore)
    expect(vault.get('dataimpulse', 'residential')).toBeNull()
    expect(changes).toEqual([[]])
    expect(status).toMatchObject({ source: 'none', configuredProducts: {}, vaultPresent: false, keyPresent: true, decryptOk: true })
  })

  it('rotateKey() keeps every pool, changes the key file and leaves no .rotating file', async () => {
    const vault = await openVault(world, fakeKeychain())
    await vault.save(input)
    await vault.save(mobileInput)
    const before = readKeyFile(vault.keyPath)
    const vaultBefore = readFileSync(vault.vaultPath, 'utf8')

    const status = await vault.rotateKey()
    const after = readKeyFile(vault.keyPath)
    expect(after.data).not.toBe(before.data)
    expect(readFileSync(vault.vaultPath, 'utf8')).not.toBe(vaultBefore)
    expect(vault.getAll()).toEqual([stored, mobileStored])
    expect(status).toMatchObject({ decryptOk: true, vaultPresent: true, keyCreatedAt: after.createdAt, configuredProducts: { dataimpulse: ['residential', 'mobile'] } })
    expect(existsSync(`${vault.keyPath}.rotating`)).toBe(false)
    if (posix) expect(statSync(vault.keyPath).mode & 0o777).toBe(0o600)

    const reopened = await openVault(makeWorld(root), fakeKeychain())
    expect(reopened.getAll()).toEqual([stored, mobileStored])
  })

  it('rotateKey() without a vault just replaces the key', async () => {
    const vault = await openVault(world, fakeKeychain())
    const before = readKeyFile(vault.keyPath)
    await vault.rotateKey()
    expect(readKeyFile(vault.keyPath).data).not.toBe(before.data)
    expect(await vault.status()).toMatchObject({ vaultPresent: false, decryptOk: true })
  })

  it('rotateKey() failure (wrapper refuses) restores the previous key and vault', async () => {
    const keychain = fakeKeychain({ failWrapAfter: 1 })
    const vault = await openVault(world, keychain)
    await vault.save(input)
    const keyBefore = readFileSync(vault.keyPath, 'utf8')
    const vaultBefore = readFileSync(vault.vaultPath, 'utf8')

    await expect(vault.rotateKey()).rejects.toMatchObject({ code: 'VAULT_ERROR' })
    expect(readFileSync(vault.keyPath, 'utf8')).toBe(keyBefore)
    expect(readFileSync(vault.vaultPath, 'utf8')).toBe(vaultBefore)
    expect(existsSync(`${vault.keyPath}.rotating`)).toBe(false)
    expect(vault.get('dataimpulse', 'residential')).toEqual(stored)
    expect(await vault.status()).toMatchObject({ decryptOk: true })
  })

  it('save() read-back verification failure: nothing is saved and the previous vault is restored', async () => {
    const vault = await openVault(world, fakeKeychain())
    const changes: StoredProxyCredentials[][] = []
    vault.onChange((c) => changes.push(c))

    fsHooks.corruptRead = vault.vaultPath
    await expect(vault.save(input)).rejects.toMatchObject({ code: 'VAULT_ERROR', message: VERIFY_FAILED_MESSAGE })
    expect(existsSync(vault.vaultPath)).toBe(false)
    expect(vault.get('dataimpulse', 'residential')).toBeNull()
    expect(changes).toEqual([])

    await vault.save(input)
    const previous = readFileSync(vault.vaultPath, 'utf8')
    fsHooks.corruptRead = vault.vaultPath
    fsHooks.unlessEquals = previous
    await expect(vault.save({ ...input, username: 'someone_else' })).rejects.toMatchObject({ code: 'VAULT_ERROR' })
    expect(readFileSync(vault.vaultPath, 'utf8')).toBe(previous)
    expect(vault.get('dataimpulse', 'residential')).toEqual(stored)
    expect(changes).toEqual([[stored]])
    expect(world.logger.entries.some((e) => e.level === 'ERROR' && /could not be verified/.test(e.message))).toBe(true)
  })

  it('recovers an interrupted key rotation from the .rotating file', async () => {
    const keychain = fakeKeychain()
    const vault = await openVault(world, keychain)
    await vault.save(input)
    const installId = world.install.get().installId

    const pendingKey = generateKey()
    const pending: WrappedKey = { ...readKeyFile(vault.keyPath), createdAt: '2026-10-03T00:00:00.000Z', data: (await keychain.wrap(pendingKey, { installId })).toString('base64') }
    writeFileSync(`${vault.keyPath}.rotating`, JSON.stringify(pending))
    writeFileSync(vault.vaultPath, JSON.stringify(encryptJson(pendingKey, toVaultPayload(entriesOf(stored)), installId)))

    const again = makeWorld(root)
    const reopened = await openVault(again, keychain)
    expect(reopened.get('dataimpulse', 'residential')).toEqual(stored)
    expect(existsSync(`${vault.keyPath}.rotating`)).toBe(false)
    expect(readKeyFile(vault.keyPath).data).toBe(pending.data)
    expect(again.logger.entries.some((e) => /interrupted key rotation/.test(e.message))).toBe(true)
  })

  it('discards a stale .rotating file when the main key still decrypts the vault', async () => {
    const keychain = fakeKeychain()
    const vault = await openVault(world, keychain)
    await vault.save(input)
    writeFileSync(`${vault.keyPath}.rotating`, JSON.stringify({ ...readKeyFile(vault.keyPath), data: (await keychain.wrap(generateKey(), { installId: 'x' })).toString('base64') }))
    const keyBefore = readFileSync(vault.keyPath, 'utf8')

    const reopened = await openVault(makeWorld(root), keychain)
    expect(reopened.get('dataimpulse', 'residential')).toEqual(stored)
    expect(existsSync(`${vault.keyPath}.rotating`)).toBe(false)
    expect(readFileSync(vault.keyPath, 'utf8')).toBe(keyBefore)
  })

  it('machine-derived backend: survives a restart on the same machine, fails closed on another', async () => {
    const vault = await openVault(world, createMachineDerivedWrapper(MACHINE))
    await vault.save(input)
    expect(readKeyFile(vault.keyPath)).toMatchObject({ backend: 'machine-derived', backendLabel: expect.stringMatching(/reduced protection/) })
    expect((await vault.status()).keyBackend).toBe('machine-derived')

    const same = await openVault(makeWorld(root), createMachineDerivedWrapper(MACHINE), { machine: MACHINE })
    expect(same.get('dataimpulse', 'residential')).toEqual(stored)

    const other = { machineId: 'different-machine', username: 'tester' }
    const otherWorld = makeWorld(root)
    const elsewhere = await openVault(otherWorld, createMachineDerivedWrapper(other), { machine: other })
    expect(elsewhere.get('dataimpulse', 'residential')).toBeNull()
    const status = await elsewhere.status()
    expect(status.decryptOk).toBe(false)
    expect(status.keyPresent).toBe(true)
    expect(status.warnings.some((w) => w.startsWith('Vault key problem'))).toBe(true)
    expect(status.warnings).toContain(UNDECRYPTABLE_WARNING)
  }, 30_000)

  it('a key written by the machine-derived backend is still readable once a keychain appears, and rotation upgrades it', async () => {
    const vault = await openVault(world, createMachineDerivedWrapper(MACHINE))
    await vault.save(input)

    const upgradedWorld = makeWorld(root)
    const upgraded = await openVault(upgradedWorld, fakeKeychain({ label: 'GNOME Keyring / libsecret' }))
    expect(upgraded.get('dataimpulse', 'residential')).toEqual(stored)
    const before = await upgraded.status()
    expect(before.keyBackend).toBe('machine-derived')
    expect(before.warnings.some((w) => /rotate the key to upgrade/.test(w))).toBe(true)

    const after = await upgraded.rotateKey()
    expect(after.keyBackend).toBe('os-keychain')
    expect(after.keyBackendLabel).toBe('GNOME Keyring / libsecret')
    expect(after.warnings).toEqual([])
    expect(upgraded.get('dataimpulse', 'residential')).toEqual(stored)
  }, 30_000)

  it('recordProxyTest() is reflected in status() and persisted in install.json', async () => {
    const vault = await openVault(world, fakeKeychain())
    vault.recordProxyTest('working', '2026-10-03T10:00:00.000Z')
    expect(await vault.status()).toMatchObject({ lastProxyTestAt: '2026-10-03T10:00:00.000Z', lastProxyTestStatus: 'working' })
    expect(JSON.parse(readFileSync(join(root, 'install.json'), 'utf8'))).toMatchObject({ lastProxyTestStatus: 'working' })
  })

  it.runIf(posix)('reports loose file permissions', async () => {
    const vault = await openVault(world, fakeKeychain())
    await vault.save(input)
    const { chmodSync } = await import('node:fs')
    chmodSync(vault.vaultPath, 0o644)
    const status = await vault.status()
    expect(status.permissionsOk).toBe(false)
    expect(status.warnings).toContain(PERMISSIONS_WARNING)
  })

  it('install.json corruption is recovered by moving the file aside', async () => {
    const first = await openVault(world, fakeKeychain())
    await first.save(input)
    writeFileSync(join(root, 'install.json'), '{ not json')
    const store = createInstallStateStore({ userData: root, appVersion: '1.0.0' })
    expect(store.recoveredFrom).toMatch(/install\.json\.corrupt-/)
    expect(store.get().installId).not.toBe(world.install.get().installId)
    expect(existsSync(store.recoveredFrom!)).toBe(true)
  })
})

describe('vault v2 → v3 migration', () => {
  let root: string
  let world: World

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'proxy-qa-vault-v3-'))
    world = makeWorld(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  type Writer = NonNullable<CredentialVaultOptions['writeFileAtomic']>

  async function openWith(target: World, wrapper: KeyWrapperBackend, extra: Partial<CredentialVaultOptions> = {}): Promise<CredentialVault> {
    return createCredentialVault({ paths: target.paths, logger: target.logger, wrapper, machine: MACHINE, install: target.install, ...extra })
  }

  /** Write a vault exactly as v1.3.0 / 1.4.0 did (payload v2, DataImpulse pools only). Returns the file text and paths. */
  async function writeV2Vault(keychain: KeyWrapperBackend, mode = 0o600): Promise<{ text: string; vaultPath: string; backupPath: string; keyPath: string }> {
    const first = await openWith(world, keychain)
    const v2 = {
      v: 2,
      pools: {
        residential: { host: input.host, port: input.port, username: input.username, password: input.password, sessionTemplate: null },
        mobile: { host: mobileInput.host, port: mobileInput.port, username: mobileInput.username, password: mobileInput.password, sessionTemplate: '{username}{sep}sid.{session}' },
      },
    }
    const text = `${JSON.stringify(encryptJson(rawKeyOf(first.keyPath), v2, world.install.get().installId, new Date('2026-09-01T00:00:00Z')), null, 2)}\n`
    writeFileSync(first.vaultPath, text, { mode })
    if (posix) chmodSync(first.vaultPath, mode)
    return { text, vaultPath: first.vaultPath, backupPath: first.backupPath, keyPath: first.keyPath }
  }

  const mobileV2: StoredProxyCredentials = { ...mobileStored, sessionTemplate: '{username}{sep}sid.{session}' }

  it('migrates both pools into providers.dataimpulse, copies the v2 file to .v2.bak first and rewrites it once', async () => {
    const keychain = fakeKeychain()
    const original = await writeV2Vault(keychain, 0o640)
    const again = makeWorld(root)
    const migrated = await openWith(again, keychain)

    expect(migrated.getAll()).toEqual([stored, mobileV2])
    expect(migrated.get('dataimpulse', 'mobile')).toEqual(mobileV2)
    expect(again.logger.secrets).toEqual(expect.arrayContaining([PASSWORD, MOBILE_PASSWORD]))
    expect(again.logger.entries.some((e) => /Migrated the per-pool vault into the per-provider format/.test(e.message))).toBe(true)

    // Backup: same directory, byte-for-byte copy, same permissions; still encrypted.
    expect(original.backupPath).toBe(join(dirname(original.vaultPath), `${VAULT_FILE_NAME}.v2.bak`))
    expect(readFileSync(original.backupPath, 'utf8')).toBe(original.text)
    if (posix) expect(statSync(original.backupPath).mode & 0o777).toBe(0o640)
    expect(readFileSync(original.backupPath, 'utf8')).not.toContain(PASSWORD)
    const v2 = decryptJson(rawKeyOf(original.keyPath), parseVaultBlob(JSON.parse(readFileSync(original.backupPath, 'utf8')))) as { v: number }
    expect(v2.v).toBe(2)

    // The vault itself is now v3, owner-only.
    const payload = decryptJson(rawKeyOf(original.keyPath), parseVaultBlob(JSON.parse(readFileSync(original.vaultPath, 'utf8')))) as VaultPayload
    expect(payload).toMatchObject({ v: 3, providers: { dataimpulse: { products: { residential: { username: USERNAME, extras: {} }, mobile: { username: MOBILE_USERNAME } } } } })
    if (posix) expect(statSync(original.vaultPath).mode & 0o777).toBe(0o600)
    expect(await migrated.status()).toMatchObject({ decryptOk: true, configuredProducts: { dataimpulse: ['residential', 'mobile'] }, warnings: [] })

    // Second start: nothing to migrate, the backup is left alone.
    const backupBefore = statSync(original.backupPath).mtimeMs
    const third = makeWorld(root)
    const stable = await openWith(third, keychain)
    expect(stable.getAll()).toEqual([stored, mobileV2])
    expect(third.logger.entries.some((e) => /Migrated|Backed up/.test(e.message))).toBe(false)
    expect(statSync(original.backupPath).mtimeMs).toBe(backupBefore)
  })

  it('a failed rewrite leaves the v2 file and the .v2.bak untouched, keeps the credentials usable and reports VAULT_ERROR naming the backup', async () => {
    const keychain = fakeKeychain()
    const original = await writeV2Vault(keychain)
    const failing: Writer = (path, data, options) => {
      if (path === original.vaultPath) throw new Error('ENOSPC: no space left on device')
      writeFileAtomicSync(path, data, options)
    }
    const again = makeWorld(root)
    const vault = await openWith(again, keychain, { writeFileAtomic: failing })

    // Original and backup are both the v2 bytes; nothing half-written.
    expect(readFileSync(original.vaultPath, 'utf8')).toBe(original.text)
    expect(readFileSync(original.backupPath, 'utf8')).toBe(original.text)
    // The decrypted credentials are still active for this session.
    expect(vault.getAll()).toEqual([stored, mobileV2])
    const status = await vault.status()
    expect(status.warnings.some((w) => w.includes(original.backupPath) && /could not be upgraded/.test(w))).toBe(true)
    const logged = again.logger.entries.find((e) => e.level === 'ERROR' && e.message.includes(original.backupPath))
    expect(logged?.meta).toMatchObject({ error: expect.stringMatching(/ENOSPC/) })
    expect(JSON.stringify(again.logger.entries)).not.toContain(PASSWORD)

    // A later save retries the rewrite and fails the same way: VAULT_ERROR, files untouched.
    await expect(vault.save({ ...input, username: 'changed_login' })).rejects.toMatchObject({ code: 'VAULT_ERROR' })
    expect(readFileSync(original.vaultPath, 'utf8')).toBe(original.text)
    expect(readFileSync(original.backupPath, 'utf8')).toBe(original.text)

    // Next start with a working disk: the migration completes.
    const fixed = await openWith(makeWorld(root), keychain)
    expect(fixed.getAll()).toEqual([stored, mobileV2])
    expect((await fixed.status()).warnings).toEqual([])
    expect(readFileSync(original.backupPath, 'utf8')).toBe(original.text)
  })

  it('a failed backup copy never lets the v2 file be overwritten: VAULT_ERROR names the backup path', async () => {
    const keychain = fakeKeychain()
    const original = await writeV2Vault(keychain)
    const noBackup: Writer = (path, data, options) => {
      if (path === original.backupPath) throw new Error('EACCES: permission denied')
      writeFileAtomicSync(path, data, options)
    }
    const vault = await openWith(makeWorld(root), keychain, { writeFileAtomic: noBackup })
    expect(existsSync(original.backupPath)).toBe(false)
    expect(readFileSync(original.vaultPath, 'utf8')).toBe(original.text)
    expect(vault.getAll()).toEqual([stored, mobileV2])

    let thrown: unknown
    try {
      await vault.save(input)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(AppException)
    expect(thrown).toMatchObject({ code: 'VAULT_ERROR' })
    expect((thrown as AppException).message).toContain(original.backupPath)
    expect(readFileSync(original.vaultPath, 'utf8')).toBe(original.text)
    await expect(vault.clear('dataimpulse', 'residential')).rejects.toMatchObject({ code: 'VAULT_ERROR' })
    await expect(vault.rotateKey()).rejects.toMatchObject({ code: 'VAULT_ERROR' })
    expect(readFileSync(original.vaultPath, 'utf8')).toBe(original.text)
    expect(existsSync(original.backupPath)).toBe(false)
  })

  it('moves an older, different .v2.bak aside instead of overwriting it', async () => {
    const keychain = fakeKeychain()
    const original = await writeV2Vault(keychain)
    writeFileSync(original.backupPath, 'older backup')
    const at = new Date('2026-10-09T00:00:00Z')
    await openWith(makeWorld(root), keychain, { now: () => at })
    expect(readFileSync(original.backupPath, 'utf8')).toBe(original.text)
    expect(readFileSync(`${original.backupPath}.${at.getTime()}`, 'utf8')).toBe('older backup')
  })

  it('round-trips several providers with extra fields; extras are encrypted like passwords', async () => {
    const keychain = fakeKeychain()
    const vault = await openWith(world, keychain)
    await vault.save(input)
    await vault.save({
      providerId: 'acme',
      pool: 'isp',
      host: 'gw.acme.example',
      port: 7000,
      username: 'acme_user',
      password: 'Acme-Pass-1',
      sessionTemplate: null,
      extras: { zone: 'zone-alpha', apiKey: 'Acme-Api-Key-77', empty: '' },
    })
    const acme: StoredProxyCredentials = {
      providerId: 'acme',
      pool: 'isp',
      host: 'gw.acme.example',
      port: 7000,
      username: 'acme_user',
      password: 'Acme-Pass-1',
      sessionTemplate: null,
      extras: { zone: 'zone-alpha', apiKey: 'Acme-Api-Key-77' },
    }
    expect(vault.get('acme', 'isp')).toEqual(acme)
    expect(vault.get('acme', 'residential')).toBeNull()
    const text = readFileSync(vault.vaultPath, 'utf8')
    for (const secret of ['zone-alpha', 'Acme-Api-Key-77', 'Acme-Pass-1', 'acme_user']) expect(text).not.toContain(secret)

    const reopened = await openWith(makeWorld(root), keychain)
    expect(reopened.getAll()).toEqual([stored, acme])
    expect(await reopened.status()).toMatchObject({ configuredProducts: { dataimpulse: ['residential'], acme: ['isp'] } })
    // A vault created in the v3 format never needs a backup.
    expect(existsSync(reopened.backupPath)).toBe(false)

    await reopened.clear('acme', 'isp')
    expect((await openWith(makeWorld(root), keychain)).getAll()).toEqual([stored])
  })

  it('registers extra fields the provider declares secret with the logger (all extras when nothing is declared)', async () => {
    const keychain = fakeKeychain()
    const secretExtraKeys = (id: string): string[] => (id === 'acme' ? ['apiKey'] : [])
    const declared = await openWith(world, keychain, { secretExtraKeys })
    await declared.save({ providerId: 'acme', pool: 'isp', host: 'gw.acme.example', port: 7000, username: 'u1', password: 'p1', sessionTemplate: null, extras: { zone: 'zone-public', apiKey: 'Secret-Api-Key' } })
    expect(world.logger.secrets).toContain('Secret-Api-Key')
    expect(world.logger.secrets).not.toContain('zone-public')

    const restarted = makeWorld(root)
    await openWith(restarted, keychain, { secretExtraKeys })
    expect(restarted.logger.secrets).toContain('Secret-Api-Key')
    expect(restarted.logger.secrets).not.toContain('zone-public')

    const conservative = makeWorld(root)
    await openWith(conservative, keychain)
    expect(conservative.logger.secrets).toEqual(expect.arrayContaining(['Secret-Api-Key', 'zone-public']))
  })
})

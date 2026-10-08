/**
 * Credential vault against real temp directories. A fake keychain wrapper
 * keeps most cases fast; the machine-derived backend is exercised end-to-end
 * in its own cases.
 *
 * `node:fs` is wrapped so one case can corrupt the vault file between the
 * write and the read-back (the "written but could not be verified" path);
 * everything else goes straight to the real module.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProxyCredentialsInput } from '../src/shared/types'
import { ProxyCredentialsInputSchema } from '../src/shared/types'
import type { CredentialVault, Logger, ProxyCredentials } from '../src/main/contracts'
import { decryptJson, encryptJson, generateKey, parseVaultBlob, parseWrappedKey } from '../src/main/security/crypto'
import type { WrappedKey } from '../src/main/security/crypto'
import {
  PERMISSIONS_WARNING,
  UNDECRYPTABLE_WARNING,
  VAULT_FILE_NAME,
  VAULT_PAYLOAD_VERSION,
  VERIFY_FAILED_MESSAGE,
  createCredentialVault,
  parseVaultPayload,
  toVaultPayload,
} from '../src/main/security/credential-vault'
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

const input: ProxyCredentialsInput = { pool: 'residential', host: 'gw.dataimpulse.com', port: 823, username: USERNAME, password: PASSWORD, sessionTemplate: null }
const stored: ProxyCredentials = { ...input, sessionTemplate: null }
const mobileInput: ProxyCredentialsInput = { pool: 'mobile', host: 'gw.dataimpulse.com', port: 823, username: MOBILE_USERNAME, password: MOBILE_PASSWORD, sessionTemplate: null }
const mobileStored: ProxyCredentials = { ...mobileInput, sessionTemplate: null }

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
  it('reads the per-pool payload and the legacy single-credential payload', () => {
    expect(parseVaultPayload({ v: VAULT_PAYLOAD_VERSION, pools: { mobile: { host: 'gw', port: 1, username: 'u', password: 'p', sessionTemplate: null } } })).toEqual({
      pools: { mobile: { pool: 'mobile', host: 'gw', port: 1, username: 'u', password: 'p', sessionTemplate: null } },
      legacy: false,
    })
    expect(parseVaultPayload({ host: 'gw', port: 823, username: 'u', password: 'p', sessionTemplate: '{username}{sep}sid.{session}' })).toEqual({
      pools: { residential: { pool: 'residential', host: 'gw', port: 823, username: 'u', password: 'p', sessionTemplate: '{username}{sep}sid.{session}' } },
      legacy: true,
    })
    expect(() => parseVaultPayload({ v: 9 })).toThrowError(/does not contain proxy credentials/)
    expect(toVaultPayload({ residential: stored })).toEqual({
      v: VAULT_PAYLOAD_VERSION,
      pools: { residential: { host: stored.host, port: stored.port, username: stored.username, password: stored.password, sessionTemplate: null } },
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
    expect(vault.get('residential')).toBeNull()
    expect(vault.get('mobile')).toBeNull()
    expect(vault.getAll()).toEqual([])

    const key = readKeyFile(vault.keyPath)
    expect(key).toMatchObject({ v: 1, backend: 'os-keychain', backendLabel: 'Fake Keychain', installId: installState.installId })
    if (posix) expect(statSync(vault.keyPath).mode & 0o777).toBe(0o600)

    const status = await vault.status()
    expect(status).toMatchObject({
      source: 'none',
      configuredPools: [],
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
    const changes: ProxyCredentials[][] = []
    vault.onChange((c) => changes.push(c))

    const status = await vault.save(input)
    expect(vault.get('residential')).toEqual(stored)
    expect(vault.get('mobile')).toBeNull()
    expect(vault.getAll()).toEqual([stored])
    expect(changes).toEqual([[stored]])
    expect(status).toMatchObject({ source: 'vault', configuredPools: ['residential'], vaultPresent: true, decryptOk: true, permissionsOk: true, warnings: [] })
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
    expect(saved?.meta).toMatchObject({ pool: 'residential', host: 'gw.dataimpulse.com', port: 823, username: 'ac****us', configuredPools: ['residential'] })
    expect(JSON.stringify(world.logger.entries)).not.toContain(PASSWORD)
    expect(JSON.stringify(world.logger.entries)).not.toContain(USERNAME)
  })

  it('stores pools independently: saving mobile keeps residential, clearing one pool keeps the other', async () => {
    const vault = await openVault(world, fakeKeychain())
    const changes: ProxyCredentials[][] = []
    vault.onChange((c) => changes.push(c))
    await vault.save(input)
    const both = await vault.save(mobileInput)
    expect(both.configuredPools).toEqual(['residential', 'mobile'])
    expect(vault.getAll()).toEqual([stored, mobileStored])
    expect(vault.get('mobile')).toEqual(mobileStored)
    expect(world.logger.secrets).toContain(MOBILE_PASSWORD)
    expect(world.logger.secrets).toContain(`${MOBILE_USERNAME}:${MOBILE_PASSWORD}`)
    const vaultText = readFileSync(vault.vaultPath, 'utf8')
    expect(vaultText).not.toContain(MOBILE_PASSWORD)
    expect(vaultText).not.toContain(MOBILE_USERNAME)

    // Overwriting one pool replaces only that pool.
    await vault.save({ ...input, username: 'acme_v2' })
    expect(vault.get('residential')?.username).toBe('acme_v2')
    expect(vault.get('mobile')).toEqual(mobileStored)

    const afterClear = await vault.clear('residential')
    expect(afterClear).toMatchObject({ configuredPools: ['mobile'], vaultPresent: true, source: 'vault' })
    expect(vault.get('residential')).toBeNull()
    expect(vault.get('mobile')).toEqual(mobileStored)
    expect(changes.at(-1)).toEqual([mobileStored])

    const reopened = await openVault(makeWorld(root), fakeKeychain())
    expect(reopened.getAll()).toEqual([mobileStored])

    // Clearing the last pool removes the file; clearing an absent pool is a no-op that still emits.
    const gone = await reopened.clear('mobile')
    expect(gone).toMatchObject({ configuredPools: [], vaultPresent: false, keyPresent: true, source: 'none' })
    expect(existsSync(reopened.vaultPath)).toBe(false)
    const noop = await reopened.clear('mobile')
    expect(noop.configuredPools).toEqual([])
  })

  it('migrates a legacy single-credential vault into pools.residential and rewrites the file once', async () => {
    const first = await openVault(world, fakeKeychain())
    const installId = world.install.get().installId
    // Write a vault exactly as the previous version did: one credential object, no pools.
    const legacyPayload = { host: input.host, port: input.port, username: input.username, password: input.password, sessionTemplate: '{username}{sep}sid.{session}' }
    const legacyBlob = encryptJson(rawKeyOf(first.keyPath), legacyPayload, installId, new Date('2026-01-01T00:00:00Z'))
    writeFileSync(first.vaultPath, JSON.stringify(legacyBlob))

    const again = makeWorld(root)
    const migrated = await openVault(again, fakeKeychain())
    expect(migrated.get('residential')).toEqual({ ...stored, sessionTemplate: '{username}{sep}sid.{session}' })
    expect(migrated.get('mobile')).toBeNull()
    expect(again.logger.secrets).toContain(PASSWORD)
    expect(again.logger.entries.some((e) => /Migrated the single-credential vault/.test(e.message))).toBe(true)

    const rewritten = parseVaultBlob(JSON.parse(readFileSync(migrated.vaultPath, 'utf8')))
    expect(rewritten.updatedAt).not.toBe(legacyBlob.updatedAt)
    const payload = decryptJson(rawKeyOf(migrated.keyPath), rewritten) as { v: number; pools: Record<string, unknown> }
    expect(payload.v).toBe(VAULT_PAYLOAD_VERSION)
    expect(Object.keys(payload.pools)).toEqual(['residential'])
    expect(JSON.stringify(payload)).toContain(PASSWORD) // the decrypted payload, never the file
    expect(readFileSync(migrated.vaultPath, 'utf8')).not.toContain(PASSWORD)

    // Second start: no migration happens again.
    const third = makeWorld(root)
    const stable = await openVault(third, fakeKeychain())
    expect(stable.getAll()).toHaveLength(1)
    expect(third.logger.entries.some((e) => /Migrated/.test(e.message))).toBe(false)
    expect(await stable.status()).toMatchObject({ configuredPools: ['residential'], decryptOk: true, warnings: [] })
  })

  it('rejects invalid input (including a template without placeholders and an unknown pool) before touching disk', async () => {
    const vault = await openVault(world, fakeKeychain())
    await expect(vault.save({ ...input, password: '' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(vault.save({ ...input, sessionTemplate: '{username}-static' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(vault.save({ ...input, pool: 'datacenter' as never })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(existsSync(vault.vaultPath)).toBe(false)
    expect(ProxyCredentialsInputSchema.safeParse({ ...input, sessionTemplate: '' }).success).toBe(true)
    // The pool defaults to residential for callers that predate pools.
    const { pool: _pool, ...withoutPool } = input
    expect(ProxyCredentialsInputSchema.parse(withoutPool).pool).toBe('residential')
    const withTemplate = await vault.save({ ...input, sessionTemplate: '  {username}{sep}sid.{session} ' })
    expect(withTemplate.decryptOk).toBe(true)
    expect(vault.get('residential')?.sessionTemplate).toBe('{username}{sep}sid.{session}')
    await vault.save({ ...input, sessionTemplate: '' })
    expect(vault.get('residential')?.sessionTemplate).toBeNull()
  })

  it('restart with the same files restores the credentials', async () => {
    const first = await openVault(world, fakeKeychain())
    await first.save(input)

    const again = makeWorld(root)
    const second = await openVault(again, fakeKeychain())
    expect(second.get('residential')).toEqual(stored)
    expect(await second.status()).toMatchObject({ vaultPresent: true, decryptOk: true, configuredPools: ['residential'], warnings: [] })
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
    expect(second.get('residential')).toBeNull()
    expect(second.getAll()).toEqual([])
    const status = await second.status()
    expect(status).toMatchObject({ keyPresent: true, vaultPresent: true, decryptOk: false, source: 'none', configuredPools: [] })
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
    expect(reopened.get('residential')).toBeNull()
    const status = await reopened.status()
    expect(status.decryptOk).toBe(false)
    expect(status.keyPresent).toBe(true)
    expect(status.warnings).toEqual([UNDECRYPTABLE_WARNING])
  })

  it('clear() of the only pool removes the vault file, keeps the key and emits an empty list', async () => {
    const vault = await openVault(world, fakeKeychain())
    await vault.save(input)
    const changes: ProxyCredentials[][] = []
    vault.onChange((c) => changes.push(c))
    const keyBefore = readFileSync(vault.keyPath, 'utf8')

    const status = await vault.clear('residential')
    expect(existsSync(vault.vaultPath)).toBe(false)
    expect(readFileSync(vault.keyPath, 'utf8')).toBe(keyBefore)
    expect(vault.get('residential')).toBeNull()
    expect(changes).toEqual([[]])
    expect(status).toMatchObject({ source: 'none', configuredPools: [], vaultPresent: false, keyPresent: true, decryptOk: true })
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
    expect(status).toMatchObject({ decryptOk: true, vaultPresent: true, keyCreatedAt: after.createdAt, configuredPools: ['residential', 'mobile'] })
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
    expect(vault.get('residential')).toEqual(stored)
    expect(await vault.status()).toMatchObject({ decryptOk: true })
  })

  it('save() read-back verification failure: nothing is saved and the previous vault is restored', async () => {
    const vault = await openVault(world, fakeKeychain())
    const changes: ProxyCredentials[][] = []
    vault.onChange((c) => changes.push(c))

    fsHooks.corruptRead = vault.vaultPath
    await expect(vault.save(input)).rejects.toMatchObject({ code: 'VAULT_ERROR', message: VERIFY_FAILED_MESSAGE })
    expect(existsSync(vault.vaultPath)).toBe(false)
    expect(vault.get('residential')).toBeNull()
    expect(changes).toEqual([])

    await vault.save(input)
    const previous = readFileSync(vault.vaultPath, 'utf8')
    fsHooks.corruptRead = vault.vaultPath
    fsHooks.unlessEquals = previous
    await expect(vault.save({ ...input, username: 'someone_else' })).rejects.toMatchObject({ code: 'VAULT_ERROR' })
    expect(readFileSync(vault.vaultPath, 'utf8')).toBe(previous)
    expect(vault.get('residential')).toEqual(stored)
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
    writeFileSync(vault.vaultPath, JSON.stringify(encryptJson(pendingKey, toVaultPayload({ residential: stored }), installId)))

    const again = makeWorld(root)
    const reopened = await openVault(again, keychain)
    expect(reopened.get('residential')).toEqual(stored)
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
    expect(reopened.get('residential')).toEqual(stored)
    expect(existsSync(`${vault.keyPath}.rotating`)).toBe(false)
    expect(readFileSync(vault.keyPath, 'utf8')).toBe(keyBefore)
  })

  it('machine-derived backend: survives a restart on the same machine, fails closed on another', async () => {
    const vault = await openVault(world, createMachineDerivedWrapper(MACHINE))
    await vault.save(input)
    expect(readKeyFile(vault.keyPath)).toMatchObject({ backend: 'machine-derived', backendLabel: expect.stringMatching(/reduced protection/) })
    expect((await vault.status()).keyBackend).toBe('machine-derived')

    const same = await openVault(makeWorld(root), createMachineDerivedWrapper(MACHINE), { machine: MACHINE })
    expect(same.get('residential')).toEqual(stored)

    const other = { machineId: 'different-machine', username: 'tester' }
    const otherWorld = makeWorld(root)
    const elsewhere = await openVault(otherWorld, createMachineDerivedWrapper(other), { machine: other })
    expect(elsewhere.get('residential')).toBeNull()
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
    expect(upgraded.get('residential')).toEqual(stored)
    const before = await upgraded.status()
    expect(before.keyBackend).toBe('machine-derived')
    expect(before.warnings.some((w) => /rotate the key to upgrade/.test(w))).toBe(true)

    const after = await upgraded.rotateKey()
    expect(after.keyBackend).toBe('os-keychain')
    expect(after.keyBackendLabel).toBe('GNOME Keyring / libsecret')
    expect(after.warnings).toEqual([])
    expect(upgraded.get('residential')).toEqual(stored)
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

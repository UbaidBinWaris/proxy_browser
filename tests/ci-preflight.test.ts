import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

let root: string
let privateKey: string
let publicKey: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'release-preflight-'))
  const keys = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  privateKey = keys.privateKey
  publicKey = keys.publicKey
  await mkdir(join(root, 'scripts'), { recursive: true })
  await mkdir(join(root, 'resources', 'updates'), { recursive: true })
  await mkdir(join(root, 'app', 'webapp'), { recursive: true })
  await cp(join(__dirname, '..', 'scripts', 'verify-release-key.mjs'), join(root, 'scripts', 'verify-release-key.mjs'))
  await writeFile(join(root, 'resources', 'updates', 'public-key.pem'), publicKey)
  await writeFile(join(root, 'app', 'webapp', 'public-key.pem'), publicKey)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function check(secret: string) {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'verify-release-key.mjs')], {
    env: { ...process.env, RELEASE_SIGNING_PRIVATE_KEY: secret },
    encoding: 'utf8',
    timeout: 10000,
  })
  const output = result.stdout + result.stderr
  expect(output).not.toContain('-----BEGIN PRIVATE KEY-----')
  return { status: result.status, output }
}

it('accepts the matching publisher key copied with Windows line endings', () => {
  const result = check(privateKey.replace(/\n/g, '\r\n'))
  expect(result.status).toBe(0)
  expect(result.output).toContain('verified against desktop and website public keys')
})

it('rejects absent and malformed signing secrets without exposing their text', () => {
  for (const secret of ['', 'invalid-sensitive-key-value']) {
    const result = check(secret)
    expect(result.status).toBe(1)
    expect(result.output).toContain('RELEASE_SIGNING_PRIVATE_KEY verification failed')
    if (secret) expect(result.output).not.toContain(secret)
  }
})

it('rejects another valid private key even when it uses the same algorithm', () => {
  const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  expect(check(other).status).toBe(1)
})

it('rejects a website public key that differs from the desktop trust key', async () => {
  const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' })
  await writeFile(join(root, 'app', 'webapp', 'public-key.pem'), other)
  expect(check(privateKey).status).toBe(1)
})

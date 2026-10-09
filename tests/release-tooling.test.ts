import { createPublicKey, verify } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DESKTOP_APP_ID, UsbReleaseSchema } from '../src/shared/desktop'
// The publisher command is plain Node ESM and is also tested directly here.
// @ts-expect-error Node scripts intentionally do not ship TypeScript declarations.
import { bumpVersion, nextVersion, initializeKeys, createUsbRelease, createServerRelease, createServerReleaseFromMetadata, macAssetFileName, manifestAppId, resolveCiVersion, syncRunnerPins } from '../scripts/release.mjs'

const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'release-tooling-'))
  folders.push(root)
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'proxy-qa-browser', version: '1.2.0' }))
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ version: '1.2.0', packages: { '': { version: '1.2.0' } } }))
  await mkdir(join(root, 'resources'))
  await writeFile(join(root, 'resources', 'release-notes.json'), JSON.stringify({ '1.2.0': ['New release'] }))
  return root
}

it('increments semantic versions and synchronizes the package and lockfile', async () => {
  expect(nextVersion('1.2.9', 'patch')).toBe('1.2.10')
  expect(nextVersion('1.2.9', 'minor')).toBe('1.3.0')
  expect(nextVersion('1.2.9', 'major')).toBe('2.0.0')
  expect(() => nextVersion('1.2.9', '1.2.8')).toThrow('increase')
  expect(() => nextVersion('1.2.9', '1.03.0')).toThrow('stable')
  const root = await fixture()
  expect(bumpVersion(root, 'minor')).toBe('1.3.0')
  expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version).toBe('1.3.0')
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  expect(lock.version).toBe('1.3.0')
  expect(lock.packages[''].version).toBe('1.3.0')
})

it('moves the CI runner image and action pins to the released version', async () => {
  const root = await fixture()
  await mkdir(join(root, 'action'), { recursive: true })
  await writeFile(join(root, 'action', 'action.yml'), 'default: ghcr.io/ubaidbinwaris/proxy-qa-runner:1.2.0\n')
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(
    join(root, 'docs', 'CI-RUNNER.md'),
    'uses: UbaidBinWaris/proxy_browser/action@v1.2.0\nimage proxy-qa-runner:1.2.0 and playwright:v1.63.0\n',
  )
  expect(bumpVersion(root, 'minor')).toBe('1.3.0')
  expect(await readFile(join(root, 'action', 'action.yml'), 'utf8')).toBe('default: ghcr.io/ubaidbinwaris/proxy-qa-runner:1.3.0\n')
  expect(await readFile(join(root, 'docs', 'CI-RUNNER.md'), 'utf8')).toBe(
    'uses: UbaidBinWaris/proxy_browser/action@v1.3.0\nimage proxy-qa-runner:1.3.0 and playwright:v1.63.0\n',
  )
  expect(syncRunnerPins(root, '1.3.0')).toEqual([])
})

it('refuses inconsistent versions before writing either file', async () => {
  const root = await fixture()
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ version: '0.0.0', packages: { '': { version: '0.0.0' } } }))
  expect(() => bumpVersion(root, 'minor')).toThrow('disagree')
  expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version).toBe('1.2.0')
})

it('keeps the publisher key stable and requires a backup if the private key is missing', async () => {
  const root = await fixture()
  const publicPath = initializeKeys(root)
  const publicKey = await readFile(publicPath, 'utf8')
  expect(initializeKeys(root)).toBe(publicPath)
  expect(await readFile(publicPath, 'utf8')).toBe(publicKey)
  const privatePath = join(root, '.release-keys', 'private-key.pem')
  if (process.platform !== 'win32') expect((await stat(privatePath)).mode & 0o777).toBe(0o600)
  await rm(privatePath)
  expect(() => initializeKeys(root)).toThrow('Restore your publisher private key')
  expect(await readFile(publicPath, 'utf8')).toBe(publicKey)
})

it('signs both platform artifacts using the exact importer schema and writes hashes', async () => {
  const root = await fixture()
  await mkdir(join(root, 'release'))
  const assets = ['Proxy-QA-Browser-1.2.0-Windows-x64.exe', 'Proxy-QA-Browser-1.2.0-x86_64.AppImage']
  for (const file of assets) await writeFile(join(root, 'release', file), `application ${file}`)
  expect(await createUsbRelease(root)).toEqual(assets)
  const envelope = JSON.parse(await readFile(join(root, 'release', 'Proxy-QA-Browser-Update.json'), 'utf8'))
  const publicKey = createPublicKey(await readFile(join(root, 'resources', 'updates', 'public-key.pem')))
  expect(verify(null, Buffer.from(envelope.payload), publicKey, Buffer.from(envelope.signature, 'base64'))).toBe(true)
  const release = UsbReleaseSchema.parse(JSON.parse(envelope.payload))
  expect(release.version).toBe('1.2.0')
  expect(release.assets.map((asset) => asset.fileName)).toEqual(assets)
  const sums = await readFile(join(root, 'release', 'SHA256SUMS-1.2.0.txt'), 'utf8')
  expect(sums.trim().split('\n')).toHaveLength(3)
  expect(sums).toContain('Proxy-QA-Browser-Update.json')
})

it('refuses incomplete platform builds and releases without notes', async () => {
  const root = await fixture()
  await expect(createUsbRelease(root)).rejects.toThrow('Build both platforms first')
  await writeFile(join(root, 'resources', 'release-notes.json'), '{}')
  await expect(createUsbRelease(root)).rejects.toThrow('Add release notes')
})

it('creates HTTPS server URLs and a signed feed compatible with the desktop updater', async () => {
  const root = await fixture()
  await mkdir(join(root, 'release'))
  for (const file of ['Proxy-QA-Browser-1.2.0-Windows-x64.exe', 'Proxy-QA-Browser-1.2.0-x86_64.AppImage']) await writeFile(join(root, 'release', file), `application ${file}`)
  await expect(createServerRelease(root, 'http://insecure.test')).rejects.toThrow('HTTPS')
  await expect(createServerRelease(root, 'https://user:secret@releases.test')).rejects.toThrow('HTTPS')
  expect(await createServerRelease(root, 'https://releases.test')).toBe('1.2.0')
  const raw = JSON.parse(await readFile(join(root, 'release', 'update.json'), 'utf8'))
  const key = await readFile(join(root, 'resources', 'updates', 'public-key.pem'), 'utf8')
  const { verifyUpdateEnvelope } = await import('../src/main/releases/updates')
  const payload = verifyUpdateEnvelope(raw, key)
  expect(payload.assets[0]?.url).toBe('https://releases.test/api/download/1.2.0/Proxy-QA-Browser-1.2.0-Windows-x64.exe')
  expect(payload.assets).toHaveLength(2)
})

it('signs CI job metadata without trusting a server-provided hash or requiring large binaries in GitHub storage', async () => {
  const root = await fixture()
  const assets = [{ platform: 'win32', arch: 'x64', fileName: 'Proxy-QA-Browser-1.2.0-Windows-x64.exe', size: 100, sha256: 'a'.repeat(64) }, { platform: 'linux', arch: 'x64', fileName: 'Proxy-QA-Browser-1.2.0-x86_64.AppImage', size: 200, sha256: 'b'.repeat(64) }]
  await expect(createServerReleaseFromMetadata(root, [assets[0]])).rejects.toThrow('Both')
  await expect(createServerReleaseFromMetadata(root, [{ ...assets[0], fileName: '../secret.exe' }, assets[1]])).rejects.toThrow('Invalid')
  await expect(createServerReleaseFromMetadata(root, [{ ...assets[0], sha256: 'bad' }, assets[1]])).rejects.toThrow('Invalid')
  expect(await createServerReleaseFromMetadata(root, assets)).toBe('1.2.0')
  const envelope = JSON.parse(await readFile(join(root, 'release', 'update.json'), 'utf8'))
  expect(JSON.parse(envelope.payload).assets.map((a: { sha256: string }) => a.sha256)).toEqual(['a'.repeat(64), 'b'.repeat(64)])
})

it('writes the current app identity unless a valid legacy identity is configured', () => {
  expect(manifestAppId(undefined)).toBe(DESKTOP_APP_ID)
  expect(manifestAppId('  ')).toBe(DESKTOP_APP_ID)
  expect(manifestAppId('com.example.legacy-app')).toBe('com.example.legacy-app')
  expect(() => manifestAppId('not an id')).toThrow('reverse-DNS')
})

it('publishes exactly the tagged version, and run-numbered versions for manual runs', () => {
  expect(resolveCiVersion({ packageVersion: '1.4.0', refType: 'tag', refName: 'v1.4.0' })).toBe('1.4.0')
  expect(resolveCiVersion({ packageVersion: '1.4.0', refType: 'tag', refName: 'v1.5.0' })).toBe('1.5.0')
  expect(() => resolveCiVersion({ packageVersion: '1.4.0', refType: 'tag', refName: 'v1.3.9' })).toThrow('increase')
  expect(() => resolveCiVersion({ packageVersion: '1.4.0', refType: 'tag', refName: 'release-1' })).toThrow('v1.2.3')
  expect(() => resolveCiVersion({ packageVersion: '1.4.0', refType: 'tag', refName: 'v1.5' })).toThrow('v1.2.3')
  expect(resolveCiVersion({ packageVersion: '1.4.0', refType: 'branch', refName: 'main', runNumber: '12' })).toBe('1.4.12')
  expect(() => resolveCiVersion({ packageVersion: '1.4.0', refType: 'branch', refName: 'main', runNumber: '' })).toThrow('RUN_NUMBER')
})

it('adds whichever macOS DMG/ZIP files were built as optional macAssets, outside the strict two-asset list', async () => {
  const root = await fixture()
  await mkdir(join(root, 'release'))
  const required = ['Proxy-QA-Browser-1.2.0-Windows-x64.exe', 'Proxy-QA-Browser-1.2.0-x86_64.AppImage']
  const mac = ['Proxy-QA-Browser-1.2.0-macOS-arm64.dmg', 'Proxy-QA-Browser-1.2.0-macOS-arm64.zip', 'Proxy-QA-Browser-1.2.0-macOS-x64.dmg']
  for (const file of [...required, ...mac]) await writeFile(join(root, 'release', file), `application ${file}`)
  expect(macAssetFileName('1.2.0', 'x64', 'zip')).toBe('Proxy-QA-Browser-1.2.0-macOS-x64.zip')
  expect(await createUsbRelease(root)).toEqual([...required, ...mac])
  const envelope = JSON.parse(await readFile(join(root, 'release', 'Proxy-QA-Browser-Update.json'), 'utf8'))
  const release = UsbReleaseSchema.parse(JSON.parse(envelope.payload))
  expect(release.assets.map((asset) => asset.fileName)).toEqual(required)
  expect(release.macAssets?.map((asset) => [asset.arch, asset.fileName])).toEqual([
    ['arm64', mac[0]],
    ['arm64', mac[1]],
    ['x64', mac[2]],
  ])
  const sums = await readFile(join(root, 'release', 'SHA256SUMS-1.2.0.txt'), 'utf8')
  expect(sums.trim().split('\n')).toHaveLength(6)

  // The server pair carries the same macOS files with download URLs the desktop updater accepts.
  expect(await createServerRelease(root, 'https://releases.test')).toBe('1.2.0')
  const raw = JSON.parse(await readFile(join(root, 'release', 'update.json'), 'utf8'))
  const { verifyUpdateEnvelope } = await import('../src/main/releases/updates')
  const payload = verifyUpdateEnvelope(raw, await readFile(join(root, 'resources', 'updates', 'public-key.pem'), 'utf8'))
  expect(payload.assets).toHaveLength(2)
  expect(payload.macAssets?.map((asset) => asset.url)).toEqual(mac.map((file) => `https://releases.test/api/download/1.2.0/${file}`))
})

it('leaves macAssets out entirely when no macOS build exists (same shape as earlier manifests)', async () => {
  const root = await fixture()
  await mkdir(join(root, 'release'))
  for (const file of ['Proxy-QA-Browser-1.2.0-Windows-x64.exe', 'Proxy-QA-Browser-1.2.0-x86_64.AppImage']) await writeFile(join(root, 'release', file), file)
  await createServerRelease(root, 'https://releases.test')
  for (const file of ['Proxy-QA-Browser-Update.json', 'update.json']) {
    const payload = JSON.parse(JSON.parse(await readFile(join(root, 'release', file), 'utf8')).payload)
    expect(Object.keys(payload)).not.toContain('macAssets')
  }
})

it('accepts optional darwin entries in CI metadata and refuses malformed or duplicate ones', async () => {
  const root = await fixture()
  const required = [{ platform: 'win32', arch: 'x64', fileName: 'Proxy-QA-Browser-1.2.0-Windows-x64.exe', size: 100, sha256: 'a'.repeat(64) }, { platform: 'linux', arch: 'x64', fileName: 'Proxy-QA-Browser-1.2.0-x86_64.AppImage', size: 200, sha256: 'b'.repeat(64) }]
  const dmg = { platform: 'darwin', arch: 'arm64', fileName: 'Proxy-QA-Browser-1.2.0-macOS-arm64.dmg', size: 300, sha256: 'c'.repeat(64) }
  // macOS files never stand in for a required platform.
  await expect(createServerReleaseFromMetadata(root, [required[0], dmg])).rejects.toThrow('Both')
  for (const bad of [
    { ...dmg, arch: 'universal' },
    { ...dmg, fileName: 'Proxy-QA-Browser-1.2.0-macOS-x64.dmg' },
    { ...dmg, fileName: 'Proxy-QA-Browser-1.1.0-macOS-arm64.dmg' },
    { ...dmg, fileName: '../Proxy-QA-Browser-1.2.0-macOS-arm64.dmg' },
    { ...dmg, sha256: 'bad' },
    { ...dmg, size: 0 },
  ])
    await expect(createServerReleaseFromMetadata(root, [...required, bad]), JSON.stringify(bad)).rejects.toThrow('Invalid macOS asset metadata')
  await expect(createServerReleaseFromMetadata(root, [...required, dmg, dmg])).rejects.toThrow('Invalid macOS asset metadata')
  expect(await createServerReleaseFromMetadata(root, [dmg, ...required])).toBe('1.2.0')
  const usb = UsbReleaseSchema.parse(JSON.parse(JSON.parse(await readFile(join(root, 'release', 'Proxy-QA-Browser-Update.json'), 'utf8')).payload))
  expect(usb.assets.map((asset) => asset.platform)).toEqual(['win32', 'linux'])
  expect(usb.macAssets).toEqual([dmg])
  const online = JSON.parse(JSON.parse(await readFile(join(root, 'release', 'update.json'), 'utf8')).payload)
  expect(online.macAssets).toEqual([{ ...dmg, url: 'https://proxybrowser.ubaidbinwaris.com/api/download/1.2.0/Proxy-QA-Browser-1.2.0-macOS-arm64.dmg' }])
})

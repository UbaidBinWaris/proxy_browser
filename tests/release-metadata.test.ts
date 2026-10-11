import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// Plain Node ESM script run by the publish job of deploy.yml.
// @ts-expect-error Node scripts intentionally do not ship TypeScript declarations.
import { REQUIRED_ASSETS, loadReleaseMetadata } from '../scripts/sign-release-metadata.mjs'

const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))) })

const entry = (platform: string, arch: string, version = '1.6.0') => ({
  version, platform, arch,
  fileName: platform === 'darwin' ? `Proxy-QA-Browser-${version}-macOS-${arch}.dmg` : `Proxy-QA-Browser-${version}-${platform === 'win32' ? 'Windows-x64.exe' : 'x86_64.AppImage'}`,
  size: 1234, sha256: '2'.repeat(64),
})
async function folder(entries: Array<Record<string, unknown>>, names?: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'release-metadata-')); folders.push(dir)
  await Promise.all(entries.map((e, i) => writeFile(join(dir, names?.[i] ?? `${e.platform}-${e.arch}.json`), JSON.stringify(e))))
  return dir
}
const all = () => [entry('win32', 'x64'), entry('linux', 'x64'), entry('darwin', 'arm64'), entry('darwin', 'x64')]

describe('release metadata handed over as artifacts', () => {
  it('requires every platform of a tagged release', () => { expect(REQUIRED_ASSETS).toEqual(['win32-x64', 'linux-x64', 'darwin-arm64', 'darwin-x64']) })

  it('keeps checksums that contain any digits (they never pass through job outputs)', async () => {
    const assets = loadReleaseMetadata(await folder(all()))
    expect(assets).toHaveLength(4)
    expect(assets.every((a: { sha256: string }) => a.sha256 === '2'.repeat(64))).toBe(true)
    expect(Object.keys(assets[0])).toEqual(['platform', 'arch', 'fileName', 'size', 'sha256'])
  })

  it('names a missing platform', async () => {
    await expect(async () => loadReleaseMetadata(await folder(all().slice(0, 3)))).rejects.toThrow('Missing build metadata for darwin-x64.')
  })

  it('rejects mismatched file names, incomplete entries and mixed versions', async () => {
    await expect(async () => loadReleaseMetadata(await folder([entry('win32', 'x64')], ['linux-x64.json']), ['win32-x64'])).rejects.toThrow('linux-x64.json describes win32-x64.')
    await expect(async () => loadReleaseMetadata(await folder([{ ...entry('win32', 'x64'), sha256: 'nope' }]), ['win32-x64'])).rejects.toThrow('win32-x64.json is incomplete.')
    await expect(async () => loadReleaseMetadata(await folder([entry('win32', 'x64'), entry('linux', 'x64', '1.5.9')]), ['win32-x64', 'linux-x64'])).rejects.toThrow('more than one version')
  })
})

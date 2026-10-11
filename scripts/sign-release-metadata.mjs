#!/usr/bin/env node
/* global process, console, URL */
/**
 * Signs the server release from the build jobs' metadata files (release/metadata/<platform>-<arch>.json, written by
 * scripts/release-asset.mjs and handed over as workflow artifacts). Artifacts replace job outputs, which GitHub drops
 * when a value happens to contain any secret's value (a checksum containing "22", for example).
 *
 * Usage: node scripts/sign-release-metadata.mjs [metadata dir]   (publish job, after the artifacts are downloaded)
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServerReleaseFromMetadata } from './release.mjs'

/** Every platform a tagged release must contain. */
export const REQUIRED_ASSETS = ['win32-x64', 'linux-x64', 'darwin-arm64', 'darwin-x64']

/**
 * Reads the metadata files of one version. Throws when a required platform is missing, a file is duplicated or
 * malformed, or the files disagree on the version.
 */
export function loadReleaseMetadata(dir, required = REQUIRED_ASSETS) {
  const files = readdirSync(dir).filter(name => name.endsWith('.json')).sort()
  const assets = files.map(name => {
    const { version, platform, arch, fileName, size, sha256 } = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    if (name !== `${platform}-${arch}.json`) throw new Error(`${name} describes ${platform}-${arch}.`)
    if (typeof fileName !== 'string' || !Number.isSafeInteger(size) || !/^[a-f0-9]{64}$/.test(sha256 ?? '')) throw new Error(`${name} is incomplete.`)
    return { version, platform, arch, fileName, size, sha256 }
  })
  const missing = required.filter(key => !assets.some(a => `${a.platform}-${a.arch}` === key))
  if (missing.length) throw new Error(`Missing build metadata for ${missing.join(', ')}.`)
  const versions = new Set(assets.map(a => a.version))
  if (versions.size !== 1) throw new Error(`Build metadata covers more than one version: ${[...versions].join(', ')}.`)
  return assets.map(({ platform, arch, fileName, size, sha256 }) => ({ platform, arch, fileName, size, sha256 }))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  try {
    const assets = loadReleaseMetadata(process.argv[2] ?? join(root, 'release', 'metadata'))
    await createServerReleaseFromMetadata(root, assets)
    console.log(`Signed release metadata for ${assets.map(a => a.fileName).join(', ')}`)
  } catch (error) {
    if (process.env.GITHUB_ACTIONS === 'true') console.log(`::error title=Release metadata::${error.message}`)
    console.error(error.message)
    process.exitCode = 1
  }
}

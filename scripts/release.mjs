#!/usr/bin/env node
/* global process, Buffer, URL */
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/**
 * Identity written into release manifests. Set PROXY_QA_MANIFEST_APP_ID to the
 * identity of an older release while copies of it still install USB updates:
 * releases before 1.4.0 accept only their own identity, newer ones accept both.
 */
const APP_ID = manifestAppId(process.env.PROXY_QA_MANIFEST_APP_ID)

export function manifestAppId(override) {
  const value = override?.trim() || 'com.ubaidbinwaris.proxy-qa-browser'
  if (!/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(value) || value.length > 200)
    throw new Error('PROXY_QA_MANIFEST_APP_ID must be a reverse-DNS application identity.')
  return value
}
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)

export function nextVersion(current, requested) {
  if (!VERSION.test(current)) throw new Error('Current version must be major.minor.patch.')
  const parts = current.split('.').map(Number)
  const index = ['major', 'minor', 'patch'].indexOf(requested)
  if (index >= 0) {
    parts[index] += 1
    for (let i = index + 1; i < parts.length; i++) parts[i] = 0
    requested = parts.join('.')
  }
  if (!VERSION.test(requested) || !requested.split('.').every((part) => Number.isSafeInteger(Number(part))))
    throw new Error('Choose patch, minor, major, or a stable major.minor.patch version.')
  const next = requested.split('.').map(Number)
  const different = next.findIndex((part, i) => part !== current.split('.').map(Number)[i])
  if (different < 0 || next[different] < Number(current.split('.')[different]))
    throw new Error('The next release version must increase.')
  return requested
}

export function bumpVersion(root, requested) {
  const pkgPath = join(root, 'package.json')
  const lockPath = join(root, 'package-lock.json')
  const pkg = json(pkgPath)
  const lock = json(lockPath)
  if (pkg.version !== lock.version || pkg.version !== lock.packages[''].version)
    throw new Error('Package and lockfile versions disagree. Fix them before releasing.')
  const version = nextVersion(pkg.version, requested)
  pkg.version = version
  lock.version = version
  lock.packages[''].version = version
  writeJson(pkgPath, pkg)
  writeJson(lockPath, lock)
  syncRunnerPins(root, version)
  return version
}

/**
 * The version a CI deploy publishes. A `vX.Y.Z` tag publishes exactly X.Y.Z (it must not be lower than
 * package.json); a manual run (no tag) keeps the old scheme: package patch + run number.
 */
export function resolveCiVersion({ packageVersion, refType, refName, runNumber }) {
  if (!VERSION.test(packageVersion)) throw new Error('package.json version must be major.minor.patch.')
  if (refType === 'tag') {
    const match = /^v(\d+\.\d+\.\d+)$/.exec(refName ?? '')
    if (!match || !VERSION.test(match[1])) throw new Error(`Release tags must look like v1.2.3 (got "${refName}").`)
    const tagged = match[1]
    if (tagged !== packageVersion) nextVersion(packageVersion, tagged) // throws when the tag is lower
    return tagged
  }
  const run = Number(runNumber)
  if (!Number.isSafeInteger(run) || run < 1) throw new Error('A positive GITHUB_RUN_NUMBER is required.')
  const [major, minor, patch] = packageVersion.split('.').map(Number)
  return `${major}.${minor}.${patch + run}`
}

/** Files that pin the CI runner image or action to a release; the runner-image workflow refuses a mismatch. */
export const RUNNER_PIN_FILES = ['action/action.yml', 'docs/CI-RUNNER.md', 'docs/MCP-SERVER.md', 'docs/site/ci-runner.md', 'docs/site/mcp-server.md', 'examples/ci/github-workflow.yml']

export function syncRunnerPins(root, version) {
  const changed = []
  for (const file of RUNNER_PIN_FILES) {
    const path = join(root, file)
    if (!existsSync(path)) continue
    const before = readFileSync(path, 'utf8')
    const after = before
      .replace(/(proxy-qa-runner:)\d+\.\d+\.\d+/g, `$1${version}`)
      .replace(/(proxy_browser\/action@v)\d+\.\d+\.\d+/g, `$1${version}`)
    if (after !== before) {
      writeFileSync(path, after)
      changed.push(file)
    }
  }
  return changed
}

export function initializeKeys(root) {
  const privatePath = join(root, '.release-keys', 'private-key.pem')
  const publicPath = join(root, 'resources', 'updates', 'public-key.pem')
  if (existsSync(publicPath)) {
    if (!existsSync(privatePath))
      throw new Error(
        'Restore your publisher private key from its backup. Do not rotate the public key for existing users.',
      )
    const actual = createPublicKey(readFileSync(privatePath)).export({ type: 'spki', format: 'pem' }).toString()
    if (actual !== readFileSync(publicPath, 'utf8')) throw new Error('Publisher keys do not match.')
    return publicPath
  }
  mkdirSync(dirname(privatePath), { recursive: true, mode: 0o700 })
  mkdirSync(dirname(publicPath), { recursive: true })
  if (!existsSync(privatePath)) {
    const keys = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    writeFileSync(privatePath, keys.privateKey, { mode: 0o600, flag: 'wx' })
  }
  const publicKey = createPublicKey(readFileSync(privatePath)).export({ type: 'spki', format: 'pem' })
  writeFileSync(publicPath, publicKey, { flag: 'wx' })
  return publicPath
}

/**
 * macOS downloads are optional and travel in `macAssets`, never in `assets`: releases up to 1.4.x
 * parse `assets` strictly (win32/linux only, at most two) and ignore unknown keys, so a manifest with
 * macOS files stays valid for every installed copy. File names follow electron-builder's mac
 * artifactName (`${productName}-${version}-macOS-${arch}.${ext}`).
 */
export const MAC_ARCHES = ['arm64', 'x64']
export const MAC_EXTENSIONS = ['dmg', 'zip']
export function macAssetFileName(version, arch, ext) {
  return `Proxy-QA-Browser-${version}-macOS-${arch}.${ext}`
}

function validMacAsset(asset, version) {
  return (
    asset?.platform === 'darwin' &&
    MAC_ARCHES.includes(asset.arch) &&
    MAC_EXTENSIONS.some((ext) => asset.fileName === macAssetFileName(version, asset.arch, ext)) &&
    Number.isSafeInteger(asset.size) &&
    asset.size >= 1 &&
    asset.size <= 2 * 1024 ** 3 &&
    /^[a-f0-9]{64}$/.test(asset.sha256)
  )
}

async function hash(path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

export async function createUsbRelease(root) {
  initializeKeys(root)
  const { version } = json(join(root, 'package.json'))
  if (!VERSION.test(version)) throw new Error('Only stable major.minor.patch releases are supported.')
  const notes = json(join(root, 'resources', 'release-notes.json'))[version]
  if (
    !Array.isArray(notes) ||
    !notes.length ||
    notes.length > 30 ||
    notes.some((note) => typeof note !== 'string' || !note.trim() || note.length > 500)
  )
    throw new Error(`Add release notes for ${version} in resources/release-notes.json before publishing.`)
  const directory = join(root, 'release')
  const assets = []
  for (const [platform, suffix] of [
    ['win32', 'Windows-x64.exe'],
    ['linux', 'x86_64.AppImage'],
  ]) {
    const fileName = `Proxy-QA-Browser-${version}-${suffix}`
    const path = join(directory, fileName)
    if (!existsSync(path)) throw new Error(`Build both platforms first. Missing: ${fileName}`)
    const size = (await stat(path)).size
    if (!size || size > 2 * 1024 ** 3) throw new Error(`Invalid release size: ${fileName}`)
    assets.push({ platform, arch: 'x64', fileName, size, sha256: await hash(path) })
  }
  // Optional: whichever macOS DMG/ZIP files were built (`npm run build:mac` on a Mac).
  const macAssets = []
  for (const arch of MAC_ARCHES)
    for (const ext of MAC_EXTENSIONS) {
      const fileName = macAssetFileName(version, arch, ext)
      const path = join(directory, fileName)
      if (!existsSync(path)) continue
      const size = (await stat(path)).size
      if (!size || size > 2 * 1024 ** 3) throw new Error(`Invalid release size: ${fileName}`)
      macAssets.push({ platform: 'darwin', arch, fileName, size, sha256: await hash(path) })
    }
  const payload = JSON.stringify({
    format: 1,
    appId: APP_ID,
    version,
    releasedAt: new Date().toISOString(),
    notes,
    assets,
    ...(macAssets.length ? { macAssets } : {}),
  })
  const signature = sign(
    null,
    Buffer.from(payload),
    readFileSync(join(root, '.release-keys', 'private-key.pem')),
  ).toString('base64')
  const manifest = join(directory, 'Proxy-QA-Browser-Update.json')
  writeJson(manifest, { payload, signature })
  const sums = [
    ...[...assets, ...macAssets].map((asset) => `${asset.sha256}  ${asset.fileName}`),
    `${await hash(manifest)}  Proxy-QA-Browser-Update.json`,
  ]
  writeFileSync(join(directory, `SHA256SUMS-${version}.txt`), `${sums.join('\n')}\n`)
  return [...assets, ...macAssets].map((asset) => asset.fileName)
}

export async function createServerReleaseFromMetadata(root, assets, origin = 'https://proxybrowser.ubaidbinwaris.com') {
  const url = new URL(origin)
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Release origin must be a plain HTTPS origin.')
  const { version } = json(join(root, 'package.json'))
  const notes = json(join(root, 'resources', 'release-notes.json'))[version]
  if (!VERSION.test(version) || !Array.isArray(notes) || !notes.length || notes.length > 30 || notes.some(n => typeof n !== 'string' || !n.trim() || n.length > 500)) throw new Error('Stable version and release notes are required.')
  if (!Array.isArray(assets)) throw new Error('Both platform assets are required.')
  // darwin entries are optional extras (see MAC_ARCHES); exactly one Windows and one Linux asset stay required.
  const macInput = assets.filter(asset => asset?.platform === 'darwin')
  assets = assets.filter(asset => asset?.platform !== 'darwin')
  if (assets.length !== 2 || new Set(assets.map(a => a.platform)).size !== 2) throw new Error('Both platform assets are required.')
  if (macInput.length > MAC_ARCHES.length * MAC_EXTENSIONS.length || new Set(macInput.map(a => a?.fileName)).size !== macInput.length || !macInput.every(asset => validMacAsset(asset, version))) throw new Error('Invalid macOS asset metadata.')
  const macAssets = macInput.map(asset => ({ platform: 'darwin', arch: asset.arch, fileName: asset.fileName, size: asset.size, sha256: asset.sha256 }))
  assets = assets.map(asset => {
    const suffix = asset.platform === 'win32' ? 'Windows-x64.exe' : asset.platform === 'linux' ? 'x86_64.AppImage' : null
    if (!suffix || asset.arch !== 'x64' || asset.fileName !== `Proxy-QA-Browser-${version}-${suffix}` || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 2 * 1024 ** 3 || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid release asset metadata.')
    return { platform: asset.platform, arch: asset.arch, fileName: asset.fileName, size: asset.size, sha256: asset.sha256 }
  })
  initializeKeys(root)
  const directory = join(root, 'release'); mkdirSync(directory, { recursive: true })
  const withUrl = asset => ({ ...asset, url: `${url.origin}/api/download/${version}/${asset.fileName}` })
  const data = { format: 1, appId: APP_ID, version, releasedAt: new Date().toISOString(), notes, assets, ...(macAssets.length ? { macAssets } : {}) }
  for (const [file, value] of [
    ['Proxy-QA-Browser-Update.json', data],
    ['update.json', { version, releasedAt: data.releasedAt, notes, assets: assets.map(withUrl), ...(macAssets.length ? { macAssets: macAssets.map(withUrl) } : {}) }],
  ]) {
    const payload = JSON.stringify(value)
    const signature = sign(null, Buffer.from(payload), readFileSync(join(root, '.release-keys', 'private-key.pem'))).toString('base64')
    writeJson(join(directory, file), { payload, signature })
  }
  const sums = [...assets, ...macAssets].map(asset => `${asset.sha256}  ${asset.fileName}`)
  for (const file of ['Proxy-QA-Browser-Update.json', 'update.json']) sums.push(`${await hash(join(directory, file))}  ${file}`)
  writeFileSync(join(directory, `SHA256SUMS-${version}.txt`), `${sums.join('\n')}\n`)
  return version
}

export async function createServerRelease(root, origin = 'https://proxybrowser.ubaidbinwaris.com') {
  // Local publishing hashes the built files. CI supplies hashes from trusted build-job outputs.
  const url = new URL(origin)
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Release origin must be a plain HTTPS origin.')
  await createUsbRelease(root)
  const usb = json(join(root, 'release', 'Proxy-QA-Browser-Update.json'))
  const signed = JSON.parse(usb.payload)
  return createServerReleaseFromMetadata(root, [...signed.assets, ...(signed.macAssets ?? [])], origin)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2]
    if (command === 'version') process.stdout.write(`Release version: ${bumpVersion(ROOT, process.argv[3])}\n`)
    else if (command === 'init') {
      initializeKeys(ROOT)
      process.stdout.write('Publisher key ready. Back up .release-keys privately; never distribute it.\n')
    } else if (command === 'usb') {
      await createUsbRelease(ROOT)
      process.stdout.write('Signed USB update and checksums written to release/.\n')
    } else if (command === 'server') {
      await createServerRelease(ROOT, process.env.PROXY_QA_RELEASE_ORIGIN)
      process.stdout.write('Signed server and USB manifests written to release/.\n')
    } else throw new Error('Usage: node scripts/release.mjs init | version patch/minor/major/1.2.3 | usb | server')
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}

/**
 * "User-space" installs on Linux: the vendor's official package is downloaded
 * and unpacked into `<userData>/data/installed-browsers/<engine>/` — no root, no
 * package manager, no dpkg — so it works the same on Debian, Ubuntu, Fedora,
 * Arch, openSUSE or anything else with an x86-64 glibc userland.
 *
 * Steps: resolve the current package (linux-sources.ts) → download with
 * progress and size/checksum checks → unpack into `<engine>.partial` (.deb: pure
 * JS `ar` reader → data.tar.* → decompress → tar; .zip: in-process reader) →
 * locate and verify the executable → write a small manifest → atomically swap
 * the new tree in place of the previous version (at most one version is kept).
 * Any failure leaves the previous install untouched and removes the leftovers.
 */
import { chmodSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { InstallPhase, InstalledBrowserEngine } from '@shared/types'

import { findDebDataMember, listArMembers, openFileSource } from './ar-archive'
import { downloadToFile, formatMegabytes } from './download'
import type { FetchFn } from './download'
import { LINUX_PACKAGE_SOURCES, resolveLinuxPackage } from './linux-sources'
import type { ResolvedPackage } from './linux-sources'
import { decompress, extractTar } from './tar-archive'
import type { TarTools } from './tar-archive'
import { extractZipFile } from './zip-archive'

export const INSTALLED_BROWSERS_DIR_NAME = 'installed-browsers'
export const INSTALL_MANIFEST_FILE = '.proxy-qa-install.json'
/** Minimum gap between two download progress events with the same percentage. */
const PROGRESS_INTERVAL_MS = 500

export interface InstallManifest {
  engine: InstalledBrowserEngine
  version: string | null
  /** Executable relative to the install directory (forward slashes). */
  binary: string
  url: string
  sha256: string
  bytes: number
  installedAt: string
}

export interface UserSpaceProgress {
  phase: InstallPhase
  message: string
  percent: number | null
}

export interface UserSpaceInstallOptions {
  engine: InstalledBrowserEngine
  /** `<userData>/data/installed-browsers` */
  rootDir: string
  fetchImpl: FetchFn
  tools: TarTools
  onProgress: (progress: UserSpaceProgress) => void
  signal?: AbortSignal
  /** Resolution of the package to download (tests inject fixtures). */
  resolvePackage?: (engine: InstalledBrowserEngine, fetchImpl: FetchFn, signal?: AbortSignal) => Promise<ResolvedPackage>
  now?: () => number
}

export interface UserSpaceInstallResult {
  executablePath: string
  installDir: string
  version: string | null
  bytes: number
}

export function managedInstallDir(rootDir: string, engine: InstalledBrowserEngine): string {
  return path.join(rootDir, engine)
}

/** The manifest of a finished install, or null when absent/corrupt. */
export function readInstallManifest(installDir: string): InstallManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(installDir, INSTALL_MANIFEST_FILE), 'utf8')) as Partial<InstallManifest>
    if (typeof parsed.binary !== 'string' || typeof parsed.engine !== 'string') return null
    return parsed as InstallManifest
  } catch {
    return null
  }
}

/** Relative path that stays inside its base directory (no absolute paths, no `..`). */
function isContainedRelative(relative: string): boolean {
  if (relative === '' || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) return false
  return !relative.split(/[\\/]/).includes('..')
}

/** Where the executable of a user-space install may be: the manifest's path first, then the vendor default. */
export function managedExecutableCandidates(rootDir: string, engine: InstalledBrowserEngine, readText: (filePath: string) => string | null): string[] {
  const dir = managedInstallDir(rootDir, engine)
  const candidates: string[] = []
  const manifestText = readText(path.join(dir, INSTALL_MANIFEST_FILE))
  if (manifestText) {
    try {
      const binary = (JSON.parse(manifestText) as { binary?: unknown }).binary
      if (typeof binary === 'string' && isContainedRelative(binary)) candidates.push(path.join(dir, binary))
    } catch {
      // Corrupt manifest: fall back to the default layout.
    }
  }
  const source = LINUX_PACKAGE_SOURCES[engine]
  if (source) candidates.push(path.join(dir, source.binary))
  return [...new Set(candidates)]
}

function isRegularFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile()
  } catch {
    return false
  }
}

/** Breadth-first search for a regular file called `name` (symlinked directories are not followed). */
export function findFileByName(dir: string, name: string, maxDepth = 8): string | null {
  let level = [dir]
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth += 1) {
    const next: string[] = []
    for (const current of level) {
      let entries: string[]
      try {
        entries = readdirSync(current)
      } catch {
        continue
      }
      for (const entry of entries.sort()) {
        const full = path.join(current, entry)
        let stat
        try {
          stat = lstatSync(full)
        } catch {
          continue
        }
        if (stat.isFile() && entry === name) return full
        if (stat.isDirectory()) next.push(full)
      }
    }
    level = next
  }
  return null
}

/** Make sure the executable bit is set (some archives lose it). */
function ensureExecutable(filePath: string): void {
  const mode = statSync(filePath).mode
  if ((mode & 0o111) === 0) chmodSync(filePath, (mode & 0o777) | 0o755)
}

async function unpackDeb(packagePath: string, destDir: string, tools: TarTools): Promise<void> {
  const source = openFileSource(packagePath)
  let data
  try {
    data = findDebDataMember(listArMembers(source))
  } finally {
    source.close()
  }
  const { member, compression } = data
  const input = createReadStream(packagePath, { start: member.offset, end: member.offset + member.size - 1 })
  const { stream, done } = decompress(input, compression, tools)
  await Promise.all([extractTar(stream, destDir, tools), done])
}

/** Install (or update) one engine into the user-space folder. */
export async function installUserSpace(options: UserSpaceInstallOptions): Promise<UserSpaceInstallResult> {
  const { engine, rootDir, fetchImpl, tools, onProgress, signal } = options
  const source = LINUX_PACKAGE_SOURCES[engine]
  if (!source) throw new Error(`There is no official Linux package the app can install for ${engine}.`)
  const now = options.now ?? Date.now
  const resolvePackage = options.resolvePackage ?? resolveLinuxPackage

  mkdirSync(rootDir, { recursive: true })
  const finalDir = managedInstallDir(rootDir, engine)
  const partialDir = `${finalDir}.partial`
  const oldDir = `${finalDir}.old`
  const workDir = path.join(rootDir, `.${engine}-download`)
  const cleanup = (): void => {
    for (const dir of [partialDir, workDir]) rmSync(dir, { recursive: true, force: true })
  }
  cleanup()
  rmSync(oldDir, { recursive: true, force: true })

  try {
    onProgress({ phase: 'starting', message: `Looking up the latest version on ${source.origin}…`, percent: null })
    const resolved = await resolvePackage(engine, fetchImpl, signal)
    const packagePath = path.join(workDir, path.basename(resolved.fileName))

    let lastPercent = -1
    let lastEmit = 0
    const download = await downloadToFile({
      url: resolved.url,
      destination: packagePath,
      fetchImpl,
      expectedSize: resolved.expectedSize,
      expectedSha256: resolved.expectedSha256,
      ...(signal ? { signal } : {}),
      onProgress: (received, total) => {
        const percent = total ? Math.min(100, Math.floor((received / total) * 100)) : null
        const at = now()
        if (percent === lastPercent && at - lastEmit < PROGRESS_INTERVAL_MS) return
        if (percent === null && at - lastEmit < PROGRESS_INTERVAL_MS) return
        lastPercent = percent ?? lastPercent
        lastEmit = at
        onProgress({ phase: 'downloading', message: `Downloading ${resolved.fileName} · ${formatMegabytes(received)}${total ? ` of ${formatMegabytes(total)}` : ''}`, percent })
      },
    })
    onProgress({
      phase: 'verifying',
      message: `Downloaded ${formatMegabytes(download.bytes)}${resolved.expectedSha256 ? ' · SHA-256 verified' : ''}`,
      percent: 100,
    })

    onProgress({ phase: 'extracting', message: `Extracting ${resolved.fileName}…`, percent: null })
    if (source.kind === 'deb') {
      await unpackDeb(packagePath, partialDir, tools)
    } else {
      await extractZipFile(packagePath, partialDir, ({ done, total }) => {
        const at = now()
        if (at - lastEmit < PROGRESS_INTERVAL_MS && done !== total) return
        lastEmit = at
        onProgress({ phase: 'extracting', message: `Extracting ${resolved.fileName} · ${done} of ${total} files`, percent: Math.floor((done / total) * 100) })
      })
    }
    rmSync(workDir, { recursive: true, force: true })

    onProgress({ phase: 'verifying', message: 'Checking the browser executable…', percent: null })
    let executable = path.join(partialDir, source.binary)
    if (!isRegularFile(executable)) {
      const found = findFileByName(partialDir, source.binaryName)
      if (!found) throw new Error(`The ${source.origin} package did not contain the "${source.binaryName}" executable. The vendor may have changed its layout.`)
      executable = found
    }
    ensureExecutable(executable)
    const binary = path.relative(partialDir, executable).split(path.sep).join('/')
    const manifest: InstallManifest = {
      engine,
      version: resolved.version,
      binary,
      url: resolved.url,
      sha256: download.sha256,
      bytes: download.bytes,
      installedAt: new Date(now()).toISOString(),
    }
    writeFileSync(path.join(partialDir, INSTALL_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)

    // Swap: the previous version is moved aside, the new one renamed into place, the old one deleted.
    if (existsSync(finalDir)) renameSync(finalDir, oldDir)
    renameSync(partialDir, finalDir)
    rmSync(oldDir, { recursive: true, force: true })

    return { executablePath: path.join(finalDir, binary), installDir: finalDir, version: resolved.version, bytes: download.bytes }
  } catch (err) {
    cleanup()
    // A swap interrupted half-way puts the previous version back.
    if (!existsSync(finalDir) && existsSync(oldDir)) renameSync(oldDir, finalDir)
    throw err
  }
}

/** Delete a user-space install. Returns false when there was nothing to remove. */
export function uninstallUserSpace(rootDir: string, engine: InstalledBrowserEngine): boolean {
  const dir = managedInstallDir(rootDir, engine)
  const existed = existsSync(dir)
  for (const leftover of [dir, `${dir}.partial`, `${dir}.old`, path.join(rootDir, `.${engine}-download`)]) rmSync(leftover, { recursive: true, force: true })
  return existed
}

/** True when `filePath` lies inside the user-space install of `engine`. */
export function isInsideManagedInstall(rootDir: string, engine: InstalledBrowserEngine, filePath: string): boolean {
  const relative = path.relative(managedInstallDir(rootDir, engine), filePath)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

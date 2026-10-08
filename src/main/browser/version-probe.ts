/**
 * Version of an installed browser, read without ever opening a browser window.
 *
 * - Windows: the VERSIONINFO resource of the .exe (pe-version.ts), falling back
 *   to the version-named directory next to it. `<exe> --version` is NEVER run:
 *   Chrome, Edge, Brave, Opera and Vivaldi ignore the flag on Windows and open a
 *   browser window that keeps running.
 * - macOS: `CFBundleShortVersionString` from `<App>.app/Contents/Info.plist`
 *   (XML plists; a binary plist yields null). The binary is never run either:
 *   launching an app bundle's executable opens the app.
 * - Linux (and other POSIX): `<exe> --version`, which every supported vendor
 *   browser answers on stdout without opening a window.
 *
 * Results are cached per executable, keyed by path + size + mtime, in memory
 * and (in production) in `<userData>/data/engine-versions.json`, so a binary
 * that has not changed is never probed again — on any OS, across restarts.
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import type { InstalledBrowserEngine } from '@shared/types'
import { INSTALLED_BROWSER_ENGINES } from '@shared/types'

import { writeFileAtomicSync } from '../util/atomic-file'
import { readPeFileVersion, readSiblingDirVersion } from './pe-version'

/** Budget for `<exe> --version` (Linux only). */
export const VERSION_TIMEOUT_MS = 3_000
export const VERSION_CACHE_FILE_NAME = 'engine-versions.json'
/** Entries kept in the persistent cache (old executables of updated browsers fall out). */
export const VERSION_CACHE_MAX_ENTRIES = 64

/** Runs `<executable> --version` and resolves with its combined output, or null on any failure. Must never reject. */
export type VersionRunner = (executablePath: string, timeoutMs: number) => Promise<string | null>

export const spawnVersionRunner: VersionRunner = (executablePath, timeoutMs) =>
  new Promise<string | null>((resolve) => {
    try {
      execFile(executablePath, ['--version'], { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
        const output = `${stdout ?? ''}\n${stderr ?? ''}`.trim()
        // Some browsers exit non-zero after printing the version; the text still counts.
        if (output.length > 0) resolve(output)
        else resolve(error ? null : output)
      })
    } catch {
      resolve(null)
    }
  })

/** First version-like token (`153.0.8010.52`, `118.0`) in a `--version` output, or null. */
export function parseVersion(output: string | null | undefined): string | null {
  if (!output) return null
  const match = /(\d+(?:\.\d+){1,3})/.exec(output)
  return match?.[1] ?? null
}

/**
 * Platforms where running `<exe> --version` is safe: it prints and exits. On Windows and macOS a
 * browser binary opens a window instead, so it is never executed there.
 */
export function mayExecuteForVersion(platform: NodeJS.Platform): boolean {
  return platform !== 'win32' && platform !== 'darwin'
}

/** Vendor browsers verified to print their version on stdout for `--version` on Linux (all of them today). */
export const VERSION_FLAG_ENGINES: ReadonlySet<InstalledBrowserEngine> = new Set(INSTALLED_BROWSER_ENGINES)

export type VersionMethod = 'pe-resource' | 'sibling-dir' | 'info-plist' | 'version-flag' | 'none'

// ---------------------------------------------------------------------------
// macOS Info.plist
// ---------------------------------------------------------------------------

/** `/Applications/Foo.app/Contents/MacOS/Foo` → `/Applications/Foo.app`, or null outside a bundle. */
export function appBundleRoot(executablePath: string): string | null {
  const normalized = executablePath.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('.app/Contents/MacOS/')
  return index === -1 ? null : normalized.slice(0, index + '.app'.length)
}

/** CFBundleShortVersionString of an XML plist; null for binary plists or when the key is missing. */
export function parsePlistShortVersion(text: string): string | null {
  if (text.startsWith('bplist')) return null
  const match = /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/.exec(text)
  return match?.[1] ?? null
}

export async function readInfoPlistVersion(executablePath: string): Promise<string | null> {
  const root = appBundleRoot(executablePath)
  if (!root) return null
  try {
    return parsePlistShortVersion(await readFile(path.posix.join(root, 'Contents', 'Info.plist'), 'utf8'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export interface FileFingerprint {
  size: number
  mtimeMs: number
}

export interface VersionCacheEntry extends FileFingerprint {
  version: string | null
  method: VersionMethod
  probedAt: string
}

export interface VersionCache {
  get(executablePath: string): VersionCacheEntry | null
  set(executablePath: string, entry: VersionCacheEntry): void
}

export function memoryVersionCache(): VersionCache {
  const entries = new Map<string, VersionCacheEntry>()
  return {
    get: (key) => entries.get(key) ?? null,
    set: (key, entry) => {
      entries.set(key, entry)
    },
  }
}

function isCacheEntry(value: unknown): value is VersionCacheEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry.size === 'number' && typeof entry.mtimeMs === 'number' && (entry.version === null || typeof entry.version === 'string') && typeof entry.method === 'string'
}

/**
 * Persistent cache in a small JSON file (read once, rewritten atomically on change). A corrupt or
 * unreadable file is treated as empty; write failures are reported to `onError` and otherwise ignored.
 */
export function fileVersionCache(filePath: string, onError?: (err: unknown) => void): VersionCache {
  let entries: Map<string, VersionCacheEntry> | null = null
  const load = (): Map<string, VersionCacheEntry> => {
    if (entries) return entries
    entries = new Map()
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { entries?: Record<string, unknown> }
      for (const [key, value] of Object.entries(parsed.entries ?? {})) if (isCacheEntry(value)) entries.set(key, value)
    } catch {
      // Missing or corrupt: start empty.
    }
    return entries
  }
  return {
    get: (key) => load().get(key) ?? null,
    set: (key, entry) => {
      const map = load()
      map.delete(key)
      map.set(key, entry)
      while (map.size > VERSION_CACHE_MAX_ENTRIES) {
        const oldest = map.keys().next().value
        if (oldest === undefined) break
        map.delete(oldest)
      }
      try {
        writeFileAtomicSync(filePath, `${JSON.stringify({ version: 1, entries: Object.fromEntries(map) }, null, 2)}\n`, { mode: 0o644 })
      } catch (err) {
        onError?.(err)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

export type VersionProbe = (engine: InstalledBrowserEngine, executablePath: string) => Promise<string | null>

export interface StaticVersionReaders {
  readPe: (executablePath: string) => Promise<string | null>
  readSiblingDirs: (executablePath: string) => Promise<string | null>
  readPlist: (executablePath: string) => Promise<string | null>
}

export const nodeStaticVersionReaders: StaticVersionReaders = {
  readPe: readPeFileVersion,
  readSiblingDirs: readSiblingDirVersion,
  readPlist: readInfoPlistVersion,
}

export interface VersionProbeOptions {
  platform: NodeJS.Platform
  /** `--version` runner; only ever called where `mayExecuteForVersion(platform)` is true. */
  runVersion?: VersionRunner
  timeoutMs?: number
  /** Size + mtime of the executable, or null when unknown (then nothing is cached). */
  stat?: (executablePath: string) => FileFingerprint | null
  cache?: VersionCache
  readers?: Partial<StaticVersionReaders>
  now?: () => number
}

/** Read the version the platform-appropriate way. Never throws, never executes on Windows/macOS. */
export async function probeVersionUncached(
  engine: InstalledBrowserEngine,
  executablePath: string,
  opts: Pick<VersionProbeOptions, 'platform' | 'runVersion' | 'timeoutMs' | 'readers'>,
): Promise<{ version: string | null; method: VersionMethod }> {
  const readers: StaticVersionReaders = { ...nodeStaticVersionReaders, ...opts.readers }
  try {
    if (opts.platform === 'win32') {
      const fromResource = await readers.readPe(executablePath)
      if (fromResource) return { version: fromResource, method: 'pe-resource' }
      const fromDirs = await readers.readSiblingDirs(executablePath)
      return fromDirs ? { version: fromDirs, method: 'sibling-dir' } : { version: null, method: 'none' }
    }
    if (opts.platform === 'darwin') {
      const fromPlist = await readers.readPlist(executablePath)
      return fromPlist ? { version: fromPlist, method: 'info-plist' } : { version: null, method: 'none' }
    }
    if (!mayExecuteForVersion(opts.platform) || !VERSION_FLAG_ENGINES.has(engine)) return { version: null, method: 'none' }
    const output = await (opts.runVersion ?? spawnVersionRunner)(executablePath, opts.timeoutMs ?? VERSION_TIMEOUT_MS)
    const version = parseVersion(output)
    return { version, method: version ? 'version-flag' : 'none' }
  } catch {
    return { version: null, method: 'none' }
  }
}

export function createVersionProbe(opts: VersionProbeOptions): VersionProbe {
  const now = opts.now ?? Date.now
  return async (engine, executablePath) => {
    const fingerprint = opts.cache && opts.stat ? opts.stat(executablePath) : null
    if (fingerprint && opts.cache) {
      const cached = opts.cache.get(executablePath)
      if (cached && cached.size === fingerprint.size && cached.mtimeMs === fingerprint.mtimeMs) return cached.version
    }
    const { version, method } = await probeVersionUncached(engine, executablePath, opts)
    // A failed `--version` (timeout, crash) is retried next time; static reads are deterministic, so their null is kept.
    if (fingerprint && opts.cache && (version !== null || !mayExecuteForVersion(opts.platform))) {
      opts.cache.set(executablePath, { ...fingerprint, version, method, probedAt: new Date(now()).toISOString() })
    }
    return version
  }
}

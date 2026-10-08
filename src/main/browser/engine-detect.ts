/**
 * Detection of real browsers already installed on this machine: Google Chrome,
 * Microsoft Edge, Brave, Opera, Opera GX, Vivaldi and a system Chromium.
 *
 * Every candidate is checked on disk — the saved path from Settings → Browsers
 * (typed by the user, or auto-saved by the app) when the file exists, then the
 * app's own user-space installs (`<userData>/data/installed-browsers/<engine>`),
 * then well-known per-platform locations, then a `which`-style scan of PATH; no
 * child process is spawned for the lookup. The version is read best-effort by
 * version-probe.ts WITHOUT executing the browser on Windows and macOS (PE
 * VERSIONINFO resource / Info.plist; running `chrome.exe --version` on Windows
 * opens a browser window) and with `<exe> --version` on Linux only; failures
 * yield `null`, never an exception. Versions are cached per binary
 * (path + size + mtime), so an unchanged browser is never probed twice.
 *
 * Results are cached for a minute (keyed by the override map, so saving a new
 * path in Settings is picked up at once); `invalidate()` forces a fresh scan.
 * An engine whose install task is running (`isEngineBusy`) is located on disk
 * only — its files are in flux, so its version is not read.
 *
 * This module never imports playwright-core or electron, so it can be exercised
 * with an injected filesystem, environment and platform in unit tests.
 */
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import type { BrowserEngineInfo, BrowserEngineSource, BrowserExecutableOrigins, BrowserExecutableOverrides, InstalledBrowserEngine } from '@shared/types'
import { BROWSER_ENGINE_FAMILY, BROWSER_ENGINE_KIND, BROWSER_ENGINE_LABELS, INSTALLED_BROWSER_ENGINES } from '@shared/types'

import { downloadUrlFor, installMethodFor } from './install-support'
import type { InstallHost } from './install-support'
import { INSTALL_MANIFEST_FILE, managedExecutableCandidates, managedInstallDir } from './installers/linux-user-space'
import { VERSION_TIMEOUT_MS, createVersionProbe, parseVersion, spawnVersionRunner } from './version-probe'
import type { FileFingerprint, VersionCache, VersionProbe, VersionRunner } from './version-probe'

export type { InstallHost } from './install-support'
export { VERSION_TIMEOUT_MS, parseVersion, spawnVersionRunner } from './version-probe'
export type { VersionRunner } from './version-probe'

export const NOT_FOUND_NOTE = 'Not installed on this machine. Install it or set its path in Settings → Browsers.'
export const SETTINGS_NOTE = 'Using the executable path set in Settings → Browsers.'
export const AUTO_SAVED_NOTE = 'Using the executable path the app saved automatically.'
export const MANAGED_NOTE = "Installed by the app in its data folder."
export const DETECTED_NOTE = 'Detected automatically on this machine.'
export const DETECTED_ON_PATH_NOTE = 'Detected on PATH.'
export const DETECTION_CACHE_TTL_MS = 60_000

const DEFAULT_WINDOWS_PATHEXT = ['.EXE', '.CMD', '.BAT', '.COM']

// ---------------------------------------------------------------------------
// Candidate locations
// ---------------------------------------------------------------------------

type CandidateMap = Record<InstalledBrowserEngine, readonly string[]>

const LINUX_CANDIDATES: CandidateMap = {
  opera: ['/usr/bin/opera', '/usr/bin/opera-stable', '/opt/opera/opera', '/usr/lib/opera/opera', '/usr/lib/x86_64-linux-gnu/opera-stable/opera', '/snap/bin/opera'],
  'opera-gx': ['/usr/bin/opera-gx', '/opt/opera-gx/opera'],
  brave: ['/usr/bin/brave', '/usr/bin/brave-browser', '/usr/bin/brave-browser-stable', '/opt/brave.com/brave/brave', '/snap/bin/brave'],
  vivaldi: ['/usr/bin/vivaldi', '/usr/bin/vivaldi-stable', '/opt/vivaldi/vivaldi'],
  chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'],
  msedge: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge'],
  'system-chromium': ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
}

/** `%VAR%` placeholders are expanded from the environment (with the usual Windows defaults). */
const WINDOWS_CANDIDATES: CandidateMap = {
  opera: ['%LOCALAPPDATA%\\Programs\\Opera\\opera.exe', '%PROGRAMFILES%\\Opera\\opera.exe'],
  'opera-gx': ['%LOCALAPPDATA%\\Programs\\Opera GX\\opera.exe'],
  brave: [
    '%PROGRAMFILES%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    '%PROGRAMFILES(X86)%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    '%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  ],
  vivaldi: ['%LOCALAPPDATA%\\Vivaldi\\Application\\vivaldi.exe', '%PROGRAMFILES%\\Vivaldi\\Application\\vivaldi.exe'],
  chrome: [
    '%PROGRAMFILES%\\Google\\Chrome\\Application\\chrome.exe',
    '%PROGRAMFILES(X86)%\\Google\\Chrome\\Application\\chrome.exe',
    '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe',
  ],
  msedge: ['%PROGRAMFILES(X86)%\\Microsoft\\Edge\\Application\\msedge.exe', '%PROGRAMFILES%\\Microsoft\\Edge\\Application\\msedge.exe'],
  'system-chromium': ['%LOCALAPPDATA%\\Chromium\\Application\\chrome.exe'],
}

/** System-wide `/Applications` first, then the per-user `~/Applications` (`$HOME` is expanded). */
const MACOS_CANDIDATES: CandidateMap = {
  opera: ['/Applications/Opera.app/Contents/MacOS/Opera', '$HOME/Applications/Opera.app/Contents/MacOS/Opera'],
  'opera-gx': ['/Applications/Opera GX.app/Contents/MacOS/Opera', '$HOME/Applications/Opera GX.app/Contents/MacOS/Opera'],
  brave: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '$HOME/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  vivaldi: ['/Applications/Vivaldi.app/Contents/MacOS/Vivaldi', '$HOME/Applications/Vivaldi.app/Contents/MacOS/Vivaldi'],
  chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  msedge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '$HOME/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  'system-chromium': ['/Applications/Chromium.app/Contents/MacOS/Chromium', '$HOME/Applications/Chromium.app/Contents/MacOS/Chromium'],
}

/** Command names looked up on PATH (POSIX). */
const POSIX_PATH_COMMANDS: CandidateMap = {
  opera: ['opera', 'opera-stable'],
  'opera-gx': ['opera-gx'],
  brave: ['brave', 'brave-browser', 'brave-browser-stable'],
  vivaldi: ['vivaldi', 'vivaldi-stable'],
  chrome: ['google-chrome', 'google-chrome-stable'],
  msedge: ['microsoft-edge', 'microsoft-edge-stable', 'msedge'],
  'system-chromium': ['chromium', 'chromium-browser'],
}

/** Command names looked up on PATH (Windows; PATHEXT extensions are appended). `chrome` is Google's name, so system Chromium only matches `chromium`. */
const WINDOWS_PATH_COMMANDS: CandidateMap = {
  opera: ['opera'],
  'opera-gx': ['opera-gx'],
  brave: ['brave'],
  vivaldi: ['vivaldi'],
  chrome: ['chrome'],
  msedge: ['msedge'],
  'system-chromium': ['chromium'],
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Minimal filesystem view so detection can run against a fake in tests. */
export interface DetectFs {
  /** True when `filePath` exists and is a regular file (symlinks are followed). */
  isFile(filePath: string): boolean
  /** Small text file contents (install manifests), or null when unreadable. Optional for fakes. */
  readText?(filePath: string): string | null
  /** Size and mtime of a file (the version cache key), or null. Optional: without it versions are not cached. */
  stat?(filePath: string): FileFingerprint | null
}

export const nodeDetectFs: DetectFs = {
  isFile(filePath: string): boolean {
    try {
      return statSync(filePath).isFile()
    } catch {
      return false
    }
  },
  readText(filePath: string): string | null {
    try {
      return readFileSync(filePath, 'utf8')
    } catch {
      return null
    }
  },
  stat(filePath: string): FileFingerprint | null {
    try {
      const stats = statSync(filePath)
      return stats.isFile() ? { size: stats.size, mtimeMs: stats.mtimeMs } : null
    } catch {
      return null
    }
  },
}

/** Case-insensitive environment lookup on Windows (where `Path`, `PATH` and `path` are the same variable). */
export function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  const exact = env[name]
  if (exact !== undefined) return exact
  if (platform !== 'win32') return undefined
  const upper = name.toUpperCase()
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upper) return value
  }
  return undefined
}

/** Windows locations most installers use when the environment does not say otherwise. */
export function withWindowsDefaults(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env }
  const systemDrive = envValue(env, 'SystemDrive', 'win32')?.trim() || 'C:'
  const userProfile = envValue(env, 'USERPROFILE', 'win32')?.trim()
  if (envValue(env, 'LOCALAPPDATA', 'win32') === undefined && userProfile) result.LOCALAPPDATA = `${userProfile}\\AppData\\Local`
  if (envValue(env, 'PROGRAMFILES', 'win32') === undefined) result.PROGRAMFILES = `${systemDrive}\\Program Files`
  if (envValue(env, 'PROGRAMFILES(X86)', 'win32') === undefined) result['PROGRAMFILES(X86)'] = `${systemDrive}\\Program Files (x86)`
  return result
}

/**
 * Expand `%NAME%`, `${NAME}` and `$NAME` from the environment. Returns null when a
 * referenced variable is missing or blank, so the candidate is skipped instead of
 * producing a path like `\Programs\Opera\opera.exe`.
 */
export function expandEnvVars(template: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  let missing = false
  const substitute = (name: string): string => {
    const value = envValue(env, name, platform)?.trim()
    if (!value) {
      missing = true
      return ''
    }
    return value
  }
  const expanded = template
    .replace(/%([^%]+)%/g, (_match, name: string) => substitute(name))
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => substitute(name))
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => substitute(name))
  return missing ? null : expanded
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/** Well-known executable locations for an engine on a platform, env vars expanded, duplicates removed. */
export function candidateExecutables(engine: InstalledBrowserEngine, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const templates = platform === 'win32' ? WINDOWS_CANDIDATES[engine] : platform === 'darwin' ? MACOS_CANDIDATES[engine] : LINUX_CANDIDATES[engine]
  const effectiveEnv = platform === 'win32' ? withWindowsDefaults(env) : env
  const expanded: string[] = []
  for (const template of templates) {
    const candidate = expandEnvVars(template, effectiveEnv, platform)
    if (candidate) expanded.push(candidate)
  }
  return dedupe(expanded)
}

/** Command names an engine may be reachable under on PATH. */
export function pathCommandNames(engine: InstalledBrowserEngine, platform: NodeJS.Platform): readonly string[] {
  return platform === 'win32' ? WINDOWS_PATH_COMMANDS[engine] : POSIX_PATH_COMMANDS[engine]
}

/** PATH entries in order, with Windows quoting removed and blanks dropped. */
export function pathEntries(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const raw = envValue(env, 'PATH', platform) ?? ''
  const delimiter = platform === 'win32' ? ';' : ':'
  return raw
    .split(delimiter)
    .map((entry) => (platform === 'win32' ? entry.replace(/^"|"$/g, '') : entry).trim())
    .filter((entry) => entry.length > 0)
}

/**
 * `which`-style lookup without spawning anything: the first `<dir>/<command>` that is a
 * regular file wins. On Windows every PATHEXT extension is tried after the bare name.
 */
export function scanPath(commands: readonly string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform, fs: DetectFs): string | null {
  const join = platform === 'win32' ? path.win32.join : path.posix.join
  const extensions =
    platform === 'win32'
      ? ['', ...(envValue(env, 'PATHEXT', platform)?.split(';').map((ext) => ext.trim()).filter((ext) => ext.length > 0) ?? DEFAULT_WINDOWS_PATHEXT)]
      : ['']
  for (const dir of pathEntries(env, platform)) {
    for (const command of commands) {
      for (const extension of extensions) {
        const candidate = join(dir, `${command}${extension}`)
        if (fs.isFile(candidate)) return candidate
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Locating one engine
// ---------------------------------------------------------------------------

export interface LocatedExecutable {
  executablePath: string | null
  source: BrowserEngineSource
  note: string
}

export interface LocateOptions {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  fs: DetectFs
  /** Who set each saved path ('auto' paths are reported as source 'auto-saved'). Missing → 'user'. */
  origins?: BrowserExecutableOrigins
  /** `<userData>/data/installed-browsers`: the app's own user-space installs. */
  managedRoot?: string | null
}

/** Executables of the app's own user-space install of `engine` that exist on disk. */
export function managedCandidates(engine: InstalledBrowserEngine, opts: Pick<LocateOptions, 'fs' | 'managedRoot'>): string[] {
  if (!opts.managedRoot) return []
  const readText = opts.fs.readText ? (filePath: string): string | null => opts.fs.readText?.(filePath) ?? null : (): null => null
  return managedExecutableCandidates(opts.managedRoot, engine, readText)
}

/** A user-space install of `engine` exists (its manifest is present). */
export function hasManagedInstall(engine: InstalledBrowserEngine, opts: Pick<LocateOptions, 'fs' | 'managedRoot'>): boolean {
  if (!opts.managedRoot || !opts.fs.readText) return false
  return opts.fs.readText(path.join(managedInstallDir(opts.managedRoot, engine), INSTALL_MANIFEST_FILE)) !== null
}

/**
 * Saved path (when the file exists) → the app's user-space install → well-known locations → PATH →
 * not found. A saved path that points nowhere is reported in the note but never used.
 */
export function locateExecutable(engine: InstalledBrowserEngine, overrides: BrowserExecutableOverrides, opts: LocateOptions): LocatedExecutable {
  const override = overrides[engine]?.trim()
  let overrideProblem = ''
  if (override) {
    const auto = opts.origins?.[engine] === 'auto'
    if (opts.fs.isFile(override)) return auto ? { executablePath: override, source: 'auto-saved', note: AUTO_SAVED_NOTE } : { executablePath: override, source: 'settings', note: SETTINGS_NOTE }
    overrideProblem = auto
      ? `The saved path (${override}) no longer exists. `
      : `The path set in Settings → Browsers (${override}) does not exist and was ignored. `
  }
  for (const candidate of managedCandidates(engine, opts)) {
    if (opts.fs.isFile(candidate)) return { executablePath: candidate, source: 'detected', note: `${overrideProblem}${MANAGED_NOTE}` }
  }
  for (const candidate of candidateExecutables(engine, opts.platform, opts.env)) {
    if (opts.fs.isFile(candidate)) return { executablePath: candidate, source: 'detected', note: `${overrideProblem}${DETECTED_NOTE}` }
  }
  const onPath = scanPath(pathCommandNames(engine, opts.platform), opts.env, opts.platform, opts.fs)
  if (onPath) return { executablePath: onPath, source: 'detected', note: `${overrideProblem}${DETECTED_ON_PATH_NOTE}` }
  return { executablePath: null, source: 'not-found', note: `${overrideProblem}${NOT_FOUND_NOTE}` }
}

/** The host this process runs on, with winget assumed absent (the provisioner probes it on Windows). */
export function defaultInstallHost(platform: NodeJS.Platform = process.platform): InstallHost {
  return { platform, arch: process.arch, winget: false }
}

/** Build the renderer-facing record for an installed-kind engine. */
export function describeInstalledEngine(
  engine: InstalledBrowserEngine,
  located: LocatedExecutable,
  version: string | null,
  host: InstallHost = defaultInstallHost(),
  managedInstall = false,
): BrowserEngineInfo {
  const install = installMethodFor(engine, host)
  return {
    id: engine,
    label: BROWSER_ENGINE_LABELS[engine],
    family: BROWSER_ENGINE_FAMILY[engine],
    kind: BROWSER_ENGINE_KIND[engine],
    available: located.executablePath !== null,
    executablePath: located.executablePath,
    version: located.executablePath ? version : null,
    source: located.source,
    note: located.note,
    installMethod: install.method,
    installNote: install.note,
    downloadUrl: downloadUrlFor(engine),
    managedInstall,
  }
}

// ---------------------------------------------------------------------------
// Version probing
// ---------------------------------------------------------------------------

/** Best-effort `--version` output parse through a runner (POSIX only; see version-probe.ts). Never throws. */
export async function readVersion(executablePath: string, runner: VersionRunner = spawnVersionRunner, timeoutMs: number = VERSION_TIMEOUT_MS): Promise<string | null> {
  try {
    return parseVersion(await runner(executablePath, timeoutMs))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Detector with cache
// ---------------------------------------------------------------------------

export interface EngineDetectorOptions {
  /** Current executable overrides from settings (read on every detection so saved paths apply immediately). */
  getOverrides: () => BrowserExecutableOverrides
  /** Who set each override ('auto' → source 'auto-saved'). Defaults to none (every override is the user's). */
  getOrigins?: () => BrowserExecutableOrigins
  /** `<userData>/data/installed-browsers` (user-space installs are detection candidates). */
  managedRoot?: string | null
  /** Host facts for the install method (winget availability is probed asynchronously on Windows). */
  getHost?: () => InstallHost | Promise<InstallHost>
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  fs?: DetectFs
  /** `--version` runner used on Linux only; never called on Windows or macOS. */
  runVersion?: VersionRunner
  versionTimeoutMs?: number
  /** Persistent version cache (path + size + mtime); none by default. */
  versionCache?: VersionCache
  /** Replaces the default platform-aware version probe entirely (tests). */
  probeVersion?: VersionProbe
  /** Engines whose install task is running: located only, their version is not read. */
  isEngineBusy?: (engine: InstalledBrowserEngine) => boolean
  cacheTtlMs?: number
  now?: () => number
}

export interface EngineDetector {
  /** Every installed-kind engine, in `INSTALLED_BROWSER_ENGINES` order (cached). */
  detect(): Promise<BrowserEngineInfo[]>
  detectEngine(engine: InstalledBrowserEngine): Promise<BrowserEngineInfo>
  /** Synchronous, uncached disk lookup of one engine (no version probe) — cheap enough to poll. */
  locate(engine: InstalledBrowserEngine): LocatedExecutable
  /** Drop the cache so the next call scans again. */
  invalidate(): void
}

function overridesKey(overrides: BrowserExecutableOverrides, origins: BrowserExecutableOrigins): string {
  const sorted = (record: Record<string, unknown>): Array<[string, unknown]> => Object.entries(record).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify([sorted(overrides), sorted(origins)])
}

export function createEngineDetector(options: EngineDetectorOptions): EngineDetector {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const fs = options.fs ?? nodeDetectFs
  const probeVersion =
    options.probeVersion ??
    createVersionProbe({
      platform,
      runVersion: options.runVersion ?? spawnVersionRunner,
      timeoutMs: options.versionTimeoutMs ?? VERSION_TIMEOUT_MS,
      ...(options.versionCache && fs.stat ? { cache: options.versionCache, stat: (filePath: string) => fs.stat?.(filePath) ?? null } : {}),
    })
  const isEngineBusy = options.isEngineBusy ?? ((): boolean => false)
  const cacheTtlMs = options.cacheTtlMs ?? DETECTION_CACHE_TTL_MS
  const now = options.now ?? Date.now
  const getOrigins = options.getOrigins ?? ((): BrowserExecutableOrigins => ({}))
  const managedRoot = options.managedRoot ?? null
  const getHost = options.getHost ?? ((): InstallHost => defaultInstallHost(platform))

  let cache: { key: string; expiresAt: number; result: Promise<BrowserEngineInfo[]> } | null = null

  const scan = async (overrides: BrowserExecutableOverrides, origins: BrowserExecutableOrigins): Promise<BrowserEngineInfo[]> => {
    const installHost = await getHost()
    return Promise.all(
      INSTALLED_BROWSER_ENGINES.map(async (engine) => {
        const located = locateExecutable(engine, overrides, { platform, env, fs, origins, managedRoot })
        const version = located.executablePath && !isEngineBusy(engine) ? await probeVersion(engine, located.executablePath).catch(() => null) : null
        return describeInstalledEngine(engine, located, version, installHost, hasManagedInstall(engine, { fs, managedRoot }))
      }),
    )
  }

  const detect = (): Promise<BrowserEngineInfo[]> => {
    const overrides = options.getOverrides()
    const origins = getOrigins()
    const key = overridesKey(overrides, origins)
    if (cache && cache.key === key && cache.expiresAt > now()) return cache.result
    const result = scan(overrides, origins)
    const entry = { key, expiresAt: now() + cacheTtlMs, result }
    cache = entry
    // A failed scan must not be served from the cache.
    result.catch(() => {
      if (cache === entry) cache = null
    })
    return result
  }

  return {
    detect,
    async detectEngine(engine) {
      const all = await detect()
      const found = all.find((info) => info.id === engine)
      if (found) return found
      // Unreachable by construction (every installed engine is scanned); kept total for type safety.
      return describeInstalledEngine(engine, { executablePath: null, source: 'not-found', note: NOT_FOUND_NOTE }, null, await getHost())
    },
    locate(engine) {
      return locateExecutable(engine, options.getOverrides(), { platform, env, fs, origins: getOrigins(), managedRoot })
    },
    invalidate() {
      cache = null
    },
  }
}

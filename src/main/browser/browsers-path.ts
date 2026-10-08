/**
 * Where the Playwright browsers live, decided once at process start.
 *
 * The bootstrap entry (src/main/index.ts) imports this module BEFORE
 * playwright-core is loaded, so it must never import playwright-core itself:
 * it reads the package's browsers.json straight from disk instead. The
 * package is resolved with createRequire(import.meta.url), which also works
 * from inside app.asar (Electron patches `fs` for asar paths).
 *
 * Precedence — the same rule for the bootstrap and the provisioner:
 *   1. PLAYWRIGHT_BROWSERS_PATH from the environment            → 'env'
 *   2. <resources>/playwright-browsers holding INSTALLATION_COMPLETE for
 *      chromium, firefox AND webkit at the current revisions   → 'bundled' (read-only)
 *   3. packaged build: <userData>/data/browsers                 → 'provisioned' (installed on demand)
 *   4. development: Playwright's default cache                  → 'dev-cache'
 *
 * Because the bootstrap exports the chosen directory to PLAYWRIGHT_BROWSERS_PATH,
 * a later caller (the provisioner) sees it as an environment value. An env
 * path that points at the bundled or the provisioned directory is therefore
 * classified back to 'bundled' / 'provisioned' so both report the same source.
 *
 * The module also knows about the Ubuntu shared libraries bundled for WebKit
 * (<resources>/webkit-libs, Linux only): see `resolveWebkitLibsDir` and
 * `webkitLaunchEnv`.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import path from 'node:path'

import type { BrowsersSource, BundledBrowserEngine } from '@shared/types'
import { BUNDLED_BROWSER_ENGINES } from '@shared/types'

/** Directory name of the bundled browsers under `process.resourcesPath`. */
export const BUNDLED_BROWSERS_DIR_NAME = 'playwright-browsers'
/** Directory name of the bundled WebKit host libraries under `process.resourcesPath` (Linux only). */
export const WEBKIT_LIBS_DIR_NAME = 'webkit-libs'
/** Env var the bootstrap sets to the bundled WebKit host-library directory; read by the browser manager. */
export const WEBKIT_LIBS_ENV = 'PROXY_QA_WEBKIT_LIBS'
/** Marker Playwright writes when a browser download finished. */
export const INSTALL_MARKER = 'INSTALLATION_COMPLETE'

export interface BrowsersJsonEntry {
  name: string
  revision: string
  revisionOverrides?: Record<string, string>
  /** Upstream browser version of this revision, e.g. "153.0.8010.12" (absent for ffmpeg). */
  browserVersion?: string
}

export interface BrowsersJson {
  browsers: BrowsersJsonEntry[]
}

export interface BrowsersResolution {
  dir: string
  source: BrowsersSource
}

export interface ResolveBrowsersDirOptions {
  /** `process.env.PLAYWRIGHT_BROWSERS_PATH` (may be unset or blank). */
  envPath: string | undefined
  /** `process.resourcesPath`: the bundled browsers are looked up beneath it. */
  resourcesPath: string
  /** `<userData>/data/browsers`, used by packaged builds without a bundle. */
  userDataBrowsersDir: string
  isPackaged: boolean
  /** Playwright's default cache; null means "compute it" (`defaultPlaywrightCacheDir()`). */
  defaultCacheDir: string | null
  /** Root of the playwright-core package, for the `PLAYWRIGHT_BROWSERS_PATH=0` convention. Resolved when omitted. */
  playwrightPackageRoot?: string
}

const require = createRequire(import.meta.url)

/** Absolute directory of the installed playwright-core package (inside app.asar when packaged). */
export function playwrightPackageRoot(): string {
  return path.dirname(require.resolve('playwright-core/package.json'))
}

/** Parse playwright-core's browsers.json (the revisions the runtime will look for). */
export function readBrowsersJson(packageRoot: string = playwrightPackageRoot()): BrowsersJson {
  return JSON.parse(readFileSync(path.join(packageRoot, 'browsers.json'), 'utf8')) as BrowsersJson
}

/** Mirrors playwright-core's `defaultRegistryDirectory()`. */
export function defaultPlaywrightCacheDir(): string {
  switch (process.platform) {
    case 'linux':
      return path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache'), 'ms-playwright')
    case 'darwin':
      return path.join(homedir(), 'Library', 'Caches', 'ms-playwright')
    case 'win32':
      return path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'ms-playwright')
    default:
      return path.join(homedir(), '.cache', 'ms-playwright')
  }
}

/** Revisions under which an engine may be installed (the default one plus distinct platform overrides). */
export function candidateRevisions(engine: BundledBrowserEngine, browsersJson: BrowsersJson): string[] {
  const entry = browsersJson.browsers.find((b) => b.name === engine)
  if (!entry) return []
  return [...new Set([entry.revision, ...Object.values(entry.revisionOverrides ?? {})])]
}

/** Upstream version of the bundled engine revision as recorded in browsers.json, or null when unknown. */
export function bundledEngineVersion(engine: BundledBrowserEngine, browsersJson: BrowsersJson): string | null {
  return browsersJson.browsers.find((b) => b.name === engine)?.browserVersion ?? null
}

/** True when `<dir>/<engine>-<revision>/INSTALLATION_COMPLETE` exists for any candidate revision. */
export function isEngineInstalled(dir: string, engine: BundledBrowserEngine, browsersJson: BrowsersJson): boolean {
  return candidateRevisions(engine, browsersJson).some((revision) => existsSync(path.join(dir, `${engine}-${revision}`, INSTALL_MARKER)))
}

export function bundledBrowsersDir(resourcesPath: string): string {
  return path.join(resourcesPath, BUNDLED_BROWSERS_DIR_NAME)
}

/** A bundle counts only when every bundled engine is complete; a partial bundle is ignored. */
export function hasCompleteBundle(dir: string, browsersJson: BrowsersJson): boolean {
  return BUNDLED_BROWSER_ENGINES.every((engine) => isEngineInstalled(dir, engine, browsersJson))
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b)
}

/**
 * Decide the browsers directory. Pure apart from filesystem existence checks,
 * so it is unit-testable with temp directories.
 */
export function resolveBrowsersDir(opts: ResolveBrowsersDirOptions, browsersJson: BrowsersJson = readBrowsersJson()): BrowsersResolution {
  const bundledDir = bundledBrowsersDir(opts.resourcesPath)
  const bundled = hasCompleteBundle(bundledDir, browsersJson)

  const fromEnv = opts.envPath?.trim()
  if (fromEnv) {
    // Playwright convention: "0" means "inside the package's own .local-browsers".
    const dir = fromEnv === '0' ? path.join(opts.playwrightPackageRoot ?? playwrightPackageRoot(), '.local-browsers') : path.resolve(fromEnv)
    if (bundled && samePath(dir, bundledDir)) return { dir: bundledDir, source: 'bundled' }
    if (samePath(dir, opts.userDataBrowsersDir)) return { dir: path.resolve(opts.userDataBrowsersDir), source: 'provisioned' }
    return { dir, source: 'env' }
  }

  if (bundled) return { dir: bundledDir, source: 'bundled' }
  if (opts.isPackaged) return { dir: path.resolve(opts.userDataBrowsersDir), source: 'provisioned' }
  return { dir: opts.defaultCacheDir ?? defaultPlaywrightCacheDir(), source: 'dev-cache' }
}

/**
 * `<resources>/webkit-libs` when it exists (Linux only): the Ubuntu shared
 * libraries Playwright's WebKit needs on distributions that do not ship them.
 */
export function resolveWebkitLibsDir(resourcesPath: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'linux') return null
  const dir = path.join(resourcesPath, WEBKIT_LIBS_DIR_NAME)
  try {
    return statSync(dir).isDirectory() ? dir : null
  } catch {
    return null
  }
}

/** The bundled WebKit libs directory the bootstrap exported, if any. */
export function webkitLibsDirFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[WEBKIT_LIBS_ENV]?.trim()
  return value ? value : null
}

/** `libsDir` first, then the existing LD_LIBRARY_PATH entries (minus any duplicate of `libsDir`). */
export function composeLdLibraryPath(libsDir: string, current: string | undefined): string {
  const rest = (current ?? '')
    .split(':')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && path.resolve(entry) !== path.resolve(libsDir))
  return [libsDir, ...rest].join(':')
}

/**
 * Environment for a WebKit browser process. Playwright replaces (does not
 * merge) the process environment when `launch({ env })` is given, so the
 * whole parent environment is copied and only LD_LIBRARY_PATH is rewritten.
 * Values are narrowed to strings, which is what Playwright accepts.
 */
export function webkitLaunchEnv(libsDir: string, baseEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) env[key] = value
  }
  env.LD_LIBRARY_PATH = composeLdLibraryPath(libsDir, baseEnv.LD_LIBRARY_PATH)
  return env
}

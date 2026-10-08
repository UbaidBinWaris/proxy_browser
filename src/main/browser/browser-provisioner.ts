/**
 * Browser provisioner: locates the browsers directory, reports which engines
 * are available, installs them and remembers where they live.
 *
 * Two kinds of engine are reported (see `BROWSER_ENGINE_KIND`):
 * - bundled (chromium/firefox/webkit): present when Playwright's
 *   `INSTALLATION_COMPLETE` marker exists in the browsers directory; installed
 *   with `playwright-core install` unless the build ships them read-only.
 * - installed (Chrome, Edge, Brave, Opera, Opera GX, Vivaldi, system Chromium):
 *   real vendor browsers found by `engine-detect.ts`. Each reports an
 *   `installMethod` for this machine (install-support.ts): 'vendor-package' /
 *   'portable-archive' (Linux: official package unpacked into
 *   `<userData>/data/installed-browsers/<engine>`, no root), 'winget' (Windows),
 *   'playwright' (Chrome/Edge on macOS: Playwright runs the vendor installer),
 *   'download-page' (vendor site + an install watcher) or 'none'.
 *
 * Paths: after every detection pass and every install the resolved executable is
 * saved into settings as an 'auto' path; paths the user typed are never
 * overwritten while they exist, stale auto paths are pruned (executable-paths.ts).
 *
 * The Playwright CLI is run through the Electron binary with ELECTRON_RUN_AS_NODE
 * so a packaged app needs no separate Node.js. playwright-core is asar-unpacked
 * (see electron-builder.config.mjs), so `app.asar` paths are rewritten to
 * `app.asar.unpacked`. Builds that bundle the browsers
 * (<resources>/playwright-browsers, read-only) report `source: 'bundled'` and
 * `installable: false`; `install()` is refused.
 *
 * Only one install (of any kind) runs at a time; a concurrent request is refused
 * (the background task manager, src/main/tasks, queues installs so this never
 * happens in practice). An install can be cancelled through `signal`; a
 * cancelled Playwright download leaves no half-extracted engine directory.
 *
 * Detection never executes a browser on Windows or macOS (version-probe.ts),
 * caches versions in `<userData>/data/engine-versions.json`, and skips the
 * version read and the path auto-save for an engine whose install task is
 * running (`isEngineBusy`): its files are in flux.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type {
  BrowserEngine,
  BrowserEngineInfo,
  BrowserInstallProgress,
  BrowserWatchUpdate,
  BrowsersStatus,
  BundledBrowserEngine,
  InstallAllResult,
  InstalledBrowserEngine,
} from '@shared/types'
import type { InstallRunOptions } from '../contracts'
import { BROWSER_ENGINES, BROWSER_ENGINE_FAMILY, BROWSER_ENGINE_LABELS, BUNDLED_BROWSER_ENGINES, isAutomaticInstallMethod, isBundledEngine, isInstalledEngine } from '@shared/types'
import { AppException } from '../contracts'
import type { AppPaths, BrowserProvisioner, Logger } from '../contracts'
import { INSTALL_MARKER, bundledEngineVersion, defaultPlaywrightCacheDir, isEngineInstalled, readBrowsersJson, resolveBrowsersDir } from './browsers-path'
import { createEngineDetector, defaultInstallHost, nodeDetectFs } from './engine-detect'
import type { DetectFs, EngineDetector, InstallHost, VersionRunner } from './engine-detect'
import { memoryExecutablePathStore, reconcileExecutablePaths, withAutoSavedPath, withoutPath } from './executable-paths'
import type { ExecutablePathStore } from './executable-paths'
import { downloadUrlFor } from './install-support'
import type { FetchFn } from './installers/download'
import { createInstallWatcher } from './installers/install-watcher'
import type { InstallWatcherOptions } from './installers/install-watcher'
import type { ResolvedPackage } from './installers/linux-sources'
import { INSTALLED_BROWSERS_DIR_NAME, installUserSpace, isInsideManagedInstall, managedInstallDir, uninstallUserSpace } from './installers/linux-user-space'
import { nodeSpawn } from './installers/system-tools'
import type { SpawnFn } from './installers/system-tools'
import { detectTarTools } from './installers/tar-archive'
import type { TarTools } from './installers/tar-archive'
import { probeWinget, runWingetInstall } from './installers/winget'
import { VERSION_CACHE_FILE_NAME, fileVersionCache } from './version-probe'
import type { ExecutablePaths } from './executable-paths'
import type { VersionProbe } from './version-probe'

export { defaultPlaywrightCacheDir } from './browsers-path'

const SCOPE = 'browsers'
const PROGRESS_PATTERN = /(\d{1,3})%/
const TAIL_LINES = 8
/** Persist a progress tick to the log only when it advanced at least this much. */
const PROGRESS_LOG_STEP = 10

export const BUNDLED_INSTALL_MESSAGE = 'Browsers are bundled with this build and cannot be reinstalled.'
export const INSTALL_BUSY_MESSAGE = 'A browser installation is already in progress. Wait for it to finish before starting another.'
export const CANCELLED_MESSAGE = 'The installation was cancelled.'
const INSTALLED_ENGINE_IDS: readonly InstalledBrowserEngine[] = BROWSER_ENGINES.filter(isInstalledEngine)

/** Injectable pieces of the installers (tests serve packages without a network or system tools). */
export interface InstallerDeps {
  fetchImpl?: FetchFn
  /** Spawner for winget. */
  spawn?: SpawnFn
  tarTools?: TarTools
  /** Overrides the `winget --version` probe (Windows). */
  probeWinget?: () => Promise<boolean>
  resolvePackage?: (engine: InstalledBrowserEngine, fetchImpl: FetchFn, signal?: AbortSignal) => Promise<ResolvedPackage>
  watcher?: Pick<InstallWatcherOptions, 'intervalMs' | 'timeoutMs' | 'setTimer' | 'clearTimer' | 'now'>
}

export interface BrowserProvisionerOptions {
  paths: AppPaths
  logger: Logger
  isPackaged: boolean
  /** Electron executable used (with ELECTRON_RUN_AS_NODE) to run the Playwright CLI. */
  execPath: string
  /** `process.resourcesPath`; bundled browsers live in `<resourcesPath>/playwright-browsers`. */
  resourcesPath: string
  /** Saved executable paths + origins (the settings table in production). Defaults to an in-memory store. */
  executablePaths?: ExecutablePathStore
  /** Detector for installed browsers; defaults to a real one over this machine (tests may inject a fake). */
  detector?: EngineDetector
  /** Options for the default detector (ignored when `detector` is given). */
  detection?: { fs?: DetectFs; env?: NodeJS.ProcessEnv; runVersion?: VersionRunner; probeVersion?: VersionProbe }
  /** Host platform / CPU deciding the install method. Default: this process. */
  platform?: NodeJS.Platform
  arch?: string
  installers?: InstallerDeps
  /**
   * Engines with a running install/uninstall task: detection locates them on disk only (no version
   * read) and their saved path is neither auto-saved nor pruned until the task is over.
   */
  isEngineBusy?: (engine: BrowserEngine) => boolean
  /** Persistent version cache file; null disables it. Default: <data>/engine-versions.json. */
  versionCacheFile?: string | null
}

/** Directory-name prefixes Playwright downloads for each bundled install target (`<prefix>-<revision>`). */
const BUNDLED_DOWNLOAD_PREFIXES: Record<BundledBrowserEngine, readonly string[]> = {
  chromium: ['chromium', 'chromium_headless_shell', 'ffmpeg', 'winldd'],
  firefox: ['firefox'],
  webkit: ['webkit'],
}

/**
 * Engine directories under `browsersPath` that a cancelled download left without Playwright's
 * INSTALLATION_COMPLETE marker (only the given targets' prefixes are considered).
 */
export function partialDownloadDirs(entries: readonly string[], targets: readonly BundledBrowserEngine[], hasMarker: (dirName: string) => boolean): string[] {
  const prefixes = new Set(targets.flatMap((target) => BUNDLED_DOWNLOAD_PREFIXES[target]))
  return entries.filter((name) => {
    const match = /^(.+)-\d+$/.exec(name)
    return match?.[1] !== undefined && prefixes.has(match[1]) && !hasMarker(name)
  })
}

function sortedJson(record: Record<string, unknown>): string {
  return JSON.stringify(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
}

function samePaths(a: ExecutablePaths, b: ExecutablePaths): boolean {
  return sortedJson(a.executables) === sortedJson(b.executables) && sortedJson(a.origins) === sortedJson(b.origins)
}

/** Keep the saved paths of busy engines exactly as they are (no auto-save, no prune while installing). */
export function withBusyPathsKept(current: ExecutablePaths, next: ExecutablePaths, busy: readonly InstalledBrowserEngine[]): ExecutablePaths {
  if (busy.length === 0) return next
  const executables = { ...next.executables }
  const origins = { ...next.origins }
  for (const engine of busy) {
    const value = current.executables[engine]
    const origin = current.origins[engine]
    if (value === undefined) delete executables[engine]
    else executables[engine] = value
    if (origin === undefined) delete origins[engine]
    else origins[engine] = origin
  }
  return { executables, origins }
}

const require = createRequire(import.meta.url)

function unpackedPath(filePath: string, isPackaged: boolean): string {
  if (!isPackaged) return filePath
  return filePath.replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked')
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Actionable message for a bundled engine that has not been downloaded yet. */
export function missingBrowserMessage(engine: BundledBrowserEngine): string {
  return `${BROWSER_ENGINE_LABELS[engine]} is not installed. Open Settings → Browsers and click Install, or run npm run browsers:install.`
}

/** `install()` only downloads Playwright's engines; real browsers go through `installEngine()`. */
export function installedEngineInstallMessage(engine: BrowserEngine): string {
  return `${BROWSER_ENGINE_LABELS[engine]} is a vendor browser, not a Playwright download. Install it from Settings → Browsers → Installed browsers, or set its executable path there.`
}

/** `installEngine()` refuses engines without an automatic method on this machine. */
export function engineNotInstallableMessage(engine: BrowserEngine, note: string): string {
  const url = downloadUrlFor(engine)
  return `${BROWSER_ENGINE_LABELS[engine]} cannot be installed automatically on this machine. ${note}${url && !note.includes('package manager') ? ` Download page: ${url}` : ''}`
}

export interface ProgressLineDecision {
  /** Percentage parsed from the line, if it carried one. */
  percent: number | null
  /** Whether this line deserves a persisted INFO log row (phase line, or ≥ PROGRESS_LOG_STEP advance). */
  log: boolean
}

/**
 * Decide whether an installer output line should be logged. Lines without a
 * percentage are phase changes ("Downloading Chromium…", "… downloaded to …")
 * and are always logged; percentage ticks are logged only every ≥10% so the log
 * table is not flooded by the download progress bar.
 */
export function decideProgressLine(line: string, lastLoggedPercent: number | null): ProgressLineDecision {
  const match = PROGRESS_PATTERN.exec(line)
  if (!match?.[1]) return { percent: null, log: true }
  const percent = Math.min(100, Number(match[1]))
  const advanced = lastLoggedPercent === null || percent - lastLoggedPercent >= PROGRESS_LOG_STEP || percent === 100
  return { percent, log: advanced && percent !== lastLoggedPercent }
}

/** Phase of a winget output line for the progress UI. */
export function wingetPhase(line: string, percent: number | null): BrowserInstallProgress['phase'] {
  if (/verif|hash/i.test(line)) return 'verifying'
  if (/install/i.test(line) && percent === null) return 'installing'
  return 'downloading'
}

export function createBrowserProvisioner(opts: BrowserProvisionerOptions): BrowserProvisioner {
  const { paths, logger, isPackaged, execPath, resourcesPath } = opts
  const platform = opts.platform ?? process.platform
  const arch = opts.arch ?? process.arch
  const installers = opts.installers ?? {}
  const fs = opts.detection?.fs ?? nodeDetectFs
  const store = opts.executablePaths ?? memoryExecutablePathStore()
  const managedRoot = path.join(paths.data, INSTALLED_BROWSERS_DIR_NAME)
  const fetchImpl: FetchFn = installers.fetchImpl ?? ((input, init) => fetch(input, init))
  const spawnImpl = installers.spawn ?? nodeSpawn
  const isEngineBusy = opts.isEngineBusy ?? ((): boolean => false)
  const versionCacheFile = opts.versionCacheFile === undefined ? path.join(paths.data, VERSION_CACHE_FILE_NAME) : opts.versionCacheFile

  let hostPromise: Promise<InstallHost> | null = null
  /** Probed once: winget availability only matters on Windows. */
  const getHost = (): Promise<InstallHost> => {
    hostPromise ??= (async (): Promise<InstallHost> => {
      if (platform !== 'win32') return { ...defaultInstallHost(platform), arch }
      const winget = await (installers.probeWinget ?? ((): Promise<boolean> => probeWinget(spawnImpl)))().catch(() => false)
      logger.info(SCOPE, winget ? 'winget is available: browsers install silently' : 'winget is not available: browsers install from their download pages')
      return { platform, arch, winget }
    })()
    return hostPromise
  }

  const detector =
    opts.detector ??
    createEngineDetector({
      getOverrides: () => store.get().executables,
      getOrigins: () => store.get().origins,
      managedRoot,
      getHost,
      platform,
      ...(opts.detection?.env ? { env: opts.detection.env } : {}),
      fs,
      ...(opts.detection?.runVersion ? { runVersion: opts.detection.runVersion } : {}),
      ...(opts.detection?.probeVersion ? { probeVersion: opts.detection.probeVersion } : {}),
      ...(versionCacheFile ? { versionCache: fileVersionCache(versionCacheFile, (err) => logger.warn(SCOPE, `Could not save the browser version cache: ${errorMessage(err)}`)) } : {}),
      isEngineBusy,
    })

  const packageRoot = unpackedPath(path.dirname(require.resolve('playwright-core/package.json')), isPackaged)
  const cliPath = path.join(packageRoot, 'cli.js')
  const playwrightVersion = (JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as { version: string }).version
  const browsersJson = readBrowsersJson(packageRoot)

  /**
   * Same rule as the bootstrap entry (src/main/index.ts), which has already
   * exported PLAYWRIGHT_BROWSERS_PATH before playwright-core was loaded: env →
   * bundled → provisioned (<userData>/data/browsers) → Playwright's dev cache.
   * An env value pointing at the bundled/provisioned directory is reported
   * under that source. Never override an env already set.
   */
  const resolution = resolveBrowsersDir(
    {
      envPath: process.env.PLAYWRIGHT_BROWSERS_PATH,
      resourcesPath,
      userDataBrowsersDir: paths.browsers,
      isPackaged,
      defaultCacheDir: defaultPlaywrightCacheDir(),
      playwrightPackageRoot: packageRoot,
    },
    browsersJson,
  )
  const browsersPath = resolution.dir
  const source = resolution.source
  /** Bundled browsers sit inside the (read-only) app resources; nothing can be installed there. */
  const installable = source !== 'bundled'
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH?.trim()) process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath
  logger.info(SCOPE, `Playwright ${playwrightVersion} browsers directory: ${browsersPath} (${source})`, { isPackaged, source, installable })

  const isInstalled = (engine: BundledBrowserEngine): boolean => isEngineInstalled(browsersPath, engine, browsersJson)

  /** Bundled engines are resolved by Playwright itself, so no executable path is reported for them. */
  const bundledEngineInfo = (engine: BundledBrowserEngine): BrowserEngineInfo => {
    const available = isInstalled(engine)
    return {
      installMethod: 'bundled',
      installNote: installable ? `Playwright ${playwrightVersion} build, downloaded into ${browsersPath}.` : 'Shipped inside this build (read-only).',
      downloadUrl: null,
      managedInstall: false,
      id: engine,
      label: BROWSER_ENGINE_LABELS[engine],
      family: BROWSER_ENGINE_FAMILY[engine],
      kind: 'bundled',
      available,
      executablePath: null,
      version: available ? bundledEngineVersion(engine, browsersJson) : null,
      source: available ? 'bundled' : 'not-found',
      note: available ? `Playwright ${playwrightVersion} build in ${browsersPath}.` : missingBrowserMessage(engine),
    }
  }

  /**
   * Detect, then apply the auto-save rules: newly found executables are remembered as 'auto',
   * stale 'auto' paths are pruned. When the saved paths change the detector cache misses
   * (its key includes them) and one more scan reports the final sources.
   */
  const detectAndRemember = async (): Promise<BrowserEngineInfo[]> => {
    const detected = await detector.detect()
    const current = store.get()
    const reconciled = reconcileExecutablePaths(current, detected, (filePath) => fs.isFile(filePath))
    if (!reconciled.changed) return detected
    // An engine being installed keeps its saved path untouched until its task is over.
    const busy = INSTALLED_ENGINE_IDS.filter((engine) => isEngineBusy(engine))
    const next = withBusyPathsKept(current, reconciled.next, busy)
    const saved = reconciled.saved.filter((engine) => !busy.includes(engine))
    const pruned = reconciled.pruned.filter((engine) => !busy.includes(engine))
    if (samePaths(next, current)) return detected
    try {
      store.set(next)
    } catch (err) {
      logger.warn(SCOPE, `Could not save browser executable paths: ${errorMessage(err)}`)
      return detected
    }
    for (const engine of pruned) logger.info(SCOPE, `Dropped the saved ${BROWSER_ENGINE_LABELS[engine]} path: the file no longer exists`, { engine })
    for (const engine of saved) logger.info(SCOPE, `Saved the ${BROWSER_ENGINE_LABELS[engine]} path automatically: ${next.executables[engine] ?? '?'}`, { engine })
    return detector.detect()
  }

  const engines = async (): Promise<BrowserEngineInfo[]> => {
    const detected = await detectAndRemember()
    const byId = new Map(detected.map((info) => [info.id, info]))
    const result: BrowserEngineInfo[] = []
    for (const engine of BROWSER_ENGINES) {
      if (isBundledEngine(engine)) {
        result.push(bundledEngineInfo(engine))
        continue
      }
      const info = byId.get(engine)
      if (info) result.push(info)
    }
    return result
  }

  const redetect = async (): Promise<BrowserEngineInfo[]> => {
    detector.invalidate()
    const result = await engines()
    const found = result.filter((info) => info.kind === 'installed' && info.available)
    logger.info(SCOPE, `Re-detected installed browsers: ${found.length === 0 ? 'none found' : found.map((info) => `${info.label} → ${info.executablePath ?? '?'}`).join('; ')}`, {
      available: found.map((info) => info.id),
    })
    return result
  }

  const resolveEngine = async (engine: BrowserEngine): Promise<BrowserEngineInfo> => {
    if (isBundledEngine(engine)) {
      const info = bundledEngineInfo(engine)
      if (!info.available) throw new AppException('BROWSER_MISSING', missingBrowserMessage(engine), `Expected under ${browsersPath}`)
      return info
    }
    const info = await detector.detectEngine(engine)
    if (!info.available || !info.executablePath) {
      throw new AppException('BROWSER_MISSING', `${info.label}: ${info.note}`)
    }
    return info
  }

  const status = async (): Promise<BrowsersStatus> => ({
    browsersPath,
    chromium: isInstalled('chromium'),
    firefox: isInstalled('firefox'),
    webkit: isInstalled('webkit'),
    playwrightVersion,
    source,
    installable,
    engines: await engines(),
  })

  /** A cancelled Playwright download: remove engine directories that never got their completion marker. */
  const removePartialDownloads = (targets: readonly BundledBrowserEngine[]): void => {
    let entries: string[]
    try {
      entries = readdirSync(browsersPath)
    } catch {
      return
    }
    for (const dir of partialDownloadDirs(entries, targets, (name) => existsSync(path.join(browsersPath, name, INSTALL_MARKER)))) {
      try {
        rmSync(path.join(browsersPath, dir), { recursive: true, force: true })
        logger.info(SCOPE, `Removed the partial download ${dir} after cancelling`, { dir })
      } catch (err) {
        logger.warn(SCOPE, `Could not remove the partial download ${dir}: ${errorMessage(err)}`)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Install lock
  // -------------------------------------------------------------------------

  let activeInstall: Promise<unknown> | null = null
  let activeAbort: AbortController | null = null

  const exclusive = <T>(run: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> => {
    if (activeInstall) return Promise.reject(new AppException('INTERNAL', INSTALL_BUSY_MESSAGE))
    if (external?.aborted) return Promise.reject(new AppException('INTERNAL', CANCELLED_MESSAGE))
    const controller = new AbortController()
    external?.addEventListener('abort', () => controller.abort(), { once: true })
    activeAbort = controller
    const running = run(controller.signal).finally(() => {
      activeInstall = null
      activeAbort = null
    })
    activeInstall = running
    return running
  }

  // -------------------------------------------------------------------------
  // Playwright CLI (bundled engines, Chrome/Edge on macOS)
  // -------------------------------------------------------------------------

  /** Spawn `cli.js install <targets>` and stream its output. */
  const runPlaywrightInstaller = (
    engine: BrowserInstallProgress['engine'],
    targets: readonly string[],
    onProgress: (p: BrowserInstallProgress) => void,
    signal: AbortSignal,
    onChildProcess?: (pid: number) => void,
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const label = targets.join(', ')
      const args = [cliPath, 'install', ...targets]
      const tail: string[] = []
      let lastPercent: number | null = null
      let lastLoggedPercent: number | null = null

      logger.info(SCOPE, `Installing ${label} (browsers directory ${browsersPath})`, { execPath, cliPath, targets })
      onProgress({ engine, phase: 'starting', message: `Installing ${label}…`, percent: null })

      const child = spawn(execPath, args, {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          PLAYWRIGHT_BROWSERS_PATH: browsersPath,
          PLAYWRIGHT_DOWNLOAD_NO_PROGRESS: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      if (child.pid !== undefined) onChildProcess?.(child.pid)
      const abort = (): void => {
        child.kill()
      }
      signal.addEventListener('abort', abort, { once: true })

      const handleLine = (rawLine: string): void => {
        const line = rawLine.replace(/\r/g, '').trim()
        if (!line) return
        tail.push(line)
        if (tail.length > TAIL_LINES) tail.shift()
        const decision = decideProgressLine(line, lastLoggedPercent)
        if (decision.percent !== null) lastPercent = decision.percent
        if (decision.log) {
          // Phase lines always; percentage ticks only every ≥10% (the UI still gets every tick below).
          if (decision.percent !== null) lastLoggedPercent = decision.percent
          logger.info(SCOPE, line)
        }
        onProgress({ engine, phase: 'downloading', message: line, percent: lastPercent })
      }

      const attachLineReader = (stream: NodeJS.ReadableStream): void => {
        let buffer = ''
        stream.setEncoding('utf8')
        stream.on('data', (chunk: string) => {
          buffer += chunk
          // Progress bars rewrite the line with \r, so treat it as a delimiter too.
          const parts = buffer.split(/\r?\n|\r/)
          buffer = parts.pop() ?? ''
          parts.forEach(handleLine)
        })
        stream.on('end', () => {
          if (buffer) handleLine(buffer)
        })
      }

      if (child.stdout) attachLineReader(child.stdout)
      if (child.stderr) attachLineReader(child.stderr)

      child.on('error', (err) => {
        signal.removeEventListener('abort', abort)
        logger.error(SCOPE, `Could not start the Playwright installer: ${err.message}`, { execPath })
        onProgress({ engine, phase: 'error', message: err.message, percent: null })
        reject(new AppException('INTERNAL', 'Could not start the browser installer. Check that the application files are intact and try again.', err.message))
      })

      child.on('close', (code, closeSignal) => {
        signal.removeEventListener('abort', abort)
        if (code === 0) {
          logger.info(SCOPE, `Installed ${label}`)
          onProgress({ engine, phase: 'done', message: `Installed ${label}`, percent: 100 })
          resolve()
          return
        }
        if (signal.aborted) {
          logger.info(SCOPE, `Cancelled installing ${label}`)
          onProgress({ engine, phase: 'error', message: CANCELLED_MESSAGE, percent: null })
          reject(new AppException('INTERNAL', CANCELLED_MESSAGE))
          return
        }
        const detail = tail.join('\n')
        const reason = closeSignal ? `was terminated by ${closeSignal}` : `exited with code ${String(code)}`
        logger.error(SCOPE, `Browser installer ${reason}`, { detail })
        onProgress({ engine, phase: 'error', message: tail[tail.length - 1] ?? `Installer ${reason}`, percent: null })
        reject(new AppException('BROWSER_MISSING', `Browser installation failed (installer ${reason}). Check your internet connection and disk space, then try again.`, detail))
      })
    })

  // -------------------------------------------------------------------------
  // Installed-kind engines
  // -------------------------------------------------------------------------

  const remember = (engine: InstalledBrowserEngine, executablePath: string): void => {
    const current = store.get()
    const next = withAutoSavedPath(current, engine, executablePath, (filePath) => fs.isFile(filePath))
    if (next !== current) store.set(next)
  }

  /** The install itself, without the lock (installAllMissing holds it for the whole batch). */
  const installOne = async (engine: InstalledBrowserEngine, onProgress: (p: BrowserInstallProgress) => void, signal: AbortSignal, onChildProcess?: (pid: number) => void): Promise<BrowserEngineInfo> => {
    detector.invalidate()
    const before = await detector.detectEngine(engine)
    const label = BROWSER_ENGINE_LABELS[engine]
    const method = before.installMethod
    const started = Date.now()
    logger.info(SCOPE, `Installing ${label} (method ${method})`, { engine, method })
    try {
      switch (method) {
        case 'vendor-package':
        case 'portable-archive': {
          const result = await installUserSpace({
            engine,
            rootDir: managedRoot,
            fetchImpl,
            tools: installers.tarTools ?? detectTarTools(),
            signal,
            onProgress: (p) => onProgress({ engine, ...p }),
            ...(installers.resolvePackage ? { resolvePackage: installers.resolvePackage } : {}),
          })
          remember(engine, result.executablePath)
          logger.info(SCOPE, `Installed ${label}${result.version ? ` ${result.version}` : ''} into ${result.installDir} in ${Math.round((Date.now() - started) / 1000)} s`, {
            engine,
            executablePath: result.executablePath,
            bytes: result.bytes,
          })
          break
        }
        case 'winget': {
          onProgress({ engine, phase: 'starting', message: `Installing ${label} with winget…`, percent: null })
          let lastPercent: number | null = null
          await runWingetInstall(engine, {
            spawn: spawnImpl,
            signal,
            ...(onChildProcess ? { onSpawn: onChildProcess } : {}),
            onLine: (line, percent) => {
              if (percent !== null) lastPercent = percent
              if (percent === null) logger.info(SCOPE, `winget: ${line}`)
              onProgress({ engine, phase: wingetPhase(line, percent), message: line, percent: percent ?? lastPercent })
            },
          })
          break
        }
        case 'playwright':
          await runPlaywrightInstaller(engine, [engine], onProgress, signal, onChildProcess)
          break
        default:
          throw new AppException('INVALID_INPUT', engineNotInstallableMessage(engine, before.installNote), `installMethod=${method}`)
      }
    } catch (err) {
      if (err instanceof AppException && err.code === 'INVALID_INPUT') throw err
      const message = errorMessage(err)
      logger.error(SCOPE, `Installing ${label} failed: ${message}`, { engine, method })
      onProgress({ engine, phase: 'error', message, percent: null })
      if (err instanceof AppException) throw err
      throw new AppException('BROWSER_MISSING', `Could not install ${label}: ${message}`, message)
    }

    onProgress({ engine, phase: 'verifying', message: `Looking for ${label} on this machine…`, percent: null })
    detector.invalidate()
    const all = await engines()
    const info = all.find((candidate) => candidate.id === engine)
    if (!info?.available) {
      const message = `The installer finished but ${label} was not found. ${info?.note ?? ''}`.trim()
      onProgress({ engine, phase: 'error', message, percent: null })
      throw new AppException('BROWSER_MISSING', message)
    }
    onProgress({ engine, phase: 'done', message: `Installed ${label}${info.version ? ` ${info.version}` : ''} → ${info.executablePath ?? ''}`, percent: 100 })
    return info
  }

  // -------------------------------------------------------------------------
  // Install watcher (download-page installs)
  // -------------------------------------------------------------------------

  const watchListeners = new Set<(update: BrowserWatchUpdate) => void>()
  const emitWatch = (update: BrowserWatchUpdate): void => {
    for (const listener of watchListeners) {
      try {
        listener(update)
      } catch (err) {
        logger.warn(SCOPE, `Browser watch listener failed: ${errorMessage(err)}`)
      }
    }
  }
  const watcher = createInstallWatcher({
    ...installers.watcher,
    probe: (engine) => detector.locate(engine).executablePath !== null,
    onFound: async (engine) => {
      detector.invalidate()
      const info = (await engines()).find((candidate) => candidate.id === engine) ?? null
      logger.info(SCOPE, `${BROWSER_ENGINE_LABELS[engine]} was installed: ${info?.executablePath ?? '?'}`, { engine })
      emitWatch({ engine, state: 'found', info })
    },
    onEnd: (engine, reason) => {
      if (reason === 'found') return
      if (reason === 'expired') logger.info(SCOPE, `Stopped waiting for ${BROWSER_ENGINE_LABELS[engine]} to be installed`, { engine })
      emitWatch({ engine, state: reason, info: null })
    },
  })

  return {
    browsersPath: () => browsersPath,
    status,
    engines,
    redetect,
    resolveEngine,

    install(engine, onProgress, options: InstallRunOptions = {}): Promise<BrowsersStatus> {
      if (engine !== 'all' && !isBundledEngine(engine)) {
        return Promise.reject(new AppException('INVALID_INPUT', installedEngineInstallMessage(engine)))
      }
      if (!installable) {
        return Promise.reject(new AppException('INVALID_INPUT', BUNDLED_INSTALL_MESSAGE, `Browsers directory ${browsersPath} is read-only (${source})`))
      }
      const targets: BundledBrowserEngine[] = engine === 'all' ? [...BUNDLED_BROWSER_ENGINES] : [engine]
      return exclusive(async (signal) => {
        try {
          await runPlaywrightInstaller(engine, targets, onProgress, signal, options.onChildProcess)
        } catch (err) {
          if (signal.aborted) removePartialDownloads(targets)
          throw err
        }
        return status()
      }, options.signal)
    },

    installEngine(engine, onProgress, options: InstallRunOptions = {}): Promise<BrowsersStatus> {
      if (!isInstalledEngine(engine)) {
        return Promise.reject(new AppException('INVALID_INPUT', `${BROWSER_ENGINE_LABELS[engine]} is a Playwright engine; use the bundled browsers installer.`))
      }
      return exclusive(async (signal) => {
        watcher.cancel(engine)
        await installOne(engine, onProgress, signal, options.onChildProcess)
        return status()
      }, options.signal)
    },

    async uninstallEngine(engine): Promise<BrowsersStatus> {
      if (!isInstalledEngine(engine)) throw new AppException('INVALID_INPUT', `${BROWSER_ENGINE_LABELS[engine]} is a Playwright engine and cannot be uninstalled here.`)
      if (activeInstall) throw new AppException('INTERNAL', INSTALL_BUSY_MESSAGE)
      const dir = managedInstallDir(managedRoot, engine)
      if (!existsSync(dir)) {
        throw new AppException('INVALID_INPUT', `${BROWSER_ENGINE_LABELS[engine]} was not installed by this app, so it cannot be uninstalled here. Remove it with your system's tools.`)
      }
      uninstallUserSpace(managedRoot, engine)
      const saved = store.get().executables[engine]
      if (saved && isInsideManagedInstall(managedRoot, engine, saved)) store.set(withoutPath(store.get(), engine))
      logger.info(SCOPE, `Uninstalled ${BROWSER_ENGINE_LABELS[engine]} from ${dir}`, { engine })
      detector.invalidate()
      return status()
    },

    installAllMissing(onProgress): Promise<InstallAllResult> {
      return exclusive(async (signal) => {
        detector.invalidate()
        const targets = (await engines()).filter((info) => isInstalledEngine(info.id) && !info.available && isAutomaticInstallMethod(info.installMethod)).map((info) => info.id as InstalledBrowserEngine)
        const installed: InstalledBrowserEngine[] = []
        const failed: InstallAllResult['failed'] = []
        logger.info(SCOPE, targets.length === 0 ? 'Install all missing: nothing to install' : `Install all missing: ${targets.join(', ')}`, { targets })
        for (const [index, engine] of targets.entries()) {
          if (signal.aborted) break
          const batch = { index: index + 1, total: targets.length }
          try {
            watcher.cancel(engine)
            await installOne(engine, (progress) => onProgress({ ...progress, batch }), signal)
            installed.push(engine)
          } catch (err) {
            failed.push({ engine, message: err instanceof AppException ? err.message : errorMessage(err) })
          }
        }
        return { status: await status(), installed, failed }
      })
    },

    watchForInstall(engine): void {
      if (!isInstalledEngine(engine)) return
      if (detector.locate(engine).executablePath !== null) return
      watcher.start(engine)
      logger.info(SCOPE, `Waiting for ${BROWSER_ENGINE_LABELS[engine]} to be installed (checking every few seconds)`, { engine })
      emitWatch({ engine, state: 'watching', info: null })
    },

    onWatchUpdate(listener) {
      watchListeners.add(listener)
      return () => {
        watchListeners.delete(listener)
      }
    },

    dispose(): void {
      watcher.cancelAll()
      activeAbort?.abort()
    },

    async assertInstalled(engine: BrowserEngine): Promise<void> {
      await resolveEngine(engine)
    },

    downloadUrl(engine): string | null {
      return downloadUrlFor(engine)
    },
  }
}

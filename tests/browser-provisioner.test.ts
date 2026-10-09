import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserEngineInfo, BrowserExecutableOverrides, BundledBrowserEngine, LogEntry } from '../src/shared/types'
import { BROWSER_ENGINES, BUNDLED_BROWSER_ENGINES, INSTALLED_BROWSER_ENGINES } from '../src/shared/types'
import { AppException } from '../src/main/contracts'
import type { AppPaths, Logger } from '../src/main/contracts'
import {
  BUNDLED_INSTALL_MESSAGE,
  createBrowserProvisioner,
  decideProgressLine,
  defaultPlaywrightCacheDir,
  engineNotInstallableMessage,
  installedEngineInstallMessage,
  partialDownloadDirs,
  withBusyPathsKept,
} from '../src/main/browser/browser-provisioner'
import { memoryExecutablePathStore } from '../src/main/browser/executable-paths'
import { SYSTEM_CHROMIUM_LINUX_NOTE, installMethodFor, isAllowedDownloadUrl } from '../src/main/browser/install-support'
import { BUNDLED_BROWSERS_DIR_NAME } from '../src/main/browser/browsers-path'
import { NOT_FOUND_NOTE, SETTINGS_NOTE, createEngineDetector } from '../src/main/browser/engine-detect'
import type { DetectFs } from '../src/main/browser/engine-detect'

interface BrowsersJsonFile {
  browsers: Array<{ name: string; revision: string; browserVersion?: string }>
}

function browsersJsonEntry(engine: BundledBrowserEngine): { revision: string; browserVersion?: string } {
  const json = JSON.parse(readFileSync(path.join(process.cwd(), 'node_modules', 'playwright-core', 'browsers.json'), 'utf8')) as BrowsersJsonFile
  const entry = json.browsers.find((b) => b.name === engine)
  if (!entry) throw new Error(`browsers.json has no ${engine}`)
  return entry
}

function realRevision(engine: BundledBrowserEngine): string {
  return browsersJsonEntry(engine).revision
}

function markInstalled(dir: string, engine: BundledBrowserEngine): void {
  const engineDir = path.join(dir, `${engine}-${realRevision(engine)}`)
  mkdirSync(engineDir, { recursive: true })
  writeFileSync(path.join(engineDir, 'INSTALLATION_COMPLETE'), '')
}

/** A Linux machine where only the system Chromium exists (plus whatever `extraFiles` adds). */
function fakeDetector(extraFiles: string[] = [], overrides: () => BrowserExecutableOverrides = () => ({})): ReturnType<typeof createEngineDetector> {
  const files = new Set(['/usr/bin/chromium', ...extraFiles])
  const fs: DetectFs = { isFile: (p) => files.has(p) }
  return createEngineDetector({
    getOverrides: overrides,
    platform: 'linux',
    env: { PATH: '/usr/local/bin:/usr/bin' },
    fs,
    runVersion: async (exe) => (exe === '/usr/bin/chromium' ? 'Chromium 153.0.8010.52 Arch Linux' : null),
  })
}

function fakeLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    log: () => undefined,
    onEntry: () => () => undefined,
    query: (): LogEntry[] => [],
    clear: () => undefined,
    registerSecret: () => undefined,
  }
}

function fakePaths(root: string): AppPaths {
  return {
    userData: root,
    data: path.join(root, 'data'),
    screenshots: path.join(root, 'data', 'screenshots'),
    browsers: path.join(root, 'data', 'browsers'),
    database: path.join(root, 'data', 'proxy-qa.sqlite'),
    logs: path.join(root, 'data', 'logs'),
    vault: path.join(root, 'vault'),
    keys: path.join(root, 'keys'),
  }
}

describe('createBrowserProvisioner', () => {
  let root: string
  let resourcesPath: string
  const originalEnv = process.env.PLAYWRIGHT_BROWSERS_PATH

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'proxy-qa-prov-'))
    resourcesPath = path.join(root, 'resources')
    mkdirSync(resourcesPath, { recursive: true })
    delete process.env.PLAYWRIGHT_BROWSERS_PATH
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    if (originalEnv === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH
    else process.env.PLAYWRIGHT_BROWSERS_PATH = originalEnv
  })

  it('uses the app data browsers dir when packaged and exports PLAYWRIGHT_BROWSERS_PATH', async () => {
    const paths = fakePaths(root)
    const provisioner = createBrowserProvisioner({ paths, logger: fakeLogger(), isPackaged: true, execPath: process.execPath, resourcesPath })
    expect(provisioner.browsersPath()).toBe(paths.browsers)
    expect(process.env.PLAYWRIGHT_BROWSERS_PATH).toBe(paths.browsers)
    const status = await provisioner.status()
    expect(status).toMatchObject({ browsersPath: paths.browsers, chromium: false, firefox: false, webkit: false, source: 'provisioned', installable: true })
    expect(status.playwrightVersion).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('prefers PLAYWRIGHT_BROWSERS_PATH from the environment and never overrides it', async () => {
    const custom = path.join(root, 'custom-browsers')
    process.env.PLAYWRIGHT_BROWSERS_PATH = custom
    const provisioner = createBrowserProvisioner({ paths: fakePaths(root), logger: fakeLogger(), isPackaged: true, execPath: process.execPath, resourcesPath })
    expect(provisioner.browsersPath()).toBe(custom)
    expect(process.env.PLAYWRIGHT_BROWSERS_PATH).toBe(custom)
    expect(await provisioner.status()).toMatchObject({ source: 'env', installable: true })
  })

  it('falls back to the Playwright default cache in development', async () => {
    const provisioner = createBrowserProvisioner({ paths: fakePaths(root), logger: fakeLogger(), isPackaged: false, execPath: process.execPath, resourcesPath })
    expect(provisioner.browsersPath()).toBe(defaultPlaywrightCacheDir())
    expect(provisioner.browsersPath()).toContain('ms-playwright')
    expect((await provisioner.status()).source).toBe('dev-cache')
  })

  it('detects an installed engine via the INSTALLATION_COMPLETE marker', async () => {
    const paths = fakePaths(root)
    markInstalled(paths.browsers, 'chromium')

    const provisioner = createBrowserProvisioner({ paths, logger: fakeLogger(), isPackaged: true, execPath: process.execPath, resourcesPath })
    const status = await provisioner.status()
    expect(status.chromium).toBe(true)
    expect(status.firefox).toBe(false)
    await expect(provisioner.assertInstalled('chromium')).resolves.toBeUndefined()
  })

  it('reports bundled, read-only browsers and refuses install() when all three engines ship with the build', async () => {
    const paths = fakePaths(root)
    const bundledDir = path.join(resourcesPath, BUNDLED_BROWSERS_DIR_NAME)
    for (const engine of BUNDLED_BROWSER_ENGINES) markInstalled(bundledDir, engine)

    const provisioner = createBrowserProvisioner({ paths, logger: fakeLogger(), isPackaged: true, execPath: process.execPath, resourcesPath })
    expect(provisioner.browsersPath()).toBe(bundledDir)
    // The bootstrap exports the same directory; the provisioner must not treat it as a user override.
    expect(process.env.PLAYWRIGHT_BROWSERS_PATH).toBe(bundledDir)
    const status = await provisioner.status()
    expect(status).toMatchObject({ browsersPath: bundledDir, chromium: true, firefox: true, webkit: true, source: 'bundled', installable: false })
    await expect(provisioner.assertInstalled('webkit')).resolves.toBeUndefined()
    await expect(provisioner.install('all', () => undefined)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AppException)
      expect((err as AppException).code).toBe('INVALID_INPUT')
      expect((err as AppException).message).toBe(BUNDLED_INSTALL_MESSAGE)
      return true
    })

    // Same answer when the env var already points at the bundle (as after the bootstrap ran).
    process.env.PLAYWRIGHT_BROWSERS_PATH = bundledDir
    const again = createBrowserProvisioner({ paths, logger: fakeLogger(), isPackaged: true, execPath: process.execPath, resourcesPath })
    expect((await again.status()).source).toBe('bundled')
  })

  it('ignores a partial bundle and provisions into the app data dir instead', async () => {
    const paths = fakePaths(root)
    const bundledDir = path.join(resourcesPath, BUNDLED_BROWSERS_DIR_NAME)
    markInstalled(bundledDir, 'chromium')
    markInstalled(bundledDir, 'firefox')

    const provisioner = createBrowserProvisioner({ paths, logger: fakeLogger(), isPackaged: true, execPath: process.execPath, resourcesPath })
    expect(provisioner.browsersPath()).toBe(paths.browsers)
    expect(await provisioner.status()).toMatchObject({ chromium: false, source: 'provisioned', installable: true })
  })

  it('logs phase lines always and percentage ticks only every >=10%', () => {
    const lines = [
      'Downloading Chromium 131.0.6778.33 (playwright build v1243) from https://cdn.playwright.dev/…',
      '|                                |   0% of 165.5 MiB',
      '|■                               |   3% of 165.5 MiB',
      '|■■                              |   7% of 165.5 MiB',
      '|■■■                             |  10% of 165.5 MiB',
      '|■■■■                            |  14% of 165.5 MiB',
      '|■■■■■■                          |  19% of 165.5 MiB',
      '|■■■■■■■                         |  20% of 165.5 MiB',
      '|■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■|  99% of 165.5 MiB',
      '|■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■| 100% of 165.5 MiB',
      '|■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■| 100% of 165.5 MiB',
      'Chromium 131.0.6778.33 (playwright build v1243) downloaded to /x/chromium-1243',
    ]
    const logged: string[] = []
    let lastLogged: number | null = null
    for (const line of lines) {
      const decision = decideProgressLine(line, lastLogged)
      if (decision.log) {
        logged.push(line)
        if (decision.percent !== null) lastLogged = decision.percent
      }
    }
    // Phase lines, 0%, 10%, 20%, the 20→99% jump, the first 100%, phase line; the 3/7/14/19% ticks and the repeated 100% are dropped.
    expect(logged).toEqual([lines[0], lines[1], lines[4], lines[7], lines[8], lines[9], lines[11]])
    expect(decideProgressLine('|  5% of 1 MiB', 0)).toEqual({ percent: 5, log: false })
    expect(decideProgressLine('|  10% of 1 MiB', 0)).toEqual({ percent: 10, log: true })
    expect(decideProgressLine('|  250% bogus', null)).toEqual({ percent: 100, log: true })
  })

  it('assertInstalled throws BROWSER_MISSING with an actionable message', async () => {
    const provisioner = createBrowserProvisioner({ paths: fakePaths(root), logger: fakeLogger(), isPackaged: true, execPath: process.execPath, resourcesPath })
    await expect(provisioner.assertInstalled('firefox')).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AppException)
      const e = err as AppException
      expect(e.code).toBe('BROWSER_MISSING')
      expect(e.message).toContain('Firefox')
      expect(e.message).toContain('npm run browsers:install')
      return true
    })
  })

  // --- Installed browsers ------------------------------------------------------

  it('status().engines lists every engine in BROWSER_ENGINES order: bundled markers + detected installed browsers', async () => {
    const paths = fakePaths(root)
    markInstalled(paths.browsers, 'chromium')
    const provisioner = createBrowserProvisioner({ paths, logger: fakeLogger(), isPackaged: true, execPath: process.execPath, resourcesPath, detector: fakeDetector() })
    const status = await provisioner.status()
    expect(status.engines.map((e) => e.id)).toEqual([...BROWSER_ENGINES])
    expect(status.engines).toHaveLength(10)

    const chromium = status.engines.find((e) => e.id === 'chromium')
    expect(chromium).toMatchObject({ kind: 'bundled', family: 'chromium', available: true, executablePath: null, source: 'bundled', version: browsersJsonEntry('chromium').browserVersion ?? null })
    expect(chromium?.note).toContain(paths.browsers)
    expect(status.engines.find((e) => e.id === 'firefox')).toMatchObject({ kind: 'bundled', available: false, source: 'not-found', version: null })
    expect(status.engines.find((e) => e.id === 'firefox')?.note).toContain('npm run browsers:install')

    expect(status.engines.find((e) => e.id === 'system-chromium')).toEqual({
      id: 'system-chromium',
      label: 'Chromium (system install)',
      family: 'chromium',
      kind: 'installed',
      available: true,
      executablePath: '/usr/bin/chromium',
      version: '153.0.8010.52',
      source: 'detected',
      note: 'Detected automatically on this machine.',
      installMethod: 'download-page',
      installNote: SYSTEM_CHROMIUM_LINUX_NOTE,
      downloadUrl: 'https://www.chromium.org/getting-involved/download-chromium/',
      managedInstall: false,
    })
    expect(chromium).toMatchObject({ installMethod: 'bundled', downloadUrl: null, managedInstall: false })
    for (const engine of INSTALLED_BROWSER_ENGINES.filter((e) => e !== 'system-chromium')) {
      expect(status.engines.find((e) => e.id === engine), engine).toMatchObject({ kind: 'installed', available: false, executablePath: null, version: null, source: 'not-found', note: NOT_FOUND_NOTE })
    }
    expect(await provisioner.engines()).toEqual(status.engines)
  })

  it('resolveEngine/assertInstalled accept detected installed browsers and reject missing ones with the detection note', async () => {
    const provisioner = createBrowserProvisioner({ paths: fakePaths(root), logger: fakeLogger(), isPackaged: true, execPath: process.execPath, resourcesPath, detector: fakeDetector() })
    await expect(provisioner.resolveEngine('system-chromium')).resolves.toMatchObject({ available: true, executablePath: '/usr/bin/chromium' })
    await expect(provisioner.assertInstalled('system-chromium')).resolves.toBeUndefined()
    for (const engine of ['opera', 'opera-gx', 'brave', 'vivaldi', 'chrome', 'msedge'] as const) {
      await expect(provisioner.assertInstalled(engine)).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(AppException)
        const e = err as AppException
        expect(e.code).toBe('BROWSER_MISSING')
        expect(e.message).toContain('(installed): ')
        expect(e.message.endsWith(`: ${NOT_FOUND_NOTE}`)).toBe(true)
        return true
      })
    }
    await expect(provisioner.assertInstalled('opera')).rejects.toMatchObject({ message: `Opera (installed): ${NOT_FOUND_NOTE}` })
  })

  it('a settings override makes an installed browser available (source "settings") and redetect() picks changes up', async () => {
    const overrides: { current: BrowserExecutableOverrides } = { current: {} }
    const logger = fakeLogger()
    const infoLines: string[] = []
    logger.info = (_scope, message): void => void infoLines.push(message)
    const provisioner = createBrowserProvisioner({
      paths: fakePaths(root),
      logger,
      isPackaged: true,
      execPath: process.execPath,
      resourcesPath,
      detector: fakeDetector([], () => overrides.current),
    })
    expect((await provisioner.engines()).find((e) => e.id === 'opera')?.available).toBe(false)

    overrides.current = { opera: '/usr/bin/chromium' }
    const after = await provisioner.redetect()
    const opera = after.find((e) => e.id === 'opera')
    expect(opera).toMatchObject({ available: true, executablePath: '/usr/bin/chromium', source: 'settings', note: SETTINGS_NOTE, version: '153.0.8010.52' })
    await expect(provisioner.resolveEngine('opera')).resolves.toMatchObject({ executablePath: '/usr/bin/chromium' })
    expect(infoLines.some((line) => line.includes('Re-detected installed browsers') && line.includes('Opera (installed) → /usr/bin/chromium'))).toBe(true)

    // An override pointing nowhere is ignored and explained.
    overrides.current = { opera: '/nope/opera' }
    const broken = (await provisioner.redetect()).find((e) => e.id === 'opera')
    expect(broken).toMatchObject({ available: false, source: 'not-found' })
    expect(broken?.note).toContain('/nope/opera')
    expect(broken?.note).toContain(NOT_FOUND_NOTE)

    overrides.current = {}
    expect((await provisioner.redetect()).find((e) => e.id === 'opera')).toMatchObject({ available: false, source: 'not-found', note: NOT_FOUND_NOTE })
  })

  it('install() refuses installed browsers: they come from their vendor, not from Playwright', async () => {
    const provisioner = createBrowserProvisioner({ paths: fakePaths(root), logger: fakeLogger(), isPackaged: true, execPath: process.execPath, resourcesPath, detector: fakeDetector() })
    await expect(provisioner.install('opera' as never, () => undefined)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AppException)
      expect((err as AppException).code).toBe('INVALID_INPUT')
      expect((err as AppException).message).toBe(installedEngineInstallMessage('opera'))
      return true
    })
    expect(installedEngineInstallMessage('brave')).toContain('Brave (installed)')
    expect(installedEngineInstallMessage('brave')).toContain('Settings → Browsers')
  })

  it('engine records are serialisable and never carry anything but paths, versions and notes', async () => {
    const provisioner = createBrowserProvisioner({ paths: fakePaths(root), logger: fakeLogger(), isPackaged: true, execPath: process.execPath, resourcesPath, detector: fakeDetector(['/opt/brave.com/brave/brave']) })
    const engines: BrowserEngineInfo[] = JSON.parse(JSON.stringify(await provisioner.engines())) as BrowserEngineInfo[]
    for (const info of engines) {
      expect(Object.keys(info).sort()).toEqual(['available', 'downloadUrl', 'executablePath', 'family', 'id', 'installMethod', 'installNote', 'kind', 'label', 'managedInstall', 'note', 'source', 'version'])
    }
    expect(engines.find((e) => e.id === 'brave')).toMatchObject({ available: true, executablePath: '/opt/brave.com/brave/brave', version: null, source: 'detected' })
  })

  // --- Vendor installs ---------------------------------------------------------

  it('downloadUrl() maps every installed-kind engine to its vendor page and bundled engines to null', () => {
    const provisioner = createBrowserProvisioner({ paths: fakePaths(root), logger: fakeLogger(), isPackaged: true, execPath: process.execPath, resourcesPath, detector: fakeDetector() })
    expect(provisioner.downloadUrl('opera')).toBe('https://www.opera.com/download')
    expect(provisioner.downloadUrl('opera-gx')).toBe('https://www.opera.com/gx')
    expect(provisioner.downloadUrl('brave')).toBe('https://brave.com/download/')
    expect(provisioner.downloadUrl('vivaldi')).toBe('https://vivaldi.com/download/')
    expect(provisioner.downloadUrl('chrome')).toBe('https://www.google.com/chrome/')
    expect(provisioner.downloadUrl('msedge')).toBe('https://www.microsoft.com/edge/download')
    expect(provisioner.downloadUrl('system-chromium')).toBe('https://www.chromium.org/getting-involved/download-chromium/')
    for (const engine of BUNDLED_BROWSER_ENGINES) expect(provisioner.downloadUrl(engine)).toBeNull()
    const win = { platform: 'win32' as const, arch: 'x64', winget: true }
    expect(installMethodFor('chrome', win).method).toBe('winget')
    expect(installMethodFor('brave', { ...win, winget: false }).method).toBe('download-page')
    expect(installMethodFor('msedge', { platform: 'darwin', arch: 'arm64', winget: false }).method).toBe('download-page')
    expect(installMethodFor('chrome', { platform: 'linux', arch: 'x64', winget: false }).method).toBe('vendor-package')
    expect(installMethodFor('chromium', win).method).toBe('bundled')
    expect(isAllowedDownloadUrl('https://brave.com/download/')).toBe(true)
    expect(isAllowedDownloadUrl('https://evil.example/')).toBe(false)
  })

  it('installEngine() refuses bundled engines and engines without an automatic method on this host', async () => {
    const linux = createBrowserProvisioner({ paths: fakePaths(root), logger: fakeLogger(), isPackaged: true, execPath: process.execPath, resourcesPath, detector: fakeDetector(), platform: 'linux', arch: 'x64' })
    await expect(linux.installEngine('chromium', () => undefined)).rejects.toMatchObject({ code: 'INVALID_INPUT', message: /Playwright engine/ })
    await expect(linux.installEngine('opera-gx', () => undefined)).rejects.toMatchObject({ code: 'INVALID_INPUT', message: /Opera GX \(installed\) cannot be installed automatically.*no Linux version.*https:\/\/www\.opera\.com\/gx/ })
    await expect(linux.installEngine('system-chromium', () => undefined)).rejects.toMatchObject({ code: 'INVALID_INPUT', message: /package manager/ })
    expect(engineNotInstallableMessage('msedge', 'Opens the vendor page.')).toContain('https://www.microsoft.com/edge/download')
    await expect(linux.uninstallEngine('chrome')).rejects.toMatchObject({ code: 'INVALID_INPUT', message: /was not installed by this app/ })
    await expect(linux.uninstallEngine('webkit')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

describe('install cancellation and busy engines', () => {
  let root: string
  const originalEnv = process.env.PLAYWRIGHT_BROWSERS_PATH

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'proxy-qa-prov-cancel-'))
    delete process.env.PLAYWRIGHT_BROWSERS_PATH
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    if (originalEnv === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH
    else process.env.PLAYWRIGHT_BROWSERS_PATH = originalEnv
  })

  it('partialDownloadDirs picks only the targets\' directories that lack the completion marker', () => {
    const entries = ['chromium-1200', 'chromium_headless_shell-1200', 'ffmpeg-1011', 'firefox-1500', 'webkit-2200', '__dirlock', 'chromium-1199', '.links']
    const complete = new Set(['chromium-1199', 'firefox-1500'])
    expect(partialDownloadDirs(entries, ['chromium'], (name) => complete.has(name))).toEqual(['chromium-1200', 'chromium_headless_shell-1200', 'ffmpeg-1011'])
    expect(partialDownloadDirs(entries, ['firefox', 'webkit'], (name) => complete.has(name))).toEqual(['webkit-2200'])
  })

  it('withBusyPathsKept leaves a busy engine\'s saved path exactly as it was', () => {
    const current = { executables: { brave: '/old/brave', opera: '/opera' }, origins: { brave: 'auto' as const, opera: 'auto' as const } }
    const next = { executables: { opera: '/opera', chrome: '/chrome' }, origins: { opera: 'auto' as const, chrome: 'auto' as const } }
    expect(withBusyPathsKept(current, next, ['brave', 'chrome'])).toEqual({ executables: { opera: '/opera', brave: '/old/brave' }, origins: { opera: 'auto', brave: 'auto' } })
    expect(withBusyPathsKept(current, next, [])).toBe(next)
  })

  it('a busy engine is neither auto-saved nor version-probed until its task is over', async () => {
    let busy = true
    const store = memoryExecutablePathStore()
    const versions: string[] = []
    const provisioner = createBrowserProvisioner({
      paths: fakePaths(root),
      logger: fakeLogger(),
      isPackaged: true,
      execPath: process.execPath,
      resourcesPath: path.join(root, 'resources'),
      executablePaths: store,
      platform: 'linux',
      detection: { fs: { isFile: (p) => p === '/usr/bin/brave' }, env: { PATH: '' }, runVersion: async (exe) => (versions.push(exe), 'Brave Browser 141.1.96.61') },
      isEngineBusy: (engine) => busy && engine === 'brave',
      versionCacheFile: null,
    })
    expect((await provisioner.redetect()).find((e) => e.id === 'brave')).toMatchObject({ available: true, version: null })
    expect(store.get()).toEqual({ executables: {}, origins: {} })
    expect(versions).toEqual([])
    busy = false
    expect((await provisioner.redetect()).find((e) => e.id === 'brave')).toMatchObject({ available: true, version: '141.1.96.61', source: 'auto-saved' })
    expect(store.get()).toEqual({ executables: { brave: '/usr/bin/brave' }, origins: { brave: 'auto' } })
  })

  it.skipIf(process.platform === 'win32')('cancelling a Playwright download kills the installer and removes the half-downloaded engine directory', async () => {
    const paths = fakePaths(root)
    mkdirSync(paths.browsers, { recursive: true })
    // Stand-in for "electron cli.js install chromium": creates a partial engine dir, prints progress, then hangs.
    const fakeInstaller = path.join(root, 'fake-installer.sh')
    writeFileSync(fakeInstaller, '#!/bin/sh\nmkdir -p "$PLAYWRIGHT_BROWSERS_PATH/chromium-9999"\necho "Downloading Chromium 10%"\nexec sleep 30\n', { mode: 0o755 })
    markInstalled(paths.browsers, 'firefox')
    const provisioner = createBrowserProvisioner({ paths, logger: fakeLogger(), isPackaged: true, execPath: fakeInstaller, resourcesPath: path.join(root, 'resources'), versionCacheFile: null })
    const controller = new AbortController()
    const pids: number[] = []
    const progress: string[] = []
    const pending = provisioner.install('chromium', (p) => progress.push(p.message), { signal: controller.signal, onChildProcess: (pid) => pids.push(pid) })
    const started = Date.now()
    while (!progress.some((line) => line.includes('10%')) && Date.now() - started < 5_000) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(pids).toHaveLength(1)
    expect(readdirSync(paths.browsers)).toContain('chromium-9999')
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'INTERNAL', message: 'The installation was cancelled.' })
    expect(readdirSync(paths.browsers)).not.toContain('chromium-9999')
    // A completed engine of another target is never touched.
    expect(readdirSync(paths.browsers).some((name) => name.startsWith('firefox-'))).toBe(true)
    // The lock is free again.
    await expect(provisioner.install('chromium', () => undefined, { signal: AbortSignal.abort() })).rejects.toMatchObject({ message: 'The installation was cancelled.' })
  })

  it.skipIf(process.platform === 'win32')('installs Chromium without the unused headless shell', async () => {
    const paths = fakePaths(root)
    mkdirSync(paths.browsers, { recursive: true })
    // Stand-in for "electron cli.js install …" that records the arguments it was given.
    const argsFile = path.join(root, 'installer-args.txt')
    const fakeInstaller = path.join(root, 'record-installer.sh')
    writeFileSync(fakeInstaller, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\n`, { mode: 0o755 })
    const provisioner = createBrowserProvisioner({ paths, logger: fakeLogger(), isPackaged: true, execPath: fakeInstaller, resourcesPath: path.join(root, 'resources'), versionCacheFile: null })
    await provisioner.install('chromium', () => undefined).catch(() => undefined) // nothing is really installed
    const args = readFileSync(argsFile, 'utf8').trim().split('\n')
    expect(args.slice(1)).toEqual(['install', '--no-shell', 'chromium'])
  })
})

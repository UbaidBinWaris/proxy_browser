/**
 * One-click installs through the provisioner, end to end with fakes for the
 * network, winget and timers: Linux user-space installs (download → unpack →
 * auto-saved path → Uninstall), the one-install-at-a-time lock, "Install all
 * missing", user paths never overwritten, stale auto paths self-healing,
 * Windows winget installs and the download-page watcher.
 */
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BrowserInstallProgress, BrowserWatchUpdate, InstalledBrowserEngine, LogEntry } from '../src/shared/types'
import type { AppPaths, Logger } from '../src/main/contracts'
import { INSTALL_BUSY_MESSAGE, createBrowserProvisioner } from '../src/main/browser/browser-provisioner'
import type { InstallerDeps } from '../src/main/browser/browser-provisioner'
import { nodeDetectFs } from '../src/main/browser/engine-detect'
import type { DetectFs } from '../src/main/browser/engine-detect'
import { memoryExecutablePathStore } from '../src/main/browser/executable-paths'
import type { ExecutablePathStore } from '../src/main/browser/executable-paths'
import { findCommand } from '../src/main/browser/installers/system-tools'
import { detectTarTools } from '../src/main/browser/installers/tar-archive'
import type { SpawnFn } from '../src/main/browser/installers/system-tools'
import { fakeDeb, fakeFetch, systemTarGz } from './helpers/archives'

const hasTar = findCommand('tar') !== null

function silentLogger(): Logger {
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

function pathsUnder(root: string): AppPaths {
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

let root: string
const originalBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'proxyqa-oneclick-'))
  mkdirSync(path.join(root, 'resources'), { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  if (originalBrowsersPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH
  else process.env.PLAYWRIGHT_BROWSERS_PATH = originalBrowsersPath
})

/** The real filesystem, but only inside the test's own folder (the host's browsers stay invisible). */
function sandboxFs(): DetectFs {
  return {
    isFile: (p) => p.startsWith(root) && nodeDetectFs.isFile(p),
    readText: (p) => (p.startsWith(root) ? (nodeDetectFs.readText?.(p) ?? null) : null),
  }
}

function linuxProvisioner(store: ExecutablePathStore, installers: InstallerDeps): ReturnType<typeof createBrowserProvisioner> {
  return createBrowserProvisioner({
    paths: pathsUnder(root),
    logger: silentLogger(),
    isPackaged: true,
    execPath: process.execPath,
    resourcesPath: path.join(root, 'resources'),
    executablePaths: store,
    platform: 'linux',
    arch: 'x64',
    detection: { fs: sandboxFs(), env: { PATH: '' }, runVersion: async (exe) => (exe.endsWith('/chrome') ? 'Google Chrome 141.0.7390.54' : 'Browser 1.0.0') },
    installers: { tarTools: detectTarTools(), ...installers },
  })
}

const chromeDeb = (): Buffer =>
  fakeDeb(
    systemTarGz([
      { path: 'opt/google/chrome/chrome', content: '#!/bin/sh\necho "Google Chrome 141.0.7390.54"\n', mode: 0o755 },
      { path: 'opt/google/chrome/resources.pak', content: randomBytes(1_100_000) },
    ]),
  )

const CHROME_URL = 'https://dl.example/google-chrome-stable_current_amd64.deb'

describe.runIf(hasTar)('one-click install on Linux (user-space)', () => {
  it('installs Chrome into <data>/installed-browsers, saves the path as "auto", reports progress, then uninstalls it', async () => {
    const store = memoryExecutablePathStore()
    const { fetch } = fakeFetch({ [CHROME_URL]: chromeDeb() })
    const provisioner = linuxProvisioner(store, {
      fetchImpl: fetch,
      resolvePackage: async () => ({ url: CHROME_URL, fileName: 'google-chrome-stable_current_amd64.deb', version: null, expectedSize: null, expectedSha256: null }),
    })
    const before = (await provisioner.engines()).find((e) => e.id === 'chrome')
    expect(before).toMatchObject({ available: false, installMethod: 'vendor-package', managedInstall: false })

    const progress: BrowserInstallProgress[] = []
    const status = await provisioner.installEngine('chrome', (p) => progress.push(p))
    const binary = path.join(root, 'data', 'installed-browsers', 'chrome', 'opt', 'google', 'chrome', 'chrome')
    expect(status.engines.find((e) => e.id === 'chrome')).toMatchObject({ available: true, executablePath: binary, source: 'auto-saved', version: '141.0.7390.54', managedInstall: true })
    expect(store.get()).toEqual({ executables: { chrome: binary }, origins: { chrome: 'auto' } })
    const phases = progress.map((p) => p.phase)
    expect(phases[0]).toBe('starting')
    expect(phases).toContain('downloading')
    expect(phases).toContain('extracting')
    expect(phases.at(-1)).toBe('done')
    expect(progress.every((p) => p.engine === 'chrome')).toBe(true)
    expect(progress.find((p) => p.phase === 'downloading' && p.percent === 100)).toBeTruthy()

    const removed = await provisioner.uninstallEngine('chrome')
    expect(removed.engines.find((e) => e.id === 'chrome')).toMatchObject({ available: false, managedInstall: false, source: 'not-found' })
    expect(existsSync(path.dirname(binary))).toBe(false)
    expect(store.get()).toEqual({ executables: {}, origins: {} })
  })

  it('runs one install at a time and never overwrites a custom path the user set', async () => {
    const custom = path.join(root, 'my-chrome')
    writeFileSync(custom, '#!/bin/sh\n', { mode: 0o755 })
    const store = memoryExecutablePathStore({ executables: { chrome: custom }, origins: { chrome: 'user' } })
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { fetch } = fakeFetch({ [CHROME_URL]: chromeDeb() })
    const provisioner = linuxProvisioner(store, {
      fetchImpl: fetch,
      resolvePackage: async () => {
        await gate
        return { url: CHROME_URL, fileName: 'chrome.deb', version: null, expectedSize: null, expectedSha256: null }
      },
    })
    const first = provisioner.installEngine('chrome', () => undefined)
    await expect(provisioner.installEngine('vivaldi', () => undefined)).rejects.toMatchObject({ code: 'INTERNAL', message: INSTALL_BUSY_MESSAGE })
    await expect(provisioner.installAllMissing(() => undefined)).rejects.toMatchObject({ message: INSTALL_BUSY_MESSAGE })
    await expect(provisioner.uninstallEngine('chrome')).rejects.toMatchObject({ message: INSTALL_BUSY_MESSAGE })
    release()
    const status = await first
    expect(status.engines.find((e) => e.id === 'chrome')).toMatchObject({ executablePath: custom, source: 'settings' })
    expect(store.get()).toEqual({ executables: { chrome: custom }, origins: { chrome: 'user' } })
  })

  it('"Install all missing" installs every automatic engine in turn, collecting failures with batch progress', async () => {
    const store = memoryExecutablePathStore()
    const { fetch } = fakeFetch({ [CHROME_URL]: chromeDeb() })
    const provisioner = linuxProvisioner(store, {
      fetchImpl: fetch,
      resolvePackage: async (engine) => {
        if (engine !== 'chrome') throw new Error(`${engine} mirror unreachable`)
        return { url: CHROME_URL, fileName: 'chrome.deb', version: null, expectedSize: null, expectedSha256: null }
      },
    })
    const progress: BrowserInstallProgress[] = []
    const result = await provisioner.installAllMissing((p) => progress.push(p))
    expect(result.installed).toEqual(['chrome'])
    // Opera GX (no Linux build) and system Chromium (package manager) are not automatic, so they are not attempted.
    expect(result.failed.map((f) => f.engine)).toEqual(['msedge', 'brave', 'opera', 'vivaldi'])
    expect(result.failed[0]?.message).toContain('msedge mirror unreachable')
    expect(result.status.engines.find((e) => e.id === 'chrome')).toMatchObject({ available: true, source: 'auto-saved' })
    expect(progress.every((p) => p.batch?.total === 5)).toBe(true)
    expect(progress.find((p) => p.engine === 'brave')?.batch?.index).toBe(3)
    expect(progress.filter((p) => p.phase === 'error').map((p) => p.engine)).toEqual(['msedge', 'brave', 'opera', 'vivaldi'])
  })

  it('self-heals settings copied from another machine: stale auto paths are pruned and the local copy is re-found', async () => {
    const managed = path.join(root, 'data', 'installed-browsers', 'opera')
    const binary = path.join(managed, 'usr', 'lib', 'x86_64-linux-gnu', 'opera-stable', 'opera')
    mkdirSync(path.dirname(binary), { recursive: true })
    writeFileSync(binary, '#!/bin/sh\n', { mode: 0o755 })
    writeFileSync(path.join(managed, '.proxy-qa-install.json'), JSON.stringify({ engine: 'opera', binary: 'usr/lib/x86_64-linux-gnu/opera-stable/opera' }))
    const store = memoryExecutablePathStore({
      executables: { opera: '/home/someone-else/.config/proxy-qa/data/installed-browsers/opera/opera', vivaldi: '/opt/elsewhere/vivaldi', brave: '/typed/by/user/brave' },
      origins: { opera: 'auto', vivaldi: 'auto', brave: 'user' },
    })
    const provisioner = linuxProvisioner(store, { fetchImpl: fakeFetch({}).fetch })
    const engines = await provisioner.redetect()
    expect(engines.find((e) => e.id === 'opera')).toMatchObject({ available: true, executablePath: binary, source: 'auto-saved', managedInstall: true })
    expect(engines.find((e) => e.id === 'vivaldi')).toMatchObject({ available: false, source: 'not-found' })
    // The user's own path is kept (and reported as ignored) even though it does not exist here.
    expect(engines.find((e) => e.id === 'brave')?.note).toContain('/typed/by/user/brave')
    expect(store.get()).toEqual({ executables: { opera: binary, brave: '/typed/by/user/brave' }, origins: { opera: 'auto', brave: 'user' } })
  })
})

/** A scripted child process: prints `lines`, then exits with `code` (runs `onClose` first). */
function scriptedChild(lines: string[], code: number, onClose: () => void = () => undefined): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  Object.assign(child, { stdout, stderr, kill: () => true })
  setImmediate(() => {
    for (const line of lines) stdout.write(line)
    stdout.end()
    stderr.end()
    setImmediate(() => {
      onClose()
      child.emit('close', code, null)
    })
  })
  return child
}

describe('one-click install on Windows (winget) and the download-page watcher', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\qa\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', PATH: '' }
  const chromeExe = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  const operaExe = 'C:\\Users\\qa\\AppData\\Local\\Programs\\Opera\\opera.exe'
  const neverRun = vi.fn(async () => 'must not run')
  afterEach(() => {
    // Running a browser binary for its version opens a window on Windows: it must never happen.
    expect(neverRun).not.toHaveBeenCalled()
  })

  function windowsProvisioner(files: Set<string>, store: ExecutablePathStore, installers: InstallerDeps): ReturnType<typeof createBrowserProvisioner> {
    return createBrowserProvisioner({
      paths: pathsUnder(root),
      logger: silentLogger(),
      isPackaged: true,
      execPath: process.execPath,
      resourcesPath: path.join(root, 'resources'),
      executablePaths: store,
      platform: 'win32',
      arch: 'x64',
      // On Windows the version is read from the .exe resources (faked here); `--version` is never run.
      detection: { fs: { isFile: (p) => files.has(p), readText: () => null }, env, runVersion: neverRun, probeVersion: async () => '141.0.7390.54' },
      installers,
    })
  }

  it('installs with winget, streams its progress and auto-saves the detected path', async () => {
    const files = new Set<string>()
    const store = memoryExecutablePathStore()
    const calls: string[][] = []
    const spawn: SpawnFn = (command, args) => {
      calls.push([command, ...args])
      return scriptedChild(['Found Google Chrome [Google.Chrome]\r\n', '  ██████▒▒▒▒  60%\r', '  ██████████  100%\r\n', 'Successfully verified installer hash\r\n', 'Starting package install...\r\n', 'Successfully installed\r\n'], 0, () => files.add(chromeExe))
    }
    const provisioner = windowsProvisioner(files, store, { spawn, probeWinget: async () => true })
    expect((await provisioner.engines()).find((e) => e.id === 'chrome')).toMatchObject({ installMethod: 'winget', available: false })
    const progress: BrowserInstallProgress[] = []
    const status = await provisioner.installEngine('chrome', (p) => progress.push(p))
    expect(calls).toEqual([['winget', 'install', '--id', 'Google.Chrome', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity']])
    expect(status.engines.find((e) => e.id === 'chrome')).toMatchObject({ available: true, executablePath: chromeExe, source: 'auto-saved', version: '141.0.7390.54' })
    expect(store.get()).toEqual({ executables: { chrome: chromeExe }, origins: { chrome: 'auto' } })
    expect(progress.find((p) => p.percent === 60)?.phase).toBe('downloading')
    expect(progress.map((p) => p.phase)).toContain('installing')
    expect(progress.map((p) => p.phase)).toContain('verifying')
    expect(progress.at(-1)?.phase).toBe('done')

    const failing: SpawnFn = () => scriptedChild(['Installer failed with exit code: 1603\r\n'], 1)
    const broken = windowsProvisioner(new Set(), memoryExecutablePathStore(), { spawn: failing, probeWinget: async () => true })
    const errors: BrowserInstallProgress[] = []
    await expect(broken.installEngine('vivaldi', (p) => errors.push(p))).rejects.toMatchObject({ code: 'BROWSER_MISSING', message: /Could not install Vivaldi.*1603/ })
    expect(errors.at(-1)?.phase).toBe('error')
  })

  it('without winget: "Get" opens the page, the watcher finds the browser, saves its path and reports it', async () => {
    vi.useFakeTimers()
    try {
      const files = new Set<string>()
      const store = memoryExecutablePathStore()
      const provisioner = windowsProvisioner(files, store, { probeWinget: async () => false, watcher: { intervalMs: 5_000, timeoutMs: 60_000 } })
      expect((await provisioner.engines()).find((e) => e.id === 'opera')).toMatchObject({ installMethod: 'download-page' })
      await expect(provisioner.installEngine('opera', () => undefined)).rejects.toMatchObject({ code: 'INVALID_INPUT', message: /cannot be installed automatically.*winget/ })

      const updates: BrowserWatchUpdate[] = []
      provisioner.onWatchUpdate((u) => updates.push(u))
      provisioner.watchForInstall('opera')
      provisioner.watchForInstall('chromium')
      expect(updates).toEqual([{ engine: 'opera', state: 'watching', info: null }])
      await vi.advanceTimersByTimeAsync(10_000)
      expect(updates).toHaveLength(1)
      files.add(operaExe)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(updates[1]).toMatchObject({ engine: 'opera', state: 'found', info: { available: true, executablePath: operaExe, source: 'auto-saved' } })
      expect(store.get()).toEqual({ executables: { opera: operaExe }, origins: { opera: 'auto' } })

      provisioner.watchForInstall('vivaldi' as InstalledBrowserEngine)
      provisioner.dispose()
      expect(updates.at(-1)).toEqual({ engine: 'vivaldi', state: 'cancelled', info: null })
    } finally {
      vi.useRealTimers()
    }
  })
})

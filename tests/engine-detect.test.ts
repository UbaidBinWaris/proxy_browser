/**
 * Installed-browser detection with an injected filesystem, environment and
 * platform: candidate lists, env-var expansion, PATH scanning, version parsing,
 * overrides, caching and the never-throw version probe.
 */
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { INSTALLED_BROWSER_ENGINES } from '../src/shared/types'
import type { BrowserExecutableOverrides, InstalledBrowserEngine } from '../src/shared/types'
import {
  AUTO_SAVED_NOTE,
  DETECTED_NOTE,
  MANAGED_NOTE,
  DETECTED_ON_PATH_NOTE,
  DETECTION_CACHE_TTL_MS,
  NOT_FOUND_NOTE,
  SETTINGS_NOTE,
  VERSION_TIMEOUT_MS,
  candidateExecutables,
  createEngineDetector,
  describeInstalledEngine,
  envValue,
  expandEnvVars,
  locateExecutable,
  nodeDetectFs,
  parseVersion,
  pathCommandNames,
  pathEntries,
  readVersion,
  scanPath,
  spawnVersionRunner,
  withWindowsDefaults,
} from '../src/main/browser/engine-detect'
import type { DetectFs } from '../src/main/browser/engine-detect'
import { NO_WINGET_NOTE, OPERA_GX_LINUX_NOTE, PORTABLE_NOTE, USER_SPACE_NOTE, WINGET_MACHINE_NOTE, WINGET_USER_NOTE } from '../src/main/browser/install-support'

const fsWith = (files: Iterable<string>): DetectFs => {
  const set = new Set(files)
  return { isFile: (p) => set.has(p) }
}

const WIN_ENV = { LOCALAPPDATA: 'C:\\Users\\qa\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)' }

describe('candidateExecutables', () => {
  it('lists the documented Linux locations for every installed-kind engine, in order', () => {
    expect(candidateExecutables('opera', 'linux', {})).toEqual(['/usr/bin/opera', '/usr/bin/opera-stable', '/opt/opera/opera', '/usr/lib/opera/opera', '/usr/lib/x86_64-linux-gnu/opera-stable/opera', '/snap/bin/opera'])
    expect(candidateExecutables('opera-gx', 'linux', {})).toEqual(['/usr/bin/opera-gx', '/opt/opera-gx/opera'])
    expect(candidateExecutables('brave', 'linux', {})).toEqual(['/usr/bin/brave', '/usr/bin/brave-browser', '/usr/bin/brave-browser-stable', '/opt/brave.com/brave/brave', '/snap/bin/brave'])
    expect(candidateExecutables('vivaldi', 'linux', {})).toEqual(['/usr/bin/vivaldi', '/usr/bin/vivaldi-stable', '/opt/vivaldi/vivaldi'])
    expect(candidateExecutables('chrome', 'linux', {})).toEqual(['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'])
    expect(candidateExecutables('msedge', 'linux', {})).toEqual(['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge'])
    expect(candidateExecutables('system-chromium', 'linux', {})).toEqual(['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'])
    // Other POSIX platforms use the Linux list.
    expect(candidateExecutables('system-chromium', 'freebsd', {})).toEqual(candidateExecutables('system-chromium', 'linux', {}))
  })

  it('expands %LOCALAPPDATA%, %PROGRAMFILES% and %PROGRAMFILES(X86)% on Windows and dedupes', () => {
    expect(candidateExecutables('opera', 'win32', WIN_ENV)).toEqual(['C:\\Users\\qa\\AppData\\Local\\Programs\\Opera\\opera.exe', 'C:\\Program Files\\Opera\\opera.exe'])
    expect(candidateExecutables('opera-gx', 'win32', WIN_ENV)).toEqual(['C:\\Users\\qa\\AppData\\Local\\Programs\\Opera GX\\opera.exe'])
    expect(candidateExecutables('brave', 'win32', WIN_ENV)).toEqual([
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'C:\\Users\\qa\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ])
    expect(candidateExecutables('vivaldi', 'win32', WIN_ENV)).toEqual(['C:\\Users\\qa\\AppData\\Local\\Vivaldi\\Application\\vivaldi.exe', 'C:\\Program Files\\Vivaldi\\Application\\vivaldi.exe'])
    expect(candidateExecutables('chrome', 'win32', WIN_ENV)).toEqual([
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Users\\qa\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    ])
    expect(candidateExecutables('msedge', 'win32', WIN_ENV)).toEqual(['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'])
    expect(candidateExecutables('system-chromium', 'win32', WIN_ENV)).toEqual(['C:\\Users\\qa\\AppData\\Local\\Chromium\\Application\\chrome.exe'])
    // Both Program Files variables pointing at the same directory (32-bit Windows) collapse to one candidate.
    expect(candidateExecutables('msedge', 'win32', { ...WIN_ENV, 'PROGRAMFILES(X86)': 'C:\\Program Files' })).toEqual(['C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'])
  })

  it('falls back to the usual Windows directories when the environment is incomplete and is case-insensitive', () => {
    expect(candidateExecutables('chrome', 'win32', { userprofile: 'D:\\Users\\qa', systemdrive: 'D:' })).toEqual([
      'D:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'D:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'D:\\Users\\qa\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    ])
    // No USERPROFILE either: the LOCALAPPDATA-based candidate is dropped rather than producing "\Google\…".
    expect(candidateExecutables('opera-gx', 'win32', {})).toEqual([])
    expect(candidateExecutables('opera', 'win32', {})).toEqual(['C:\\Program Files\\Opera\\opera.exe'])
    const defaults = withWindowsDefaults({ USERPROFILE: 'C:\\Users\\me' })
    expect(defaults).toMatchObject({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)' })
    expect(envValue({ Path: 'x' }, 'PATH', 'win32')).toBe('x')
    expect(envValue({ Path: 'x' }, 'PATH', 'linux')).toBeUndefined()
  })

  it('lists /Applications and ~/Applications bundles on macOS', () => {
    const env = { HOME: '/Users/qa' }
    expect(candidateExecutables('opera', 'darwin', env)).toEqual(['/Applications/Opera.app/Contents/MacOS/Opera', '/Users/qa/Applications/Opera.app/Contents/MacOS/Opera'])
    expect(candidateExecutables('opera-gx', 'darwin', env)[0]).toBe('/Applications/Opera GX.app/Contents/MacOS/Opera')
    expect(candidateExecutables('brave', 'darwin', env)[0]).toBe('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser')
    expect(candidateExecutables('vivaldi', 'darwin', env)[0]).toBe('/Applications/Vivaldi.app/Contents/MacOS/Vivaldi')
    expect(candidateExecutables('chrome', 'darwin', env)[0]).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    expect(candidateExecutables('msedge', 'darwin', env)[0]).toBe('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
    expect(candidateExecutables('system-chromium', 'darwin', env)[0]).toBe('/Applications/Chromium.app/Contents/MacOS/Chromium')
    // Without HOME only the system-wide bundle remains.
    expect(candidateExecutables('chrome', 'darwin', {})).toEqual(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'])
  })
})

describe('expandEnvVars', () => {
  it('expands %VAR%, ${VAR} and $VAR and returns null for missing or blank variables', () => {
    const env = { A: 'alpha', B: 'beta', BLANK: '  ' }
    expect(expandEnvVars('%A%\\x\\%B%', env, 'win32')).toBe('alpha\\x\\beta')
    expect(expandEnvVars('${A}/x/$B', env, 'linux')).toBe('alpha/x/beta')
    expect(expandEnvVars('/plain/path', env, 'linux')).toBe('/plain/path')
    expect(expandEnvVars('%MISSING%\\x', env, 'win32')).toBeNull()
    expect(expandEnvVars('$BLANK/x', env, 'linux')).toBeNull()
    expect(expandEnvVars('%a%', env, 'win32')).toBe('alpha')
    expect(expandEnvVars('%a%', env, 'linux')).toBeNull()
  })
})

describe('scanPath', () => {
  it('finds the first matching command on PATH without spawning anything (POSIX)', () => {
    const env = { PATH: '/usr/local/bin::/usr/bin:/opt/bin' }
    const fs = fsWith(['/usr/bin/brave-browser', '/opt/bin/brave'])
    expect(pathEntries(env, 'linux')).toEqual(['/usr/local/bin', '/usr/bin', '/opt/bin'])
    // Directory order wins over command order: /usr/bin is scanned before /opt/bin.
    expect(scanPath(pathCommandNames('brave', 'linux'), env, 'linux', fs)).toBe('/usr/bin/brave-browser')
    expect(scanPath(pathCommandNames('opera', 'linux'), env, 'linux', fs)).toBeNull()
    expect(scanPath(['x'], {}, 'linux', fs)).toBeNull()
    expect(pathCommandNames('system-chromium', 'linux')).toEqual(['chromium', 'chromium-browser'])
    expect(pathCommandNames('msedge', 'darwin')).toContain('microsoft-edge')
  })

  it('tries PATHEXT extensions and strips quotes on Windows', () => {
    const env = { Path: '"C:\\Tools";C:\\Browsers\\Vivaldi\\Application', PATHEXT: '.COM;.EXE;.BAT' }
    const fs = fsWith(['C:\\Browsers\\Vivaldi\\Application\\vivaldi.EXE'])
    expect(pathEntries(env, 'win32')).toEqual(['C:\\Tools', 'C:\\Browsers\\Vivaldi\\Application'])
    expect(scanPath(pathCommandNames('vivaldi', 'win32'), env, 'win32', fs)).toBe('C:\\Browsers\\Vivaldi\\Application\\vivaldi.EXE')
    // Default PATHEXT when the variable is absent.
    const defaultExt = fsWith(['C:\\Tools\\opera.EXE'])
    expect(scanPath(pathCommandNames('opera', 'win32'), { PATH: 'C:\\Tools' }, 'win32', defaultExt)).toBe('C:\\Tools\\opera.EXE')
    // On Windows "chrome" is Google's name; system Chromium only matches "chromium".
    expect(pathCommandNames('system-chromium', 'win32')).toEqual(['chromium'])
    expect(pathCommandNames('chrome', 'win32')).toEqual(['chrome'])
  })
})

describe('parseVersion / readVersion', () => {
  it('extracts the first version-like token and tolerates junk', () => {
    expect(parseVersion('Chromium 153.0.8010.52 Arch Linux')).toBe('153.0.8010.52')
    expect(parseVersion('Opera 118.0.5461.60')).toBe('118.0.5461.60')
    expect(parseVersion('Brave Browser 1.75.180 Chromium: 133.0.6943.126')).toBe('1.75.180')
    expect(parseVersion('Google Chrome 131.0.6778.85 ')).toBe('131.0.6778.85')
    expect(parseVersion('Microsoft Edge 131.0')).toBe('131.0')
    expect(parseVersion('Vivaldi 7.1.3570.42\n')).toBe('7.1.3570.42')
    expect(parseVersion('no digits here')).toBeNull()
    expect(parseVersion('build 42')).toBeNull()
    expect(parseVersion('')).toBeNull()
    expect(parseVersion(null)).toBeNull()
    expect(parseVersion(undefined)).toBeNull()
  })

  it('readVersion never throws: runner failures, rejections and timeouts yield null', async () => {
    expect(await readVersion('/x', async () => 'Opera 118.0.5461.60')).toBe('118.0.5461.60')
    expect(await readVersion('/x', async () => null)).toBeNull()
    expect(await readVersion('/x', async () => 'garbage')).toBeNull()
    expect(
      await readVersion('/x', async () => {
        throw new Error('spawn ENOENT')
      }),
    ).toBeNull()
    const runner = vi.fn(async (_exe: string, timeoutMs: number) => `v ${timeoutMs}.1`)
    expect(await readVersion('/x', runner)).toBe(`${VERSION_TIMEOUT_MS}.1`)
    expect(runner).toHaveBeenCalledWith('/x', VERSION_TIMEOUT_MS)
    expect(await readVersion('/x', runner, 500)).toBe('500.1')
  })

  it('the real spawn runner resolves (never rejects) for a missing executable and reads a real one', async () => {
    expect(await spawnVersionRunner('/definitely/not/here/browser', 1_000)).toBeNull()
    // `node --version` is always available in the test environment and prints "vXX.Y.Z".
    const output = await spawnVersionRunner(process.execPath, 5_000)
    expect(parseVersion(output)).toBe(process.versions.node)
    expect(await readVersion(process.execPath)).toBe(process.versions.node)
  })

  it('nodeDetectFs.isFile distinguishes files from directories and missing paths', () => {
    expect(nodeDetectFs.isFile(process.execPath)).toBe(true)
    expect(nodeDetectFs.isFile(process.cwd())).toBe(false)
    expect(nodeDetectFs.isFile('/definitely/not/here')).toBe(false)
  })
})

describe('locateExecutable / describeInstalledEngine', () => {
  const linux = { platform: 'linux' as const, env: { PATH: '/usr/bin' } }

  it('prefers an existing settings override, then well-known paths, then PATH, else not-found', () => {
    const fs = fsWith(['/custom/opera', '/usr/bin/opera-stable', '/usr/bin/vivaldi-stable'])
    expect(locateExecutable('opera', { opera: '/custom/opera' }, { ...linux, fs })).toEqual({ executablePath: '/custom/opera', source: 'settings', note: SETTINGS_NOTE })
    expect(locateExecutable('opera', {}, { ...linux, fs })).toEqual({ executablePath: '/usr/bin/opera-stable', source: 'detected', note: DETECTED_NOTE })
    // vivaldi-stable is not in the well-known list under /usr/bin? It is — so detection reports a well-known path.
    expect(locateExecutable('vivaldi', {}, { ...linux, fs })).toEqual({ executablePath: '/usr/bin/vivaldi-stable', source: 'detected', note: DETECTED_NOTE })
    const onPath = locateExecutable('brave', {}, { ...linux, env: { PATH: '/home/qa/.local/bin' }, fs: fsWith(['/home/qa/.local/bin/brave-browser']) })
    expect(onPath).toEqual({ executablePath: '/home/qa/.local/bin/brave-browser', source: 'detected', note: DETECTED_ON_PATH_NOTE })
    expect(locateExecutable('msedge', {}, { ...linux, fs })).toEqual({ executablePath: null, source: 'not-found', note: NOT_FOUND_NOTE })
  })

  it('ignores an override that points nowhere, says so in the note and keeps detecting', () => {
    const fs = fsWith(['/usr/bin/chromium'])
    const detected = locateExecutable('system-chromium', { 'system-chromium': '/missing/chromium' }, { ...linux, fs })
    expect(detected).toMatchObject({ executablePath: '/usr/bin/chromium', source: 'detected' })
    expect(detected.note).toBe(`The path set in Settings → Browsers (/missing/chromium) does not exist and was ignored. ${DETECTED_NOTE}`)
    const missing = locateExecutable('opera', { opera: '/missing/opera' }, { ...linux, fs })
    expect(missing).toMatchObject({ executablePath: null, source: 'not-found' })
    expect(missing.note).toBe(`The path set in Settings → Browsers (/missing/opera) does not exist and was ignored. ${NOT_FOUND_NOTE}`)
    // Blank overrides are treated as absent.
    expect(locateExecutable('opera', { opera: '   ' }, { ...linux, fs })).toEqual({ executablePath: null, source: 'not-found', note: NOT_FOUND_NOTE })
  })

  it('describeInstalledEngine builds the renderer record and drops the version when nothing was found', () => {
    expect(describeInstalledEngine('brave', { executablePath: '/usr/bin/brave', source: 'detected', note: DETECTED_NOTE }, '1.75.180', { platform: 'linux', arch: 'x64', winget: false })).toEqual({
      id: 'brave',
      label: 'Brave (installed)',
      family: 'chromium',
      kind: 'installed',
      available: true,
      executablePath: '/usr/bin/brave',
      version: '1.75.180',
      source: 'detected',
      note: DETECTED_NOTE,
      installMethod: 'portable-archive',
      installNote: PORTABLE_NOTE,
      downloadUrl: 'https://brave.com/download/',
      managedInstall: false,
    })
    expect(describeInstalledEngine('msedge', { executablePath: null, source: 'not-found', note: NOT_FOUND_NOTE }, '1.0')).toMatchObject({ available: false, version: null, label: 'Microsoft Edge (installed)' })
  })

  it('describeInstalledEngine reports how the engine can be installed on the host', () => {
    const located = { executablePath: null, source: 'not-found' as const, note: NOT_FOUND_NOTE }
    const linux = { platform: 'linux' as const, arch: 'x64', winget: false }
    const windows = { platform: 'win32' as const, arch: 'x64', winget: true }
    const mac = { platform: 'darwin' as const, arch: 'arm64', winget: false }
    expect(describeInstalledEngine('chrome', located, null, linux)).toMatchObject({ installMethod: 'vendor-package', installNote: USER_SPACE_NOTE, downloadUrl: 'https://www.google.com/chrome/' })
    expect(describeInstalledEngine('opera-gx', located, null, linux)).toMatchObject({ installMethod: 'none', installNote: OPERA_GX_LINUX_NOTE })
    expect(describeInstalledEngine('system-chromium', located, null, linux)).toMatchObject({ installMethod: 'download-page', downloadUrl: 'https://www.chromium.org/getting-involved/download-chromium/' })
    expect(describeInstalledEngine('vivaldi', located, null, windows)).toMatchObject({ installMethod: 'winget', installNote: WINGET_USER_NOTE })
    expect(describeInstalledEngine('chrome', located, null, windows)).toMatchObject({ installMethod: 'winget', installNote: WINGET_MACHINE_NOTE })
    expect(describeInstalledEngine('chrome', located, null, { ...windows, winget: false })).toMatchObject({ installMethod: 'download-page', installNote: NO_WINGET_NOTE })
    expect(describeInstalledEngine('msedge', located, null, mac)).toMatchObject({ installMethod: 'playwright', downloadUrl: 'https://www.microsoft.com/edge/download' })
    expect(describeInstalledEngine('opera', located, null, mac)).toMatchObject({ installMethod: 'download-page', downloadUrl: 'https://www.opera.com/download' })
    expect(describeInstalledEngine('opera', located, null, linux, true)).toMatchObject({ managedInstall: true })
  })
})

describe('createEngineDetector', () => {
  interface World {
    files: Set<string>
    overrides: BrowserExecutableOverrides
    now: number
    runs: string[]
  }

  function detectorFor(world: World, cacheTtlMs?: number): ReturnType<typeof createEngineDetector> {
    return createEngineDetector({
      getOverrides: () => world.overrides,
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      fs: { isFile: (p) => world.files.has(p) },
      runVersion: async (exe) => {
        world.runs.push(exe)
        if (exe === '/usr/bin/chromium') return 'Chromium 153.0.8010.52 Arch Linux'
        if (exe === '/opt/brave.com/brave/brave') throw new Error('crashed')
        return null
      },
      now: () => world.now,
      ...(cacheTtlMs !== undefined ? { cacheTtlMs } : {}),
    })
  }

  it('reports every installed-kind engine in INSTALLED_BROWSER_ENGINES order, reading versions only for found binaries', async () => {
    const world: World = { files: new Set(['/usr/bin/chromium', '/opt/brave.com/brave/brave']), overrides: {}, now: 1_000, runs: [] }
    const detector = detectorFor(world)
    const all = await detector.detect()
    expect(all.map((e) => e.id)).toEqual([...INSTALLED_BROWSER_ENGINES])
    expect(all.every((e) => e.kind === 'installed' && e.family === 'chromium')).toBe(true)
    expect(all.find((e) => e.id === 'system-chromium')).toMatchObject({ available: true, executablePath: '/usr/bin/chromium', version: '153.0.8010.52', source: 'detected' })
    // A version probe that throws is swallowed: the browser is still available, version unknown.
    expect(all.find((e) => e.id === 'brave')).toMatchObject({ available: true, executablePath: '/opt/brave.com/brave/brave', version: null })
    for (const id of ['opera', 'opera-gx', 'vivaldi', 'chrome', 'msedge'] as InstalledBrowserEngine[]) {
      expect(all.find((e) => e.id === id), id).toMatchObject({ available: false, executablePath: null, version: null, source: 'not-found', note: NOT_FOUND_NOTE })
    }
    expect(world.runs.sort()).toEqual(['/opt/brave.com/brave/brave', '/usr/bin/chromium'])
    expect(await detector.detectEngine('opera')).toMatchObject({ id: 'opera', available: false })
    // Any Linux distribution: Chrome/Edge come from the vendor package, unpacked without root.
    expect(all.find((e) => e.id === 'chrome')).toMatchObject({ installMethod: process.arch === 'x64' ? 'vendor-package' : 'download-page', downloadUrl: 'https://www.google.com/chrome/' })
    expect(all.find((e) => e.id === 'opera-gx')).toMatchObject({ installMethod: 'none' })
  })

  it('caches for the TTL, re-scans when overrides change or after invalidate()/expiry, and dedupes in-flight scans', async () => {
    const world: World = { files: new Set(['/usr/bin/chromium']), overrides: {}, now: 10_000, runs: [] }
    const detector = detectorFor(world)
    const first = detector.detect()
    const second = detector.detect()
    expect(second).toBe(first)
    await first
    expect(world.runs).toHaveLength(1)

    // Cached: the file appearing on disk is not noticed yet.
    world.files.add('/usr/bin/opera')
    expect((await detector.detect()).find((e) => e.id === 'opera')?.available).toBe(false)
    expect(world.runs).toHaveLength(1)

    // Changing the overrides invalidates the cache on its own.
    world.overrides = { vivaldi: '/usr/bin/chromium' }
    const changed = await detector.detect()
    expect(changed.find((e) => e.id === 'opera')?.available).toBe(true)
    expect(changed.find((e) => e.id === 'vivaldi')).toMatchObject({ available: true, executablePath: '/usr/bin/chromium', source: 'settings', version: '153.0.8010.52' })
    expect(world.runs.length).toBeGreaterThan(1)

    // Explicit invalidate.
    const before = world.runs.length
    world.files.delete('/usr/bin/opera')
    await detector.detect()
    expect(world.runs.length).toBe(before)
    detector.invalidate()
    expect((await detector.detect()).find((e) => e.id === 'opera')?.available).toBe(false)
    expect(world.runs.length).toBeGreaterThan(before)

    // Expiry.
    const beforeExpiry = world.runs.length
    world.now += DETECTION_CACHE_TTL_MS - 1
    await detector.detect()
    expect(world.runs.length).toBe(beforeExpiry)
    world.now += 2
    await detector.detect()
    expect(world.runs.length).toBeGreaterThan(beforeExpiry)
  })

  it('does not cache a failed scan', async () => {
    let calls = 0
    const detector = createEngineDetector({
      getOverrides: () => ({}),
      platform: 'linux',
      env: {},
      fs: {
        isFile: () => {
          calls += 1
          if (calls === 1) throw new Error('disk error')
          return false
        },
      },
      runVersion: async () => null,
    })
    await expect(detector.detect()).rejects.toThrow('disk error')
    const second = await detector.detect()
    expect(second).toHaveLength(INSTALLED_BROWSER_ENGINES.length)
  })

  it('uses the real platform/env/fs by default without throwing', async () => {
    const detector = createEngineDetector({ getOverrides: () => ({}), runVersion: async () => null, cacheTtlMs: 0 })
    const all = await detector.detect()
    expect(all).toHaveLength(INSTALLED_BROWSER_ENGINES.length)
  })
})

describe('saved-path origins and the app\'s user-space installs', () => {
  const linux = { platform: 'linux' as const, env: { PATH: '/usr/bin' } }
  const root = '/data/installed-browsers'
  const manifest = (binary: string): string => JSON.stringify({ engine: 'opera', binary, version: '136.0', url: 'x', sha256: 'y', bytes: 1, installedAt: 'z' })

  it('reports an existing auto-saved path as source "auto-saved" and a user path as "settings"', () => {
    const fs = fsWith(['/opt/x/opera'])
    expect(locateExecutable('opera', { opera: '/opt/x/opera' }, { ...linux, fs, origins: { opera: 'auto' } })).toEqual({ executablePath: '/opt/x/opera', source: 'auto-saved', note: AUTO_SAVED_NOTE })
    expect(locateExecutable('opera', { opera: '/opt/x/opera' }, { ...linux, fs, origins: { opera: 'user' } })).toEqual({ executablePath: '/opt/x/opera', source: 'settings', note: SETTINGS_NOTE })
    // No origin recorded (settings from before origins existed) → the user's.
    expect(locateExecutable('opera', { opera: '/opt/x/opera' }, { ...linux, fs })).toMatchObject({ source: 'settings' })
    const stale = locateExecutable('opera', { opera: '/gone/opera' }, { ...linux, fs, origins: { opera: 'auto' } })
    expect(stale).toMatchObject({ executablePath: null, source: 'not-found' })
    expect(stale.note).toContain('The saved path (/gone/opera) no longer exists.')
  })

  it('finds the user-space install through its manifest first, then the vendor layout, before system locations', () => {
    const files = new Map<string, string>([[join(root, 'opera/.proxy-qa-install.json'), manifest('usr/lib/x86_64-linux-gnu/opera-stable/opera')]])
    const exists = new Set([join(root, 'opera/usr/lib/x86_64-linux-gnu/opera-stable/opera'), '/usr/bin/opera'])
    const fs: DetectFs = { isFile: (p) => exists.has(p), readText: (p) => files.get(p) ?? null }
    expect(locateExecutable('opera', {}, { ...linux, fs, managedRoot: root })).toEqual({ executablePath: join(root, 'opera/usr/lib/x86_64-linux-gnu/opera-stable/opera'), source: 'detected', note: MANAGED_NOTE })
    // Without the managed root, the system copy is found as before.
    expect(locateExecutable('opera', {}, { ...linux, fs })).toMatchObject({ executablePath: '/usr/bin/opera' })
    // A manifest pointing outside its folder is ignored; the default layout is still tried.
    files.set(join(root, 'opera/.proxy-qa-install.json'), manifest('../../etc/passwd'))
    expect(locateExecutable('opera', {}, { ...linux, fs, managedRoot: root })).toMatchObject({ executablePath: join(root, 'opera/usr/lib/x86_64-linux-gnu/opera-stable/opera') })
  })

  it('the detector marks user-space installs as managed and labels auto-saved paths', async () => {
    const files = new Map<string, string>([[join(root, 'brave/.proxy-qa-install.json'), JSON.stringify({ engine: 'brave', binary: 'brave' })]])
    const exists = new Set([join(root, 'brave/brave')])
    const detector = createEngineDetector({
      getOverrides: () => ({ brave: join(root, 'brave/brave') }),
      getOrigins: () => ({ brave: 'auto' }),
      managedRoot: root,
      platform: 'linux',
      env: { PATH: '' },
      fs: { isFile: (p) => exists.has(p), readText: (p) => files.get(p) ?? null },
      runVersion: async () => 'Brave Browser 141.1.96.61',
      getHost: async () => ({ platform: 'linux', arch: 'x64', winget: false }),
    })
    const brave = await detector.detectEngine('brave')
    expect(brave).toMatchObject({ available: true, source: 'auto-saved', managedInstall: true, version: '141.1.96.61', installMethod: 'portable-archive' })
    expect(detector.locate('brave')).toMatchObject({ executablePath: join(root, 'brave/brave') })
    expect(detector.locate('vivaldi')).toMatchObject({ executablePath: null })
  })
})

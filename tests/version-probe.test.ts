/**
 * Detection must never run a browser binary on Windows or macOS (it opens a
 * browser window there): versions come from the PE resource / sibling version
 * directory / Info.plist instead; Linux keeps `--version`. Versions are cached
 * per binary by path + size + mtime, in memory and in a JSON file.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { INSTALLED_BROWSER_ENGINES } from '../src/shared/types'
import { createEngineDetector } from '../src/main/browser/engine-detect'
import {
  VERSION_CACHE_MAX_ENTRIES,
  appBundleRoot,
  createVersionProbe,
  fileVersionCache,
  mayExecuteForVersion,
  memoryVersionCache,
  parsePlistShortVersion,
  probeVersionUncached,
  readInfoPlistVersion,
} from '../src/main/browser/version-probe'
import type { StaticVersionReaders, VersionRunner } from '../src/main/browser/version-probe'

let work: string
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'proxyqa-version-'))
})
afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Google Chrome</string>
  <key>CFBundleShortVersionString</key>
  <string>154.0.8037.97</string>
  <key>CFBundleVersion</key><string>8037.97</string>
</dict></plist>`

function readers(overrides: Partial<StaticVersionReaders> = {}): StaticVersionReaders {
  return {
    readPe: vi.fn(async () => '154.0.8037.97'),
    readSiblingDirs: vi.fn(async () => '153.0.0.1'),
    readPlist: vi.fn(async () => '154.0.8037.97'),
    ...overrides,
  }
}

describe('never execute a browser for its version on Windows / macOS', () => {
  it('only Linux-like platforms may run --version', () => {
    expect(mayExecuteForVersion('win32')).toBe(false)
    expect(mayExecuteForVersion('darwin')).toBe(false)
    expect(mayExecuteForVersion('linux')).toBe(true)
    expect(mayExecuteForVersion('freebsd')).toBe(true)
  })

  it('win32 reads the PE resource, then the version directory; the runner is never called', async () => {
    const runner = vi.fn<VersionRunner>(async () => 'Google Chrome 1.2.3.4')
    const win = readers()
    for (const engine of INSTALLED_BROWSER_ENGINES) {
      expect(await probeVersionUncached(engine, 'C:\\Chrome\\chrome.exe', { platform: 'win32', runVersion: runner, readers: win })).toEqual({ version: '154.0.8037.97', method: 'pe-resource' })
    }
    const fallback = readers({ readPe: vi.fn(async () => null) })
    expect(await probeVersionUncached('opera', 'C:\\Opera\\opera.exe', { platform: 'win32', runVersion: runner, readers: fallback })).toEqual({ version: '153.0.0.1', method: 'sibling-dir' })
    const nothing = readers({ readPe: vi.fn(async () => null), readSiblingDirs: vi.fn(async () => null) })
    expect(await probeVersionUncached('brave', 'C:\\Brave\\brave.exe', { platform: 'win32', runVersion: runner, readers: nothing })).toEqual({ version: null, method: 'none' })
    expect(runner).not.toHaveBeenCalled()
  })

  it('darwin reads Info.plist; the runner is never called', async () => {
    const runner = vi.fn<VersionRunner>(async () => 'Google Chrome 1.2.3.4')
    const mac = readers()
    expect(await probeVersionUncached('chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', { platform: 'darwin', runVersion: runner, readers: mac })).toEqual({ version: '154.0.8037.97', method: 'info-plist' })
    expect(mac.readPe).not.toHaveBeenCalled()
    expect(await probeVersionUncached('chrome', '/x', { platform: 'darwin', runVersion: runner, readers: readers({ readPlist: vi.fn(async () => null) }) })).toEqual({ version: null, method: 'none' })
    expect(runner).not.toHaveBeenCalled()
  })

  it('linux runs --version (and never touches the static readers)', async () => {
    const runner = vi.fn<VersionRunner>(async () => 'Brave Browser 141.1.96.61')
    const linux = readers()
    expect(await probeVersionUncached('brave', '/usr/bin/brave', { platform: 'linux', runVersion: runner, readers: linux, timeoutMs: 1234 })).toEqual({ version: '141.1.96.61', method: 'version-flag' })
    expect(runner).toHaveBeenCalledWith('/usr/bin/brave', 1234)
    expect(linux.readPe).not.toHaveBeenCalled()
    expect(await probeVersionUncached('brave', '/usr/bin/brave', { platform: 'linux', runVersion: async () => { throw new Error('boom') } })).toEqual({ version: null, method: 'none' })
  })

  it('the detector on win32 and darwin never calls the injected runner, even across rescans', async () => {
    for (const platform of ['win32', 'darwin'] as const) {
      const exe = platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      const runner = vi.fn<VersionRunner>(async () => 'should not run')
      const detector = createEngineDetector({
        getOverrides: () => ({ chrome: exe }),
        platform,
        env: { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\qa\\AppData\\Local', PATH: '' },
        fs: { isFile: (p) => p === exe },
        runVersion: runner,
        cacheTtlMs: 0,
      })
      for (let i = 0; i < 3; i += 1) {
        detector.invalidate()
        expect((await detector.detectEngine('chrome')).available).toBe(true)
      }
      expect(runner).not.toHaveBeenCalled()
    }
  })

  it('an engine being installed is located but its version is not read', async () => {
    const probe = vi.fn(async () => '1.0')
    let busy = true
    const detector = createEngineDetector({
      getOverrides: () => ({}),
      platform: 'linux',
      env: { PATH: '' },
      fs: { isFile: (p) => p === '/usr/bin/brave' },
      probeVersion: probe,
      isEngineBusy: (engine) => busy && engine === 'brave',
      cacheTtlMs: 0,
    })
    expect(await detector.detectEngine('brave')).toMatchObject({ available: true, version: null })
    expect(probe).not.toHaveBeenCalled()
    busy = false
    expect(await detector.detectEngine('brave')).toMatchObject({ available: true, version: '1.0' })
  })
})

describe('macOS Info.plist', () => {
  it('finds the bundle root and parses CFBundleShortVersionString (XML only)', () => {
    expect(appBundleRoot('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')).toBe('/Applications/Google Chrome.app')
    expect(appBundleRoot('/Users/qa/Applications/Opera GX.app/Contents/MacOS/Opera')).toBe('/Users/qa/Applications/Opera GX.app')
    expect(appBundleRoot('/usr/bin/chromium')).toBeNull()
    expect(parsePlistShortVersion(PLIST)).toBe('154.0.8037.97')
    expect(parsePlistShortVersion('bplist00\u0000binary')).toBeNull()
    expect(parsePlistShortVersion('<plist><dict></dict></plist>')).toBeNull()
  })

  it('reads the plist of a bundle on disk', async () => {
    const bundle = path.join(work, 'Brave Browser.app')
    mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), PLIST.replace('154.0.8037.97', '1.96.61'))
    expect(await readInfoPlistVersion(path.join(bundle, 'Contents', 'MacOS', 'Brave Browser'))).toBe('1.96.61')
    expect(await readInfoPlistVersion(path.join(work, 'Nope.app', 'Contents', 'MacOS', 'Nope'))).toBeNull()
  })
})

describe('version cache (path + size + mtime)', () => {
  it('probes an unchanged binary once; a new size or mtime probes again', async () => {
    let fingerprint = { size: 100, mtimeMs: 1 }
    const read = vi.fn(async () => '154.0.8037.97')
    const probe = createVersionProbe({ platform: 'win32', cache: memoryVersionCache(), stat: () => fingerprint, readers: { readPe: read } })
    expect(await probe('chrome', 'C:\\chrome.exe')).toBe('154.0.8037.97')
    expect(await probe('chrome', 'C:\\chrome.exe')).toBe('154.0.8037.97')
    expect(read).toHaveBeenCalledTimes(1)
    fingerprint = { size: 100, mtimeMs: 2 }
    await probe('chrome', 'C:\\chrome.exe')
    fingerprint = { size: 200, mtimeMs: 2 }
    await probe('chrome', 'C:\\chrome.exe')
    expect(read).toHaveBeenCalledTimes(3)
    // Without a fingerprint nothing is cached.
    const uncached = createVersionProbe({ platform: 'win32', cache: memoryVersionCache(), stat: () => null, readers: { readPe: read } })
    await uncached('chrome', 'C:\\chrome.exe')
    await uncached('chrome', 'C:\\chrome.exe')
    expect(read).toHaveBeenCalledTimes(5)
  })

  it('keeps a static "no version" result but retries a failed --version on Linux', async () => {
    const pe = vi.fn(async () => null)
    const win = createVersionProbe({ platform: 'win32', cache: memoryVersionCache(), stat: () => ({ size: 1, mtimeMs: 1 }), readers: { readPe: pe, readSiblingDirs: async () => null } })
    await win('brave', 'C:\\brave.exe')
    await win('brave', 'C:\\brave.exe')
    expect(pe).toHaveBeenCalledTimes(1)
    const runner = vi.fn<VersionRunner>(async () => null)
    const linux = createVersionProbe({ platform: 'linux', runVersion: runner, cache: memoryVersionCache(), stat: () => ({ size: 1, mtimeMs: 1 }) })
    await linux('brave', '/usr/bin/brave')
    await linux('brave', '/usr/bin/brave')
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('persists to a JSON file across instances, tolerates corruption and caps its size', async () => {
    const file = path.join(work, 'engine-versions.json')
    const read = vi.fn(async () => '118.0.5461.60')
    const first = createVersionProbe({ platform: 'win32', cache: fileVersionCache(file), stat: () => ({ size: 5, mtimeMs: 7 }), readers: { readPe: read }, now: () => 0 })
    expect(await first('opera', 'C:\\opera.exe')).toBe('118.0.5461.60')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, entries: { 'C:\\opera.exe': { size: 5, mtimeMs: 7, version: '118.0.5461.60', method: 'pe-resource', probedAt: '1970-01-01T00:00:00.000Z' } } })
    const second = createVersionProbe({ platform: 'win32', cache: fileVersionCache(file), stat: () => ({ size: 5, mtimeMs: 7 }), readers: { readPe: read } })
    expect(await second('opera', 'C:\\opera.exe')).toBe('118.0.5461.60')
    expect(read).toHaveBeenCalledTimes(1)

    writeFileSync(file, '{not json')
    const recovered = fileVersionCache(file)
    expect(recovered.get('C:\\opera.exe')).toBeNull()
    for (let i = 0; i < VERSION_CACHE_MAX_ENTRIES + 5; i += 1) recovered.set(`exe-${i}`, { size: i, mtimeMs: i, version: null, method: 'none', probedAt: 'x' })
    const entries = Object.keys((JSON.parse(readFileSync(file, 'utf8')) as { entries: Record<string, unknown> }).entries)
    expect(entries).toHaveLength(VERSION_CACHE_MAX_ENTRIES)
    expect(entries[0]).toBe('exe-5')

    const errors: unknown[] = []
    const unwritable = fileVersionCache(path.join(work, 'missing-dir', 'v.json'), (err) => errors.push(err))
    unwritable.set('a', { size: 1, mtimeMs: 1, version: '1', method: 'none', probedAt: 'x' })
    expect(errors).toHaveLength(1)
    expect(unwritable.get('a')).toMatchObject({ version: '1' })
  })

  it('the detector uses the cache when its filesystem reports size and mtime', async () => {
    const runner = vi.fn<VersionRunner>(async () => 'Chromium 153.0.8010.52')
    const detector = createEngineDetector({
      getOverrides: () => ({}),
      platform: 'linux',
      env: { PATH: '' },
      fs: { isFile: (p) => p === '/usr/bin/chromium', stat: () => ({ size: 10, mtimeMs: 10 }) },
      runVersion: runner,
      versionCache: memoryVersionCache(),
      cacheTtlMs: 0,
    })
    expect((await detector.detectEngine('system-chromium')).version).toBe('153.0.8010.52')
    detector.invalidate()
    expect((await detector.detectEngine('system-chromium')).version).toBe('153.0.8010.52')
    expect(runner).toHaveBeenCalledTimes(1)
  })
})

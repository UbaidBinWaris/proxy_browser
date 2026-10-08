import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BundledBrowserEngine } from '../src/shared/types'
import { BUNDLED_BROWSER_ENGINES } from '../src/shared/types'
import {
  BUNDLED_BROWSERS_DIR_NAME,
  INSTALL_MARKER,
  WEBKIT_LIBS_DIR_NAME,
  WEBKIT_LIBS_ENV,
  bundledEngineVersion,
  candidateRevisions,
  composeLdLibraryPath,
  defaultPlaywrightCacheDir,
  hasCompleteBundle,
  readBrowsersJson,
  resolveBrowsersDir,
  resolveWebkitLibsDir,
  webkitLaunchEnv,
  webkitLibsDirFromEnv,
} from '../src/main/browser/browsers-path'
import type { BrowsersJson } from '../src/main/browser/browsers-path'

const FIXTURE: BrowsersJson = {
  browsers: [
    { name: 'chromium', revision: '1243', browserVersion: '153.0.8010.12' },
    { name: 'chromium-headless-shell', revision: '1243', browserVersion: '153.0.8010.12' },
    { name: 'firefox', revision: '1543', browserVersion: '155.0' },
    { name: 'webkit', revision: '2359', revisionOverrides: { mac14: '2251', 'mac14-arm64': '2251' }, browserVersion: '26.6' },
    { name: 'ffmpeg', revision: '1011' },
  ],
}

function markInstalled(dir: string, engine: BundledBrowserEngine, revision: string): void {
  const engineDir = path.join(dir, `${engine}-${revision}`)
  mkdirSync(engineDir, { recursive: true })
  writeFileSync(path.join(engineDir, INSTALL_MARKER), '')
}

function markAll(dir: string): void {
  for (const engine of BUNDLED_BROWSER_ENGINES) markInstalled(dir, engine, candidateRevisions(engine, FIXTURE)[0]!)
}

describe('bundledEngineVersion', () => {
  it('reads the upstream browser version recorded for the bundled revision', () => {
    expect(bundledEngineVersion('chromium', FIXTURE)).toBe('153.0.8010.12')
    expect(bundledEngineVersion('webkit', FIXTURE)).toBe('26.6')
    expect(bundledEngineVersion('firefox', { browsers: [{ name: 'firefox', revision: '1' }] })).toBeNull()
  })
})

describe('browsers-path', () => {
  let root: string
  let resources: string
  let userDataBrowsers: string
  let bundledDir: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'proxy-qa-browsers-path-'))
    resources = path.join(root, 'resources')
    userDataBrowsers = path.join(root, 'userData', 'data', 'browsers')
    bundledDir = path.join(resources, BUNDLED_BROWSERS_DIR_NAME)
    mkdirSync(resources, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const base = (overrides: Partial<Parameters<typeof resolveBrowsersDir>[0]> = {}): Parameters<typeof resolveBrowsersDir>[0] => ({
    envPath: undefined,
    resourcesPath: resources,
    userDataBrowsersDir: userDataBrowsers,
    isPackaged: true,
    defaultCacheDir: path.join(root, 'dev-cache'),
    playwrightPackageRoot: path.join(root, 'pw'),
    ...overrides,
  })

  it('reads the real browsers.json and lists the default revision plus platform overrides', () => {
    const real = readBrowsersJson()
    expect(real.browsers.some((b) => b.name === 'chromium')).toBe(true)
    expect(candidateRevisions('webkit', FIXTURE)).toEqual(['2359', '2251'])
    expect(candidateRevisions('chromium', FIXTURE)).toEqual(['1243'])
    expect(candidateRevisions('webkit', { browsers: [] })).toEqual([])
  })

  it('prefers a bundled directory only when all three engines are complete', () => {
    expect(hasCompleteBundle(bundledDir, FIXTURE)).toBe(false)
    markInstalled(bundledDir, 'chromium', '1243')
    markInstalled(bundledDir, 'firefox', '1543')
    expect(hasCompleteBundle(bundledDir, FIXTURE)).toBe(false)
    // Partial bundle: a packaged build falls back to the provisioned directory.
    expect(resolveBrowsersDir(base(), FIXTURE)).toEqual({ dir: path.resolve(userDataBrowsers), source: 'provisioned' })

    markInstalled(bundledDir, 'webkit', '2359')
    expect(hasCompleteBundle(bundledDir, FIXTURE)).toBe(true)
    expect(resolveBrowsersDir(base(), FIXTURE)).toEqual({ dir: bundledDir, source: 'bundled' })
    // A bundle also wins in development builds.
    expect(resolveBrowsersDir(base({ isPackaged: false }), FIXTURE)).toEqual({ dir: bundledDir, source: 'bundled' })
  })

  it('accepts a revision override marker (frozen WebKit builds) as installed', () => {
    markInstalled(bundledDir, 'chromium', '1243')
    markInstalled(bundledDir, 'firefox', '1543')
    markInstalled(bundledDir, 'webkit', '2251')
    expect(resolveBrowsersDir(base(), FIXTURE).source).toBe('bundled')
  })

  it('ignores a bundle whose markers are missing even if the directories exist', () => {
    for (const engine of BUNDLED_BROWSER_ENGINES) mkdirSync(path.join(bundledDir, `${engine}-${candidateRevisions(engine, FIXTURE)[0]}`), { recursive: true })
    expect(resolveBrowsersDir(base(), FIXTURE)).toEqual({ dir: path.resolve(userDataBrowsers), source: 'provisioned' })
  })

  it('uses <userData>/data/browsers when packaged without a bundle and the dev cache otherwise', () => {
    expect(resolveBrowsersDir(base(), FIXTURE)).toEqual({ dir: path.resolve(userDataBrowsers), source: 'provisioned' })
    expect(resolveBrowsersDir(base({ isPackaged: false }), FIXTURE)).toEqual({ dir: path.join(root, 'dev-cache'), source: 'dev-cache' })
    const computed = resolveBrowsersDir(base({ isPackaged: false, defaultCacheDir: null }), FIXTURE)
    expect(computed).toEqual({ dir: defaultPlaywrightCacheDir(), source: 'dev-cache' })
    expect(computed.dir).toContain('ms-playwright')
  })

  it('lets PLAYWRIGHT_BROWSERS_PATH win over a complete bundle', () => {
    markAll(bundledDir)
    const custom = path.join(root, 'custom')
    expect(resolveBrowsersDir(base({ envPath: custom }), FIXTURE)).toEqual({ dir: path.resolve(custom), source: 'env' })
    expect(resolveBrowsersDir(base({ envPath: '   ' }), FIXTURE).source).toBe('bundled')
    expect(resolveBrowsersDir(base({ envPath: '0' }), FIXTURE)).toEqual({ dir: path.join(root, 'pw', '.local-browsers'), source: 'env' })
  })

  it('classifies an env path that points at the bundled or provisioned directory back to that source', () => {
    markAll(bundledDir)
    // The bootstrap exports the chosen directory to the env; the provisioner must report the same source.
    expect(resolveBrowsersDir(base({ envPath: bundledDir }), FIXTURE)).toEqual({ dir: bundledDir, source: 'bundled' })
    expect(resolveBrowsersDir(base({ envPath: `${bundledDir}${path.sep}` }), FIXTURE).source).toBe('bundled')
    expect(resolveBrowsersDir(base({ envPath: userDataBrowsers }), FIXTURE)).toEqual({ dir: path.resolve(userDataBrowsers), source: 'provisioned' })
    // An incomplete bundle pointed at explicitly is just an env override.
    rmSync(path.join(bundledDir, 'webkit-2359'), { recursive: true, force: true })
    expect(resolveBrowsersDir(base({ envPath: bundledDir }), FIXTURE).source).toBe('env')
  })

  it('finds the bundled WebKit host libraries directory on Linux only', () => {
    expect(resolveWebkitLibsDir(resources, 'linux')).toBeNull()
    const libs = path.join(resources, WEBKIT_LIBS_DIR_NAME)
    mkdirSync(libs)
    expect(resolveWebkitLibsDir(resources, 'linux')).toBe(libs)
    expect(resolveWebkitLibsDir(resources, 'win32')).toBeNull()
    expect(resolveWebkitLibsDir(resources, 'darwin')).toBeNull()
    writeFileSync(path.join(resources, 'not-a-dir'), '')
    expect(resolveWebkitLibsDir(path.join(resources, 'not-a-dir'), 'linux')).toBeNull()
  })

  it('reads the WebKit libs directory from the bootstrap env var', () => {
    expect(webkitLibsDirFromEnv({})).toBeNull()
    expect(webkitLibsDirFromEnv({ [WEBKIT_LIBS_ENV]: '  ' })).toBeNull()
    expect(webkitLibsDirFromEnv({ [WEBKIT_LIBS_ENV]: '/opt/app/resources/webkit-libs' })).toBe('/opt/app/resources/webkit-libs')
  })

  it('composes LD_LIBRARY_PATH with the bundled directory first and no duplicates', () => {
    expect(composeLdLibraryPath('/res/webkit-libs', undefined)).toBe('/res/webkit-libs')
    expect(composeLdLibraryPath('/res/webkit-libs', '')).toBe('/res/webkit-libs')
    expect(composeLdLibraryPath('/res/webkit-libs', '/appdir/usr/lib:/usr/local/lib')).toBe('/res/webkit-libs:/appdir/usr/lib:/usr/local/lib')
    expect(composeLdLibraryPath('/res/webkit-libs', '/appdir/usr/lib:/res/webkit-libs/')).toBe('/res/webkit-libs:/appdir/usr/lib')
    expect(composeLdLibraryPath('/res/webkit-libs', ' : :/x')).toBe('/res/webkit-libs:/x')
  })

  it('builds a complete string-only browser environment for WebKit', () => {
    const env = webkitLaunchEnv('/res/webkit-libs', { HOME: '/home/qa', LD_LIBRARY_PATH: '/appdir/usr/lib', EMPTY: '', GONE: undefined })
    expect(env).toEqual({ HOME: '/home/qa', EMPTY: '', LD_LIBRARY_PATH: '/res/webkit-libs:/appdir/usr/lib' })
    expect(Object.values(env).every((v) => typeof v === 'string')).toBe(true)
    expect(webkitLaunchEnv('/res/webkit-libs', { PATH: '/bin' }).LD_LIBRARY_PATH).toBe('/res/webkit-libs')
  })
})

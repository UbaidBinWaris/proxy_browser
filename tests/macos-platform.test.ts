/**
 * macOS (darwin) support, exercised with the platform injected so it runs on every CI host.
 * The packaged-app behaviour is covered by scripts/macos-smoke.mjs on the macos-latest runner.
 */
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { DESKTOP_APP_ID, MacReleaseAssetSchema, UsbReleaseSchema, macAssetFor, updateDeliveryFor } from '../src/shared/desktop'
import { INSTALLED_BROWSER_ENGINES } from '../src/shared/types'
import { keysDirFor, resolveAppPaths } from '../src/main/config/paths'
import { createDesktopIntegration, unsupportedSetupMessage } from '../src/main/desktop/integration'
import type { DesktopIntegrationOptions } from '../src/main/desktop/integration'
import { desktopLocations } from '../src/main/desktop/locations'
import { AFTER_EXIT_FLAG, restartPlan } from '../src/main/desktop/restart'
import { updateDirectories } from '../src/main/desktop/update-paths'
import { DOWNLOAD_PAGE_UPDATE_MESSAGE, UpdatePayloadSchema, createUpdateManager, downloadPageUrl, verifyUpdateEnvelope } from '../src/main/releases/updates'
import { candidateExecutables, createEngineDetector, locateExecutable } from '../src/main/browser/engine-detect'
import type { DetectFs } from '../src/main/browser/engine-detect'
import { parsePlistShortVersion, probeVersionUncached, readInfoPlistVersion } from '../src/main/browser/version-probe'
import { assessSafeStorage, selectKeyWrapper } from '../src/main/security/key-wrapper'

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})
async function tempDir(prefix: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), prefix))
  folders.push(folder)
  return folder
}

const sha = (char: string): string => char.repeat(64)
const legacyAssets = [
  { platform: 'win32', arch: 'x64', fileName: 'Proxy-QA-Browser-1.5.0-Windows-x64.exe', size: 100, sha256: sha('a') },
  { platform: 'linux', arch: 'x64', fileName: 'Proxy-QA-Browser-1.5.0-x86_64.AppImage', size: 200, sha256: sha('b') },
]
const macAssets = [
  { platform: 'darwin', arch: 'arm64', fileName: 'Proxy-QA-Browser-1.5.0-macOS-arm64.zip', size: 290, sha256: sha('c') },
  { platform: 'darwin', arch: 'arm64', fileName: 'Proxy-QA-Browser-1.5.0-macOS-arm64.dmg', size: 300, sha256: sha('d') },
  { platform: 'darwin', arch: 'x64', fileName: 'Proxy-QA-Browser-1.5.0-macOS-x64.zip', size: 310, sha256: sha('e') },
]
const manifest = (extra: Record<string, unknown> = {}) => ({
  format: 1,
  appId: DESKTOP_APP_ID,
  version: '1.5.0',
  releasedAt: '2026-10-09T10:00:00.000Z',
  notes: ['macOS builds'],
  assets: legacyAssets,
  ...extra,
})

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

describe('macOS paths', () => {
  it('keeps the vault key outside userData in ~/Library/Application Support', () => {
    expect(keysDirFor({ platform: 'darwin', env: { XDG_DATA_HOME: '/ignored', LOCALAPPDATA: '/ignored' }, homedir: '/Users/qa' })).toBe(
      path.join('/Users/qa', 'Library', 'Application Support', 'ProxyQABrowser-keys'),
    )
  })

  it('resolveAppPaths on darwin creates data under userData and an owner-only key folder', () => {
    const home = mkdtempSync(join(tmpdir(), 'macos-home-'))
    try {
      const userData = join(home, 'Library', 'Application Support', 'proxy-qa-browser')
      const paths = resolveAppPaths(userData, { platform: 'darwin', env: {}, homedir: home })
      expect(paths.data).toBe(join(userData, 'data'))
      expect(paths.browsers).toBe(join(userData, 'data', 'browsers'))
      expect(paths.keys).toBe(join(home, 'Library', 'Application Support', 'ProxyQABrowser-keys'))
      expect(path.relative(userData, paths.keys).startsWith('..')).toBe(true)
      if (process.platform !== 'win32') {
        expect(statSync(paths.keys).mode & 0o777).toBe(0o700)
        expect(statSync(paths.vault).mode & 0o777).toBe(0o700)
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('desktop folders per platform: macOS uses ~/Library/Application Support/ProxyQABrowser and ~/Applications', () => {
    expect(desktopLocations({ platform: 'darwin', env: { XDG_DATA_HOME: '/ignored' }, home: '/Users/qa', appData: '/Users/qa/Library/Application Support' })).toEqual({
      root: '/Users/qa/Library/Application Support/ProxyQABrowser',
      menuDirectory: '/Users/qa/Applications',
    })
    expect(desktopLocations({ platform: 'linux', env: {}, home: '/home/qa', appData: '/home/qa/.config' })).toEqual({
      root: '/home/qa/.local/share/proxy-qa-browser',
      menuDirectory: '/home/qa/.local/share/applications',
    })
    expect(desktopLocations({ platform: 'linux', env: { XDG_DATA_HOME: '/data' }, home: '/home/qa', appData: '/home/qa/.config' })).toEqual({
      root: '/data/proxy-qa-browser',
      menuDirectory: '/data/applications',
    })
    expect(desktopLocations({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\qa\\AppData\\Local' }, home: 'C:\\Users\\qa', appData: 'C:\\Users\\qa\\AppData\\Roaming' })).toEqual({
      root: 'C:\\Users\\qa\\AppData\\Local\\ProxyQABrowser',
      menuDirectory: 'C:\\Users\\qa\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs',
    })
  })
})

// ---------------------------------------------------------------------------
// Vault key backend
// ---------------------------------------------------------------------------

describe('macOS vault key backend', () => {
  const safeStorage = (available: boolean) => ({
    isEncryptionAvailable: () => available,
    encryptString: (text: string) => Buffer.from(`enc:${text}`),
    decryptString: (data: Buffer) => data.toString().slice(4),
  })
  const machine = { machineId: 'mac-uuid', username: 'qa', hostname: 'mac' } as never

  it('uses Electron safeStorage (Keychain) and labels it "macOS Keychain"; no Linux backend is consulted', () => {
    expect(assessSafeStorage(safeStorage(true), 'darwin')).toEqual({ usable: true, label: 'macOS Keychain', linuxBackend: null, reason: null })
    const selection = selectKeyWrapper({ safeStorage: safeStorage(true), platform: 'darwin', machine })
    expect(selection.primary).toMatchObject({ backend: 'os-keychain', label: 'macOS Keychain' })
  })

  it('falls back to the machine-derived key when the Keychain is unavailable', () => {
    const selection = selectKeyWrapper({ safeStorage: safeStorage(false), platform: 'darwin', machine })
    expect(selection.primary.backend).toBe('machine-derived')
    expect(selection.assessment.usable).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Browser detection (never executes a browser)
// ---------------------------------------------------------------------------

const PLIST = (version: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n\t<key>CFBundleExecutable</key>\n\t<string>Vivaldi</string>\n\t<key>CFBundleVersion</key>\n\t<string>7777.1</string>\n\t<key>CFBundleShortVersionString</key>\n\t<string>\n\t\t${version}\n\t</string>\n</dict>\n</plist>\n`

describe('macOS browser detection', () => {
  it('Info.plist: reads CFBundleShortVersionString (whitespace tolerated), never CFBundleVersion; binary plists yield null', () => {
    expect(parsePlistShortVersion(PLIST('7.6.3874.24'))).toBe('7.6.3874.24')
    expect(parsePlistShortVersion('<plist><dict><key>CFBundleVersion</key><string>1.2</string></dict></plist>')).toBeNull()
    expect(parsePlistShortVersion('bplist00\u00d1\u0001\u0002')).toBeNull()
    expect(parsePlistShortVersion('')).toBeNull()
  })

  it('reads the version from the bundle that contains the executable', async () => {
    const root = await tempDir('macos-apps-')
    const bundle = join(root, 'Applications', 'Vivaldi.app')
    await mkdir(join(bundle, 'Contents', 'MacOS'), { recursive: true })
    await writeFile(join(bundle, 'Contents', 'Info.plist'), PLIST('7.6.3874.24'))
    await writeFile(join(bundle, 'Contents', 'MacOS', 'Vivaldi'), '#!/bin/sh\nexit 99\n', { mode: 0o755 })
    expect(await readInfoPlistVersion(join(bundle, 'Contents', 'MacOS', 'Vivaldi'))).toBe('7.6.3874.24')
    expect(await readInfoPlistVersion(join(root, 'not-a-bundle', 'vivaldi'))).toBeNull()
    expect(await readInfoPlistVersion(join(root, 'Missing.app', 'Contents', 'MacOS', 'Missing'))).toBeNull()
  })

  it('checks /Applications first, then ~/Applications, for every vendor browser', () => {
    const env = { HOME: '/Users/qa' }
    for (const engine of INSTALLED_BROWSER_ENGINES) {
      const candidates = candidateExecutables(engine, 'darwin', env)
      expect(candidates, engine).toHaveLength(2)
      expect(candidates[0]!.startsWith('/Applications/')).toBe(true)
      expect(candidates[1]!.startsWith('/Users/qa/Applications/')).toBe(true)
      for (const candidate of candidates) expect(candidate).toMatch(/\.app\/Contents\/MacOS\/[^/]+$/)
    }
  })

  it('locates a per-user install in ~/Applications and reads its version from Info.plist without running it', async () => {
    const present = new Set(['/Users/qa/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'])
    const fs: DetectFs = { isFile: (file) => present.has(file) }
    expect(locateExecutable('brave', {}, { platform: 'darwin', env: { HOME: '/Users/qa', PATH: '/usr/bin' }, fs })).toMatchObject({
      executablePath: '/Users/qa/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      source: 'detected',
    })
    const runVersion = vi.fn(async () => '1.2.3')
    const readPlist = vi.fn(async () => '1.84.120')
    expect(await probeVersionUncached('brave', [...present][0]!, { platform: 'darwin', runVersion, readers: { readPlist } })).toEqual({ version: '1.84.120', method: 'info-plist' })
    const detector = createEngineDetector({
      getOverrides: () => ({}),
      platform: 'darwin',
      env: { HOME: '/Users/qa', PATH: '/usr/bin' },
      fs,
      runVersion,
      getHost: () => ({ platform: 'darwin', arch: 'arm64', winget: false }),
    })
    const engines = await detector.detect()
    const brave = engines.find((engine) => engine.id === 'brave')!
    expect(brave).toMatchObject({ available: true, installMethod: 'download-page', downloadUrl: 'https://brave.com/download/' })
    expect(engines.filter((engine) => engine.id !== 'brave').every((engine) => !engine.available && engine.installMethod === 'download-page')).toBe(true)
    expect(runVersion).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Release manifests with and without macOS downloads
// ---------------------------------------------------------------------------

/** The 1.4.0 schemas, verbatim in behaviour: strict `assets`, unknown keys dropped. */
const Legacy140UsbSchema = z.object({
  format: z.literal(1),
  appId: z.string(),
  version: z.string(),
  releasedAt: z.string().datetime(),
  notes: z.array(z.string().min(1).max(500)).max(30),
  assets: z
    .array(z.object({ platform: z.enum(['win32', 'linux']), arch: z.literal('x64'), fileName: z.string().regex(/^[A-Za-z0-9_.-]+\.(exe|AppImage)$/), size: z.int().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }))
    .min(1)
    .max(2),
})
const Legacy140FeedSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  assets: z
    .array(z.object({ platform: z.enum(['linux', 'win32']), arch: z.literal('x64'), url: z.string(), size: z.int().min(1), sha256: z.string(), fileName: z.string().regex(/^[A-Za-z0-9_.-]+\.(exe|AppImage)$/) }))
    .min(1)
    .max(4),
})

describe('release manifests with optional macOS assets', () => {
  it('old two-asset manifests stay valid and have no macAssets', () => {
    const release = UsbReleaseSchema.parse(manifest())
    expect(release.assets).toHaveLength(2)
    expect(release.macAssets).toBeUndefined()
  })

  it('accepts up to four DMG/ZIP files per release and rejects anything else', () => {
    expect(UsbReleaseSchema.parse(manifest({ macAssets })).macAssets).toHaveLength(3)
    const bad = (asset: Record<string, unknown>) => UsbReleaseSchema.safeParse(manifest({ macAssets: [{ ...macAssets[0], ...asset }] })).success
    expect(bad({ fileName: 'Proxy-QA-Browser-1.5.0-macOS-arm64.pkg' })).toBe(false)
    expect(bad({ fileName: '../escape.dmg' })).toBe(false)
    expect(bad({ arch: 'universal' })).toBe(false)
    expect(bad({ platform: 'linux' })).toBe(false)
    expect(bad({ sha256: 'nope' })).toBe(false)
    const five = Array.from({ length: 5 }, (_, i) => ({ ...macAssets[1], fileName: `Proxy-QA-Browser-1.5.0-macOS-arm64-${i}.dmg` }))
    expect(UsbReleaseSchema.safeParse(manifest({ macAssets: five })).success).toBe(false)
    // A darwin entry can never sneak into the strict `assets` list.
    expect(UsbReleaseSchema.safeParse(manifest({ assets: [legacyAssets[0], macAssets[1]] })).success).toBe(false)
  })

  it('manifests carrying macAssets remain valid for installed 1.4.0 copies (the extra key is dropped)', () => {
    const parsed = Legacy140UsbSchema.parse(manifest({ macAssets }))
    expect(parsed.assets).toEqual(legacyAssets)
    expect('macAssets' in parsed).toBe(false)
    const feed = { version: '1.5.0', assets: legacyAssets.map((a) => ({ ...a, url: `https://r.test/api/download/1.5.0/${a.fileName}` })), macAssets: macAssets.map((a) => ({ ...a, url: `https://r.test/api/download/1.5.0/${a.fileName}` })) }
    expect(Legacy140FeedSchema.parse(feed).assets).toHaveLength(2)
    expect(UpdatePayloadSchema.parse(feed).macAssets).toHaveLength(3)
  })

  it('offers the DMG for the Mac architecture, falling back to the ZIP', () => {
    const parsed = macAssets.map((asset) => MacReleaseAssetSchema.parse(asset))
    expect(macAssetFor(parsed, 'arm64')?.fileName).toBe('Proxy-QA-Browser-1.5.0-macOS-arm64.dmg')
    expect(macAssetFor(parsed, 'x64')?.fileName).toBe('Proxy-QA-Browser-1.5.0-macOS-x64.zip')
    expect(macAssetFor(parsed, 'ia32')).toBeNull()
    expect(macAssetFor(undefined, 'arm64')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Updates on macOS: check the signed feed, offer the download page, never install in-app
// ---------------------------------------------------------------------------

function signedFeed(payload: Record<string, unknown>) {
  const keys = generateKeyPairSync('ed25519')
  const body = JSON.stringify(payload)
  return {
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    envelope: { payload: body, signature: sign(null, Buffer.from(body), keys.privateKey).toString('base64') },
  }
}
const origin = 'https://releases.test'
const withUrls = <T extends { fileName: string }>(assets: T[]) => assets.map((a) => ({ ...a, url: `${origin}/api/download/1.5.0/${a.fileName}` }))

describe('macOS updates', () => {
  it('delivers updates through the download page on darwin only', () => {
    expect(updateDeliveryFor('darwin')).toBe('download-page')
    expect(updateDeliveryFor('win32')).toBe('in-app')
    expect(updateDeliveryFor('linux')).toBe('in-app')
    expect(downloadPageUrl({ feedUrl: `${origin}/api/updates/stable`, publicKey: 'k' })).toBe(`${origin}/#download`)
    expect(downloadPageUrl({ feedUrl: 'http://insecure.test/api/updates/stable', publicKey: 'k' })).toBeNull()
    expect(downloadPageUrl(null)).toBeNull()
  })

  it('a Mac sees the release for its architecture but is sent to the website instead of downloading', async () => {
    const feed = signedFeed({ version: '1.5.0', assets: withUrls(legacyAssets), macAssets: withUrls(macAssets) })
    const requested: string[] = []
    const fetchImpl = async (url: string): Promise<Response> => {
      requested.push(url)
      return Response.json(feed.envelope)
    }
    for (const [arch, fileName] of [
      ['arm64', 'Proxy-QA-Browser-1.5.0-macOS-arm64.dmg'],
      ['x64', 'Proxy-QA-Browser-1.5.0-macOS-x64.zip'],
    ] as const) {
      const updates = createUpdateManager({ config: { feedUrl: `${origin}/api/updates/stable`, publicKey: feed.publicKey }, currentVersion: '1.4.0', platform: 'darwin', arch, directory: await tempDir('mac-updates-'), fetchImpl })
      expect(await updates.check()).toEqual({ configured: true, available: true, currentVersion: '1.4.0', version: '1.5.0', fileName })
      await expect(updates.downloadRelease()).rejects.toThrow(DOWNLOAD_PAGE_UPDATE_MESSAGE)
    }
    // Only the feed was fetched: no macOS file was downloaded.
    expect(requested).toEqual([`${origin}/api/updates/stable`, `${origin}/api/updates/stable`])
  })

  it('a Mac sees no update in feeds without macOS assets; Windows and Linux ignore macAssets', async () => {
    const legacyOnly = signedFeed({ version: '1.5.0', assets: withUrls(legacyAssets) })
    const mac = createUpdateManager({ config: { feedUrl: `${origin}/api/updates/stable`, publicKey: legacyOnly.publicKey }, currentVersion: '1.4.0', platform: 'darwin', arch: 'arm64', directory: await tempDir('mac-updates-'), fetchImpl: async () => Response.json(legacyOnly.envelope) })
    expect(await mac.check()).toMatchObject({ available: false, version: '1.5.0' })
    await expect(mac.downloadRelease()).rejects.toThrow('Check for a verified update first.')

    const both = signedFeed({ version: '1.5.0', assets: withUrls(legacyAssets), macAssets: withUrls(macAssets) })
    expect(verifyUpdateEnvelope(both.envelope, both.publicKey).macAssets).toHaveLength(3)
    const linux = createUpdateManager({ config: { feedUrl: `${origin}/api/updates/stable`, publicKey: both.publicKey }, currentVersion: '1.4.0', platform: 'linux', arch: 'x64', directory: await tempDir('linux-updates-'), fetchImpl: async () => Response.json(both.envelope) })
    expect(await linux.check()).toMatchObject({ available: true, fileName: 'Proxy-QA-Browser-1.5.0-x86_64.AppImage' })
  })
})

// ---------------------------------------------------------------------------
// Desktop integration on macOS
// ---------------------------------------------------------------------------

async function macIntegration(extra: Partial<DesktopIntegrationOptions> = {}) {
  const folder = await tempDir('mac-desktop-')
  const app = join(folder, 'Applications', 'Proxy-QA-Browser.app')
  await mkdir(join(app, 'Contents', 'Resources'), { recursive: true })
  const openExternal = vi.fn(async () => undefined)
  const restart = vi.fn()
  const dirs = updateDirectories(join(folder, 'userData', 'data'))
  const locations = desktopLocations({ platform: 'darwin', env: {}, home: folder, appData: join(folder, 'Library', 'Application Support') })
  const integration = createDesktopIntegration({
    platform: 'darwin',
    arch: 'arm64',
    isPackaged: true,
    version: '1.4.0',
    executable: join(app, 'Contents', 'MacOS', 'Proxy-QA-Browser'),
    appImage: null,
    portableExecutable: null,
    resourcesPath: join(app, 'Contents', 'Resources'),
    root: locations.root,
    desktopDirectory: join(folder, 'Desktop'),
    menuDirectory: locations.menuDirectory,
    updatesDirectory: dirs.staged,
    onlineDownloadsDirectory: dirs.downloads,
    publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    releaseNotes: [],
    writeWindowsShortcut: () => true,
    reveal: vi.fn(),
    restart,
    downloadPageUrl: `${origin}/#download`,
    openExternal,
    ...extra,
  })
  return { integration, openExternal, restart, folder }
}

describe('macOS desktop integration', () => {
  it('reports computer setup as unsupported, with download-page updates, for arm64 and x64', async () => {
    for (const arch of ['arm64', 'x64']) {
      const { integration } = await macIntegration({ arch })
      expect(await integration.status()).toMatchObject({
        supported: false,
        platform: 'darwin',
        arch,
        installedVersion: null,
        installedPath: null,
        runningInstalledCopy: false,
        updateDelivery: 'download-page',
        downloadPageUrl: `${origin}/#download`,
      })
    }
  })

  it('refuses setup, USB and in-app online updates with the macOS explanation; nothing is restarted', async () => {
    const { integration, restart, folder } = await macIntegration()
    const message = unsupportedSetupMessage('darwin')
    expect(message).toContain('Applications')
    await expect(integration.setup({ desktop: true, startMenu: true })).rejects.toThrow(message)
    await expect(integration.showPinning()).rejects.toThrow(message)
    await writeFile(join(folder, 'Proxy-QA-Browser-Update.json'), '{}')
    await expect(integration.inspectUsb(join(folder, 'Proxy-QA-Browser-Update.json'))).rejects.toThrow(message)
    await expect(integration.launchInstalled()).rejects.toThrow('Set up this version on the computer first.')
    expect(await integration.finishPendingUpdate()).toBe('none')
    expect(restart).not.toHaveBeenCalled()
    expect(unsupportedSetupMessage('linux')).toBe('Computer setup is available in the Windows EXE and Linux AppImage releases.')
  })

  it('opens only the build-provided download page', async () => {
    const { integration, openExternal } = await macIntegration()
    await integration.openDownloadPage()
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(`${origin}/#download`)
    const { integration: withoutFeed } = await macIntegration({ downloadPageUrl: null })
    await expect(withoutFeed.openDownloadPage()).rejects.toThrow('no download page')
    expect((await withoutFeed.status()).downloadPageUrl).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Restart
// ---------------------------------------------------------------------------

describe('macOS restart', () => {
  it("uses Electron's relauncher (app.relaunch) without the Linux after-exit handshake", () => {
    expect(restartPlan('darwin', ['--user-data-dir=/Users/qa/Library/Application Support/proxy-qa-browser'], 4321)).toEqual({
      kind: 'relaunch',
      args: ['--user-data-dir=/Users/qa/Library/Application Support/proxy-qa-browser'],
    })
    expect(restartPlan('darwin', [], 1).args.some((arg) => arg.startsWith(AFTER_EXIT_FLAG))).toBe(false)
  })
})

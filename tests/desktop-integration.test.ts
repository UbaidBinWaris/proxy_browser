import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_APP_ID } from '../src/shared/desktop'
import { createDesktopIntegration, desktopEntry, fileSha256, newerInstalledCopy } from '../src/main/desktop/integration'
import type { DesktopIntegrationOptions } from '../src/main/desktop/integration'
import { captureRelaunchEnvironment, restoreRelaunchEnvironment } from '../src/main/desktop/relaunch-env'
import { LEGACY_APP_ID_SHA256, createAppIdMatcher, isLegacyDesktopEntryName } from '../src/main/desktop/app-identity'
import { createUpdateManager } from '../src/main/releases/updates'
import { updateDirectories } from '../src/main/desktop/update-paths'

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})
async function fixture(platform = 'linux', version = '1.2.0') {
  const folder = await mkdtemp(join(tmpdir(), 'desktop-integration-'))
  folders.push(folder)
  const runtime = join(folder, 'runtime')
  await mkdir(join(runtime, 'resources'), { recursive: true })
  await writeFile(join(runtime, 'Proxy-QA-Browser.exe'), 'runtime executable')
  await writeFile(join(runtime, 'resources', 'app.asar'), 'application code')
  await writeFile(join(runtime, 'resources', 'icon.png'), 'icon')
  const appImage = join(folder, 'Portable.AppImage')
  const portableExecutable = join(folder, 'Portable.exe')
  await writeFile(appImage, 'portable linux app')
  await writeFile(portableExecutable, 'portable windows app')
  const keys = generateKeyPairSync('ed25519')
  const restart = vi.fn()
  const reveal = vi.fn()
  const shortcuts: { path: string; target: string; appUserModelId: string }[] = []
  const options: DesktopIntegrationOptions = {
    platform,
    arch: 'x64',
    isPackaged: true,
    version,
    executable: join(runtime, 'Proxy-QA-Browser.exe'),
    appImage,
    portableExecutable,
    root: join(folder, 'local'),
    resourcesPath: join(runtime, 'resources'),
    desktopDirectory: join(folder, 'Desktop'),
    menuDirectory: join(folder, 'menu'),
    updatesDirectory: updateDirectories(join(folder, 'userData', 'data')).staged,
    onlineDownloadsDirectory: updateDirectories(join(folder, 'userData', 'data')).downloads,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    releaseNotes: ['New release'],
    writeWindowsShortcut: (path, value) => {
      shortcuts.push({ path, ...value })
      return true
    },
    restart,
    reveal,
  }
  const manager = createDesktopIntegration(options)
  async function manifest(changes: Record<string, unknown> = {}, useKeys = keys) {
    const fileName = platform === 'win32' ? 'Update.exe' : 'Update.AppImage'
    const assetPath = join(folder, fileName)
    await writeFile(assetPath, 'new signed application')
    const payload = JSON.stringify({
      format: 1,
      appId: DESKTOP_APP_ID,
      version: '1.3.0',
      releasedAt: new Date().toISOString(),
      notes: ['Update notes'],
      assets: [
        { platform, arch: 'x64', fileName, size: (await stat(assetPath)).size, sha256: await fileSha256(assetPath) },
      ],
      ...changes,
    })
    const path = join(folder, 'update.json')
    await writeFile(
      path,
      JSON.stringify({ payload, signature: sign(null, Buffer.from(payload), useKeys.privateKey).toString('base64') }),
    )
    return { path, assetPath }
  }
  return { folder, options, manager, manifest, keys, restart, reveal, shortcuts }
}

describe('computer setup', () => {
  it('copies Linux to a stable executable and creates launchers without changing user data', async () => {
    const f = await fixture()
    await mkdir(join(f.folder, 'userData'), { recursive: true })
    await writeFile(join(f.folder, 'userData', 'profiles.sqlite'), 'profiles and settings')
    const result = await f.manager.setup({ desktop: true, startMenu: true })
    expect(result.installedVersion).toBe('1.2.0')
    expect(result.desktopShortcut).toBe(true)
    expect(result.startMenuShortcut).toBe(true)
    expect(await readFile(result.installedPath!, 'utf8')).toBe('portable linux app')
    if (process.platform !== 'win32') expect((await stat(result.installedPath!)).mode & 0o111).toBe(0o111)
    expect(await readFile(join(f.options.menuDirectory, `${DESKTOP_APP_ID}.desktop`), 'utf8')).toContain(
      `Exec="${result.installedPath!.replace(/\\/g, '\\\\\\\\')}"`,
    )
    expect(await readFile(join(f.folder, 'userData', 'profiles.sqlite'), 'utf8')).toBe('profiles and settings')
    await f.manager.launchInstalled()
    expect(f.restart).toHaveBeenCalledWith(result.installedPath)
  })
  it('copies the extracted Windows runtime and targets shortcuts at its executable', async () => {
    const f = await fixture('win32')
    if (process.platform !== 'win32') await symlink(join(f.folder, 'missing-secret'), join(f.folder, 'runtime', 'external-link'))
    const result = await f.manager.setup({ desktop: true, startMenu: true })
    expect(await readFile(join(f.options.root, 'Application', 'resources', 'app.asar'), 'utf8')).toBe(
      'application code',
    )
    expect(f.shortcuts).toHaveLength(2)
    expect(
      f.shortcuts.every(
        (shortcut) => shortcut.target === result.installedPath && shortcut.appUserModelId === DESKTOP_APP_ID,
      ),
    ).toBe(true)
    expect(result.installedPath).not.toBe(f.options.portableExecutable)
    await expect(stat(join(f.options.root, 'Application', 'external-link'))).rejects.toThrow()
    await f.manager.showPinning()
    expect(f.reveal).toHaveBeenCalledWith(result.installedPath) // fake writer does not create a .lnk
  })
  it('keeps the prior managed application when a newer release is set up', async () => {
    const f = await fixture()
    await f.manager.setup({ desktop: false, startMenu: true })
    await writeFile(f.options.appImage!, 'updated application')
    const newer = createDesktopIntegration({ ...f.options, version: '1.3.0' })
    expect((await newer.setup({ desktop: false, startMenu: true })).installedVersion).toBe('1.3.0')
    expect(await readFile(join(f.options.root, 'Application.previous', 'Proxy-QA-Browser.AppImage'), 'utf8')).toBe(
      'portable linux app',
    )
    await expect(f.manager.setup({ desktop: true, startMenu: true })).rejects.toThrow('newer version')
  })
  it('leaves unknown destination folders untouched', async () => {
    const f = await fixture()
    await mkdir(join(f.options.root, 'Application'), { recursive: true })
    await writeFile(join(f.options.root, 'Application', 'important.txt'), 'owner data')
    await expect(f.manager.setup({ desktop: false, startMenu: false })).rejects.toThrow('unrecognized files')
    expect(await readFile(join(f.options.root, 'Application', 'important.txt'), 'utf8')).toBe('owner data')
  })
  it('does not replace a running computer copy', async () => {
    const f = await fixture()
    const status = await f.manager.setup({ desktop: false, startMenu: false })
    const running = createDesktopIntegration({ ...f.options, version: '1.3.0', appImage: status.installedPath })
    expect((await running.status()).runningInstalledCopy).toBe(true)
    await expect(running.setup({ desktop: false, startMenu: false })).rejects.toThrow('Open the newer release from USB')
  })
  it('keeps a usable application when shortcuts fail', async () => {
    const f = await fixture('win32')
    const manager = createDesktopIntegration({ ...f.options, writeWindowsShortcut: () => false })
    const result = await manager.setup({ desktop: true, startMenu: true })
    expect(result.installedPath).toBeTruthy()
    expect(result.warnings).toHaveLength(2)
  })
  it('rejects development builds and incompatible architectures', async () => {
    const f = await fixture()
    for (const change of [{ isPackaged: false }, { arch: 'arm64' }]) {
      await expect(
        createDesktopIntegration({ ...f.options, ...change }).setup({ desktop: true, startMenu: true }),
      ).rejects.toThrow('Windows EXE and Linux AppImage')
    }
  })
})

describe('signed USB updates', () => {
  it('verifies the release and copies it before restarting', async () => {
    const f = await fixture()
    const update = await f.manifest()
    expect(await f.manager.inspectUsb(update.path)).toMatchObject({ version: '1.3.0', notes: ['Update notes'] })
    await f.manager.applyUsb()
    const destination = f.restart.mock.calls[0]![0] as string
    expect(destination.startsWith(f.options.updatesDirectory)).toBe(true)
    expect(await readFile(destination, 'utf8')).toBe('new signed application')
    expect(JSON.parse(await readFile(join(f.options.root, 'pending-usb-update.json'), 'utf8')).managed).toBe(false)
  })
  it('completes a Windows USB update using the outer portable file and preserves the stable target', async () => {
    const f = await fixture('win32')
    const installed = await f.manager.setup({ desktop: false, startMenu: false })
    const update = await f.manifest()
    await f.manager.inspectUsb(update.path)
    await f.manager.applyUsb()
    const distribution = f.restart.mock.calls[0]![0] as string
    await writeFile(join(f.folder, 'runtime', 'resources', 'app.asar'), 'new code')
    const next = createDesktopIntegration({ ...f.options, version: '1.3.0', portableExecutable: distribution })
    await next.finishPendingUpdate()
    expect((await next.status()).installedPath).toBe(installed.installedPath)
    expect((await next.status()).installedVersion).toBe('1.3.0')
    expect(await readFile(join(f.options.root, 'Application', 'resources', 'app.asar'), 'utf8')).toBe('new code')
    await expect(stat(join(f.options.root, 'pending-usb-update.json'))).rejects.toThrow()
  })
  it('completes Linux updates and preserves menu shortcuts', async () => {
    const f = await fixture()
    await f.manager.setup({ desktop: false, startMenu: true })
    const update = await f.manifest()
    await f.manager.inspectUsb(update.path)
    await f.manager.applyUsb()
    const next = createDesktopIntegration({
      ...f.options,
      version: '1.3.0',
      appImage: f.restart.mock.calls[0]![0] as string,
    })
    await next.finishPendingUpdate()
    expect((await next.status()).installedVersion).toBe('1.3.0')
    expect((await next.status()).startMenuShortcut).toBe(true)
  })
  it('rejects signatures from a different publisher', async () => {
    const f = await fixture()
    const update = await f.manifest({}, generateKeyPairSync('ed25519'))
    await expect(f.manager.inspectUsb(update.path)).rejects.toThrow('not signed')
    expect(f.restart).not.toHaveBeenCalled()
  })
  it('rejects downgrades, wrong app identity and wrong platforms', async () => {
    const f = await fixture()
    for (const change of [
      { version: '1.1.0' },
      { appId: 'other-app' },
      { assets: [{ platform: 'win32', arch: 'x64', fileName: 'Other.exe', size: 1, sha256: 'a'.repeat(64) }] },
    ]) {
      const update = await f.manifest(change)
      await expect(f.manager.inspectUsb(update.path)).rejects.toThrow()
    }
  })
  it('rejects path traversal and corrupt files', async () => {
    const f = await fixture()
    const traversal = await f.manifest({
      assets: [{ platform: 'linux', arch: 'x64', fileName: '../Other.AppImage', size: 1, sha256: 'a'.repeat(64) }],
    })
    await expect(f.manager.inspectUsb(traversal.path)).rejects.toThrow()
    const update = await f.manifest()
    await writeFile(update.assetPath, 'bad application')
    await expect(f.manager.inspectUsb(update.path)).rejects.toThrow('incomplete or has changed')
  })
  it('rechecks the copied bytes if USB contents change after preview', async () => {
    const f = await fixture()
    const update = await f.manifest()
    await f.manager.inspectUsb(update.path)
    await writeFile(update.assetPath, 'modified after preview')
    await expect(f.manager.applyUsb()).rejects.toThrow('incomplete or has changed')
    expect(f.restart).not.toHaveBeenCalled()
    await expect(stat(join(f.options.root, 'pending-usb-update.json'))).rejects.toThrow()
  })
  it('turns an updated Windows portable copy into the computer copy with Desktop and Start shortcuts', async () => {
    const f = await fixture('win32')
    const update = await f.manifest()
    await f.manager.inspectUsb(update.path)
    await f.manager.applyUsb()
    const distribution = f.restart.mock.calls[0]![0] as string
    const next = createDesktopIntegration({ ...f.options, version: '1.3.0', portableExecutable: distribution })
    await next.finishPendingUpdate()
    const after = await next.status()
    expect(after.installedVersion).toBe('1.3.0')
    expect(f.shortcuts.map((shortcut) => shortcut.target)).toEqual([after.installedPath, after.installedPath])
    await expect(stat(join(f.options.root, 'pending-usb-update.json'))).rejects.toThrow()
  })
  it('turns an updated Linux AppImage into the computer copy with Desktop and menu entries', async () => {
    const f = await fixture()
    const update = await f.manifest()
    await f.manager.inspectUsb(update.path)
    await f.manager.applyUsb()
    const next = createDesktopIntegration({ ...f.options, version: '1.3.0', appImage: f.restart.mock.calls[0]![0] as string })
    await next.finishPendingUpdate()
    expect(await next.status()).toMatchObject({ installedVersion: '1.3.0', desktopShortcut: true, startMenuShortcut: true })
  })
  it('keeps the shortcut choices of an existing computer copy when it updates', async () => {
    const f = await fixture()
    await f.manager.setup({ desktop: false, startMenu: true })
    const update = await f.manifest()
    await f.manager.inspectUsb(update.path)
    await f.manager.applyUsb()
    const next = createDesktopIntegration({ ...f.options, version: '1.3.0', appImage: f.restart.mock.calls[0]![0] as string })
    await next.finishPendingUpdate()
    expect(await next.status()).toMatchObject({ installedVersion: '1.3.0', desktopShortcut: false, startMenuShortcut: true })
  })
  it('offers the newer computer copy when an older copy is opened, and opens it on request', async () => {
    const f = await fixture()
    await writeFile(f.options.appImage!, 'portable linux app 1.3.0')
    const newer = createDesktopIntegration({ ...f.options, version: '1.3.0' })
    const installed = await newer.setup({ desktop: false, startMenu: true })
    expect(newerInstalledCopy(await newer.status())).toBeNull()
    const older = createDesktopIntegration({ ...f.options, version: '1.2.0' })
    expect(newerInstalledCopy(await older.status())).toBe('1.3.0')
    await older.openInstalled()
    expect(f.restart).toHaveBeenCalledWith(installed.installedPath)
    const unsupported = createDesktopIntegration({ ...f.options, version: '1.2.0', isPackaged: false })
    expect(newerInstalledCopy(await unsupported.status())).toBeNull()
  })
  it('never auto-applies a pending update from a different running file', async () => {
    const f = await fixture()
    const update = await f.manifest()
    await f.manager.inspectUsb(update.path)
    await f.manager.applyUsb()
    const next = createDesktopIntegration({ ...f.options, version: '1.3.0' })
    await next.finishPendingUpdate()
    expect((await next.status()).installedPath).toBeNull()
    expect(await stat(join(f.options.root, 'pending-usb-update.json'))).toBeTruthy()
  })
})

describe('update outcome notice', () => {
  async function prepared() {
    const f = await fixture()
    const update = await f.manifest()
    await f.manager.inspectUsb(update.path)
    await f.manager.applyUsb()
    const distribution = f.restart.mock.calls[0]![0] as string
    const next = createDesktopIntegration({ ...f.options, version: '1.3.0', appImage: distribution, now: () => new Date('2026-10-09T08:00:00.000Z') })
    return { f, distribution, next }
  }
  it('records a success when the new version finishes the pending update, until dismissed', async () => {
    const { f, next } = await prepared()
    expect((await next.status()).lastUpdate).toBeNull()
    expect(await next.finishPendingUpdate()).toBe('finished')
    expect((await next.status()).lastUpdate).toEqual({
      version: '1.3.0',
      status: 'succeeded',
      message: 'Your shortcuts and local data were kept.',
      at: '2026-10-09T08:00:00.000Z',
    })
    // An older copy opened later does not claim the update.
    expect((await f.manager.status()).lastUpdate).toBeNull()
    await next.dismissUpdateNotice()
    expect((await next.status()).lastUpdate).toBeNull()
    expect(await next.finishPendingUpdate()).toBe('none')
  })
  it('records a user-safe failure, keeps the pending update and finishes it on retry', async () => {
    const { distribution, next } = await prepared()
    const original = await readFile(distribution)
    await writeFile(distribution, 'tampered after restart')
    await expect(next.finishPendingUpdate()).rejects.toThrow('The prepared USB update has changed.')
    expect((await next.status()).lastUpdate).toMatchObject({ version: '1.3.0', status: 'failed', message: 'The prepared USB update has changed.' })
    await expect(next.retryPendingUpdate()).rejects.toThrow('has changed')
    await writeFile(distribution, original)
    const after = await next.retryPendingUpdate()
    expect(after).toMatchObject({ installedVersion: '1.3.0', lastUpdate: { status: 'succeeded', version: '1.3.0' } })
  })
  it('retry without a pending update clears a stale failure and says so', async () => {
    const { f, distribution, next } = await prepared()
    await writeFile(distribution, 'tampered')
    await expect(next.finishPendingUpdate()).rejects.toThrow()
    // The user updated another way (or removed the record): nothing is left to finish.
    await rm(join(f.options.root, 'pending-usb-update.json'), { force: true })
    await expect(next.retryPendingUpdate()).rejects.toThrow('No update is waiting to finish')
    expect((await next.status()).lastUpdate).toBeNull()
  })
  it('drops an unreadable pending record and reports it once', async () => {
    const f = await fixture()
    await mkdir(f.options.root, { recursive: true })
    await writeFile(join(f.options.root, 'pending-usb-update.json'), '{broken')
    await expect(f.manager.finishPendingUpdate()).rejects.toThrow('unreadable')
    expect((await f.manager.status()).lastUpdate).toMatchObject({ version: '1.2.0', status: 'failed' })
    await expect(stat(join(f.options.root, 'pending-usb-update.json'))).rejects.toThrow()
    expect(await f.manager.finishPendingUpdate()).toBe('none')
  })
  it('records nothing for a pending update of another file', async () => {
    const f = await fixture()
    const update = await f.manifest()
    await f.manager.inspectUsb(update.path)
    await f.manager.applyUsb()
    const other = createDesktopIntegration({ ...f.options, version: '1.3.0' })
    expect(await other.finishPendingUpdate()).toBe('skipped')
    expect((await other.status()).lastUpdate).toBeNull()
    await expect(other.retryPendingUpdate()).rejects.toThrow('another copy')
  })
})

it('escapes desktop-entry field codes and reserved characters without invoking a shell', () => {
  const entry = desktopEntry('/home/a b/$quoted"%name.AppImage', '/home/a b/icon.png')
  expect(entry).toContain('Exec="/home/a b/\\\\$quoted\\\\"%%name.AppImage"')
  expect(entry).not.toContain('sh -c')
  expect(() => desktopEntry('/bad\nExec=evil', '/icon')).toThrow('Unsupported application path')
})

it('restores user browser overrides and discards expired wrapper environment on restart', () => {
  const env: NodeJS.ProcessEnv = {
    PLAYWRIGHT_BROWSERS_PATH: '/user/browser-cache',
    APPDIR: '/old/mount',
    APPIMAGE: '/usb/old.AppImage',
    LD_LIBRARY_PATH: '/old/mount/lib:/usr/lib',
    PORTABLE_EXECUTABLE_FILE: '/old.exe',
  }
  captureRelaunchEnvironment(env)
  env.PLAYWRIGHT_BROWSERS_PATH = '/generated/cache'
  env.PROXY_QA_WEBKIT_LIBS = '/old/mount/webkit'
  env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1'
  restoreRelaunchEnvironment(env)
  expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe('/user/browser-cache')
  expect(env.PROXY_QA_WEBKIT_LIBS).toBeUndefined()
  expect(env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS).toBeUndefined()
  expect(env.APPIMAGE).toBeUndefined()
  expect(env.PORTABLE_EXECUTABLE_FILE).toBeUndefined()
  expect(env.LD_LIBRARY_PATH).toBe('/usr/lib')
})

 it('prepares an online update only from the managed directory and rechecks its hash before restarting', async () => {
   const f = await fixture()
   await f.manager.setup({ desktop: true, startMenu: true })
   await mkdir(f.options.onlineDownloadsDirectory, { recursive: true })
   const path = join(f.options.onlineDownloadsDirectory, 'download.AppImage')
   await writeFile(path, 'new online application')
   const asset = { platform: 'linux' as const, arch: 'x64' as const, fileName: 'download.AppImage', size: (await stat(path)).size, sha256: await fileSha256(path), url: 'https://releases.test/download.AppImage' }
   await expect(f.manager.applyOnline({ path: f.options.appImage!, version: '1.3.0', asset })).rejects.toThrow('managed')
   await expect(f.manager.applyOnline({ path, version: '1.1.0', asset })).rejects.toThrow('incompatible')
   await writeFile(path, 'tampered online application')
   await expect(f.manager.applyOnline({ path, version: '1.3.0', asset })).rejects.toThrow()
   expect(f.restart).not.toHaveBeenCalled()
   await writeFile(path, 'new online application')
   await f.manager.applyOnline({ path, version: '1.3.0', asset })
   const pending = JSON.parse(await readFile(join(f.options.root, 'pending-usb-update.json'), 'utf8'))
   expect(pending).toMatchObject({ version: '1.3.0', managed: true, desktop: true, startMenu: true, sha256: asset.sha256 })
   expect(f.restart).toHaveBeenCalledWith(pending.executable)
   expect(await readFile(pending.executable, 'utf8')).toBe('new online application')
 })

describe('legacy application identity', () => {
  const legacyId = 'com.example.legacy-app'
  const legacy = createAppIdMatcher(DESKTOP_APP_ID, [createHash('sha256').update(legacyId).digest('hex')])

  it('accepts the current and listed legacy identities only', () => {
    expect(legacy.isAccepted(DESKTOP_APP_ID)).toBe(true)
    expect(legacy.isLegacy(DESKTOP_APP_ID)).toBe(false)
    expect(legacy.isAccepted(legacyId)).toBe(true)
    expect(legacy.isLegacy(legacyId)).toBe(true)
    expect(legacy.isAccepted('com.example.other-app')).toBe(false)
    expect(isLegacyDesktopEntryName(`${legacyId}.desktop`, legacy)).toBe(true)
    expect(isLegacyDesktopEntryName(`${DESKTOP_APP_ID}.desktop`, legacy)).toBe(false)
    expect(isLegacyDesktopEntryName(legacyId, legacy)).toBe(false)
  })
  it('stores legacy identities only as SHA-256 digests', () => {
    expect(LEGACY_APP_ID_SHA256.length).toBeGreaterThan(0)
    for (const digest of LEGACY_APP_ID_SHA256) expect(digest).toMatch(/^[a-f0-9]{64}$/)
  })
  it('updates an install made under a legacy identity and replaces its Linux menu entry', async () => {
    const f = await fixture()
    const application = join(f.options.root, 'Application')
    await mkdir(application, { recursive: true })
    await writeFile(join(application, 'Proxy-QA-Browser.AppImage'), 'old application')
    await writeFile(
      join(application, 'proxy-qa-application.json'),
      JSON.stringify({ appId: legacyId, platform: 'linux', version: '1.1.0', installedAt: new Date().toISOString() }),
    )
    await mkdir(f.options.menuDirectory, { recursive: true })
    await writeFile(join(f.options.menuDirectory, `${legacyId}.desktop`), '[Desktop Entry]\n')
    await writeFile(join(f.options.menuDirectory, 'unrelated.desktop'), '[Desktop Entry]\n')

    const manager = createDesktopIntegration({ ...f.options, appIds: legacy })
    expect((await manager.status()).installedVersion).toBe('1.1.0')
    const result = await manager.setup({ desktop: false, startMenu: true })

    expect(result.installedVersion).toBe('1.2.0')
    await expect(stat(join(f.options.menuDirectory, `${legacyId}.desktop`))).rejects.toThrow()
    expect(await readFile(join(f.options.menuDirectory, 'unrelated.desktop'), 'utf8')).toBe('[Desktop Entry]\n')
    expect(await readFile(join(f.options.menuDirectory, `${DESKTOP_APP_ID}.desktop`), 'utf8')).toContain('Exec=')
    const marker = JSON.parse(await readFile(join(application, 'proxy-qa-application.json'), 'utf8'))
    expect(marker.appId).toBe(DESKTOP_APP_ID)
  })
  it('rewrites managed Windows shortcuts of a legacy install with the current identity', async () => {
    const f = await fixture('win32')
    const application = join(f.options.root, 'Application')
    await mkdir(application, { recursive: true })
    await writeFile(join(application, 'Proxy-QA-Browser.exe'), 'old application')
    await writeFile(
      join(application, 'proxy-qa-application.json'),
      JSON.stringify({ appId: legacyId, platform: 'win32', version: '1.1.0', installedAt: new Date().toISOString() }),
    )
    const manager = createDesktopIntegration({ ...f.options, appIds: legacy })
    await manager.setup({ desktop: true, startMenu: true })
    expect(f.shortcuts).toHaveLength(2)
    expect(f.shortcuts.every((shortcut) => shortcut.appUserModelId === DESKTOP_APP_ID)).toBe(true)
    const marker = JSON.parse(await readFile(join(application, 'proxy-qa-application.json'), 'utf8'))
    expect(marker.appId).toBe(DESKTOP_APP_ID)
  })
  it('accepts signed USB manifests carrying a legacy identity and rejects unknown ones', async () => {
    const f = await fixture()
    const manager = createDesktopIntegration({ ...f.options, appIds: legacy })
    const accepted = await f.manifest({ appId: legacyId })
    expect((await manager.inspectUsb(accepted.path)).version).toBe('1.3.0')
    const rejected = await f.manifest({ appId: 'com.example.other-app' })
    await expect(manager.inspectUsb(rejected.path)).rejects.toThrow('different application')
  })
})

describe('online update end to end (downloader → installer, as wired in main.ts)', () => {
  it('applies a signed online update downloaded by the real update manager on Windows', async () => {
    const f = await fixture('win32')
    const dirs = updateDirectories(join(f.folder, 'userData', 'data'))
    const bytes = Buffer.from('new signed windows application')
    const fileName = 'Proxy-QA-Browser-1.3.0-Windows-x64.exe'
    const payload = JSON.stringify({
      version: '1.3.0',
      releasedAt: new Date().toISOString(),
      notes: ['Update notes'],
      assets: [
        {
          platform: 'win32',
          arch: 'x64',
          url: `https://releases.test/api/download/1.3.0/${fileName}`,
          fileName,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    })
    const envelope = { payload, signature: sign(null, Buffer.from(payload), f.keys.privateKey).toString('base64') }
    const updates = createUpdateManager({
      config: { feedUrl: 'https://releases.test/api/updates/stable', publicKey: f.options.publicKey! },
      currentVersion: '1.2.0',
      platform: 'win32',
      arch: 'x64',
      directory: dirs.downloads,
      fetchImpl: async (url) => (url.endsWith('/stable') ? Response.json(envelope) : new Response(bytes)),
    })
    const manager = createDesktopIntegration({ ...f.options, updatesDirectory: dirs.staged, onlineDownloadsDirectory: dirs.downloads })

    expect(await updates.check()).toMatchObject({ available: true, version: '1.3.0' })
    await manager.applyOnline(await updates.downloadRelease())

    const pending = JSON.parse(await readFile(join(f.options.root, 'pending-usb-update.json'), 'utf8'))
    expect(pending).toMatchObject({ version: '1.3.0', managed: false })
    expect(f.restart).toHaveBeenCalledWith(pending.executable)
    expect(await readFile(pending.executable)).toEqual(bytes)
  })
})

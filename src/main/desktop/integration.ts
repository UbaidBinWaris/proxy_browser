import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as fileSystem from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { AppIdSchema, DESKTOP_APP_ID, DESKTOP_APP_NAME, UsbReleaseSchema, updateDeliveryFor } from '@shared/desktop'
import type { DesktopSetupOptions, DesktopStatus, UsbRelease, UsbUpdatePreview } from '@shared/desktop'
import { AppException } from '../contracts'
import type { UpdateManager } from '../releases/updates'
import { newerVersion } from '../releases/updates'
import { LAST_UPDATE_FILE, createUpdateOutcomeStore, updateFailureMessage, visibleUpdateOutcome } from './update-outcome'
import { appIdMatcher as defaultAppIdMatcher, isLegacyDesktopEntryName } from './app-identity'
import type { AppIdMatcher } from './app-identity'

const InstallMarkerSchema = z.object({
  appId: AppIdSchema,
  platform: z.enum(['win32', 'linux']),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  installedAt: z.string(),
})
const MARKER = 'proxy-qa-application.json'
const PENDING = 'pending-usb-update.json'
const PendingUpdateSchema = z.object({
  version: z.string(),
  executable: z.string(),
  sha256: z.string(),
  managed: z.boolean(),
  desktop: z.boolean(),
  startMenu: z.boolean(),
})
/**
 * What finishing a pending update did: nothing was waiting ('none'), the record belongs to another
 * version or file ('skipped'), or this version replaced the computer copy ('finished').
 */
export type PendingUpdateResult = 'none' | 'skipped' | 'finished'
const exists = async (path: string): Promise<boolean> =>
  fileSystem.stat(path)
    .then(() => true)
    .catch(() => false)

export async function fileSha256(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

/** Desktop entries have their own escaping rules, not shell quoting. */
export function desktopEntry(executable: string, icon: string): string {
  if (/\r|\n|=/.test(executable) || /\r|\n/.test(icon))
    throw new AppException('INVALID_INPUT', 'Unsupported application path.')
  const argument = executable
    .replace(/\\/g, '\\\\\\\\')
    .replace(/["`$]/g, (char) => `\\\\${char}`)
    .replace(/%/g, '%%')
  const iconValue = icon.replace(/\\/g, '\\\\')
  return `[Desktop Entry]\nType=Application\nVersion=1.0\nName=${DESKTOP_APP_NAME}\nComment=Isolated browser profiles for desktop QA\nExec="${argument}"\nIcon=${iconValue}\nTerminal=false\nCategories=Development;Network;\nStartupWMClass=${DESKTOP_APP_ID}\n`
}

export interface DesktopIntegrationOptions {
  /** Electron supplies original-fs so app.asar is copied as a file, rather than a virtual directory. */
  fileSystem?: typeof fileSystem
  platform: string
  arch: string
  isPackaged: boolean
  version: string
  /** Windows: extracted application executable. */
  executable: string
  /** Linux: the outer AppImage, rather than its mounted executable. */
  appImage: string | null
  portableExecutable: string | null
  resourcesPath: string
  root: string
  desktopDirectory: string
  menuDirectory: string
  /** Where the executable a USB or online update restarts into is staged. */
  updatesDirectory: string
  /** Where the online update manager writes verified downloads; the only accepted source for `applyOnline`. */
  onlineDownloadsDirectory: string
  publicKey: string | null
  releaseNotes: string[]
  writeWindowsShortcut: (
    path: string,
    options: {
      target: string
      cwd: string
      icon: string
      iconIndex: number
      appUserModelId: string
      description: string
    },
  ) => boolean
  reveal: (path: string) => void
  restart: (executable: string) => void
  onInstalled?: (executable: string) => void
  /** Which identities count as this application; defaults to the current plus legacy identities. */
  appIds?: AppIdMatcher
  /** Clock for the stored update outcome (tests). */
  now?: () => Date
  /** The publisher's download page (from the signed feed's origin); null when the build has no feed. */
  downloadPageUrl?: string | null
  /** Opens `downloadPageUrl` in the default browser; nothing else is ever passed to it. */
  openExternal?: (url: string) => Promise<void>
}

/** Why computer setup is unavailable, worded for the platform the app runs on. */
export function unsupportedSetupMessage(platform: string): string {
  return platform === 'darwin'
    ? 'On macOS, drag Proxy QA Browser from its disk image into Applications. New versions are downloaded from the website.'
    : 'Computer setup is available in the Windows EXE and Linux AppImage releases.'
}

export function createDesktopIntegration(opts: DesktopIntegrationOptions) {
  const { chmod, copyFile, cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } = opts.fileSystem ?? fileSystem
  const windows = opts.platform === 'win32'
  const appIds = opts.appIds ?? defaultAppIdMatcher
  // macOS is never "supported" here: the .app is installed by dragging it from the DMG into
  // Applications, and new versions come from the download page (updateDeliveryFor('darwin')).
  const supported =
    opts.isPackaged && opts.arch === 'x64' && (windows || (opts.platform === 'linux' && !!opts.appImage))
  const updateDelivery = updateDeliveryFor(opts.platform)
  const downloadPageUrl = opts.downloadPageUrl ?? null
  const application = join(opts.root, 'Application')
  const previous = join(opts.root, 'Application.previous')
  const executableName = windows ? 'Proxy-QA-Browser.exe' : 'Proxy-QA-Browser.AppImage'
  const installedExecutable = join(application, executableName)
  const shortcutName = windows ? `${DESKTOP_APP_NAME}.lnk` : `${DESKTOP_APP_ID}.desktop`
  const desktopShortcut = join(opts.desktopDirectory, shortcutName)
  const menuShortcut = join(opts.menuDirectory, shortcutName)
  const currentExecutable = windows ? opts.executable : opts.appImage
  const distributionFile = windows ? opts.portableExecutable : opts.appImage
  const outcomes = createUpdateOutcomeStore({
    path: join(opts.root, LAST_UPDATE_FILE),
    fileSystem: opts.fileSystem ?? fileSystem,
    ...(opts.now ? { now: opts.now } : {}),
  })
  let warnings: string[] = []
  let busy = false
  let selected: { release: UsbRelease; asset: UsbRelease['assets'][number]; source: string } | null = null

  const requireSupported = (): void => {
    if (!supported) throw new AppException('INVALID_INPUT', unsupportedSetupMessage(opts.platform))
  }
  const readMarker = async (folder = application) => {
    try {
      // Markers written by earlier releases carry a legacy identity and remain valid installs.
      const marker = InstallMarkerSchema.parse(JSON.parse(await readFile(join(folder, MARKER), 'utf8')))
      return appIds.isAccepted(marker.appId) ? marker : null
    } catch {
      return null
    }
  }
  const status = async (): Promise<DesktopStatus> => {
    const marker = await readMarker()
    const installed = !!marker && marker.platform === opts.platform && (await exists(installedExecutable))
    return {
      supported,
      platform: opts.platform,
      arch: opts.arch,
      currentVersion: opts.version,
      installedVersion: installed ? marker.version : null,
      installedPath: installed ? installedExecutable : null,
      runningInstalledCopy:
        installed && !!currentExecutable && resolve(currentExecutable) === resolve(installedExecutable),
      desktopShortcut: await exists(desktopShortcut),
      startMenuShortcut: await exists(menuShortcut),
      offlineUpdatesReady: !!opts.publicKey,
      releaseNotes: opts.releaseNotes,
      warnings,
      lastUpdate: visibleUpdateOutcome(await outcomes.read(), opts.version),
      updateDelivery,
      downloadPageUrl,
    }
  }
  const exclusive = async <T>(run: () => Promise<T>): Promise<T> => {
    if (busy) throw new AppException('SESSION_LIMIT', 'Computer setup or an update is already in progress.')
    busy = true
    try {
      return await run()
    } finally {
      busy = false
    }
  }
  /** Linux entries are named after the identity; remove ones a legacy identity left so the menu has one entry. */
  const removeLegacyDesktopEntries = async (): Promise<void> => {
    if (windows) return
    for (const directory of new Set([opts.desktopDirectory, opts.menuDirectory])) {
      const names = await readdir(directory).catch(() => [] as string[])
      for (const name of names.filter((entry) => isLegacyDesktopEntryName(entry, appIds))) await rm(join(directory, name), { force: true })
    }
  }
  const writeShortcuts = async (options: DesktopSetupOptions): Promise<void> => {
    await removeLegacyDesktopEntries()
    for (const [enabled, path, label] of [
      [options.desktop, desktopShortcut, 'Desktop'],
      [options.startMenu, menuShortcut, windows ? 'Start menu' : 'Applications menu'],
    ] as const) {
      if (!enabled) continue
      try {
        await mkdir(dirname(path), { recursive: true })
        if (windows) {
          if (
            !opts.writeWindowsShortcut(path, {
              target: installedExecutable,
              cwd: application,
              icon: installedExecutable,
              iconIndex: 0,
              appUserModelId: DESKTOP_APP_ID,
              description: DESKTOP_APP_NAME,
            })
          )
            throw new Error('Shortcut could not be written')
        } else {
          await writeFile(path, desktopEntry(installedExecutable, join(application, 'icon.png')), { mode: 0o755 })
          await chmod(path, 0o755)
        }
      } catch {
        warnings.push(`${label} shortcut could not be created. You can still open the installed app directly.`)
      }
    }
  }
  const install = async (options: DesktopSetupOptions): Promise<DesktopStatus> => {
    requireSupported()
    warnings = []
    const before = await status()
    if (before.installedVersion && newerVersion(before.installedVersion, opts.version))
      throw new AppException(
        'INVALID_INPUT',
        'A newer version is already set up on this computer. Open that version instead.',
      )
    if (before.installedVersion === opts.version) {
      await writeShortcuts(options)
      opts.onInstalled?.(installedExecutable)
      return status()
    }
    if (before.runningInstalledCopy)
      throw new AppException('INVALID_INPUT', 'Open the newer release from USB to update the installed copy.')
    if ((await exists(application)) && !(await readMarker()))
      throw new AppException(
        'INVALID_INPUT',
        'The application destination contains unrecognized files. They have been left untouched.',
      )
    if ((await exists(previous)) && !(await readMarker(previous)))
      throw new AppException(
        'INVALID_INPUT',
        'The previous application folder contains unrecognized files. They have been left untouched.',
      )
    await mkdir(opts.root, { recursive: true, mode: 0o700 })
    const staging = join(opts.root, `Application.staging-${randomUUID()}`)
    let movedPrevious = false
    try {
      if (windows) {
        const source = dirname(opts.executable)
        if (
          relative(source, opts.root) === '' ||
          (!relative(source, opts.root).startsWith('..') && !isAbsolute(relative(source, opts.root)))
        )
          throw new AppException('INVALID_INPUT', 'The setup destination must be outside the running application.')
        await cp(source, staging, {
          recursive: true,
          force: false,
          errorOnExist: true,
          filter: async (path) => !(await lstat(path)).isSymbolicLink(),
        })
      } else {
        await mkdir(staging, { mode: 0o700 })
        await copyFile(opts.appImage!, join(staging, executableName))
        await chmod(join(staging, executableName), 0o755)
        await copyFile(join(opts.resourcesPath, 'icon.png'), join(staging, 'icon.png'))
      }
      if (!(await exists(join(staging, executableName))))
        throw new AppException('INTERNAL', 'The application copy is incomplete.')
      await writeFile(
        join(staging, MARKER),
        JSON.stringify({
          appId: DESKTOP_APP_ID,
          platform: opts.platform,
          version: opts.version,
          installedAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      )
      if (await exists(application)) {
        await rm(previous, { recursive: true, force: true })
        await rename(application, previous)
        movedPrevious = true
      }
      try {
        await rename(staging, application)
      } catch (error) {
        if (movedPrevious) await rename(previous, application)
        throw error
      }
      await writeShortcuts(options)
      opts.onInstalled?.(installedExecutable)
      return status()
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
  const verifyAsset = async (source: string, asset: UsbRelease['assets'][number]): Promise<void> => {
    const details = await lstat(source)
    if (!details.isFile() || details.size !== asset.size || (await fileSha256(source)) !== asset.sha256)
      throw new AppException(
        'INVALID_INPUT',
        'The USB update file is incomplete or has changed. Copy the release again.',
      )
  }
  /** Failures are recorded without masking the original error (the outcome file is best effort). */
  const recordFailure = async (version: string, error: unknown): Promise<void> => {
    await outcomes.record(version, 'failed', updateFailureMessage(error)).catch(() => undefined)
  }
  const finishPending = async (): Promise<PendingUpdateResult> => {
    const path = join(opts.root, PENDING)
    if (!supported || !(await exists(path))) return 'none'
    let pending: z.infer<typeof PendingUpdateSchema>
    try {
      pending = PendingUpdateSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    } catch {
      // An unreadable record can never complete; drop it so the next check or USB update starts clean.
      await rm(path, { force: true })
      const error = new AppException(
        'INVALID_INPUT',
        'The prepared update record is unreadable. Check for updates again or open the new release directly.',
      )
      await recordFailure(opts.version, error)
      throw error
    }
    if (
      pending.version !== opts.version ||
      !distributionFile ||
      resolve(pending.executable) !== resolve(distributionFile)
    )
      return 'skipped'
    try {
      if ((await fileSha256(distributionFile)) !== pending.sha256)
        throw new AppException('INVALID_INPUT', 'The prepared USB update has changed.')
      // A portable copy that updated itself becomes the computer copy. Otherwise the file the user
      // opens next (their downloaded EXE or AppImage) would still be the old release.
      const shortcuts = pending.managed
        ? { desktop: pending.desktop, startMenu: pending.startMenu }
        : { desktop: true, startMenu: true }
      await exclusive(() => install(shortcuts))
      await rm(path)
    } catch (error) {
      await recordFailure(pending.version, error)
      throw error
    }
    await outcomes
      .record(pending.version, 'succeeded', 'Your shortcuts and local data were kept.')
      .catch(() => undefined)
    return 'finished'
  }
  return {
    status,
    setup: (options: DesktopSetupOptions) => exclusive(() => install(options)),
    async showPinning(): Promise<void> {
      requireSupported()
      const current = await status()
      if (!current.installedPath)
        throw new AppException('INVALID_INPUT', 'Set up the app on this computer before creating a pin.')
      await writeShortcuts({ desktop: false, startMenu: true })
      opts.reveal((await exists(menuShortcut)) ? menuShortcut : installedExecutable)
    },
    /** Restart into the computer copy, whatever its version (used when an older copy was opened). */
    async openInstalled(): Promise<void> {
      const current = await status()
      if (!current.installedPath) throw new AppException('INVALID_INPUT', 'Set up the app on this computer first.')
      opts.restart(current.installedPath)
    },
    async launchInstalled(): Promise<void> {
      const current = await status()
      if (!current.installedPath || current.installedVersion !== opts.version)
        throw new AppException('INVALID_INPUT', 'Set up this version on the computer first.')
      opts.restart(current.installedPath)
    },
    async inspectUsb(manifestPath: string): Promise<UsbUpdatePreview> {
      selected = null
      requireSupported()
      if (!opts.publicKey) throw new AppException('INVALID_INPUT', 'This build has no publisher key for USB updates.')
      if ((await lstat(manifestPath)).size > 100000)
        throw new AppException('INVALID_INPUT', 'The USB update file is too large.')
      const envelope = z
        .object({ payload: z.string().max(65536), signature: z.string().max(256) })
        .parse(JSON.parse(await readFile(manifestPath, 'utf8')))
      const key = createPublicKey(opts.publicKey)
      if (
        key.asymmetricKeyType !== 'ed25519' ||
        !verify(null, Buffer.from(envelope.payload), key, Buffer.from(envelope.signature, 'base64'))
      )
        throw new AppException('INVALID_INPUT', 'This USB update is not signed by your publisher.')
      const release = UsbReleaseSchema.parse(JSON.parse(envelope.payload))
      if (!appIds.isAccepted(release.appId))
        throw new AppException('INVALID_INPUT', 'This USB update is for a different application.')
      if (!newerVersion(release.version, opts.version))
        throw new AppException('INVALID_INPUT', 'Choose a release newer than the version currently running.')
      const asset = release.assets.find((item) => item.platform === opts.platform && item.arch === opts.arch)
      if (!asset || (windows ? !asset.fileName.endsWith('.exe') : !asset.fileName.endsWith('.AppImage')))
        throw new AppException('INVALID_INPUT', 'This USB release is not compatible with this computer.')
      const source = join(dirname(manifestPath), asset.fileName)
      await verifyAsset(source, asset)
      selected = { release, asset, source }
      return { version: release.version, fileName: asset.fileName, notes: release.notes, size: asset.size }
    },
    /** Only the main-process signed updater supplies this value; IPC accepts no path or manifest. */
    async applyOnline(update: Awaited<ReturnType<UpdateManager['downloadRelease']>>): Promise<void> {
      requireSupported()
      if (!newerVersion(update.version, opts.version) || update.asset.platform !== opts.platform || update.asset.arch !== opts.arch)
        throw new AppException('INVALID_INPUT', 'The verified update is incompatible with this computer.')
      if (dirname(resolve(update.path)) !== resolve(opts.onlineDownloadsDirectory))
        throw new AppException('INVALID_INPUT', 'The update is outside the managed download directory.')
      await verifyAsset(update.path, update.asset)
      selected = { source: update.path, asset: update.asset, release: {
        format: 1, appId: DESKTOP_APP_ID, version: update.version, releasedAt: new Date().toISOString(), notes: [], assets: [update.asset],
      } }
      await this.applyUsb()
    },
    async applyUsb(): Promise<void> {
      await exclusive(async () => {
        if (!selected) throw new AppException('INVALID_INPUT', 'Choose and verify a USB update first.')
        const update = selected
        await mkdir(opts.updatesDirectory, { recursive: true, mode: 0o700 })
        const destination = join(opts.updatesDirectory, `${update.asset.sha256.slice(0, 16)}-${update.asset.fileName}`)
        const partial = `${destination}.${randomUUID()}.part`
        try {
          await copyFile(update.source, partial)
          await verifyAsset(partial, update.asset)
          await chmod(partial, windows ? 0o600 : 0o755)
          await rename(partial, destination)
          const current = await status()
          await mkdir(opts.root, { recursive: true, mode: 0o700 })
          await writeFile(
            join(opts.root, PENDING),
            JSON.stringify({
              version: update.release.version,
              executable: destination,
              sha256: update.asset.sha256,
              managed: !!current.installedPath,
              desktop: current.desktopShortcut,
              startMenu: current.startMenuShortcut,
            }),
            { mode: 0o600 },
          )
          opts.restart(destination)
        } finally {
          await rm(partial, { force: true })
        }
      })
    },
    /**
     * The verified new USB or online runtime replaces the old local copy now that the old process has
     * exited. The result (success or a user-safe failure message) is stored for the update notice.
     */
    finishPendingUpdate: finishPending,
    /** Run the pending update again after a failure (the notice's Retry); returns the fresh status. */
    async retryPendingUpdate(): Promise<DesktopStatus> {
      const result = await finishPending()
      if (result === 'none') {
        await outcomes.dismiss()
        throw new AppException('INVALID_INPUT', 'No update is waiting to finish. Check for updates in App & updates.')
      }
      if (result === 'skipped')
        throw new AppException(
          'INVALID_INPUT',
          'The prepared update belongs to another copy of the app. Open the new release to finish it.',
        )
      return status()
    },
    /** Hide the update notice; a pending update that failed is still retried on the next start. */
    async dismissUpdateNotice(): Promise<void> {
      await outcomes.dismiss()
    },
    /** Open the publisher's download page (macOS updates); the URL comes from the build, never from IPC. */
    async openDownloadPage(): Promise<void> {
      if (!downloadPageUrl || !opts.openExternal)
        throw new AppException('INVALID_INPUT', 'This build has no download page. Get the new version from the publisher.')
      await opts.openExternal(downloadPageUrl)
    },
  }
}
export type DesktopIntegration = ReturnType<typeof createDesktopIntegration>

/**
 * The version of a newer computer copy when an older copy (an old downloaded EXE or AppImage)
 * was opened instead; null when there is nothing better to offer.
 */
export function newerInstalledCopy(status: DesktopStatus): string | null {
  if (!status.supported || status.runningInstalledCopy || !status.installedVersion || !status.installedPath) return null
  return newerVersion(status.installedVersion, status.currentVersion) ? status.installedVersion : null
}

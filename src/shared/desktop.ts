import { z } from 'zod'

/**
 * Keep this identity stable across releases: Windows pins and Linux desktop entries use it.
 * Identities of earlier releases stay accepted through src/main/desktop/app-identity.ts.
 */
export const DESKTOP_APP_ID = 'com.ubaidbinwaris.proxy-qa-browser'
/** Reverse-DNS application identity; whether it is accepted is decided in the main process. */
export const AppIdSchema = z.string().regex(/^[a-z0-9]+(\.[a-z0-9-]+)+$/).max(200)
export const DESKTOP_APP_NAME = 'Proxy QA Browser'
export const USB_MANIFEST_NAME = 'Proxy-QA-Browser-Update.json'
export const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/** True when `candidate` is a strictly higher x.y.z release than `current`; false for anything malformed. */
export function newerVersion(candidate: string, current: string): boolean {
  const left = candidate.split('.').map(Number),
    right = current.split('.').map(Number)
  if (
    left.length !== 3 ||
    right.length !== 3 ||
    [...left, ...right].some((part) => !Number.isSafeInteger(part) || part < 0)
  )
    return false
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index]! > right[index]!
  return false
}

/**
 * How the last USB or online update ended, as recorded by the new version when it finished
 * (or failed to finish) replacing the computer copy. `message` is user-facing and path-free.
 */
export const UpdateOutcomeSchema = z.object({
  version: z.string().regex(RELEASE_VERSION),
  status: z.enum(['succeeded', 'failed']),
  message: z.string().max(500),
  at: z.string().datetime(),
})
export type UpdateOutcome = z.infer<typeof UpdateOutcomeSchema>

/** Result of the latest signed-feed check (the startup check or a remembered one); never a download. */
export interface UpdateAvailability {
  available: boolean
  /** The newer release, when the feed offered one. */
  version: string | null
  checkedAt: string
}

/**
 * How a newer release reaches this computer:
 * - 'in-app': the signed release is downloaded (online) or copied (USB), verified and restarted into
 *   (Windows EXE, Linux AppImage);
 * - 'download-page': the app only checks the signed feed and opens the publisher's download page; the
 *   user replaces the app themselves (macOS: replacing a running, signed .app bundle in place is not
 *   done by this app — see docs/DISTRIBUTION.md → macOS).
 */
export type UpdateDelivery = 'in-app' | 'download-page'

export function updateDeliveryFor(platform: string): UpdateDelivery {
  return platform === 'darwin' ? 'download-page' : 'in-app'
}

export const DesktopSetupOptionsSchema = z.object({ desktop: z.boolean(), startMenu: z.boolean() })
export type DesktopSetupOptions = z.infer<typeof DesktopSetupOptionsSchema>

export interface UsbUpdatePreview {
  version: string
  fileName: string
  notes: string[]
  size: number
}

export interface DesktopStatus {
  supported: boolean
  platform: string
  arch: string
  currentVersion: string
  installedVersion: string | null
  installedPath: string | null
  runningInstalledCopy: boolean
  desktopShortcut: boolean
  startMenuShortcut: boolean
  offlineUpdatesReady: boolean
  releaseNotes: string[]
  warnings: string[]
  /** The last update result still worth showing (a success for this version, or a failure); null once dismissed. */
  lastUpdate: UpdateOutcome | null
  /** 'download-page' on macOS: updates are offered as a link to the publisher's download page. */
  updateDelivery: UpdateDelivery
  /** The publisher's download page (derived from the signed feed's origin); null without a feed. */
  downloadPageUrl: string | null
}

const ReleaseSizeSchema = z
  .int()
  .min(1)
  .max(2 * 1024 * 1024 * 1024)
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

/** Architectures macOS releases are built for (separate DMG/ZIP per architecture, no universal app). */
export const MAC_RELEASE_ARCHES = ['arm64', 'x64'] as const

/**
 * A macOS download (DMG, or the ZIP of the same .app). macOS assets travel in a separate `macAssets`
 * list: releases up to 1.4.x parse `assets` strictly (platform win32/linux, at most two entries) but
 * drop unknown keys, so manifests that add macOS downloads stay valid for every installed copy.
 */
export const MacReleaseAssetSchema = z.object({
  platform: z.literal('darwin'),
  arch: z.enum(MAC_RELEASE_ARCHES),
  fileName: z.string().regex(/^[A-Za-z0-9_.-]+\.(dmg|zip)$/),
  size: ReleaseSizeSchema,
  sha256: Sha256Schema,
})
export type MacReleaseAsset = z.infer<typeof MacReleaseAssetSchema>
/** Up to a DMG and a ZIP for each architecture. */
export const MacReleaseAssetsSchema = z.array(MacReleaseAssetSchema).max(4)

/** The download a Mac should be offered: the DMG for its architecture, else the ZIP; null when neither exists. */
export function macAssetFor<T extends MacReleaseAsset>(assets: readonly T[] | undefined, arch: string): T | null {
  const matching = (assets ?? []).filter((asset) => asset.arch === arch)
  return matching.find((asset) => asset.fileName.endsWith('.dmg')) ?? matching[0] ?? null
}

export const UsbReleaseSchema = z.object({
  format: z.literal(1),
  appId: AppIdSchema,
  version: z.string().regex(RELEASE_VERSION),
  releasedAt: z.string().datetime(),
  notes: z.array(z.string().min(1).max(500)).max(30),
  assets: z
    .array(
      z.object({
        platform: z.enum(['win32', 'linux']),
        arch: z.literal('x64'),
        fileName: z.string().regex(/^[A-Za-z0-9_.-]+\.(exe|AppImage)$/),
        size: ReleaseSizeSchema,
        sha256: Sha256Schema,
      }),
    )
    .min(1)
    .max(2),
  /** Optional macOS downloads (see MacReleaseAssetSchema); absent in manifests before macOS builds. */
  macAssets: MacReleaseAssetsSchema.optional(),
})
export type UsbRelease = z.infer<typeof UsbReleaseSchema>

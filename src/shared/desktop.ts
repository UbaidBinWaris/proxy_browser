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
        size: z
          .int()
          .min(1)
          .max(2 * 1024 * 1024 * 1024),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(1)
    .max(2),
})
export type UsbRelease = z.infer<typeof UsbReleaseSchema>

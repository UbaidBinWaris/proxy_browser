/**
 * Window icon for Linux. Windows takes the icon embedded in the executable (build/icons/icon.ico)
 * and macOS the bundle icon, but on Linux a BrowserWindow without `icon` shows the generic Electron
 * mark in the title bar / task switcher (an AppImage is not always integrated into the desktop).
 *
 * Packaged builds ship build/icons/icon.png as `<resources>/icon.png` (electron-builder
 * `extraResources`); development runs read it straight from the repository.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const APP_ICON_RESOURCE = 'icon.png'

export interface ResolveAppIconOptions {
  platform: NodeJS.Platform | string
  isPackaged: boolean
  /** `process.resourcesPath`. */
  resourcesPath: string
  /** `app.getAppPath()` (the repository root in development). */
  appPath: string
  exists?: (path: string) => boolean
}

/** Absolute path of the 512 px PNG to pass as `BrowserWindow` `icon`, or null when none applies. */
export function resolveAppIconPath(opts: ResolveAppIconOptions): string | null {
  if (opts.platform !== 'linux') return null
  const exists = opts.exists ?? existsSync
  const packaged = join(opts.resourcesPath, APP_ICON_RESOURCE)
  const development = join(opts.appPath, 'build', 'icons', 'icon.png')
  const ordered = opts.isPackaged ? [packaged, development] : [development, packaged]
  return ordered.find((path) => exists(path)) ?? null
}

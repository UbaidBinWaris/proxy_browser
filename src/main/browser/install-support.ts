/**
 * How each engine can be obtained on this machine (`BrowserEngineInfo.installMethod`).
 *
 * - bundled engines (chromium / firefox / webkit) are Playwright downloads → 'bundled';
 * - Linux x86-64: Chrome, Edge, Vivaldi and Opera → 'vendor-package' (the official
 *   .deb is unpacked into the app's data folder without root, on any distribution);
 *   Brave → 'portable-archive' (its official portable zip); Opera GX has no Linux
 *   build → 'none'; the distribution's Chromium comes from its package manager →
 *   'download-page'. Other Linux architectures → 'download-page';
 * - Windows: every installed-kind browser through winget when it is available →
 *   'winget', otherwise the vendor page plus an install watcher → 'download-page';
 * - macOS: Chrome and Edge through Playwright's CLI (vendor .pkg) → 'playwright',
 *   everything else → 'download-page'.
 *
 * The download URLs double as the allow-list for `shell.openExternal`: nothing
 * else can ever be opened from the renderer.
 */
import type { BrowserEngine, EngineInstallMethod, InstalledBrowserEngine } from '@shared/types'
import { isBundledEngine } from '@shared/types'

import { WINGET_USER_SCOPE } from './installers/winget'

export const DOWNLOAD_URLS: Readonly<Record<InstalledBrowserEngine, string>> = {
  chrome: 'https://www.google.com/chrome/',
  msedge: 'https://www.microsoft.com/edge/download',
  brave: 'https://brave.com/download/',
  opera: 'https://www.opera.com/download',
  'opera-gx': 'https://www.opera.com/gx',
  vivaldi: 'https://vivaldi.com/download/',
  'system-chromium': 'https://www.chromium.org/getting-involved/download-chromium/',
}

/** Every URL the app may hand to `shell.openExternal`. */
export const ALLOWED_DOWNLOAD_URLS: ReadonlySet<string> = new Set(Object.values(DOWNLOAD_URLS))

/** Channels Playwright's CLI can install on behalf of the app (`cli.js install <channel>`, macOS). */
export const PLAYWRIGHT_INSTALLABLE_CHANNELS: readonly BrowserEngine[] = ['chrome', 'msedge']

/** Host facts that decide the install method. */
export interface InstallHost {
  platform: NodeJS.Platform
  arch: string
  /** `winget --version` ran successfully (Windows only; false elsewhere). */
  winget: boolean
}

export interface InstallMethodInfo {
  method: EngineInstallMethod
  note: string
}

export const USER_SPACE_NOTE = "Downloads the vendor's official Linux package and unpacks it into the app's data folder — no root or package manager needed, works on any x86-64 distribution."
export const PORTABLE_NOTE = "Downloads the vendor's official portable Linux build (checksum verified) into the app's data folder — no root needed."
export const OPERA_GX_LINUX_NOTE = 'Opera GX has no Linux version.'
export const SYSTEM_CHROMIUM_LINUX_NOTE = 'Install it with your package manager, e.g. sudo pacman -S chromium, sudo apt install chromium or sudo dnf install chromium — it is detected automatically.'
export const WINGET_USER_NOTE = 'Installs silently for your Windows account with winget — no administrator rights needed.'
export const WINGET_MACHINE_NOTE = 'Installs silently with winget. Windows may ask for administrator permission (UAC prompt).'
export const WINGET_EDGE_NOTE = 'Usually preinstalled on Windows; otherwise installs silently with winget.'
export const NO_WINGET_NOTE = "winget (App Installer) is not available, so the vendor's download page opens and the app detects the browser as soon as it is installed."
export const DOWNLOAD_PAGE_NOTE = "Opens the vendor's download page; the app detects the browser as soon as it is installed."
export const PLAYWRIGHT_NOTE = "Runs the vendor's official installer; macOS may ask for your password."
export const UNSUPPORTED_ARCH_NOTE = 'Automatic install is only available for x86-64 Linux. Install it from the vendor; it is detected automatically.'

const LINUX_METHODS: Readonly<Record<InstalledBrowserEngine, InstallMethodInfo>> = {
  chrome: { method: 'vendor-package', note: USER_SPACE_NOTE },
  msedge: { method: 'vendor-package', note: USER_SPACE_NOTE },
  vivaldi: { method: 'vendor-package', note: USER_SPACE_NOTE },
  opera: { method: 'vendor-package', note: USER_SPACE_NOTE },
  brave: { method: 'portable-archive', note: PORTABLE_NOTE },
  'opera-gx': { method: 'none', note: OPERA_GX_LINUX_NOTE },
  'system-chromium': { method: 'download-page', note: SYSTEM_CHROMIUM_LINUX_NOTE },
}

export function downloadUrlFor(engine: BrowserEngine): string | null {
  if (isBundledEngine(engine)) return null
  return DOWNLOAD_URLS[engine]
}

/** How `engine` is installed on `host`, with a one-sentence explanation for the UI. */
export function installMethodFor(engine: BrowserEngine, host: InstallHost): InstallMethodInfo {
  if (isBundledEngine(engine)) return { method: 'bundled', note: 'Playwright build downloaded into the app data folder.' }
  switch (host.platform) {
    case 'linux': {
      const linux = LINUX_METHODS[engine]
      if (host.arch !== 'x64' && linux.method !== 'none' && linux.method !== 'download-page') return { method: 'download-page', note: UNSUPPORTED_ARCH_NOTE }
      return linux
    }
    case 'win32': {
      if (!host.winget) return { method: 'download-page', note: NO_WINGET_NOTE }
      if (engine === 'msedge') return { method: 'winget', note: WINGET_EDGE_NOTE }
      return { method: 'winget', note: WINGET_USER_SCOPE.has(engine) ? WINGET_USER_NOTE : WINGET_MACHINE_NOTE }
    }
    case 'darwin':
      if (PLAYWRIGHT_INSTALLABLE_CHANNELS.includes(engine)) return { method: 'playwright', note: PLAYWRIGHT_NOTE }
      return { method: 'download-page', note: DOWNLOAD_PAGE_NOTE }
    default:
      return { method: 'download-page', note: DOWNLOAD_PAGE_NOTE }
  }
}

export function isAllowedDownloadUrl(url: string): boolean {
  return ALLOWED_DOWNLOAD_URLS.has(url)
}

import path from 'node:path'

/**
 * Folders used by computer setup (src/main/desktop/integration.ts), per platform:
 *
 *   Windows: root %LOCALAPPDATA%\ProxyQABrowser, menu = Start menu Programs folder
 *   Linux:   root ${XDG_DATA_HOME:-~/.local/share}/proxy-qa-browser, menu = …/applications
 *   macOS:   root ~/Library/Application Support/ProxyQABrowser, menu = ~/Applications
 *
 * On macOS computer setup itself is unavailable (the .app is dragged into Applications from the DMG);
 * the root only holds the update-outcome bookkeeping, next to the vault key folder
 * (~/Library/Application Support/ProxyQABrowser-keys, src/main/config/paths.ts).
 */
export interface DesktopLocationInput {
  platform: string
  env: NodeJS.ProcessEnv
  /** app.getPath('home') */
  home: string
  /** app.getPath('appData'): %APPDATA% on Windows, ~/Library/Application Support on macOS. */
  appData: string
}

export interface DesktopLocations {
  root: string
  menuDirectory: string
}

export function desktopLocations(input: DesktopLocationInput): DesktopLocations {
  if (input.platform === 'win32') {
    const join = path.win32.join
    return {
      root: join(input.env.LOCALAPPDATA?.trim() || input.appData, 'ProxyQABrowser'),
      menuDirectory: join(input.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    }
  }
  const join = path.posix.join
  if (input.platform === 'darwin')
    return {
      root: join(input.home, 'Library', 'Application Support', 'ProxyQABrowser'),
      menuDirectory: join(input.home, 'Applications'),
    }
  const dataHome = input.env.XDG_DATA_HOME?.trim() || join(input.home, '.local', 'share')
  return { root: join(dataHome, 'proxy-qa-browser'), menuDirectory: join(dataHome, 'applications') }
}

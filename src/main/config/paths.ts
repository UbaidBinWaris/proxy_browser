/**
 * Application filesystem layout.
 *
 * Runtime data lives under the Electron `userData` directory so the app never
 * writes next to its own binary (which may be read-only when installed).
 *
 * The one deliberate exception is the vault KEY directory: it sits outside
 * `userData` so that copying/backing up the profile directory (vault included)
 * does not carry the key along with it.
 *
 *   Windows: %LOCALAPPDATA%\ProxyQABrowser\keys
 *   Linux:   ${XDG_DATA_HOME:-~/.local/share}/proxy-qa-browser/keys
 *   macOS:   ~/Library/Application Support/ProxyQABrowser-keys
 *
 * Platform, environment and home directory are injectable for tests.
 */
import { chmodSync, mkdirSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { join } from 'node:path'

import type { AppPaths } from '../contracts'

export const DATABASE_FILE_NAME = 'proxy-qa.sqlite'
/** Owner-only directory mode for the vault and key directories (POSIX only; ignored on Windows). */
export const PRIVATE_DIR_MODE = 0o700

export interface ResolveAppPathsOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  homedir?: string
}

/** Directory holding the wrapped vault key for the current OS user. */
export function keysDirFor(opts: Required<ResolveAppPathsOptions>): string {
  switch (opts.platform) {
    case 'win32': {
      const localAppData = opts.env.LOCALAPPDATA?.trim() || join(opts.homedir, 'AppData', 'Local')
      return join(localAppData, 'ProxyQABrowser', 'keys')
    }
    case 'darwin':
      return join(opts.homedir, 'Library', 'Application Support', 'ProxyQABrowser-keys')
    default: {
      const dataHome = opts.env.XDG_DATA_HOME?.trim() || join(opts.homedir, '.local', 'share')
      return join(dataHome, 'proxy-qa-browser', 'keys')
    }
  }
}

/** `mkdir -p` with an owner-only mode; an already existing directory is tightened to the same mode on POSIX. */
export function ensurePrivateDir(dir: string, platform: NodeJS.Platform): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE })
  if (platform !== 'win32') chmodSync(dir, PRIVATE_DIR_MODE)
}

/**
 * Resolve every directory/file path the app uses and make sure the
 * directories exist (`mkdir -p` semantics). Vault and key directories are
 * created owner-only.
 */
export function resolveAppPaths(userDataDir: string, options: ResolveAppPathsOptions = {}): AppPaths {
  const resolved: Required<ResolveAppPathsOptions> = {
    platform: options.platform ?? process.platform,
    env: options.env ?? process.env,
    homedir: options.homedir ?? osHomedir(),
  }
  const data = join(userDataDir, 'data')
  const paths: AppPaths = {
    userData: userDataDir,
    data,
    screenshots: join(data, 'screenshots'),
    browsers: join(data, 'browsers'),
    database: join(data, DATABASE_FILE_NAME),
    logs: join(data, 'logs'),
    vault: join(userDataDir, 'vault'),
    keys: keysDirFor(resolved),
  }

  for (const dir of [paths.userData, paths.data, paths.screenshots, paths.browsers, paths.logs]) {
    mkdirSync(dir, { recursive: true })
  }
  ensurePrivateDir(paths.vault, resolved.platform)
  ensurePrivateDir(paths.keys, resolved.platform)

  return paths
}

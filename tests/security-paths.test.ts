import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { keysDirFor, resolveAppPaths } from '../src/main/config/paths'

describe('keysDirFor', () => {
  const home = '/home/qa'

  it('Linux honours XDG_DATA_HOME and defaults to ~/.local/share', () => {
    expect(keysDirFor({ platform: 'linux', env: { XDG_DATA_HOME: '/data/xdg' }, homedir: home })).toBe(join('/data/xdg', 'proxy-qa-browser', 'keys'))
    expect(keysDirFor({ platform: 'linux', env: { XDG_DATA_HOME: '  ' }, homedir: home })).toBe(join('/home/qa', '.local', 'share', 'proxy-qa-browser', 'keys'))
    expect(keysDirFor({ platform: 'linux', env: {}, homedir: home })).toBe(join('/home/qa', '.local', 'share', 'proxy-qa-browser', 'keys'))
  })

  it('Windows uses %LOCALAPPDATA% (never %APPDATA%, where userData lives)', () => {
    expect(keysDirFor({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\qa\\AppData\\Local', APPDATA: 'C:\\Users\\qa\\AppData\\Roaming' }, homedir: 'C:\\Users\\qa' })).toBe(
      join('C:\\Users\\qa\\AppData\\Local', 'ProxyQABrowser', 'keys'),
    )
    expect(keysDirFor({ platform: 'win32', env: {}, homedir: 'C:\\Users\\qa' })).toBe(join('C:\\Users\\qa', 'AppData', 'Local', 'ProxyQABrowser', 'keys'))
  })

  it('macOS uses a dedicated Application Support directory', () => {
    expect(keysDirFor({ platform: 'darwin', env: {}, homedir: '/Users/qa' })).toBe(join('/Users/qa', 'Library', 'Application Support', 'ProxyQABrowser-keys'))
  })
})

describe('resolveAppPaths', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'proxy-qa-paths-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('creates the data layout plus owner-only vault and keys directories outside userData', () => {
    const userData = join(root, 'userData')
    const paths = resolveAppPaths(userData, { platform: 'linux', env: { XDG_DATA_HOME: join(root, 'xdg') }, homedir: root })
    expect(paths.vault).toBe(join(userData, 'vault'))
    expect(paths.keys).toBe(join(root, 'xdg', 'proxy-qa-browser', 'keys'))
    expect(paths.keys.startsWith(userData)).toBe(false)
    for (const dir of [paths.data, paths.screenshots, paths.browsers, paths.logs, paths.vault, paths.keys]) {
      expect(statSync(dir).isDirectory(), dir).toBe(true)
    }
    if (process.platform !== 'win32') {
      expect(statSync(paths.vault).mode & 0o777).toBe(0o700)
      expect(statSync(paths.keys).mode & 0o777).toBe(0o700)
    }
  })
})

import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { keysWindowOptions } from '../src/main/windows/keys-window'
import { APP_ICON_RESOURCE, resolveAppIconPath } from '../src/main/windows/app-icon'

const base = { resourcesPath: '/opt/app/resources', appPath: '/repo' }
const packaged = join('/opt/app/resources', APP_ICON_RESOURCE)
const development = join('/repo', 'build', 'icons', 'icon.png')

describe('resolveAppIconPath', () => {
  it('uses the packaged resource first in packaged builds and the repo PNG in development', () => {
    const all = (): boolean => true
    expect(resolveAppIconPath({ ...base, platform: 'linux', isPackaged: true, exists: all })).toBe(packaged)
    expect(resolveAppIconPath({ ...base, platform: 'linux', isPackaged: false, exists: all })).toBe(development)
  })

  it('falls back to whichever file exists and returns null when none does', () => {
    expect(resolveAppIconPath({ ...base, platform: 'linux', isPackaged: true, exists: (p) => p === development })).toBe(development)
    expect(resolveAppIconPath({ ...base, platform: 'linux', isPackaged: true, exists: () => false })).toBeNull()
  })

  it('only applies on Linux (Windows/macOS use the executable or bundle icon)', () => {
    for (const platform of ['win32', 'darwin']) expect(resolveAppIconPath({ ...base, platform, isPackaged: true, exists: () => true })).toBeNull()
  })

  it('finds the committed icon from the repository root', () => {
    expect(resolveAppIconPath({ platform: 'linux', isPackaged: false, resourcesPath: '/nonexistent', appPath: join(__dirname, '..') })).toBe(join(__dirname, '..', 'build', 'icons', 'icon.png'))
  })
})

describe('keys window icon', () => {
  it('passes the icon through only when one is given', () => {
    const input = { parent: null, preload: 'p', backgroundColor: '#000', isPackaged: true, platform: 'linux' }
    expect(keysWindowOptions({ ...input, icon: '/x/icon.png' }).icon).toBe('/x/icon.png')
    expect('icon' in keysWindowOptions({ ...input, icon: null })).toBe(false)
    expect('icon' in keysWindowOptions(input)).toBe(false)
  })
})

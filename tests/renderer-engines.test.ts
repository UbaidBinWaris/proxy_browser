/**
 * Renderer presentation helpers for browser engines: short names, progress
 * wording, which action a row offers, custom vs auto-saved paths, and which
 * missing engines the launcher keeps selectable so they can be installed inline.
 */
import { describe, expect, it } from 'vitest'

import type { BrowserEngineInfo, DevicePresetInfo } from '../src/shared/types'
import { BROWSER_ENGINES, BROWSER_ENGINE_FAMILY, BROWSER_ENGINE_KIND, BROWSER_ENGINE_LABELS } from '../src/shared/types'
import { PHASE_LABELS, SOURCE_LABELS, engineAction, progressHeadline, shortEngineName, userPathsFrom } from '../src/renderer/src/lib/engines'
import { keepsSelectedEngine } from '../src/renderer/src/lib/launcherForm'
import { isEngineInstallable } from '../src/renderer/src/lib/profileForm'

function info(id: BrowserEngineInfo['id'], overrides: Partial<BrowserEngineInfo> = {}): BrowserEngineInfo {
  return {
    id,
    label: BROWSER_ENGINE_LABELS[id],
    family: BROWSER_ENGINE_FAMILY[id],
    kind: BROWSER_ENGINE_KIND[id],
    available: false,
    executablePath: null,
    version: null,
    source: 'not-found',
    note: '',
    installMethod: BROWSER_ENGINE_KIND[id] === 'bundled' ? 'bundled' : 'vendor-package',
    installNote: '',
    downloadUrl: null,
    managedInstall: false,
    ...overrides,
  }
}

describe('engine presentation helpers', () => {
  it('names, labels and progress headlines', () => {
    expect(shortEngineName({ label: 'Google Chrome (installed)' })).toBe('Google Chrome')
    expect(shortEngineName({ label: 'Chromium (system install)' })).toBe('Chromium')
    expect(SOURCE_LABELS['auto-saved']).toBe('Path saved automatically')
    expect(PHASE_LABELS.extracting).toBe('Extracting')
    expect(progressHeadline({ phase: 'downloading', percent: 41.6 })).toBe('Downloading · 42%')
    expect(progressHeadline({ phase: 'extracting', percent: null })).toBe('Extracting')
    expect(progressHeadline({ phase: 'done', percent: 100 })).toBe('Done')
    expect(progressHeadline({ phase: 'error', percent: 40 })).toBe('Failed')
  })

  it('offers Install / Get / Uninstall / nothing per method and availability', () => {
    expect(engineAction(info('brave', { installMethod: 'portable-archive' }))).toBe('install')
    expect(engineAction(info('chrome', { installMethod: 'winget' }))).toBe('install')
    expect(engineAction(info('msedge', { installMethod: 'playwright' }))).toBe('install')
    expect(engineAction(info('system-chromium', { installMethod: 'download-page' }))).toBe('get')
    expect(engineAction(info('opera-gx', { installMethod: 'none' }))).toBe('unavailable')
    expect(engineAction(info('opera', { available: true, managedInstall: true }))).toBe('uninstall')
    expect(engineAction(info('opera', { available: true, managedInstall: false }))).toBe('none-needed')
    expect(engineAction(info('chromium', { available: true, managedInstall: true }))).toBe('none-needed')
  })

  it('separates custom paths the user typed from auto-saved ones', () => {
    expect(userPathsFrom({ opera: '/home/qa/opera', brave: '/data/ib/brave/brave', chromium: '/x' }, { opera: 'user', brave: 'auto' })).toEqual({ opera: '/home/qa/opera' })
    expect(userPathsFrom({ vivaldi: '/opt/vivaldi/vivaldi' })).toEqual({ vivaldi: '/opt/vivaldi/vivaldi' })
  })
})

describe('missing engines stay selectable when they can be installed inline', () => {
  const desktop: DevicePresetInfo = { id: 'windows-desktop', label: 'Windows desktop', deviceType: 'desktop', playwrightDevice: null, viewportWidth: 1920, viewportHeight: 1080, userAgent: 'UA', supportedEngines: BROWSER_ENGINES }
  const phone: DevicePresetInfo = { ...desktop, id: 'iphone-15', deviceType: 'mobile', supportedEngines: BROWSER_ENGINES.filter((e) => e !== 'firefox') }
  const engines = [info('brave'), info('opera-gx', { installMethod: 'none' }), info('system-chromium', { installMethod: 'download-page' }), info('firefox', { available: true }), info('webkit')]

  it('keepsSelectedEngine', () => {
    expect(keepsSelectedEngine(engines, desktop, 'brave')).toBe(true)
    expect(keepsSelectedEngine(engines, desktop, 'system-chromium')).toBe(true)
    expect(keepsSelectedEngine(engines, desktop, 'opera-gx')).toBe(false)
    expect(keepsSelectedEngine(engines, desktop, 'webkit')).toBe(false)
    expect(keepsSelectedEngine(engines, phone, 'firefox')).toBe(false)
    expect(keepsSelectedEngine(engines, desktop, 'firefox')).toBe(true)
    expect(keepsSelectedEngine(null, desktop, 'brave')).toBe(true)
  })

  it('isEngineInstallable', () => {
    expect(isEngineInstallable(engines, 'brave')).toBe(true)
    expect(isEngineInstallable(engines, 'system-chromium')).toBe(true)
    expect(isEngineInstallable(engines, 'opera-gx')).toBe(false)
    expect(isEngineInstallable(engines, 'webkit')).toBe(false)
    expect(isEngineInstallable(null, 'brave')).toBe(false)
  })
})

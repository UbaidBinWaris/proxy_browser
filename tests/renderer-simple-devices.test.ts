import { describe, expect, it } from 'vitest'
import { AppSettingsSchema, DEFAULT_SETTINGS, SIMPLE_DEVICE_OS } from '../src/shared/types'
import { DEVICE_PRESETS } from '../src/main/browser/device-presets'
import { isLandscapeVariant, presetOs } from '../src/renderer/src/lib/devicePicker'
import { pickSimpleDevice, screenSizeLabel, simpleCatalog, simpleOsOf, simpleOsUnavailableReason, simplePool } from '../src/renderer/src/lib/simpleDevices'

describe('simple device picker (beta)', () => {
  it('is off by default, and settings saved before it existed load as off', () => {
    expect(DEFAULT_SETTINGS.simpleDevices).toBe(false)
    const { simpleDevices: _omitted, ...older } = { ...DEFAULT_SETTINGS, screenshotDir: '/tmp/shots' }
    expect(AppSettingsSchema.parse(older).simpleDevices).toBe(false)
  })

  it('offers Windows and macOS desktops and Android and iOS phones, and nothing else', () => {
    expect(SIMPLE_DEVICE_OS).toEqual(['windows', 'macos', 'android', 'ios'])
    const catalog = simpleCatalog(DEVICE_PRESETS)
    expect(catalog.length).toBeGreaterThan(0)
    for (const preset of catalog) {
      expect(preset.legacy, preset.id).not.toBe(true)
      expect(isLandscapeVariant(preset), preset.id).toBe(false)
      const os = presetOs(preset)
      expect(['windows', 'macos', 'android', 'ios'], preset.id).toContain(os)
      expect(preset.deviceType, preset.id).toBe(os === 'windows' || os === 'macos' ? 'desktop' : 'mobile')
    }
    // Hidden, not deleted: Linux, iPadOS and ChromeOS presets and tablets stay in the full catalog.
    for (const hidden of ['linux', 'ipados', 'chromeos'] as const) {
      expect(DEVICE_PRESETS.some((p) => presetOs(p) === hidden), hidden).toBe(true)
      expect(catalog.some((p) => presetOs(p) === hidden), hidden).toBe(false)
    }
    expect(DEVICE_PRESETS.some((p) => p.deviceType === 'tablet')).toBe(true)
    expect(catalog.some((p) => p.deviceType === 'tablet')).toBe(false)
    for (const os of SIMPLE_DEVICE_OS) expect(simplePool(DEVICE_PRESETS, os, null).length, os).toBeGreaterThan(0)
  })

  it('maps a preset to its system only when the simple picker offers it', () => {
    expect(simpleOsOf(DEVICE_PRESETS.find((p) => p.id === 'windows-desktop'))).toBe('windows')
    expect(simpleOsOf(DEVICE_PRESETS.find((p) => p.id === 'iphone-15'))).toBe('ios')
    expect(simpleOsOf(DEVICE_PRESETS.find((p) => p.deviceType === 'tablet'))).toBeNull()
    expect(simpleOsOf(DEVICE_PRESETS.find((p) => presetOs(p) === 'linux'))).toBeNull()
    expect(simpleOsOf(null)).toBeNull()
  })

  it('picks a random phone of the system, never the current one when another exists', () => {
    const current = simplePool(DEVICE_PRESETS, 'android', 'chromium')[0]!
    for (const roll of [0, 0.5, 0.999]) {
      const next = pickSimpleDevice(DEVICE_PRESETS, 'android', 'chromium', current, () => roll)
      expect(next).not.toBeNull()
      expect(presetOs(next!)).toBe('android')
      expect(next!.deviceType).toBe('mobile')
      expect(next!.id).not.toBe(current.id)
    }
    const desktop = pickSimpleDevice(DEVICE_PRESETS, 'windows', 'chromium', null, () => 0)
    expect(desktop?.deviceType).toBe('desktop')
    expect(presetOs(desktop!)).toBe('windows')
  })

  it('explains why phones are unavailable with Firefox, and keeps desktops available', () => {
    expect(simpleOsUnavailableReason(DEVICE_PRESETS, 'android', 'firefox')).toBe("Firefox can't emulate mobile devices")
    expect(simpleOsUnavailableReason(DEVICE_PRESETS, 'ios', 'firefox')).toBe("Firefox can't emulate mobile devices")
    expect(simpleOsUnavailableReason(DEVICE_PRESETS, 'windows', 'firefox')).toBeNull()
    expect(pickSimpleDevice(DEVICE_PRESETS, 'ios', 'firefox')).toBeNull()
    for (const os of SIMPLE_DEVICE_OS) expect(simpleOsUnavailableReason(DEVICE_PRESETS, os, 'chromium'), os).toBeNull()
  })

  it('labels the screen size the full-screen window will use', () => {
    expect(screenSizeLabel({ availWidth: 1920, availHeight: 1048 })).toBe('1920×1048')
    expect(screenSizeLabel({ availWidth: 0, availHeight: 0 })).toBeNull()
  })
})

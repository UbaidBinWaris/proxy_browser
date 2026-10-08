import { describe, expect, it } from 'vitest'
import { Cpu, Monitor } from 'lucide-react'
import { FaChrome } from 'react-icons/fa6'
import { SiApple, SiOpera, SiOperagx, SiSamsung } from 'react-icons/si'
import { BROWSER_ENGINES, DEVICE_BRANDS, DEVICE_OS } from '@shared/types'
import { DEVICE_PRESETS } from '../src/main/browser/device-presets'
import { BRAND_TILE_HEX, DEVICE_BRAND_MARKS, ENGINE_MARKS, OS_MARKS, contrastRatio, relativeLuminance } from '../src/renderer/src/lib/brandIcons'

describe('brand icons: mapping coverage', () => {
  it('has an explicit mark for every browser engine (no placeholders)', () => {
    expect(Object.keys(ENGINE_MARKS).sort()).toEqual([...BROWSER_ENGINES].sort())
    for (const engine of BROWSER_ENGINES) expect(typeof ENGINE_MARKS[engine].icon).toBe('function')
  })

  it('has a mark for every brand in the device catalog and in DEVICE_BRANDS', () => {
    const catalogBrands = new Set(DEVICE_PRESETS.map((preset) => preset.brand ?? 'Generic'))
    expect(catalogBrands.size).toBeGreaterThan(5)
    for (const brand of catalogBrands) expect(DEVICE_BRAND_MARKS[brand], brand).toBeDefined()
    expect(Object.keys(DEVICE_BRAND_MARKS).sort()).toEqual([...DEVICE_BRANDS].sort())
  })

  it('has a mark for every OS value and every OS in the device catalog', () => {
    expect(Object.keys(OS_MARKS).sort()).toEqual([...DEVICE_OS].sort())
    for (const preset of DEVICE_PRESETS) if (preset.os) expect(OS_MARKS[preset.os], preset.os).toBeDefined()
  })

  it('uses real marks for known values; generic glyphs only for the generic desktop and "other" OS', () => {
    expect(ENGINE_MARKS.chrome.icon).not.toBe(ENGINE_MARKS.chromium.icon)
    expect(ENGINE_MARKS.chromium.icon).toBe(FaChrome)
    expect(ENGINE_MARKS.opera.icon).toBe(SiOpera)
    expect(ENGINE_MARKS['opera-gx'].icon).toBe(SiOperagx)
    expect(DEVICE_BRAND_MARKS.Apple.icon).toBe(SiApple)
    expect(DEVICE_BRAND_MARKS.Samsung.icon).toBe(SiSamsung)
    const generic = new Set<unknown>([Monitor, Cpu])
    for (const brand of DEVICE_BRANDS) expect(generic.has(DEVICE_BRAND_MARKS[brand].icon), brand).toBe(brand === 'Generic')
    for (const os of DEVICE_OS) expect(generic.has(OS_MARKS[os]), os).toBe(os === 'other')
    expect(OS_MARKS.ios).toBe(SiApple)
    expect(OS_MARKS.macos).toBe(SiApple)
  })

  it('shows wordmark logos in a wider box', () => {
    for (const brand of ['Samsung', 'Nokia', 'LG'] as const) expect(DEVICE_BRAND_MARKS[brand].wordmarkWidth).toBeGreaterThan(2)
    expect(DEVICE_BRAND_MARKS.Apple.wordmarkWidth).toBeUndefined()
  })
})

describe('brand icons: colours', () => {
  it('computes WCAG contrast', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5)
    expect(relativeLuminance('#000000')).toBe(0)
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(() => relativeLuminance('blue')).toThrow()
  })

  it('keeps every engine colour at >= 3:1 against the tile', () => {
    for (const engine of BROWSER_ENGINES) {
      const color = ENGINE_MARKS[engine].color
      if (color === null) continue
      expect(color).toMatch(/^#[0-9A-F]{6}$/i)
      expect(contrastRatio(color, BRAND_TILE_HEX), engine).toBeGreaterThanOrEqual(3)
    }
  })

  it('gives Opera GX a colour distinct from Opera and uses the vendor primaries', () => {
    expect(ENGINE_MARKS['opera-gx'].color).not.toBe(ENGINE_MARKS.opera.color)
    expect(ENGINE_MARKS.chrome.color).toBe('#4285F4')
    expect(ENGINE_MARKS.firefox.color).toBe('#FF7139')
    expect(ENGINE_MARKS.webkit.color).toBe('#006CFF')
    expect(ENGINE_MARKS.msedge.color).toBe('#0078D7')
    expect(ENGINE_MARKS['system-chromium'].color).toBeNull()
  })
})

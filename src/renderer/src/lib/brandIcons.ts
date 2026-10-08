/**
 * Central mapping of browser engines, device brands and operating systems to their marks.
 *
 * Brand marks come from react-icons (Simple Icons `si`, CC0 / MIT, and Font Awesome 6 `fa6`,
 * CC BY 4.0); generic fallbacks are lucide glyphs. Every known value has an explicit entry
 * (tests/renderer-brand-icons.test.ts asserts coverage), so no known engine, brand or OS ever
 * falls back to a placeholder. The components that render these live in
 * components/icons/BrandIcon.tsx; this module stays JSX-free so it can be unit-tested in Node.
 *
 * Colour rules:
 * - engines use the vendor's primary brand colour, checked for >= 3:1 contrast against the
 *   darkest-to-lightest tile they sit on (`BRAND_TILE_HEX`, the `muted` token);
 * - device brands and operating systems are drawn in the current text colour (monochrome):
 *   several vendor colours (Samsung, Nokia, LG, BlackBerry, Microsoft grey) are too dark to
 *   reach 3:1 on the dark theme, and a mixed set would look noisy in chip rows.
 */
import type { ComponentType } from 'react'
import type { IconBaseProps } from 'react-icons'
import { FaAmazon, FaChrome, FaEdge, FaMicrosoft, FaWindows } from 'react-icons/fa6'
import {
  SiAndroid,
  SiApple,
  SiBlackberry,
  SiBrave,
  SiFirefoxbrowser,
  SiGoogle,
  SiGooglechrome,
  SiLg,
  SiLinux,
  SiMotorola,
  SiNokia,
  SiOneplus,
  SiOpera,
  SiOperagx,
  SiSafari,
  SiSamsung,
  SiVivaldi,
  SiXiaomi,
} from 'react-icons/si'
import { Cpu, Monitor } from 'lucide-react'
import type { BrowserEngine, DeviceBrand, DeviceOs } from '@shared/types'

/** Anything renderable as an SVG glyph: a react-icons `IconType` or a lucide icon. */
export type BrandGlyph = ComponentType<Pick<IconBaseProps, 'size' | 'color' | 'className' | 'aria-hidden' | 'focusable'>>

/** Hex of the `--muted` token (hsl 0 0% 15%): the lightest tile a coloured mark sits on. */
export const BRAND_TILE_HEX = '#262626'

export interface EngineMark {
  icon: BrandGlyph
  /** Icon colour (vendor primary), or null to inherit the muted text colour. */
  color: string | null
}

export const ENGINE_MARKS: Record<BrowserEngine, EngineMark> = {
  // Chromium has no separate mark in either set: the Chrome-style glyph in a neutral light blue.
  chromium: { icon: FaChrome, color: '#7BAAF7' },
  firefox: { icon: SiFirefoxbrowser, color: '#FF7139' },
  // Playwright WebKit (Safari-compatible, never "real Safari"): the label says so next to it.
  webkit: { icon: SiSafari, color: '#006CFF' },
  chrome: { icon: SiGooglechrome, color: '#4285F4' },
  msedge: { icon: FaEdge, color: '#0078D7' },
  brave: { icon: SiBrave, color: '#FB542B' },
  opera: { icon: SiOpera, color: '#FF1B2D' },
  // Simple Icons ships the dedicated Opera GX mark (double ring); GX red keeps it apart from Opera.
  'opera-gx': { icon: SiOperagx, color: '#FA1E4E' },
  vivaldi: { icon: SiVivaldi, color: '#EF3939' },
  'system-chromium': { icon: FaChrome, color: null },
}

export interface DeviceBrandMark {
  icon: BrandGlyph
  /**
   * Width of the visible box as a multiple of the icon height, for wordmark logos (Samsung, Nokia,
   * LG) that are a thin horizontal band inside the 24×24 artboard and illegible as a square.
   * Absent for square marks.
   */
  wordmarkWidth?: number
}

export const DEVICE_BRAND_MARKS: Record<DeviceBrand, DeviceBrandMark> = {
  Apple: { icon: SiApple },
  Samsung: { icon: SiSamsung, wordmarkWidth: 3.25 },
  Google: { icon: SiGoogle },
  Motorola: { icon: SiMotorola },
  OnePlus: { icon: SiOneplus },
  Xiaomi: { icon: SiXiaomi },
  Microsoft: { icon: FaMicrosoft },
  Nokia: { icon: SiNokia, wordmarkWidth: 3.25 },
  BlackBerry: { icon: SiBlackberry },
  LG: { icon: SiLg, wordmarkWidth: 2.25 },
  Amazon: { icon: FaAmazon },
  // Desktop presets carry no vendor: a neutral monitor glyph.
  Generic: { icon: Monitor },
}

export const OS_MARKS: Record<DeviceOs, BrandGlyph> = {
  ios: SiApple,
  ipados: SiApple,
  android: SiAndroid,
  windows: FaWindows,
  macos: SiApple,
  linux: SiLinux,
  chromeos: SiGooglechrome,
  other: Cpu,
}

// ---------------------------------------------------------------------------
// Contrast (WCAG 2.x relative luminance)
// ---------------------------------------------------------------------------

function channel(value: number): number {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function relativeLuminance(hex: string): number {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match?.[1]) throw new Error(`Not a #rrggbb colour: ${hex}`)
  const n = Number.parseInt(match[1], 16)
  return 0.2126 * channel((n >> 16) & 0xff) + 0.7152 * channel((n >> 8) & 0xff) + 0.0722 * channel(n & 0xff)
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

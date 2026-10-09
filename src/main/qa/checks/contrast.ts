/**
 * WCAG 2.x contrast math for consent checks: CSS computed-color parsing, alpha compositing over the
 * stack of ancestor backgrounds, relative luminance and the contrast ratio.
 * https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio
 */

/** sRGB 0–255 channels and alpha 0–1. */
export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))
const channel = (raw: string, scale: number): number | null => {
  const text = raw.trim()
  if (!text) return null
  const value = text.endsWith('%') ? (Number(text.slice(0, -1)) / 100) * scale : Number(text)
  return Number.isFinite(value) ? clamp(value, 0, scale) : null
}
const alpha = (raw: string | undefined): number | null => {
  if (raw === undefined) return 1
  const text = raw.trim()
  const value = text.endsWith('%') ? Number(text.slice(0, -1)) / 100 : Number(text)
  return Number.isFinite(value) ? clamp(value, 0, 1) : null
}

/**
 * Parses the colors browsers return from getComputedStyle: `rgb()`/`rgba()` (comma or space syntax),
 * `transparent`, and `color(srgb r g b / a)`. Other spaces (display-p3, oklch, …) return null, which the
 * check reports as "not measurable" rather than guessing.
 */
export function parseCssColor(input: string): Rgba | null {
  const text = input.trim().toLowerCase()
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  const rgb = /^rgba?\((.*)\)$/.exec(text)
  if (rgb) {
    const body = rgb[1]!
    const [colors, slashAlpha] = body.includes('/') ? body.split('/') : [body, undefined]
    const parts = colors!.includes(',') ? colors!.split(',') : colors!.trim().split(/\s+/)
    if (parts.length !== 3 && !(parts.length === 4 && slashAlpha === undefined)) return null
    const [r, g, b] = parts.slice(0, 3).map((part) => channel(part, 255))
    const a = alpha(parts.length === 4 ? parts[3] : slashAlpha)
    if (r == null || g == null || b == null || a == null) return null
    return { r, g, b, a }
  }
  const srgb = /^color\(srgb\s+([^)]*)\)$/.exec(text)
  if (srgb) {
    const [colors, slashAlpha] = srgb[1]!.split('/')
    const parts = colors!.trim().split(/\s+/)
    if (parts.length !== 3) return null
    const [r, g, b] = parts.map((part) => channel(part, 1))
    const a = alpha(slashAlpha)
    if (r == null || g == null || b == null || a == null) return null
    return { r: r * 255, g: g * 255, b: b * 255, a }
  }
  return null
}

/** Source-over compositing of `top` onto an opaque `bottom`; the result is opaque. */
export function blend(top: Rgba, bottom: Rgba): Rgba {
  const a = clamp(top.a, 0, 1)
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  }
}

export const CANVAS_WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 }

/**
 * The opaque color behind the text: `layers` are background colors from the text's element outward
 * (innermost first). They are composited from the outermost up, starting from the white canvas, so a
 * transparent or semi-transparent ancestor shows what is behind it.
 */
export function effectiveBackground(layers: readonly Rgba[], canvas: Rgba = CANVAS_WHITE): Rgba {
  let color = canvas
  for (let index = layers.length - 1; index >= 0; index--) color = blend(layers[index]!, color)
  return color
}

/** WCAG relative luminance of an sRGB color (alpha ignored). */
export function relativeLuminance(color: Rgba): number {
  const linear = (value: number): number => {
    const c = clamp(value, 0, 255) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
}

/** WCAG contrast ratio between two opaque colors, 1–21. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

export type ContrastMeasurement =
  | { measurable: true; ratio: number; foreground: Rgba; background: Rgba }
  | { measurable: false; reason: string }

/**
 * Contrast of text against what is behind it. `opacity` is the product of the element's and its
 * ancestors' CSS opacity and fades the text toward the background (an approximation: opacity also
 * fades the backgrounds of the faded subtree, which equal-weight compositing ignores).
 */
export function measureTextContrast(facts: {
  color: string
  /** Background colors from the text's element outward, ending at the first opaque one. */
  backgrounds: readonly string[]
  /** Set when an element in that stack paints a background image or gradient. */
  backgroundImage?: boolean
  opacity?: number
}): ContrastMeasurement {
  if (facts.backgroundImage)
    return { measurable: false, reason: 'a background image or gradient is behind the text' }
  const text = parseCssColor(facts.color)
  if (!text) return { measurable: false, reason: `text color "${facts.color}" is not an sRGB color` }
  const layers: Rgba[] = []
  for (const raw of facts.backgrounds) {
    const parsed = parseCssColor(raw)
    if (!parsed) return { measurable: false, reason: `background color "${raw}" is not an sRGB color` }
    layers.push(parsed)
  }
  const background = effectiveBackground(layers)
  const foreground = blend({ ...text, a: text.a * clamp(facts.opacity ?? 1, 0, 1) }, background)
  return { measurable: true, ratio: contrastRatio(foreground, background), foreground, background }
}

/** "4.52:1" — truncated, never rounded up, so a displayed pass is a real pass. */
export function formatRatio(ratio: number): string {
  return `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`
}

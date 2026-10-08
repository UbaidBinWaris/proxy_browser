import type { BrowserEngine, DeviceBrand, DeviceOs } from '@shared/types'
import { DEVICE_BRAND_MARKS, ENGINE_MARKS, OS_MARKS } from '@/lib/brandIcons'
import { cn } from '@/lib/utils'

/*
 * Brand marks (browser engines, device vendors, operating systems). All of them are decorative:
 * the name is always printed next to the mark or carried by the surrounding control's label, so
 * every glyph is aria-hidden. Mapping tables live in lib/brandIcons.ts.
 */

export interface EngineIconProps {
  engine: BrowserEngine
  /** Glyph size in px (16 in buttons/inputs, 14 in chips, 20 in cards/triggers). */
  size?: number
  /** Draw the glyph inside a subtle rounded tile (pickers, tables). */
  tile?: boolean
  className?: string
}

/** Browser engine mark in its vendor colour, optionally on a rounded tile sized 1.8× the glyph. */
export function EngineIcon({ engine, size = 16, tile = false, className }: EngineIconProps): React.JSX.Element {
  const mark = ENGINE_MARKS[engine]
  const Glyph = mark.icon
  const glyph = <Glyph size={size} color={mark.color ?? undefined} className={cn('shrink-0', mark.color === null && 'text-muted-foreground', !tile && className)} aria-hidden="true" focusable="false" />
  if (!tile) return glyph
  const box = Math.round(size * 1.8)
  return (
    <span className={cn('inline-flex shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/40', className)} style={{ width: box, height: box }} aria-hidden="true">
      {glyph}
    </span>
  )
}

export interface DeviceBrandIconProps {
  brand: DeviceBrand
  size?: number
  className?: string
}

/**
 * Device vendor mark in the current text colour. Wordmark logos (Samsung, Nokia, LG) are shown in
 * a wider box — the glyph is drawn `wordmarkWidth`× larger and the empty top/bottom of its square
 * artboard is cropped — so the lettering stays legible at chip size.
 */
export function DeviceBrandIcon({ brand, size = 16, className }: DeviceBrandIconProps): React.JSX.Element {
  const mark = DEVICE_BRAND_MARKS[brand]
  const Glyph = mark.icon
  if (!mark.wordmarkWidth) return <Glyph size={size} className={cn('shrink-0', className)} aria-hidden="true" focusable="false" />
  const width = Math.round(size * mark.wordmarkWidth)
  return (
    <span className={cn('inline-flex shrink-0 items-center justify-center overflow-hidden', className)} style={{ width, height: size }} aria-hidden="true">
      <Glyph size={width} className="shrink-0" aria-hidden="true" focusable="false" />
    </span>
  )
}

/** True when the brand's mark is its name spelled out (the visible name can then be screen-reader only). */
export function isWordmarkBrand(brand: DeviceBrand): boolean {
  return DEVICE_BRAND_MARKS[brand].wordmarkWidth !== undefined
}

/**
 * Brand mark + name. For wordmark brands the logo *is* the name, so the text is kept for screen
 * readers only instead of printing "SAMSUNG Samsung".
 */
export function DeviceBrandLabel({ brand, label, size = 14, className }: { brand: DeviceBrand; label?: string; size?: number; className?: string }): React.JSX.Element {
  const text = label ?? brand
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <DeviceBrandIcon brand={brand} size={size} />
      <span className={isWordmarkBrand(brand) ? 'sr-only' : 'truncate'}>{text}</span>
    </span>
  )
}

export interface OsIconProps {
  os: DeviceOs
  size?: number
  className?: string
}

/** Operating-system mark in the current text colour. */
export function OsIcon({ os, size = 16, className }: OsIconProps): React.JSX.Element {
  const Glyph = OS_MARKS[os]
  return <Glyph size={size} className={cn('shrink-0', className)} aria-hidden="true" focusable="false" />
}

/**
 * Decides whether a consent block is visibly rendered from facts gathered in the page (see
 * compliance.ts → collectConsentFacts). Pure, so every hiding technique is unit-tested without a browser.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface VisibilityFacts {
  /** The element or an ancestor computes to display:none (the element has no layout boxes). */
  displayNone: boolean
  /** Computed visibility of the element (hidden/collapse are inherited from ancestors). */
  visibility: string
  /** Product of the element's and its ancestors' opacity. */
  opacity: number
  /** Border box in viewport coordinates, after the check scrolled the element into view. */
  rect: Rect
  /** Part of `rect` left after clipping by overflow, `clip` and `clip-path: inset()` of the element and its ancestors. */
  visibleRect: Rect | null
  viewport: { width: number; height: number }
  /**
   * What `elementFromPoint` found at the center of the visible part: the element itself, one of its
   * descendants or ancestors (all fine), another element (it covers the block), or nothing.
   */
  centerHit: 'self' | 'descendant' | 'ancestor' | 'other' | 'none'
  /** Short description of the covering element, e.g. `div#cookie-banner.modal`. */
  coveredBy?: string
}

/** Below this effective opacity text is treated as invisible (the contrast check covers fainter text). */
export const MIN_VISIBLE_OPACITY = 0.1
/** A box smaller than this in either dimension cannot show readable text. */
export const MIN_VISIBLE_SIZE_PX = 2

export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
}

/** Reasons the block is hidden; empty when it is visible. */
export function hiddenReasons(facts: VisibilityFacts): string[] {
  if (facts.displayNone) return ['display:none (element or an ancestor)']
  const reasons: string[] = []
  if (facts.visibility === 'hidden' || facts.visibility === 'collapse') reasons.push(`visibility:${facts.visibility}`)
  if (facts.opacity < MIN_VISIBLE_OPACITY) reasons.push(`opacity ${Number(facts.opacity.toFixed(2))}`)
  if (facts.rect.width < MIN_VISIBLE_SIZE_PX || facts.rect.height < MIN_VISIBLE_SIZE_PX) {
    reasons.push(`zero size (${Math.round(facts.rect.width)}×${Math.round(facts.rect.height)} px)`)
    return reasons
  }
  const visible = facts.visibleRect
  if (!visible || visible.width < MIN_VISIBLE_SIZE_PX || visible.height < MIN_VISIBLE_SIZE_PX) {
    reasons.push('clipped (overflow, clip or clip-path)')
    return reasons
  }
  const viewport = { x: 0, y: 0, width: facts.viewport.width, height: facts.viewport.height }
  if (!intersect(visible, viewport)) {
    reasons.push('offscreen (outside the viewport after scrolling into view)')
    return reasons
  }
  if (facts.centerHit === 'other') reasons.push(`covered by ${facts.coveredBy ?? 'another element'} at its center`)
  else if (facts.centerHit === 'none') reasons.push('nothing is rendered at its center')
  return reasons
}

/** Gap between two boxes (0 when they touch or overlap), in px. */
export function rectDistance(a: Rect, b: Rect): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width))
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height))
  return Math.hypot(dx, dy)
}

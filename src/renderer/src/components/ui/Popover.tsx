import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

export interface PopoverProps {
  open: boolean
  /** Escape, a click outside, or (modal) Tab-free dismissal. The parent sets `open` to false. */
  onClose: () => void
  /** Element the panel is positioned against; focus returns to it when a modal panel closes. */
  anchorRef: RefObject<HTMLElement | null>
  /** Panel width in px, or 'anchor' to match the anchor; clamped by min/max and the viewport. */
  width: number | 'anchor'
  minWidth?: number
  maxWidth?: number
  /** Fixed panel height (clamped to the viewport). Omit to size to content up to `maxHeight`. */
  height?: number
  maxHeight?: number
  align?: 'start' | 'end'
  /** At or below this window width a modal panel becomes a centered dialog with a dimmed backdrop. */
  dialogBelow?: number
  /**
   * Modal panels (role="dialog") trap focus, move it inside on open and give it back to the anchor
   * on close. Non-modal panels (a combobox listbox) leave focus where it is.
   */
  modal?: boolean
  role?: 'dialog' | 'presentation'
  id?: string
  'aria-label'?: string
  'aria-labelledby'?: string
  /** Element focused when a modal panel opens (defaults to the first focusable element). */
  initialFocusRef?: RefObject<HTMLElement | null>
  className?: string
  children: ReactNode
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
const MARGIN = 8
const GAP = 6

interface Placement {
  style: CSSProperties
  dialog: boolean
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/** Position below the anchor when it fits, else above, else pinned inside the viewport. */
function computePlacement(anchor: HTMLElement | null, props: Pick<PopoverProps, 'width' | 'minWidth' | 'maxWidth' | 'height' | 'maxHeight' | 'align' | 'dialogBelow' | 'modal'>): Placement {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const maxWidth = Math.min(props.maxWidth ?? Number.POSITIVE_INFINITY, vw - MARGIN * 2)
  const dialog = props.modal !== false && props.dialogBelow !== undefined && vw <= props.dialogBelow
  if (dialog || !anchor) {
    const width = Math.min(typeof props.width === 'number' ? props.width : maxWidth, vw - 32)
    const height = props.height !== undefined ? Math.min(props.height, vh - 32) : undefined
    return {
      dialog: true,
      style: { width, ...(height !== undefined ? { height } : { maxHeight: Math.min(props.maxHeight ?? vh - 32, vh - 32) }), left: (vw - width) / 2, top: Math.max(16, (vh - (height ?? Math.min(props.maxHeight ?? vh, vh - 32))) / 2) },
    }
  }
  const rect = anchor.getBoundingClientRect()
  const wanted = props.width === 'anchor' ? rect.width : props.width
  const width = clamp(wanted, Math.min(props.minWidth ?? 0, maxWidth), maxWidth)
  const left = clamp(props.align === 'end' ? rect.right - width : rect.left, MARGIN, vw - width - MARGIN)
  const desired = props.height ?? props.maxHeight ?? 400
  const below = vh - rect.bottom - GAP - MARGIN
  const above = rect.top - GAP - MARGIN
  let top: number
  let size: number
  if (props.height !== undefined) {
    // A fixed-height panel keeps its size: below, else above, else shifted up to fit (it may cover the trigger).
    size = Math.min(props.height, vh - MARGIN * 2)
    top = below >= size ? rect.bottom + GAP : above >= size ? rect.top - GAP - size : Math.max(MARGIN, vh - MARGIN - size)
  } else if (below >= desired || below >= above) {
    size = Math.min(desired, Math.max(below, 160))
    top = rect.bottom + GAP
    if (top + size > vh - MARGIN) top = Math.max(MARGIN, vh - MARGIN - size)
  } else {
    size = Math.min(desired, above)
    top = rect.top - GAP - size
  }
  return { dialog: false, style: { width, left, top, ...(props.height !== undefined ? { height: size } : { maxHeight: size }) } }
}

/**
 * Floating panel rendered in a portal: anchored under (or above) its trigger, or a centered modal dialog
 * on narrow windows. Escape and outside clicks close it; modal panels trap Tab and restore focus.
 */
export function Popover({
  open,
  onClose,
  anchorRef,
  width,
  minWidth,
  maxWidth,
  height,
  maxHeight,
  align = 'start',
  dialogBelow,
  modal = true,
  role = 'dialog',
  id,
  initialFocusRef,
  className,
  children,
  ...aria
}: PopoverProps): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const onCloseRef = useRef(onClose)
  useLayoutEffect(() => {
    onCloseRef.current = onClose
  })

  const place = useCallback((): void => {
    setPlacement(computePlacement(anchorRef.current, { width, minWidth, maxWidth, height, maxHeight, align, dialogBelow, modal }))
  }, [anchorRef, width, minWidth, maxWidth, height, maxHeight, align, dialogBelow, modal])

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null)
      return undefined
    }
    place()
    window.addEventListener('resize', place)
    // Scrolling the page (not the panel itself) moves the anchor: follow it.
    const onScroll = (event: Event): void => {
      if (panelRef.current && event.target instanceof Node && panelRef.current.contains(event.target)) return
      place()
    }
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, place])

  // Modal: move focus in on open, give it back to the trigger on close.
  useEffect(() => {
    if (!open || !modal) return undefined
    const anchor = anchorRef.current
    const frame = requestAnimationFrame(() => {
      const target = initialFocusRef?.current ?? panelRef.current?.querySelector<HTMLElement>(FOCUSABLE) ?? panelRef.current
      target?.focus({ preventScroll: true })
    })
    return () => {
      cancelAnimationFrame(frame)
      if (anchor && document.contains(anchor)) anchor.focus({ preventScroll: true })
    }
  }, [open, modal, anchorRef, initialFocusRef])

  // Modal: Escape closes even when focus fell out of the panel (e.g. the focused control was removed).
  useEffect(() => {
    if (!open || !modal) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (panelRef.current && event.target instanceof Node && panelRef.current.contains(event.target)) return
      event.preventDefault()
      onCloseRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, modal])

  // Non-modal: close on a press outside both the panel and the anchor.
  useEffect(() => {
    if (!open || modal) return undefined
    const onPointer = (event: MouseEvent): void => {
      const target = event.target as Node
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return
      onCloseRef.current()
    }
    document.addEventListener('mousedown', onPointer)
    return () => document.removeEventListener('mousedown', onPointer)
  }, [open, modal, anchorRef])

  if (!open || !placement) return null

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (!modal || event.key !== 'Tab' || !panelRef.current) return
    const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement)
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (!first || !last) return
    if (event.shiftKey && (document.activeElement === first || !panelRef.current.contains(document.activeElement))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const panel = (
    <div
      ref={panelRef}
      id={id}
      role={role}
      aria-modal={modal && role === 'dialog' ? true : undefined}
      aria-label={aria['aria-label']}
      aria-labelledby={aria['aria-labelledby']}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      style={placement.style}
      data-placement={placement.dialog ? 'dialog' : 'popover'}
      className={cn('popover-in fixed z-50 flex flex-col overflow-hidden rounded-lg border border-border bg-card text-foreground shadow-2xl shadow-black/50 outline-none', className)}
    >
      {children}
    </div>
  )

  if (!modal) return createPortal(panel, document.body)

  return createPortal(
    <div
      className={cn('fixed inset-0 z-50', placement.dialog && 'bg-background/70 backdrop-blur-sm')}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      {panel}
    </div>,
    document.body,
  )
}

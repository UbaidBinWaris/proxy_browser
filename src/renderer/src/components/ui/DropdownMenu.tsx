import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface MenuItem {
  id: string
  label: string
  icon?: LucideIcon
  destructive?: boolean
  disabled?: boolean
  onSelect: () => void
}

export interface DropdownMenuProps {
  /** The trigger button content (icon-only triggers must pass `triggerLabel`). */
  trigger: ReactNode
  triggerLabel: string
  items: MenuItem[]
  align?: 'start' | 'end'
  /**
   * 'fixed' positions the menu against the viewport so it is not clipped by a scrolling ancestor
   * (e.g. a table inside overflow-x-auto); it closes on scroll and resize.
   */
  strategy?: 'absolute' | 'fixed'
  className?: string
}

/** Minimal accessible menu button: Escape/outside click closes, arrow keys move, Enter/Space selects. */
export function DropdownMenu({ trigger, triggerLabel, items, align = 'end', strategy = 'absolute', className }: DropdownMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [fixedPosition, setFixedPosition] = useState<{ top: number; left: number; right: number } | null>(null)
  const menuId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const handlePointer = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handlePointer)
    const closeOnViewportChange = (): void => setOpen(false)
    if (strategy === 'fixed') {
      window.addEventListener('scroll', closeOnViewportChange, true)
      window.addEventListener('resize', closeOnViewportChange)
    }
    const frame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus({ preventScroll: true })
    })
    return () => {
      document.removeEventListener('mousedown', handlePointer)
      window.removeEventListener('scroll', closeOnViewportChange, true)
      window.removeEventListener('resize', closeOnViewportChange)
      cancelAnimationFrame(frame)
    }
  }, [open, strategy])

  const toggle = (): void => {
    if (!open && strategy === 'fixed' && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      setFixedPosition({ top: rect.bottom + 4, left: rect.left, right: window.innerWidth - rect.right })
    }
    setOpen((v) => !v)
  }

  const close = (): void => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])
    const index = buttons.findIndex((b) => b === document.activeElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      buttons[(index + 1) % buttons.length]?.focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      buttons[(index - 1 + buttons.length) % buttons.length]?.focus()
    } else if (event.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <div ref={rootRef} className={cn('relative inline-block', className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={triggerLabel}
        onClick={toggle}
        className="focus-ring inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        {trigger}
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={triggerLabel}
          onKeyDown={handleMenuKeyDown}
          style={
            strategy === 'fixed' && fixedPosition
              ? { top: fixedPosition.top, ...(align === 'end' ? { right: fixedPosition.right } : { left: fixedPosition.left }) }
              : undefined
          }
          className={cn(
            'z-40 min-w-[160px] overflow-hidden rounded-md border border-border bg-card p-1 shadow-xl',
            strategy === 'fixed' ? 'fixed' : cn('absolute mt-1', align === 'end' ? 'right-0' : 'left-0'),
          )}
        >
          {items.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false)
                  item.onSelect()
                }}
                className={cn(
                  'focus-ring flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-0 disabled:pointer-events-none disabled:opacity-50',
                  item.destructive ? 'text-destructive' : 'text-foreground',
                )}
              >
                {Icon ? <Icon className="h-4 w-4" aria-hidden="true" /> : null}
                {item.label}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

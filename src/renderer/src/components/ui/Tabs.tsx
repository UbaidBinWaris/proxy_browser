import { useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { cn } from '@/lib/utils'

export interface TabItem<V extends string = string> {
  value: V
  label: string
  count?: number
}

export interface TabsProps<V extends string> {
  items: readonly TabItem<V>[]
  value: V
  onChange: (value: V) => void
  /** Prefix for tab/panel ids; use with `tabPanelProps`. */
  idPrefix: string
  /** Accessible name of the tab list. */
  'aria-label'?: string
  className?: string
}

/** Accessible tab list (roving tabindex, arrow keys, Home/End). */
export function Tabs<V extends string>({ items, value, onChange, idPrefix, className, 'aria-label': ariaLabel }: TabsProps<V>): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const index = items.findIndex((item) => item.value === value)
    if (index < 0) return
    let nextIndex: number
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % items.length
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + items.length) % items.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = items.length - 1
    else return
    event.preventDefault()
    const next = items[nextIndex]
    if (!next) return
    onChange(next.value)
    listRef.current?.querySelector<HTMLButtonElement>(`#${idPrefix}-tab-${next.value}`)?.focus()
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      className={cn('flex items-center gap-1 border-b border-border', className)}
    >
      {items.map((item) => {
        const selected = item.value === value
        return (
          <button
            key={item.value}
            id={`${idPrefix}-tab-${item.value}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${item.value}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.value)}
            className={cn(
              'focus-ring -mb-px inline-flex h-9 items-center gap-2 border-b-2 px-3 text-sm font-medium transition-colors',
              selected
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground',
            )}
          >
            {item.label}
            {item.count !== undefined ? (
              <span className="tabular rounded-full bg-muted px-1.5 text-xs text-muted-foreground">{item.count}</span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

export function tabPanelProps(idPrefix: string, value: string): { id: string; role: 'tabpanel'; 'aria-labelledby': string } {
  return { id: `${idPrefix}-panel-${value}`, role: 'tabpanel', 'aria-labelledby': `${idPrefix}-tab-${value}` }
}

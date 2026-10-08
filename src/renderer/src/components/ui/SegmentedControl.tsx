import { useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SegmentedOption<V extends string> {
  value: V
  label: string
  disabled?: boolean
  /** Leading icon (decorative). */
  icon?: LucideIcon
  /** Muted count after the label ("Phones 98"). */
  count?: number
}

export interface SegmentedControlProps<V extends string> {
  options: readonly SegmentedOption<V>[]
  value: V
  onChange: (value: V) => void
  /** One of the two labelling props is required: the control is a radiogroup. */
  'aria-label'?: string
  'aria-labelledby'?: string
  id?: string
  size?: 'sm' | 'md'
  /** Stretch to the container width with equal-width segments. */
  fullWidth?: boolean
  disabled?: boolean
  className?: string
}

/** Radio group styled as connected segments (roving tabindex, arrow keys, Home/End). */
export function SegmentedControl<V extends string>({
  options,
  value,
  onChange,
  id,
  size = 'md',
  fullWidth = false,
  disabled = false,
  className,
  ...aria
}: SegmentedControlProps<V>): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)

  const focusValue = (next: V): void => {
    onChange(next)
    rootRef.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(next)}"]`)?.focus()
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const enabled = options.filter((option) => !option.disabled)
    const index = enabled.findIndex((option) => option.value === value)
    if (enabled.length === 0) return
    let next: SegmentedOption<V> | undefined
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = enabled[(index + 1) % enabled.length]
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = enabled[(index - 1 + enabled.length) % enabled.length]
    else if (event.key === 'Home') next = enabled[0]
    else if (event.key === 'End') next = enabled[enabled.length - 1]
    if (!next) return
    event.preventDefault()
    focusValue(next.value)
  }

  return (
    <div
      ref={rootRef}
      id={id}
      role="radiogroup"
      aria-label={aria['aria-label']}
      aria-labelledby={aria['aria-labelledby']}
      aria-disabled={disabled || undefined}
      onKeyDown={handleKeyDown}
      className={cn(
        'max-w-full items-stretch overflow-x-auto rounded-md border border-border bg-background p-0.5',
        fullWidth ? 'flex w-full' : 'inline-flex',
        disabled && 'opacity-50',
        className,
      )}
    >
      {options.map((option) => {
        const checked = option.value === value
        const optionDisabled = disabled || option.disabled === true
        const Icon = option.icon
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            data-value={option.value}
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={optionDisabled}
            onClick={() => onChange(option.value)}
            className={cn(
              'focus-ring inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[calc(var(--radius)-4px)] font-medium transition-colors disabled:pointer-events-none',
              size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
              fullWidth && 'min-w-0 flex-1',
              checked ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            {Icon ? <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
            {option.label}
            {option.count !== undefined ? <span className={cn('tabular text-[11px] font-normal', checked ? 'text-primary-foreground/75' : 'text-muted-foreground/80')}>{option.count}</span> : null}
          </button>
        )
      })}
    </div>
  )
}

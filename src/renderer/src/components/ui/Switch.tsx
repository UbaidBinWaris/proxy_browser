import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface SwitchProps {
  id: string
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  /** Secondary line under the label (wired with aria-describedby). */
  description?: ReactNode
  disabled?: boolean
  className?: string
}

/** On/off setting: a labelled `role="switch"` button with a 44px-high hit area. */
export function Switch({ id, checked, onChange, label, description, disabled = false, className }: SwitchProps): React.JSX.Element {
  const descriptionId = description ? `${id}-description` : undefined
  return (
    <div className={cn('flex min-h-[44px] items-center justify-between gap-4', className)}>
      <div className="min-w-0">
        <label htmlFor={id} className={cn('text-sm font-medium', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
          {label}
        </label>
        {description ? (
          <p id={descriptionId} className="mt-0.5 text-xs text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={descriptionId}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'focus-ring relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-50',
          checked ? 'bg-primary' : 'bg-muted-foreground/40',
        )}
      >
        <span className={cn('inline-block h-4 w-4 rounded-full bg-background shadow transition-transform', checked ? 'translate-x-4' : 'translate-x-0')} aria-hidden="true" />
      </button>
    </div>
  )
}

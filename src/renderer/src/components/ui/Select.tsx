import type { Ref, SelectHTMLAttributes } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SelectOption<V extends string = string> {
  value: V
  label: string
  disabled?: boolean
}

/** A labelled `<optgroup>`. Empty groups are not rendered. */
export interface SelectOptionGroup<V extends string = string> {
  label: string
  options: readonly SelectOption<V>[]
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  ref?: Ref<HTMLSelectElement>
  /** Flat options, rendered after `groups` when both are given. */
  options?: readonly SelectOption[]
  /** Grouped options (`<optgroup>`), rendered first. */
  groups?: readonly SelectOptionGroup[]
  invalid?: boolean
  placeholder?: string
}

function renderOption(option: SelectOption): React.JSX.Element {
  return (
    <option key={option.value} value={option.value} disabled={option.disabled}>
      {option.label}
    </option>
  )
}

export function Select({ className, options = [], groups = [], invalid, placeholder, ...rest }: SelectProps): React.JSX.Element {
  return (
    <div className="relative">
      <select
        aria-invalid={invalid || undefined}
        className={cn(
          'focus-ring flex h-9 w-full appearance-none rounded-md border border-border bg-background py-1 pl-3 pr-9 text-sm text-foreground shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50',
          invalid && 'border-destructive focus-visible:ring-destructive',
          className,
        )}
        {...rest}
      >
        {placeholder ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {groups
          .filter((group) => group.options.length > 0)
          .map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.options.map(renderOption)}
            </optgroup>
          ))}
        {options.map(renderOption)}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
    </div>
  )
}

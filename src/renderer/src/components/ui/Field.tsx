import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface FieldProps {
  /** Must match the `id` of the wrapped control. */
  htmlFor: string
  label: ReactNode
  hint?: ReactNode
  error?: string | null
  required?: boolean
  className?: string
  children: ReactNode
}

/** Label + control + hint/error, wired with aria-describedby ids. */
export function Field({ htmlFor, label, hint, error, required, className, children }: FieldProps): React.JSX.Element {
  const hintId = `${htmlFor}-hint`
  const errorId = `${htmlFor}-error`
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium leading-none">
        {label}
        {required ? (
          <span className="ml-1 text-destructive" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {children}
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/** Compute `aria-describedby` for a control wrapped in a Field. */
export function fieldDescribedBy(htmlFor: string, hasHint: boolean, hasError: boolean): string | undefined {
  if (hasError) return `${htmlFor}-error`
  if (hasHint) return `${htmlFor}-hint`
  return undefined
}

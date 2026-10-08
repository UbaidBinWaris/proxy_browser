import type { InputHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean
  mono?: boolean
}

export const INPUT_BASE_CLASSES =
  'focus-ring flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground/70 disabled:cursor-not-allowed disabled:opacity-50 read-only:bg-muted/40'

export function Input({ className, invalid, mono, ...rest }: InputProps): React.JSX.Element {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={cn(INPUT_BASE_CLASSES, invalid && 'border-destructive focus-visible:ring-destructive', mono && 'font-mono text-xs', className)}
      {...rest}
    />
  )
}

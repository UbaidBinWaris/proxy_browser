import { AlertCircle, RotateCw } from 'lucide-react'
import type { AppError } from '@shared/types'
import { errorLabel } from '@/lib/result'
import { Button } from './Button'
import { cn } from '@/lib/utils'

export interface ErrorAlertProps {
  error: AppError
  title?: string
  onRetry?: () => void
  retryLabel?: string
  compact?: boolean
  className?: string
}

/** Inline AppError display: label, code, actionable message, optional detail and retry. */
export function ErrorAlert({ error, title, onRetry, retryLabel = 'Retry', compact, className }: ErrorAlertProps): React.JSX.Element {
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 text-sm',
        compact ? 'p-3' : 'p-4',
        className,
      )}
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">
          {title ?? errorLabel(error.code)}
          <span className="ml-2 font-mono text-xs text-muted-foreground">{error.code}</span>
        </p>
        <p className="mt-1 break-words text-muted-foreground">{error.message}</p>
        {error.detail ? <p className="mt-1 break-words font-mono text-xs text-muted-foreground/80">{error.detail}</p> : null}
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry} leftIcon={<RotateCw className="h-3.5 w-3.5" aria-hidden="true" />}>
          {retryLabel}
        </Button>
      ) : null}
    </div>
  )
}

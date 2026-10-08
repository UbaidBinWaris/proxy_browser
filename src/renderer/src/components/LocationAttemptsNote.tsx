import { AlertTriangle, RefreshCw } from 'lucide-react'
import { locationAttemptsLabel } from '@/lib/targeting'
import { cn } from '@/lib/utils'

export interface LocationAttemptsNoteProps {
  /** Sticky session ids tried before the browser opened (1 = no re-roll). */
  attempts: number
  maxAttempts: number
  /** Set by the main process when no attempt met the location policy and the best result was used. */
  warning: string | null
  className?: string
}

/**
 * Outcome of the location re-roll under a verified exit IP:
 * "Sticky session re-rolled for location · exit IP from attempt 2 of 3", or the fallback warning
 * ("Could not get an exit IP in … after 3 attempts; using …").
 * Renders nothing when the first exit IP was used as-is. The icon and wording carry the meaning, not the colour.
 */
export function LocationAttemptsNote({ attempts, maxAttempts, warning, className }: LocationAttemptsNoteProps): React.JSX.Element | null {
  if (warning) {
    return (
      <p className={cn('flex items-start gap-1.5 text-xs text-warning', className)}>
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 break-words">{warning}</span>
      </p>
    )
  }
  const label = locationAttemptsLabel({ locationAttempts: attempts, locationMaxAttempts: maxAttempts })
  if (!label) return null
  return (
    <p className={cn('flex items-center gap-1.5 text-xs text-muted-foreground', className)}>
      <RefreshCw className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>Sticky session re-rolled for location · exit IP from {label}</span>
    </p>
  )
}

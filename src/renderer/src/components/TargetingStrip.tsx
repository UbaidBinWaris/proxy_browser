import { AlertTriangle, Info, Loader2 } from 'lucide-react'
import type { AppError, GeoTarget, TargetingPreview } from '@shared/types'
import { CopyButton } from '@/components/ui/CopyButton'
import type { LoadStatus } from '@/lib/result'
import { describeTarget, poolLabel } from '@/lib/targeting'
import type { PoolChoice } from '@/lib/targeting'
import { cn } from '@/lib/utils'

export interface TargetingStripProps {
  pool: PoolChoice
  target: GeoTarget | null
  preview: TargetingPreview | null
  status: LoadStatus
  error: AppError | null
  /** Why no preview can be computed yet (validation), shown instead of the string. */
  blockedReason?: string | null
  /** What happens when the exit IP lands outside the target (settings.locationMatchPolicy). */
  policySummary?: string | null
  className?: string
}

/**
 * "Will connect as" on one line: the exact provider parameters (monospace, copyable). Preview
 * warnings and the location policy sit behind a small info icon whose text is also read by screen
 * readers; a pool without keys is the one blocking problem and is spelled out under the line.
 */
export function TargetingStrip({ pool, target, preview, status, error, blockedReason = null, policySummary = null, className }: TargetingStripProps): React.JSX.Element {
  const notConfigured = preview !== null && pool !== 'none' && !preview.poolConfigured
  const loading = status === 'loading' && preview === null
  const warnings = pool === 'none' ? [] : (preview?.warnings ?? [])
  const notes = [...warnings, ...(pool !== 'none' && policySummary ? [policySummary] : [])]
  const notesText = notes.join(' ')

  let body: React.ReactNode
  if (pool === 'none') body = <span className="truncate text-xs text-muted-foreground">Direct · this machine’s own connection</span>
  else if (blockedReason) body = <span className="truncate text-xs text-muted-foreground">{blockedReason}</span>
  else if (loading)
    body = (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Computing…
      </span>
    )
  else if (error)
    body = (
      <span className="truncate text-xs text-destructive" title={error.message}>
        Preview unavailable · {error.code}
      </span>
    )
  else if (preview?.targetingString)
    body = (
      <>
        <code className="min-w-0 flex-1 truncate font-mono text-xs" title={`${poolLabel(pool)} · ${describeTarget(target)} · ${preview.targetingString}`}>
          {preview.targetingString}
        </code>
        <CopyButton value={preview.targetingString} label="Copy targeting string" />
      </>
    )
  else body = <span className="truncate text-xs text-muted-foreground">No targeting parameters · any exit IP in the pool</span>

  return (
    <section aria-labelledby="targeting-strip-title" aria-live="polite" className={cn('flex flex-col gap-1.5', className)}>
      <div className={cn('flex h-10 min-w-0 items-center gap-2 rounded-md border px-3', notConfigured ? 'border-destructive/40 bg-destructive/5' : 'border-border bg-muted/30')}>
        <h2 id="targeting-strip-title" className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Will connect as
        </h2>
        <div className="flex min-w-0 flex-1 items-center gap-1">{body}</div>
        {notes.length > 0 ? (
          <span className="flex shrink-0 items-center" title={notesText}>
            {warnings.length > 0 ? <AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" /> : <Info className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
            <span className="sr-only">{warnings.length > 0 ? `Warnings: ${notesText}` : `Note: ${notesText}`}</span>
          </span>
        ) : null}
      </div>
      {notConfigured ? (
        <p role="alert" className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {poolLabel(pool)} has no keys. Add them with “Manage keys” before connecting.
        </p>
      ) : null}
    </section>
  )
}

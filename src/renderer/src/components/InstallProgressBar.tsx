import type { BrowserInstallProgress } from '@shared/types'
import { progressHeadline } from '@/lib/engines'
import { cn } from '@/lib/utils'

export interface InstallProgressBarProps {
  progress: BrowserInstallProgress
  /** Accessible name of the bar; defaults to "Install progress for <engine>". */
  label?: string
  /** Overrides the bar fill (e.g. the overall percentage of a batch). */
  percentOverride?: number | null
  className?: string
}

/** Thin progress bar + "Downloading · 42%" headline + the latest status line. */
export function InstallProgressBar({ progress, label, percentOverride, className }: InstallProgressBarProps): React.JSX.Element {
  const raw = percentOverride !== undefined ? percentOverride : progress.percent
  const percent = raw === null ? null : Math.max(0, Math.min(100, raw))
  const failed = progress.phase === 'error'
  return (
    <div className={cn('mt-2', className)} aria-live="polite">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={progressHeadline(progress)}
        aria-label={label ?? `Install progress for ${progress.engine}`}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn('h-full rounded-full transition-[width] duration-200', failed ? 'bg-destructive' : progress.phase === 'done' ? 'bg-success' : 'bg-primary', percent === null && !failed && progress.phase !== 'done' && 'w-1/3 animate-pulse')}
          style={percent !== null ? { width: `${percent}%` } : undefined}
        />
      </div>
      <p className={cn('mt-1 truncate text-[11px]', failed ? 'text-destructive' : 'text-muted-foreground')} title={progress.message}>
        <span className={cn('font-medium', !failed && 'text-foreground')}>{progressHeadline(progress)}</span>
        {progress.message ? <span className="font-mono"> · {progress.message}</span> : null}
      </p>
    </div>
  )
}

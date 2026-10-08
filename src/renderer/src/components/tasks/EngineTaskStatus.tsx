import { CheckCircle2, RotateCcw } from 'lucide-react'
import type { Task } from '@shared/types'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { InstallProgressBar } from '@/components/InstallProgressBar'
import { cn } from '@/lib/utils'
import { taskProgress, taskStatusLabel, useTasksStore } from '@/stores/tasks'
import { toast } from '@/stores/toasts'

export interface EngineTaskStatusProps {
  task: Task
  /** Every task (for the queue position). */
  tasks: readonly Task[]
  /** Short browser name for accessible labels ("Google Chrome"). */
  name: string
  /** Show the "Verified ✓" line for a finished install (rows hide it once the engine row says Available). */
  showVerified?: boolean
  className?: string
}

/**
 * Inline state of an engine's background task: "Queued (2nd)", a live progress bar, "Verifying…",
 * "Verified ✓", or the failure reason with Retry.
 */
export function EngineTaskStatus({ task, tasks, name, showVerified = true, className }: EngineTaskStatusProps): React.JSX.Element | null {
  const retry = useTasksStore((s) => s.retry)
  const busy = useTasksStore((s) => s.busy[task.id])
  const label = taskStatusLabel(tasks, task)

  const handleRetry = (): void => {
    retry(task.id).catch((err: unknown) => toast.fromError(err, `Could not retry: ${task.label}`))
  }

  switch (task.state) {
    case 'queued':
      return (
        <div className={cn('flex flex-col items-start gap-1', className)} role="status">
          <Badge variant="info" dot>
            {label}
          </Badge>
          <span className="text-[11px] text-muted-foreground">Starts after the tasks ahead of it.</span>
        </div>
      )
    case 'running':
      return <InstallProgressBar progress={taskProgress(task)} label={`${task.label} progress`} className={cn('mt-0 w-full', className)} />
    case 'verifying':
      return (
        <div className={cn('flex flex-col items-start gap-1', className)} role="status">
          <Badge variant="info" dot pulse>
            {label}
          </Badge>
          <span className="text-[11px] text-muted-foreground">Headless test launch — no window opens.</span>
        </div>
      )
    case 'done':
      if (!showVerified) return null
      return (
        <p className={cn('flex items-center gap-1.5 text-[11px] text-success', className)} title={task.note ?? undefined}>
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{task.kind === 'uninstall' ? 'Uninstalled' : `Verified${task.verification?.version ? ` · v${task.verification.version}` : ''}`}</span>
        </p>
      )
    case 'failed':
    case 'cancelled':
      return (
        <div className={cn('flex w-full flex-col items-start gap-1', className)}>
          <p className={cn('line-clamp-3 text-[11px]', task.state === 'failed' ? 'text-destructive' : 'text-muted-foreground')} title={task.error?.detail ?? task.error?.message ?? undefined} role={task.state === 'failed' ? 'alert' : undefined}>
            {task.state === 'failed' ? (task.error?.message ?? 'The task failed.') : 'Cancelled.'}
          </p>
          <Button variant="outline" size="sm" loading={busy === 'retry'} onClick={handleRetry} leftIcon={<RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />} aria-label={`Retry: ${task.label} (${name})`}>
            Retry
          </Button>
        </div>
      )
  }
}

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, ListChecks, Loader2, RotateCcw, Settings2, X } from 'lucide-react'
import type { Task } from '@shared/types'
import { isTaskActive } from '@shared/types'
import { EngineIcon } from '@/components/icons/BrandIcon'
import { Badge } from '@/components/ui/Badge'
import type { BadgeVariant } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Popover } from '@/components/ui/Popover'
import { InstallProgressBar } from '@/components/InstallProgressBar'
import { settingsPath } from '@/lib/navigation'
import { cn } from '@/lib/utils'
import { elapsedLabel, selectActiveTasks, selectFinishedTasks, selectTasksIndicator, taskProgress, taskStatusLabel, useTasksStore } from '@/stores/tasks'
import { toast } from '@/stores/toasts'

const STATE_VARIANT: Record<Task['state'], BadgeVariant> = {
  queued: 'info',
  running: 'default',
  verifying: 'info',
  done: 'success',
  failed: 'destructive',
  cancelled: 'muted',
}

/** Re-render every second while something is running (elapsed times). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

interface TaskRowProps {
  task: Task
  tasks: readonly Task[]
  now: number
  onCancel: (task: Task) => void
  onRetry: (task: Task) => void
  busy: 'cancel' | 'retry' | undefined
}

function TaskRow({ task, tasks, now, onCancel, onRetry, busy }: TaskRowProps): React.JSX.Element {
  const active = isTaskActive(task.state)
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-start gap-3">
        <EngineIcon engine={task.engine} size={20} tile />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{task.label}</span>
            <Badge variant={STATE_VARIANT[task.state]} dot pulse={task.state === 'running' || task.state === 'verifying'}>
              {taskStatusLabel(tasks, task)}
            </Badge>
          </div>
          <p className="tabular mt-0.5 text-[11px] text-muted-foreground">
            {task.startedAt ? `${active ? 'Running for' : 'Took'} ${elapsedLabel(task, now)}` : 'Not started yet'}
          </p>
        </div>
        {active ? (
          <Button variant="ghost" size="icon-sm" loading={busy === 'cancel'} onClick={() => onCancel(task)} aria-label={`Cancel: ${task.label}`} title="Cancel">
            {busy === 'cancel' ? null : <X className="h-4 w-4" aria-hidden="true" />}
          </Button>
        ) : task.state === 'failed' || task.state === 'cancelled' ? (
          <Button variant="outline" size="sm" loading={busy === 'retry'} onClick={() => onRetry(task)} leftIcon={<RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />} aria-label={`Retry: ${task.label}`}>
            Retry
          </Button>
        ) : null}
      </div>
      {task.state === 'running' ? (
        <InstallProgressBar progress={taskProgress(task)} label={`${task.label} progress`} className="mt-0" />
      ) : task.state === 'failed' ? (
        <p className="line-clamp-3 text-xs text-destructive" title={task.error?.detail ?? undefined}>
          {task.error?.message ?? 'The task failed.'}
        </p>
      ) : (
        <p className={cn('truncate text-xs', task.state === 'done' ? 'text-success' : 'text-muted-foreground')} title={task.note ?? task.phase}>
          {task.state === 'done' ? (task.note ?? 'Done') : task.state === 'verifying' ? `${task.phase}` : task.phase}
        </p>
      )}
    </li>
  )
}

/**
 * Sidebar-footer indicator for background installs (spinner + count while active, red dot after a
 * failure, check when everything finished) and the Tasks panel it opens: every task with its phase,
 * progress, elapsed time, Cancel (confirmed for vendor installs), Retry and "Clear finished".
 */
export function TasksIndicator(): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const [open, setOpen] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState<Task | null>(null)
  const tasks = useTasksStore((s) => s.tasks)
  const busy = useTasksStore((s) => s.busy)
  const cancel = useTasksStore((s) => s.cancel)
  const retry = useTasksStore((s) => s.retry)
  const clearFinished = useTasksStore((s) => s.clearFinished)
  const indicator = selectTasksIndicator(tasks)
  const active = useMemo(() => selectActiveTasks(tasks), [tasks])
  const finished = useMemo(() => selectFinishedTasks(tasks), [tasks])
  const now = useNow(open && active.length > 0)

  const runCancel = (task: Task): void => {
    cancel(task.id).catch((err: unknown) => toast.fromError(err, `Could not cancel: ${task.label}`))
  }
  const requestCancel = (task: Task): void => {
    // Stopping a vendor installer half-way is disruptive: confirm first. Queued tasks and Playwright downloads stop at once.
    if (task.kind === 'install-vendor' && task.state !== 'queued') setConfirmCancel(task)
    else runCancel(task)
  }
  const handleRetry = (task: Task): void => {
    retry(task.id).catch((err: unknown) => toast.fromError(err, `Could not retry: ${task.label}`))
  }

  const summary =
    indicator.kind === 'active'
      ? `${indicator.activeCount} task${indicator.activeCount === 1 ? '' : 's'} running`
      : indicator.kind === 'failed'
        ? `${indicator.failedCount} task${indicator.failedCount === 1 ? '' : 's'} failed`
        : indicator.kind === 'done'
          ? 'All tasks finished'
          : 'No background tasks'

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Background tasks: ${summary}`}
        className="focus-ring flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
      >
        <span className="relative flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
          {indicator.kind === 'active' ? (
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          ) : indicator.kind === 'done' ? (
            <CheckCircle2 className="h-4 w-4 text-success" />
          ) : (
            <ListChecks className="h-4 w-4" />
          )}
          {indicator.kind === 'failed' ? <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-destructive ring-2 ring-card" /> : null}
        </span>
        <span className="truncate">Tasks</span>
        {indicator.kind === 'active' ? (
          <span className="tabular ml-auto rounded-full bg-primary/15 px-1.5 text-[11px] font-medium text-primary" aria-hidden="true">
            {indicator.activeCount}
          </span>
        ) : indicator.kind === 'failed' ? (
          <span className="ml-auto text-[11px] font-medium text-destructive" aria-hidden="true">
            Failed
          </span>
        ) : null}
      </button>

      <Popover open={open} onClose={() => setOpen(false)} anchorRef={triggerRef} width={420} maxWidth={460} maxHeight={560} aria-labelledby={titleId} dialogBelow={640}>
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold tracking-tight">
              Background tasks
            </h2>
            <p className="text-xs text-muted-foreground">Installs run one at a time and are verified without opening a window.</p>
          </div>
          <Button variant="outline" size="sm" disabled={finished.length === 0} onClick={() => void clearFinished().catch((err: unknown) => toast.fromError(err, 'Could not clear finished tasks'))}>
            Clear Finished
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {tasks.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
              <ListChecks className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm font-medium">No background tasks</p>
              <p className="max-w-xs text-xs text-muted-foreground">Browser installs you start appear here with their progress and verification.</p>
              <Link
                to={settingsPath('browsers')}
                onClick={() => setOpen(false)}
                className="focus-ring mt-2 inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-4 text-sm font-medium hover:bg-muted/50"
              >
                <Settings2 className="h-4 w-4" aria-hidden="true" />
                Manage Browsers
              </Link>
            </div>
          ) : (
            <ul className="divide-y divide-border" aria-label="Tasks">
              {[...active, ...finished].map((task) => (
                <TaskRow key={task.id} task={task} tasks={tasks} now={now} busy={busy[task.id]} onCancel={requestCancel} onRetry={handleRetry} />
              ))}
            </ul>
          )}
        </div>
      </Popover>

      <ConfirmDialog
        open={confirmCancel !== null}
        title={confirmCancel ? `Cancel “${confirmCancel.label}”?` : 'Cancel install?'}
        description="The vendor installer is stopped together with every process it started. A half-finished install may need to be repeated."
        confirmLabel="Cancel Install"
        cancelLabel="Keep Installing"
        destructive
        loading={confirmCancel !== null && busy[confirmCancel.id] === 'cancel'}
        onConfirm={() => {
          const task = confirmCancel
          if (!task) return
          cancel(task.id)
            .catch((err: unknown) => toast.fromError(err, `Could not cancel: ${task.label}`))
            .finally(() => setConfirmCancel(null))
        }}
        onCancel={() => setConfirmCancel(null)}
      />
    </>
  )
}

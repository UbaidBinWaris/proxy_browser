import { AlertCircle, CheckCircle2, RotateCw, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { settingsPath } from '@/lib/navigation'
import { updateNoticeView } from '@/lib/updates'
import { cn } from '@/lib/utils'
import { useUpdatesStore } from '@/stores/updates'

/**
 * Non-blocking banner at the top of the content area after a restart into an update: success with
 * Dismiss, or the failure message with Retry update and a link to App & updates.
 */
export function UpdateNotice(): React.JSX.Element | null {
  const notice = useUpdatesStore((s) => s.notice)
  const retrying = useUpdatesStore((s) => s.retrying)
  const retry = useUpdatesStore((s) => s.retry)
  const dismiss = useUpdatesStore((s) => s.dismiss)
  const view = updateNoticeView(notice)
  if (!view) return null
  const success = view.tone === 'success'
  const Icon = success ? CheckCircle2 : AlertCircle

  return (
    <div
      role={view.role}
      aria-labelledby="update-notice-title"
      aria-describedby="update-notice-description"
      className={cn(
        'flex flex-col gap-4 rounded-lg border p-4 sm:flex-row sm:items-center',
        success ? 'border-success/30 bg-success/5' : 'border-destructive/40 bg-destructive/5',
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', success ? 'text-success' : 'text-destructive')} aria-hidden="true" />
        <div className="min-w-0">
          <p id="update-notice-title" className="text-sm font-medium">
            {view.title}
          </p>
          <p id="update-notice-description" className="mt-1 break-words text-sm text-muted-foreground">
            {view.description}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {view.canRetry ? (
          <>
            <Button size="sm" loading={retrying} disabled={retrying} leftIcon={<RotateCw aria-hidden="true" />} onClick={() => void retry()}>
              Retry update
            </Button>
            <Link
              to={settingsPath('about')}
              className="focus-ring inline-flex h-8 items-center rounded-md px-2 text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              Open App &amp; updates
            </Link>
          </>
        ) : null}
        <Button variant="ghost" size="icon-sm" aria-label="Dismiss update notice" title="Dismiss" disabled={retrying} onClick={() => void dismiss()}>
          <X aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}

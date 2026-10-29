import { AlertOctagon, AlertTriangle, Info, ShieldCheck } from 'lucide-react'
import type { ExitIpNotice } from '@/lib/exitIpWatch'
import { cn } from '@/lib/utils'

const TONE_STYLES: Record<ExitIpNotice['tone'], string> = {
  danger: 'border-destructive/50 bg-destructive/10 text-foreground',
  warning: 'border-warning/40 bg-warning/10 text-foreground',
  info: 'border-info/40 bg-info/10 text-foreground',
  ok: 'border-border/60 bg-muted/20 text-foreground',
}
const TONE_ICON = { danger: AlertOctagon, warning: AlertTriangle, info: Info, ok: ShieldCheck } as const
const ICON_COLOR: Record<ExitIpNotice['tone'], string> = { danger: 'text-destructive', warning: 'text-warning', info: 'text-info', ok: 'text-success' }

/**
 * Exit-IP watch state under the verified IP: a red alert when the provider switched the IP
 * ("do not submit"), an amber note when re-checks fail, a blue note for rotating sessions and
 * a quiet "IP stable" line otherwise. The icon and the wording carry the meaning, not the colour.
 */
export function ExitIpWatchNotice({ notice, className }: { notice: ExitIpNotice | null; className?: string }): React.JSX.Element | null {
  if (!notice) return null
  const Icon = TONE_ICON[notice.tone]
  const urgent = notice.tone === 'danger' || notice.tone === 'warning'
  if (notice.tone === 'ok') {
    return (
      <p className={cn('flex items-start gap-1.5 text-xs text-muted-foreground', className)} role="status">
        <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', ICON_COLOR.ok)} aria-hidden="true" />
        <span className="min-w-0 break-words">
          <span className="font-medium text-foreground">{notice.title}.</span> {notice.detail}
        </span>
      </p>
    )
  }
  return (
    <div className={cn('flex items-start gap-3 rounded-lg border p-4', TONE_STYLES[notice.tone], className)} role={urgent ? 'alert' : 'status'}>
      <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', ICON_COLOR[notice.tone])} aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-sm font-semibold">{notice.title}</p>
        {notice.detail ? <p className="mt-1 break-words text-sm text-muted-foreground">{notice.detail}</p> : null}
      </div>
    </div>
  )
}

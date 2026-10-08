import { AlertTriangle, CheckCircle2, HelpCircle, XCircle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { GeoTarget, TargetMatch } from '@shared/types'
import { Badge } from '@/components/ui/Badge'
import { TARGET_MATCH_META, resolveTargetMatch, targetMatchSentence } from '@/lib/targeting'
import type { VerifiedLocation } from '@/lib/targeting'
import { cn } from '@/lib/utils'

const MATCH_ICONS: Record<TargetMatch, LucideIcon> = {
  match: CheckCircle2,
  partial: AlertTriangle,
  mismatch: XCircle,
  unknown: HelpCircle,
}

export interface TargetMatchBadgeProps {
  /** Verdict recorded by the main process; derived from `target` + `ip` when null/unknown. */
  match: TargetMatch | null | undefined
  target: GeoTarget | null | undefined
  /** Verified location (an IpInfo or the same fields from a run, postal code included for ZIP targets). */
  ip: VerifiedLocation | null | undefined
  /** Also print "Requested X · Got Y" next to the pill. */
  sentence?: boolean
  className?: string
}

/** Requested-vs-verified pill with an icon so the verdict never relies on colour alone. Renders nothing without a target. */
export function TargetMatchBadge({ match, target, ip, sentence = false, className }: TargetMatchBadgeProps): React.JSX.Element | null {
  if (!target) return null
  const resolved = resolveTargetMatch(match, target, ip)
  const meta = TARGET_MATCH_META[resolved]
  const Icon = MATCH_ICONS[resolved]
  const text = targetMatchSentence(target, ip, resolved)
  return (
    <span className={cn('inline-flex min-w-0 flex-wrap items-center gap-2', className)}>
      <Badge variant={meta.variant} title={text ?? undefined}>
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {meta.label}
      </Badge>
      {sentence && text ? <span className="min-w-0 truncate text-xs text-muted-foreground">{text}</span> : null}
    </span>
  )
}

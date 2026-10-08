import type { HTMLAttributes } from 'react'
import type { ProxyStatus, RunStatus, SessionStatus } from '@shared/types'
import { cn } from '@/lib/utils'

export type BadgeVariant = 'default' | 'success' | 'warning' | 'destructive' | 'info' | 'muted' | 'outline'

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant
  /** Show a leading status dot. */
  dot?: boolean
  /** Animate the dot (in-progress states). */
  pulse?: boolean
}

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  default: 'bg-primary/15 text-primary border-primary/30',
  success: 'bg-success/15 text-success border-success/30',
  warning: 'bg-warning/15 text-warning border-warning/30',
  destructive: 'bg-destructive/15 text-destructive border-destructive/30',
  info: 'bg-info/15 text-info border-info/30',
  muted: 'bg-muted text-muted-foreground border-border',
  outline: 'bg-transparent text-foreground border-border',
}

const DOT_CLASSES: Record<BadgeVariant, string> = {
  default: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  info: 'bg-info',
  muted: 'bg-muted-foreground',
  outline: 'bg-foreground',
}

export function Badge({ variant = 'default', dot, pulse, className, children, ...rest }: BadgeProps): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium leading-5',
        VARIANT_CLASSES[variant],
        className,
      )}
      {...rest}
    >
      {dot ? (
        <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
          {pulse ? (
            <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-75', DOT_CLASSES[variant])} />
          ) : null}
          <span className={cn('relative inline-flex h-1.5 w-1.5 rounded-full', DOT_CLASSES[variant])} />
        </span>
      ) : null}
      {children}
    </span>
  )
}

interface StatusMeta {
  label: string
  variant: BadgeVariant
  pulse: boolean
}

export const PROXY_STATUS_META: Record<ProxyStatus, StatusMeta> = {
  untested: { label: 'Untested', variant: 'muted', pulse: false },
  testing: { label: 'Testing', variant: 'warning', pulse: true },
  working: { label: 'Working', variant: 'success', pulse: false },
  failed: { label: 'Failed', variant: 'destructive', pulse: false },
  offline: { label: 'Offline', variant: 'muted', pulse: false },
}

export const RUN_STATUS_META: Record<RunStatus, StatusMeta> = {
  running: { label: 'Running', variant: 'warning', pulse: true },
  success: { label: 'Success', variant: 'success', pulse: false },
  failed: { label: 'Failed', variant: 'destructive', pulse: false },
  aborted: { label: 'Aborted', variant: 'muted', pulse: false },
}

export const SESSION_STATUS_META: Record<SessionStatus, StatusMeta> = {
  starting: { label: 'Validating', variant: 'warning', pulse: true },
  'verifying-proxy': { label: 'Verifying proxy', variant: 'warning', pulse: true },
  launching: { label: 'Launching', variant: 'warning', pulse: true },
  open: { label: 'Open', variant: 'success', pulse: false },
  closing: { label: 'Closing', variant: 'muted', pulse: true },
  closed: { label: 'Closed', variant: 'muted', pulse: false },
  error: { label: 'Error', variant: 'destructive', pulse: false },
}

export type StatusBadgeProps =
  | { kind: 'proxy'; status: ProxyStatus; className?: string }
  | { kind: 'run'; status: RunStatus; className?: string }
  | { kind: 'session'; status: SessionStatus; className?: string }

/** Status pill for ProxyStatus / RunStatus / SessionStatus with consistent colours. */
export function StatusBadge(props: StatusBadgeProps): React.JSX.Element {
  const meta: StatusMeta =
    props.kind === 'proxy'
      ? PROXY_STATUS_META[props.status]
      : props.kind === 'run'
        ? RUN_STATUS_META[props.status]
        : SESSION_STATUS_META[props.status]
  return (
    <Badge variant={meta.variant} dot pulse={meta.pulse} className={props.className}>
      {meta.label}
    </Badge>
  )
}

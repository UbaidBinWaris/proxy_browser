import { CheckCircle2, Loader2, Network, RotateCw, ShieldAlert, ShieldQuestion } from 'lucide-react'
import type { AppError, GeoTarget, IpInfo, ProductKey, TargetMatch } from '@shared/types'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { CopyButton } from '@/components/ui/CopyButton'
import { LocationAttemptsNote } from '@/components/LocationAttemptsNote'
import { TargetMatchBadge } from '@/components/TargetMatchBadge'
import { errorLabel } from '@/lib/result'
import { sessionLabelFor } from '@/lib/launch'
import type { ConnectionKind } from '@/lib/launch'
import { describeTarget, locationAttemptsLabel, poolLabel, resolveTargetMatch, targetMatchSentence } from '@/lib/targeting'
import { cn, formatDate, orDash } from '@/lib/utils'
import type { ProviderLike } from '@/lib/providers'

export interface ProxyStatusCardProps {
  ip: IpInfo | null
  error: AppError | null
  /** Sticky session id used for this check; null for the rotating gateway and for direct connections. */
  sessionId: string | null
  /**
   * How the connection was made. Drives the DIRECT CONNECTION variant and the session label
   * ("none" / "rotating" / sticky id). Defaults to sticky when a session id is present, rotating otherwise.
   */
  kind?: ConnectionKind
  /** Provider product the connection goes through (shown as a badge; omitted for direct connections). */
  pool?: ProductKey | null
  /** The provider of `pool`, for labels ("DataImpulse Residential"). */
  provider?: Pick<ProviderLike, 'displayName' | 'capabilities'> | null
  /** Requested exit location, compared with the verified IP. */
  target?: GeoTarget | null
  /** Verdict recorded by the main process (derived from target + ip when null). */
  targetMatch?: TargetMatch | null
  /** Exact parameters sent to the provider (no secrets), shown in monospace with a copy button. */
  targetingString?: string | null
  /** Show the pool · requested · targeting-string line (off when the parent already shows it, e.g. LaunchPanel). */
  showTargetingLine?: boolean
  /** Location re-roll: sticky session ids tried so far, the budget, and the fallback warning (see BrowserSession). */
  locationAttempts?: number
  locationMaxAttempts?: number
  locationWarning?: string | null
  testing?: boolean
  onRetry?: () => void
  /** Label of the retry/test button; defaults depend on the state. */
  retryLabel?: string
  className?: string
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn('mt-0.5 truncate text-sm font-medium', mono && 'font-mono')} title={value}>
        {value}
      </dd>
    </div>
  )
}

const DIRECT_NOTE = "Browser is connecting without a proxy; this is the machine's own exit IP."

/** Pool · requested target · targeting string, shown under the heading of proxied cards. */
function TargetingLine({
  pool,
  provider,
  target,
  targetingString,
}: {
  pool: ProductKey | null | undefined
  provider: Pick<ProviderLike, 'displayName' | 'capabilities'> | null | undefined
  target: GeoTarget | null | undefined
  targetingString: string | null | undefined
}): React.JSX.Element | null {
  if (!pool && !target && !targetingString) return null
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      {pool ? <Badge variant="default">{poolLabel(pool, provider)}</Badge> : null}
      {target ? (
        <span>
          Requested <span className="font-medium text-foreground">{describeTarget(target)}</span>
        </span>
      ) : null}
      {targetingString ? (
        <span className="flex min-w-0 items-center gap-1">
          <code className="min-w-0 truncate rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground" title={targetingString}>
            {targetingString}
          </code>
          <CopyButton value={targetingString} label="Copy targeting string" />
        </span>
      ) : null}
    </div>
  )
}

/**
 * The large exit-IP verdict card.
 * Proxied runs: PROXY READY (success) / PROXY FAILED (destructive) / testing / untested, with the
 * requested-vs-verified match next to the location when a target was requested.
 * Direct runs (proxyMode 'none'): DIRECT CONNECTION in a neutral info colour with session "none".
 */
export function ProxyStatusCard({
  ip,
  error,
  sessionId,
  kind,
  pool = null,
  provider = null,
  target = null,
  targetMatch = null,
  targetingString = null,
  showTargetingLine = true,
  locationAttempts = 1,
  locationMaxAttempts = 1,
  locationWarning = null,
  testing = false,
  onRetry,
  retryLabel,
  className,
}: ProxyStatusCardProps): React.JSX.Element {
  const connection: ConnectionKind = kind ?? (sessionId ? 'sticky' : 'rotating')
  const direct = connection === 'direct'
  const sessionLabel = sessionLabelFor(connection, sessionId)
  const targeting = direct || !showTargetingLine ? null : <TargetingLine pool={pool} provider={provider} target={target} targetingString={targetingString} />
  const attemptLabel = locationAttemptsLabel({ locationAttempts, locationMaxAttempts })

  if (testing) {
    return (
      <Card className={cn('p-5', direct ? 'border-info/40' : 'border-warning/40', className)} role="status" aria-live="polite">
        <div className="flex items-center gap-3">
          <Loader2 className={cn('h-5 w-5 animate-spin', direct ? 'text-info' : 'text-warning')} aria-hidden="true" />
          <div>
            <p className={cn('text-xs font-semibold uppercase tracking-widest', direct ? 'text-info' : 'text-warning')}>
              {direct ? 'Direct connection' : 'Testing proxy'}
            </p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {direct ? (
                'Detecting the machine’s own exit IP (no proxy)…'
              ) : (
                <>
                  Connecting through {pool ? poolLabel(pool, provider) : (provider?.displayName ?? 'the proxy')} and verifying the exit IP (session: <span className="font-mono">{sessionLabel}</span>{attemptLabel ? `, ${attemptLabel}` : ''})…
                </>
              )}
            </p>
          </div>
        </div>
        {targeting}
      </Card>
    )
  }

  if (error) {
    return (
      <Card className={cn('border-destructive/50 bg-destructive/5 p-5', className)} role="alert">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-widest text-destructive">{direct ? 'Exit IP check failed' : 'Proxy failed'}</p>
              <p className="mt-1 text-sm font-medium">
                {errorLabel(error.code)}
                <span className="ml-2 font-mono text-xs text-muted-foreground">{error.code}</span>
              </p>
              <p className="mt-1 break-words text-sm text-muted-foreground">{error.message}</p>
              {error.detail ? <p className="mt-1 break-words font-mono text-xs text-muted-foreground/80">{error.detail}</p> : null}
              <p className="mt-2 text-xs text-muted-foreground">
                Session: <span className="font-mono">{sessionLabel}</span>
              </p>
            </div>
          </div>
          {onRetry ? (
            <Button variant="outline" onClick={onRetry} leftIcon={<RotateCw className="h-4 w-4" aria-hidden="true" />}>
              {retryLabel ?? 'Retry'}
            </Button>
          ) : null}
        </div>
        {targeting}
      </Card>
    )
  }

  if (!ip) {
    return (
      <Card className={cn('p-5', direct && 'border-info/30', className)}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {direct ? (
              <Network className="h-5 w-5 text-info" aria-hidden="true" />
            ) : (
              <ShieldQuestion className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            )}
            <div>
              <p className={cn('text-xs font-semibold uppercase tracking-widest', direct ? 'text-info' : 'text-muted-foreground')}>
                {direct ? 'Direct connection' : 'Proxy untested'}
              </p>
              <p className="mt-0.5 text-sm text-muted-foreground">{direct ? DIRECT_NOTE : 'Run a test to detect the exit IP for this session.'}</p>
            </div>
          </div>
          {onRetry ? (
            <Button variant="primary" onClick={onRetry} leftIcon={<RotateCw className="h-4 w-4" aria-hidden="true" />}>
              {retryLabel ?? (direct ? 'Check Exit IP' : 'Test Proxy')}
            </Button>
          ) : null}
        </div>
        {targeting}
      </Card>
    )
  }

  return (
    <Card className={cn('p-5', direct ? 'border-info/40' : 'border-success/40', className)} role="status">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          {direct ? (
            <Network className="h-5 w-5 text-info" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="h-5 w-5 text-success" aria-hidden="true" />
          )}
          <div>
            <p className={cn('text-xs font-semibold uppercase tracking-widest', direct ? 'text-info' : 'text-success')}>
              {direct ? 'Direct connection' : 'Proxy ready'}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Checked {formatDate(ip.checkedAt, { seconds: true })} via {ip.provider}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={direct ? 'info' : 'muted'} className="font-mono">
            {sessionLabel}
          </Badge>
          {onRetry ? (
            <Button variant="ghost" size="sm" onClick={onRetry} leftIcon={<RotateCw className="h-3.5 w-3.5" aria-hidden="true" />}>
              {retryLabel ?? 'Re-test'}
            </Button>
          ) : null}
        </div>
      </div>
      {direct ? <p className="mt-3 text-xs text-muted-foreground">{DIRECT_NOTE}</p> : null}
      {targeting}
      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
        <div className="col-span-2 md:col-span-1">
          <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Public IP</dt>
          <dd className="tabular mt-0.5 font-mono text-xl font-semibold tracking-tight">{ip.ip}</dd>
        </div>
        <Fact label="Country" value={ip.countryCode ? `${orDash(ip.country)} (${ip.countryCode})` : orDash(ip.country)} />
        <Fact label="State / Region" value={orDash(ip.region)} />
        <Fact label="City / ZIP" value={ip.postalCode ? `${orDash(ip.city)} · ${ip.postalCode}` : orDash(ip.city)} />
        <Fact label="ISP" value={ip.asn ? `${orDash(ip.isp)} · ${ip.asn}` : orDash(ip.isp)} />
        <Fact label="Latency" value={`${Math.round(ip.latencyMs)} ms`} mono />
        <Fact label="Session" value={sessionLabel} mono />
        {target && !direct ? (
          <div className="col-span-2 min-w-0 md:col-span-1">
            <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Requested vs. verified</dt>
            <dd className="mt-1">
              <TargetMatchBadge match={targetMatch} target={target} ip={ip} />
            </dd>
          </div>
        ) : null}
      </dl>
      {target && !direct ? (
        <p className="mt-4 text-sm text-foreground" aria-live="polite">
          {targetMatchSentence(target, ip, resolveTargetMatch(targetMatch, target, ip))}
        </p>
      ) : null}
      {!direct ? <LocationAttemptsNote attempts={locationAttempts} maxAttempts={locationMaxAttempts} warning={locationWarning} className="mt-2" /> : null}
    </Card>
  )
}

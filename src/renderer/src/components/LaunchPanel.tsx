import { Camera, Check, Circle, Loader2, X, XCircle } from 'lucide-react'
import type { BrowserSession, DevicePresetInfo, SessionStatus } from '@shared/types'
import { BROWSER_ENGINE_LABELS } from '@shared/types'
import { Card, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge, StatusBadge } from '@/components/ui/Badge'
import { CopyButton } from '@/components/ui/CopyButton'
import { ErrorAlert } from '@/components/ui/ErrorAlert'
import { ProxyStatusCard } from '@/components/ProxyStatusCard'
import { LocationAttemptsNote } from '@/components/LocationAttemptsNote'
import { TargetMatchBadge } from '@/components/TargetMatchBadge'
import { deriveLaunchSteps, failedStepFor, isBrowserWindowOpen, stepLabel } from '@/lib/launch'
import type { ConnectionKind, LaunchStep } from '@/lib/launch'
import { describeTarget, poolLabel } from '@/lib/targeting'
import { useProvider } from '@/hooks/useProviders'
import { isSessionLive } from '@/stores/sessions'
import { cn, formatDate } from '@/lib/utils'

export interface LaunchPanelProps {
  session: BrowserSession
  /** Direct vs. proxied, resolved from the profile by the caller. */
  connection: ConnectionKind
  /** Status seen right before the session errored (from the sessions store), if known. */
  statusBeforeError?: SessionStatus | null
  busy: 'closing' | 'screenshot' | 'focusing' | undefined
  /** True while a retry launch request is in flight. */
  relaunching?: boolean
  /** Device preset behind the session (for its label); null while presets are loading. */
  preset?: DevicePresetInfo | null
  onScreenshot: (session: BrowserSession) => void
  onClose: (session: BrowserSession) => void
  /** Launch the same profile again (a new run). Shown on failure. */
  onRetryLaunch?: () => void
}

const STEP_STATE_TEXT: Record<LaunchStep['state'], string> = {
  done: 'complete',
  active: 'in progress',
  failed: 'failed',
  pending: 'pending',
}

function StepIcon({ state }: { state: LaunchStep['state'] }): React.JSX.Element {
  switch (state) {
    case 'failed':
      return <XCircle className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
    case 'active':
      return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-warning" aria-hidden="true" />
    case 'done':
      return <Check className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
    case 'pending':
      return <Circle className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden="true" />
  }
}

const STEP_CLASSES: Record<LaunchStep['state'], string> = {
  failed: 'border-destructive/50 bg-destructive/10 text-foreground',
  active: 'border-warning/50 bg-warning/10 text-foreground',
  done: 'border-success/40 bg-success/5 text-foreground',
  pending: 'border-border text-muted-foreground',
}

/**
 * Live launch progress for a BrowserSession (Validating → Verifying proxy → Launching → Open),
 * the exit-IP verdict as soon as the IP is known, and the session controls.
 * On failure only the step that was in progress is marked failed; earlier steps stay complete.
 */
export function LaunchPanel({
  session,
  connection,
  statusBeforeError,
  busy,
  relaunching = false,
  preset = null,
  onScreenshot,
  onClose,
  onRetryLaunch,
}: LaunchPanelProps): React.JSX.Element {
  const live = isSessionLive(session)
  const errored = session.status === 'error'
  const verifying = session.status === 'verifying-proxy'
  const steps = deriveLaunchSteps(session, { statusBeforeError, connection })
  const failedStep = errored ? failedStepFor(session, statusBeforeError) : null
  const windowOpen = isBrowserWindowOpen(session, statusBeforeError)
  const failedAtVerify = failedStep === 'verifying'
  const showProxyCard = session.ip !== null || verifying || failedAtVerify
  const direct = connection === 'direct'
  const provider = useProvider(session.provider)
  const deviceLabel = preset?.label ?? session.devicePreset
  // Quick-launch profile names already contain the device ("Direct · Pixel 7"); do not repeat it.
  const deviceSuffix = session.profileName.includes(deviceLabel) ? '' : ` · ${deviceLabel}`

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            Live session
            <StatusBadge kind="session" status={session.status} />
          </span>
        }
        description={`${session.profileName} · ${BROWSER_ENGINE_LABELS[session.engine]}${deviceSuffix} · started ${formatDate(session.startedAt, { seconds: true })}`}
        actions={
          live ? (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={!windowOpen}
                title={windowOpen ? undefined : 'Available once the browser window is open'}
                loading={busy === 'screenshot'}
                onClick={() => onScreenshot(session)}
                leftIcon={<Camera className="h-3.5 w-3.5" aria-hidden="true" />}
              >
                Take Screenshot
              </Button>
              <Button
                variant="destructive"
                size="sm"
                loading={busy === 'closing'}
                onClick={() => onClose(session)}
                leftIcon={<X className="h-3.5 w-3.5" aria-hidden="true" />}
              >
                {windowOpen || session.status !== 'error' ? 'Close Browser' : 'Dismiss Session'}
              </Button>
            </>
          ) : null
        }
      />
      <div className="flex flex-col gap-5 p-5">
        <ol className="grid grid-cols-2 gap-2 md:grid-cols-4" aria-label="Launch progress">
          {steps.map((step) => (
            <li
              key={step.id}
              aria-current={step.state === 'active' ? 'step' : undefined}
              className={cn('flex items-center gap-2 rounded-md border px-3 py-2 text-sm', STEP_CLASSES[step.state])}
            >
              <StepIcon state={step.state} />
              <span className="truncate font-medium">{step.label}</span>
              <span className="sr-only">{STEP_STATE_TEXT[step.state]}</span>
            </li>
          ))}
        </ol>

        <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-sm text-muted-foreground" aria-live="polite">
          <span>{session.statusDetail}</span>
          {session.currentUrl ? (
            <span className="min-w-0 max-w-full truncate font-mono text-xs" title={session.currentUrl}>
              {session.currentUrl}
            </span>
          ) : null}
        </p>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-md border border-border bg-muted/30 px-4 py-3 md:grid-cols-4" aria-label="Targeting">
          <div className="min-w-0">
            <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Pool</dt>
            <dd className="mt-1">
              <Badge variant={direct || !session.proxyPool ? 'info' : 'default'}>{direct ? 'Direct (no proxy)' : poolLabel(session.proxyPool, provider)}</Badge>
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Requested</dt>
            <dd className="mt-1 truncate text-sm" title={describeTarget(session.target)}>
              {direct ? '—' : describeTarget(session.target)}
            </dd>
          </div>
          <div className="col-span-2 min-w-0">
            <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Targeting string</dt>
            <dd className="mt-1 flex min-w-0 items-center gap-1">
              {session.targetingString ? (
                <>
                  <code className="min-w-0 truncate rounded bg-background px-1.5 py-0.5 font-mono text-xs" title={session.targetingString}>
                    {session.targetingString}
                  </code>
                  <CopyButton value={session.targetingString} label="Copy targeting string" />
                </>
              ) : (
                <span className="text-sm text-muted-foreground">{direct ? 'none' : 'provider default'}</span>
              )}
            </dd>
          </div>
          {session.target && !direct && !showProxyCard ? (
            <div className="col-span-2 min-w-0 md:col-span-4">
              <dt className="sr-only">Requested vs. verified</dt>
              <dd>
                <TargetMatchBadge match={session.targetMatch} target={session.target} ip={session.ip} sentence />
              </dd>
              <LocationAttemptsNote attempts={session.locationAttempts} maxAttempts={session.locationMaxAttempts} warning={session.locationWarning} className="mt-1" />
            </div>
          ) : null}
        </dl>

        {showProxyCard ? (
          <ProxyStatusCard
            ip={session.ip}
            error={failedAtVerify ? session.error : null}
            sessionId={session.proxySessionId}
            kind={connection}
            pool={session.proxyPool}
            provider={provider}
            target={session.target}
            targetMatch={session.targetMatch}
            targetingString={session.targetingString}
            showTargetingLine={false}
            locationAttempts={session.locationAttempts}
            locationMaxAttempts={session.locationMaxAttempts}
            locationWarning={session.locationWarning}
            testing={verifying}
            onRetry={failedAtVerify && onRetryLaunch && !relaunching ? onRetryLaunch : undefined}
            retryLabel="Retry launch"
          />
        ) : null}

        {errored && session.error && !failedAtVerify ? (
          <ErrorAlert
            error={session.error}
            title={`Launch failed · ${stepLabel(failedStep ?? 'open', connection)}`}
            onRetry={onRetryLaunch && !relaunching ? onRetryLaunch : undefined}
            retryLabel="Retry launch"
          />
        ) : null}

        {errored && onRetryLaunch && relaunching ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            Starting a new run for {session.profileName}…
          </p>
        ) : null}
      </div>
    </Card>
  )
}

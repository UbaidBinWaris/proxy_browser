import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AppWindow, RefreshCw, Rocket, Trash2, X } from 'lucide-react'
import type { BrowserSession, TestRun } from '@shared/types'
import { BROWSER_ENGINE_LABELS } from '@shared/types'
import { EngineIcon } from '@/components/icons/BrandIcon'
import { PageHeader } from '@/components/ui/PageHeader'
import { Card, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge, StatusBadge } from '@/components/ui/Badge'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorAlert } from '@/components/ui/ErrorAlert'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from '@/components/ui/Table'
import { SessionsTable } from '@/components/SessionsTable'
import { TargetMatchBadge } from '@/components/TargetMatchBadge'
import { historyRunPath } from '@/lib/navigation'
import { describeTarget, locationAttemptsLabel } from '@/lib/targeting'
import { recordPoolLabel } from '@/lib/providers'
import { useProviders } from '@/hooks/useProviders'
import { describeVerifiedLocation, formatDate, orDash } from '@/lib/utils'
import { useProfilesStore } from '@/stores/profiles'
import { useRunsStore } from '@/stores/runs'
import { useSessionsStore, selectLiveSessions } from '@/stores/sessions'
import { toast } from '@/stores/toasts'

export const RECENT_RUNS_LIMIT = 10

/** The last finished runs (anything not still running), newest first. */
export function selectRecentFinishedRuns(runs: readonly TestRun[], limit: number = RECENT_RUNS_LIMIT): TestRun[] {
  return runs.filter((run) => run.status !== 'running').slice(0, limit)
}

export function SessionsPage(): React.JSX.Element {
  const providers = useProviders()
  const navigate = useNavigate()
  const sessionsById = useSessionsStore((s) => s.sessions)
  const status = useSessionsStore((s) => s.status)
  const error = useSessionsStore((s) => s.error)
  const load = useSessionsStore((s) => s.load)
  const busy = useSessionsStore((s) => s.busy)
  const focusSession = useSessionsStore((s) => s.focus)
  const statusBeforeError = useSessionsStore((s) => s.statusBeforeError)
  const closingAll = useSessionsStore((s) => s.closingAll)
  const close = useSessionsStore((s) => s.close)
  const closeMany = useSessionsStore((s) => s.closeMany)
  const closeAll = useSessionsStore((s) => s.closeAll)
  const screenshot = useSessionsStore((s) => s.screenshot)
  const presets = useProfilesStore((s) => s.presets)
  const loadPresets = useProfilesStore((s) => s.loadPresets)
  const runs = useRunsStore((s) => s.runs)
  const loadRuns = useRunsStore((s) => s.load)

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [confirmAll, setConfirmAll] = useState(false)
  const [closingSelected, setClosingSelected] = useState(false)

  useEffect(() => {
    void load()
    void loadPresets()
    void loadRuns(50)
  }, [load, loadPresets, loadRuns])

  const sessions = useMemo(() => selectLiveSessions(sessionsById), [sessionsById])
  const recentRuns = useMemo(() => selectRecentFinishedRuns(runs), [runs])

  // Sessions that closed meanwhile leave the selection.
  useEffect(() => {
    setSelected((current) => {
      const next = new Set([...current].filter((id) => sessions.some((session) => session.id === id)))
      return next.size === current.size ? current : next
    })
  }, [sessions])

  const toggle = (id: string): void =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleAll = (checked: boolean): void => setSelected(checked ? new Set(sessions.map((session) => session.id)) : new Set())

  const handleTerminate = async (session: BrowserSession): Promise<void> => {
    try {
      await close(session.id)
      toast.info('Session terminated', session.profileName)
    } catch (err) {
      toast.fromError(err, `Could not terminate ${session.profileName}`)
    }
  }

  const handleScreenshot = async (session: BrowserSession): Promise<void> => {
    try {
      const path = await screenshot(session.id)
      toast.success('Screenshot saved', path)
    } catch (err) {
      toast.fromError(err, 'Screenshot failed')
    }
  }

  const handleFocus = async (session: BrowserSession): Promise<void> => {
    try {
      await focusSession(session.id)
    } catch (err) {
      toast.fromError(err, 'Could not bring the browser to the front')
    }
  }

  const handleTerminateSelected = async (): Promise<void> => {
    const ids = [...selected]
    if (ids.length === 0) return
    setClosingSelected(true)
    try {
      const failed = await closeMany(ids)
      if (failed.length === 0) toast.info(`${ids.length} session${ids.length === 1 ? '' : 's'} terminated`)
      else toast.error(`${failed.length} of ${ids.length} sessions could not be terminated`, 'See Settings → Advanced → Logs for details.')
      setSelected(new Set())
    } finally {
      setClosingSelected(false)
    }
  }

  const handleTerminateAll = async (): Promise<void> => {
    try {
      await closeAll()
      toast.info('All sessions terminated')
      setSelected(new Set())
      void load()
    } catch (err) {
      toast.fromError(err, 'Could not terminate all sessions')
    } finally {
      setConfirmAll(false)
    }
  }

  const anyBusy = closingAll || closingSelected

  return (
    <>
      <PageHeader
        title="Sessions"
        description="Open browsers and their verified exit IPs."
        actions={
          <>
            <Button variant="outline" onClick={() => void load()} loading={status === 'loading'} leftIcon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}>
              Refresh
            </Button>
            <Button variant="primary" onClick={() => navigate('/launch')} leftIcon={<Rocket className="h-4 w-4" aria-hidden="true" />}>
              Launch
            </Button>
          </>
        }
      />

      {error ? <ErrorAlert error={error} title="Could not load sessions" onRetry={() => void load()} /> : null}

      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              Live sessions
              <Badge variant={sessions.length > 0 ? 'success' : 'muted'} dot>
                {sessions.length}
              </Badge>
            </span>
          }
          actions={
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={selected.size === 0 || anyBusy}
                loading={closingSelected}
                onClick={() => void handleTerminateSelected()}
                leftIcon={<X className="h-3.5 w-3.5" aria-hidden="true" />}
              >
                Terminate selected{selected.size > 0 ? ` (${selected.size})` : ''}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={sessions.length === 0 || anyBusy}
                loading={closingAll}
                onClick={() => setConfirmAll(true)}
                leftIcon={<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
              >
                Terminate all
              </Button>
            </>
          }
        />
        {status === 'loading' && sessions.length === 0 ? (
          <SkeletonRows rows={3} columns={8} />
        ) : sessions.length === 0 ? (
          <EmptyState
            icon={AppWindow}
            title="No browser session is open"
            description="Launched browsers appear here with their exit IP."
            action={
              <Button variant="primary" onClick={() => navigate('/launch')} leftIcon={<Rocket className="h-4 w-4" aria-hidden="true" />}>
                Connect & Launch
              </Button>
            }
            className="m-4 border-0"
          />
        ) : (
          <SessionsTable
            sessions={sessions}
            presets={presets}
            selected={selected}
            onToggle={toggle}
            onToggleAll={toggleAll}
            busy={busy}
            statusBeforeError={statusBeforeError}
            onScreenshot={(session) => void handleScreenshot(session)}
            onFocus={(session) => void handleFocus(session)}
            onTerminate={(session) => void handleTerminate(session)}
          />
        )}
      </Card>

      <Card>
        <CardHeader
          title="Recently finished"
          actions={
            <Link to="/history" className="focus-ring rounded text-xs font-medium text-primary hover:underline">
              All history
            </Link>
          }
        />
        {recentRuns.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">No finished runs yet.</p>
        ) : (
          <Table aria-label="Recent finished runs">
            <TableHead>
              <TableRow>
                <TableHeaderCell>Ended</TableHeaderCell>
                <TableHeaderCell>Profile</TableHeaderCell>
                <TableHeaderCell>Pool</TableHeaderCell>
                <TableHeaderCell>Requested</TableHeaderCell>
                <TableHeaderCell>Verified</TableHeaderCell>
                <TableHeaderCell>Match</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {recentRuns.map((run) => {
                const verified = describeVerifiedLocation(run)
                return (
                  <TableRow key={run.id}>
                    <TableCell className="tabular whitespace-nowrap text-xs text-muted-foreground">{formatDate(run.endedAt ?? run.startedAt, { seconds: true })}</TableCell>
                    <TableCell className="max-w-[220px]">
                      <Link to={historyRunPath(run.id)} className="focus-ring block truncate rounded font-medium hover:underline" title={run.profileName}>
                        {run.profileName}
                      </Link>
                      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                        <EngineIcon engine={run.engine} size={14} />
                        <span className="truncate">{BROWSER_ENGINE_LABELS[run.engine]}</span>
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={run.proxyPool ? 'default' : 'info'}>{recordPoolLabel(providers, run.provider, run.proxyPool)}</Badge>
                    </TableCell>
                    <TableCell className="max-w-[160px]">
                      <span className="block truncate" title={describeTarget(run.target)}>
                        {describeTarget(run.target)}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-[220px]">
                      <span className="block truncate" title={verified}>
                        {verified}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        <span className="font-mono">{orDash(run.publicIp)}</span>
                        {locationAttemptsLabel(run) ? <span title={run.locationWarning ?? undefined}> · {locationAttemptsLabel(run)}</span> : null}
                      </span>
                    </TableCell>
                    <TableCell>
                      {run.target ? (
                        <TargetMatchBadge match={run.targetMatch} target={run.target} ip={{ country: run.country, countryCode: null, region: run.region, city: run.city, postalCode: run.postalCode }} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadge kind="run" status={run.status} />
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      <ConfirmDialog
        open={confirmAll}
        title="Terminate all sessions?"
        description={`Every open browser window (${sessions.length}) is closed and its run is marked aborted. Screenshots already taken are kept.`}
        confirmLabel="Terminate all"
        destructive
        loading={closingAll}
        onConfirm={() => void handleTerminateAll()}
        onCancel={() => setConfirmAll(false)}
      />
    </>
  )
}

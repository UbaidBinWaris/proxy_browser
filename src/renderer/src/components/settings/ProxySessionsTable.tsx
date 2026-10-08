import { useEffect } from 'react'
import { RefreshCw, RotateCw, Shuffle } from 'lucide-react'
import type { Profile, ProxySession } from '@shared/types'
import { Button } from '@/components/ui/Button'
import { StatusBadge } from '@/components/ui/Badge'
import { ErrorAlert } from '@/components/ui/ErrorAlert'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from '@/components/ui/Table'
import { proxySessionIdLabel, proxySessionName, rotateDisabledReason, testDisabledReason } from '@/lib/proxySessions'
import { describeVerifiedLocation, formatDate, orDash } from '@/lib/utils'
import { useProfilesStore, selectProfileById } from '@/stores/profiles'
import { useProxyStore } from '@/stores/proxy'
import { toast } from '@/stores/toasts'

/**
 * Proxy session history (Settings → Advanced): sticky sessions assigned to profiles and the gateway
 * row, with their last verified exit IP. Test re-checks a profile's session; Rotate requests a new IP.
 */
export function ProxySessionsTable(): React.JSX.Element {
  const sessions = useProxyStore((s) => s.sessions)
  const status = useProxyStore((s) => s.sessionsStatus)
  const error = useProxyStore((s) => s.sessionsError)
  const load = useProxyStore((s) => s.loadSessions)
  const busyProfiles = useProxyStore((s) => s.busyProfiles)
  const testProfile = useProxyStore((s) => s.testProfile)
  const rotateProfile = useProxyStore((s) => s.rotateProfile)
  const profiles = useProfilesStore((s) => s.items)
  const loadProfiles = useProfilesStore((s) => s.load)

  useEffect(() => {
    void load()
    void loadProfiles()
  }, [load, loadProfiles])

  const profileFor = (session: ProxySession): Profile | null => selectProfileById(profiles, session.profileId)
  const nameFor = (session: ProxySession): string => proxySessionName(session, profileFor(session))

  const handleTest = async (session: ProxySession): Promise<void> => {
    if (!session.profileId) return
    try {
      const result = await testProfile(session.profileId)
      if (result.status === 'working' && result.ip) toast.success(`Proxy working · ${nameFor(session)}`, `Exit IP ${result.ip.ip}`)
      else if (result.error) toast.error(`Proxy failed · ${nameFor(session)}`, `${result.error.code}: ${result.error.message}`)
      void load()
    } catch (err) {
      toast.fromError(err, 'Proxy test failed')
    }
  }

  const handleRotate = async (session: ProxySession): Promise<void> => {
    if (!session.profileId) return
    try {
      const rotated = await rotateProfile(session.profileId)
      toast.success(`Session rotated · ${nameFor(session)}`, `New session id ${rotated.sessionId ?? '—'} · ${rotated.status}`)
    } catch (err) {
      toast.fromError(err, 'Could not rotate session')
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">A row appears the first time a proxied profile is tested or launched.</p>
        <Button variant="outline" size="sm" onClick={() => void load()} loading={status === 'loading'} leftIcon={<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}>
          Refresh
        </Button>
      </div>
      {error ? <ErrorAlert error={error} title="Could not load proxy sessions" onRetry={() => void load()} compact /> : null}
      <div className="rounded-md border border-border">
        {status === 'loading' && sessions.length === 0 ? (
          <SkeletonRows rows={4} columns={6} />
        ) : sessions.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">No proxy sessions yet.</p>
        ) : (
          <Table aria-label="Proxy session history">
            <TableHead>
              <TableRow>
                <TableHeaderCell>Profile</TableHeaderCell>
                <TableHeaderCell>Session ID</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>IP</TableHeaderCell>
                <TableHeaderCell>Location</TableHeaderCell>
                <TableHeaderCell>ISP</TableHeaderCell>
                <TableHeaderCell className="text-right">Latency</TableHeaderCell>
                <TableHeaderCell>Last checked</TableHeaderCell>
                <TableHeaderCell>Error</TableHeaderCell>
                <TableHeaderCell className="text-right">Actions</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {sessions.map((session) => {
                const profile = profileFor(session)
                const name = proxySessionName(session, profile)
                const busy = session.profileId ? busyProfiles[session.profileId] : undefined
                const rowStatus = busy === 'testing' || busy === 'rotating' ? 'testing' : session.status
                const rotateReason = rotateDisabledReason(session, profile)
                const testReason = testDisabledReason(session, profile)
                return (
                  <TableRow key={session.id}>
                    <TableCell className="max-w-[180px]">
                      <span className={profile ? 'block truncate font-medium' : 'block truncate font-medium text-muted-foreground'} title={name}>
                        {name}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-[180px]">
                      <span className="block truncate font-mono text-xs" title={proxySessionIdLabel(session, profile)}>
                        {proxySessionIdLabel(session, profile)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge kind="proxy" status={rowStatus} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{orDash(session.lastIp)}</TableCell>
                    <TableCell className="max-w-[200px]">
                      <span className="block truncate text-muted-foreground" title={describeVerifiedLocation(session)}>
                        {describeVerifiedLocation(session)}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-[160px]">
                      <span className="block truncate text-muted-foreground" title={session.isp ?? undefined}>
                        {orDash(session.isp)}
                      </span>
                    </TableCell>
                    <TableCell className="tabular text-right font-mono text-xs">{session.latencyMs === null ? '—' : `${Math.round(session.latencyMs)} ms`}</TableCell>
                    <TableCell className="tabular whitespace-nowrap text-xs text-muted-foreground">{formatDate(session.lastCheckedAt, { seconds: true })}</TableCell>
                    <TableCell className="max-w-[220px]">
                      {session.lastError ? (
                        <span className="block truncate text-xs text-destructive" title={session.lastError}>
                          {session.lastError}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <span className="inline-flex" title={testReason ?? undefined}>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={testReason !== null || busy !== undefined}
                            loading={busy === 'testing'}
                            onClick={() => void handleTest(session)}
                            leftIcon={<RotateCw className="h-3.5 w-3.5" aria-hidden="true" />}
                            aria-label={testReason ? `Test unavailable for ${name}: ${testReason}` : `Test proxy for ${name}`}
                          >
                            Test
                          </Button>
                        </span>
                        <span className="inline-flex" title={rotateReason ?? undefined}>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={rotateReason !== null || busy !== undefined}
                            loading={busy === 'rotating'}
                            onClick={() => void handleRotate(session)}
                            leftIcon={<Shuffle className="h-3.5 w-3.5" aria-hidden="true" />}
                            aria-label={rotateReason ? `Rotate unavailable for ${name}: ${rotateReason}` : `Rotate proxy session for ${name}`}
                          >
                            Rotate
                          </Button>
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}

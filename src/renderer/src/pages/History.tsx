import { useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { FlaskConical, RefreshCw, Rocket } from 'lucide-react'
import { PageHeader } from '@/components/ui/PageHeader'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorAlert } from '@/components/ui/ErrorAlert'
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton'
import { RunsTable } from '@/components/RunsTable'
import { getApi, useApiCall } from '@/lib/api'
import { formatSuccessRate, historyOverview } from '@/lib/history'
import { relativeTime } from '@/lib/security'
import { describeVerifiedLocation } from '@/lib/utils'
import { useRunsStore } from '@/stores/runs'

export const HISTORY_RUN_LIMIT = 200

interface OverviewItemProps {
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  loading?: boolean
  title?: string
}

function OverviewItem({ label, value, sub, loading = false, title }: OverviewItemProps): React.JSX.Element {
  return (
    <div className="min-w-0 px-4 py-3">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 min-w-0" title={title}>
        {loading ? (
          <Skeleton className="h-5 w-16" />
        ) : (
          <>
            <span className="tabular block truncate text-lg font-semibold tracking-tight">{value}</span>
            {sub ? <span className="block truncate text-xs text-muted-foreground">{sub}</span> : null}
          </>
        )}
      </dd>
    </div>
  )
}

/** Every launch is a run: overview strip + the run list (details at /history/:id). */
export function HistoryPage(): React.JSX.Element {
  const navigate = useNavigate()
  const runs = useRunsStore((s) => s.runs)
  const status = useRunsStore((s) => s.status)
  const error = useRunsStore((s) => s.error)
  const load = useRunsStore((s) => s.load)
  const stats = useApiCall(() => getApi().dashboard.stats())

  const runStats = stats.run
  useEffect(() => {
    void load(HISTORY_RUN_LIMIT)
    void runStats()
  }, [load, runStats])

  const overview = useMemo(() => historyOverview(runs), [runs])
  const statsLoading = stats.loading && !stats.data
  const ip = stats.data?.currentIp ?? null

  const refresh = (): void => {
    void load(HISTORY_RUN_LIMIT)
    void stats.run()
  }

  return (
    <>
      <PageHeader
        title="History"
        description="Every launch with its exit IP, outcome and captured ids."
        actions={
          <Button variant="outline" onClick={refresh} loading={status === 'loading' || stats.loading} leftIcon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}>
            Refresh
          </Button>
        }
      />

      <section aria-label="Overview">
        <dl className="grid grid-cols-2 divide-border rounded-lg border border-border bg-card lg:grid-cols-4 lg:divide-x">
          <OverviewItem label="Profiles" value={stats.data?.totalProfiles ?? '—'} loading={statsLoading} />
          <OverviewItem label="Runs today" value={overview.runsToday} loading={status === 'loading' && runs.length === 0} />
          <OverviewItem
            label="Success rate"
            value={formatSuccessRate(overview.successRate)}
            sub={overview.judged > 0 ? `of ${overview.judged} finished run${overview.judged === 1 ? '' : 's'}` : 'no finished runs yet'}
            loading={status === 'loading' && runs.length === 0}
          />
          <OverviewItem
            label="Last verified exit IP"
            value={<span className="font-mono">{ip?.ip ?? '—'}</span>}
            sub={ip ? `${describeVerifiedLocation(ip)} · ${relativeTime(ip.checkedAt)}` : 'none yet'}
            title={ip ? describeVerifiedLocation(ip) : undefined}
            loading={statsLoading}
          />
        </dl>
      </section>

      {stats.error ? <ErrorAlert error={stats.error} title="Overview unavailable" onRetry={() => void stats.run()} compact /> : null}
      {error ? <ErrorAlert error={error} title="Could not load runs" onRetry={() => void load(HISTORY_RUN_LIMIT)} /> : null}

      <Card>
        {status === 'loading' && runs.length === 0 ? (
          <SkeletonRows rows={8} columns={7} />
        ) : runs.length === 0 ? (
          <EmptyState
            icon={FlaskConical}
            title="No runs yet"
            description="Launch a browser to create the first run. Runs stay here with their screenshot and network capture."
            action={
              <Button variant="primary" onClick={() => navigate('/launch')} leftIcon={<Rocket className="h-4 w-4" aria-hidden="true" />}>
                Connect & Launch
              </Button>
            }
            className="m-4 border-0"
          />
        ) : (
          <RunsTable runs={runs} />
        )}
      </Card>
    </>
  )
}

import { Link, useNavigate } from 'react-router-dom'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { TestRun } from '@shared/types'
import { BROWSER_ENGINE_LABELS } from '@shared/types'
import { EngineIcon } from '@/components/icons/BrandIcon'
import { Badge, StatusBadge } from '@/components/ui/Badge'
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from '@/components/ui/Table'
import { TargetMatchBadge } from '@/components/TargetMatchBadge'
import { describeTarget, locationAttemptsLabel, poolShortLabel } from '@/lib/targeting'
import { historyRunPath } from '@/lib/navigation'
import { describeVerifiedLocation, formatDate, orDash } from '@/lib/utils'

export interface RunsTableProps {
  runs: TestRun[]
}

/** Test runs, newest first. Rows navigate to the run detail; the profile name is a real link for keyboard users. */
export function RunsTable({ runs }: RunsTableProps): React.JSX.Element {
  const navigate = useNavigate()
  const open = (run: TestRun): void => {
    void navigate(historyRunPath(run.id))
  }
  const onRowKeyDown = (event: ReactKeyboardEvent<HTMLTableRowElement>, run: TestRun): void => {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      open(run)
    }
  }

  return (
    <Table>
      <TableHead>
        <TableRow>
          <TableHeaderCell>Started</TableHeaderCell>
          <TableHeaderCell>Profile</TableHeaderCell>
          <TableHeaderCell>Engine</TableHeaderCell>
          <TableHeaderCell>Device</TableHeaderCell>
          <TableHeaderCell>Pool</TableHeaderCell>
          <TableHeaderCell>Requested</TableHeaderCell>
          <TableHeaderCell>IP</TableHeaderCell>
          <TableHeaderCell>Location</TableHeaderCell>
          <TableHeaderCell>Session</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>Lead / Cert</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {runs.map((run) => (
          <TableRow
            key={run.id}
            interactive
            tabIndex={0}
            onClick={() => open(run)}
            onKeyDown={(event) => onRowKeyDown(event, run)}
            aria-label={`Open test run for ${run.profileName} started ${formatDate(run.startedAt)}`}
          >
            <TableCell className="tabular whitespace-nowrap text-muted-foreground">{formatDate(run.startedAt, { seconds: true })}</TableCell>
            <TableCell className="max-w-[200px]">
              <Link
                to={historyRunPath(run.id)}
                onClick={(event) => event.stopPropagation()}
                className="focus-ring block truncate rounded font-medium hover:underline"
                title={run.profileName}
              >
                {run.profileName}
              </Link>
            </TableCell>
            <TableCell className="whitespace-nowrap text-muted-foreground">
              <span className="inline-flex items-center gap-2">
                <EngineIcon engine={run.engine} size={16} />
                {BROWSER_ENGINE_LABELS[run.engine]}
              </span>
            </TableCell>
            <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">{run.devicePreset}</TableCell>
            <TableCell>
              <Badge variant={run.proxyPool ? 'default' : 'info'}>{poolShortLabel(run.proxyPool ?? 'none')}</Badge>
            </TableCell>
            <TableCell className="max-w-[160px]">
              <span className="block truncate text-muted-foreground" title={describeTarget(run.target)}>
                {describeTarget(run.target)}
              </span>
            </TableCell>
            <TableCell className="font-mono text-xs">{orDash(run.publicIp)}</TableCell>
            <TableCell className="max-w-[260px]">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-muted-foreground" title={describeVerifiedLocation(run)}>
                  {describeVerifiedLocation(run)}
                </span>
                {run.target ? <TargetMatchBadge match={run.targetMatch} target={run.target} ip={{ country: run.country, countryCode: null, region: run.region, city: run.city, postalCode: run.postalCode }} /> : null}
              </span>
              {locationAttemptsLabel(run) ? (
                <span className="block text-xs text-muted-foreground" title={run.locationWarning ?? undefined}>
                  {locationAttemptsLabel(run)}
                </span>
              ) : null}
            </TableCell>
            <TableCell className="max-w-[160px]">
              <span className="block truncate font-mono text-xs text-muted-foreground" title={run.proxySessionId ?? undefined}>
                {orDash(run.proxySessionId)}
              </span>
            </TableCell>
            <TableCell>
              <StatusBadge kind="run" status={run.status} />
            </TableCell>
            <TableCell className="font-mono text-xs">
              <span className="block" title="Lead ID">
                {orDash(run.leadId)}
              </span>
              <span className="block text-muted-foreground" title="Certificate ID">
                {orDash(run.certificateId)}
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

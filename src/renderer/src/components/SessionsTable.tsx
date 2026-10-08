import { Link } from 'react-router-dom'
import { ArrowUpRight, Camera, MonitorUp, X } from 'lucide-react'
import type { BrowserSession, DevicePresetInfo } from '@shared/types'
import { BROWSER_ENGINE_LABELS } from '@shared/types'
import { EngineIcon } from '@/components/icons/BrandIcon'
import { Button } from '@/components/ui/Button'
import { Badge, StatusBadge } from '@/components/ui/Badge'
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from '@/components/ui/Table'
import { TargetMatchBadge } from '@/components/TargetMatchBadge'
import { isBrowserWindowOpen } from '@/lib/launch'
import { historyRunPath } from '@/lib/navigation'
import { relativeTime } from '@/lib/security'
import { describeTarget, locationAttemptsLabel, poolShortLabel } from '@/lib/targeting'
import { describeVerifiedLocation, formatDate, orDash, shortId } from '@/lib/utils'

export interface SessionsTableProps {
  sessions: readonly BrowserSession[]
  presets: readonly DevicePresetInfo[]
  selected: ReadonlySet<string>
  onToggle: (sessionId: string) => void
  onToggleAll: (checked: boolean) => void
  busy: Record<string, 'closing' | 'screenshot' | 'focusing' | undefined>
  statusBeforeError: Record<string, BrowserSession['status']>
  onScreenshot: (session: BrowserSession) => void
  /** Bring the session's browser window to the front. */
  onFocus: (session: BrowserSession) => void
  onTerminate: (session: BrowserSession) => void
}

/** Live browser sessions with a selection column for bulk termination. */
export function SessionsTable({ sessions, presets, selected, onToggle, onToggleAll, busy, statusBeforeError, onScreenshot, onFocus, onTerminate }: SessionsTableProps): React.JSX.Element {
  const allSelected = sessions.length > 0 && sessions.every((session) => selected.has(session.id))
  const someSelected = sessions.some((session) => selected.has(session.id))

  return (
    <Table aria-label="Live browser sessions">
      <TableHead>
        <TableRow>
          <TableHeaderCell className="w-10">
            <input
              type="checkbox"
              aria-label={allSelected ? 'Deselect all sessions' : 'Select all sessions'}
              checked={allSelected}
              ref={(element) => {
                if (element) element.indeterminate = someSelected && !allSelected
              }}
              onChange={(event) => onToggleAll(event.target.checked)}
              className="focus-ring h-4 w-4 rounded border-border accent-[hsl(var(--primary))]"
            />
          </TableHeaderCell>
          <TableHeaderCell>#</TableHeaderCell>
          <TableHeaderCell>Session</TableHeaderCell>
          <TableHeaderCell>Pool</TableHeaderCell>
          <TableHeaderCell>Requested</TableHeaderCell>
          <TableHeaderCell>Verified</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>Started</TableHeaderCell>
          <TableHeaderCell className="text-right">Actions</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {sessions.map((session) => {
          const preset = presets.find((p) => p.id === session.devicePreset) ?? null
          const rowBusy = busy[session.id]
          const windowOpen = isBrowserWindowOpen(session, statusBeforeError[session.id])
          const name = `${session.profileName} (${shortId(session.id)})`
          const verified = describeVerifiedLocation(session.ip)
          const attempts = locationAttemptsLabel(session)
          return (
            <TableRow key={session.id} highlighted={selected.has(session.id)}>
              <TableCell>
                <input
                  type="checkbox"
                  aria-label={`Select session ${name}`}
                  checked={selected.has(session.id)}
                  onChange={() => onToggle(session.id)}
                  className="focus-ring h-4 w-4 rounded border-border accent-[hsl(var(--primary))]"
                />
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground" title={session.id}>
                {shortId(session.id)}
              </TableCell>
              <TableCell className="max-w-[240px]">
                <Link to={historyRunPath(session.runId)} className="focus-ring block truncate rounded font-medium hover:underline" title={session.profileName}>
                  {session.profileName}
                </Link>
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={`${BROWSER_ENGINE_LABELS[session.engine]} · ${preset?.label ?? session.devicePreset}`}>
                  <EngineIcon engine={session.engine} size={14} />
                  <span className="truncate">
                    {BROWSER_ENGINE_LABELS[session.engine]} · {preset?.label ?? session.devicePreset}
                  </span>
                </span>
              </TableCell>
              <TableCell>
                <Badge variant={session.proxyPool ? 'default' : 'info'}>{poolShortLabel(session.proxyPool ?? 'none')}</Badge>
              </TableCell>
              <TableCell className="max-w-[180px]">
                <span className="block truncate" title={describeTarget(session.target)}>
                  {describeTarget(session.target)}
                </span>
              </TableCell>
              <TableCell className="max-w-[240px]">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate" title={verified}>
                      {verified}
                    </span>
                    {session.target ? <TargetMatchBadge match={session.targetMatch} target={session.target} ip={session.ip} /> : null}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    <span className="font-mono">{orDash(session.ip?.ip)}</span>
                    {attempts ? <span title={session.locationWarning ?? undefined}> · {attempts}</span> : null}
                  </span>
                </div>
              </TableCell>
              <TableCell>
                <StatusBadge kind="session" status={session.status} />
              </TableCell>
              <TableCell className="whitespace-nowrap text-xs text-muted-foreground" title={formatDate(session.startedAt, { seconds: true })}>
                {relativeTime(session.startedAt)}
              </TableCell>
              <TableCell>
                {/* Icon-only actions keep the row within the content width; each carries an aria-label and a title. */}
                <div className="flex justify-end gap-1">
                  <Link
                    to={historyRunPath(session.runId)}
                    aria-label={`Open run for ${name}`}
                    title="Open run"
                    className="focus-ring inline-flex h-8 w-8 items-center justify-center rounded-md text-foreground hover:bg-muted/60"
                  >
                    <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                  </Link>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={!windowOpen || rowBusy !== undefined}
                    loading={rowBusy === 'focusing'}
                    title={windowOpen ? 'Bring to front' : 'Available once the browser window is open'}
                    onClick={() => onFocus(session)}
                    aria-label={`Bring ${name} to the front`}
                  >
                    {rowBusy === 'focusing' ? null : <MonitorUp className="h-4 w-4" aria-hidden="true" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={!windowOpen || rowBusy !== undefined}
                    loading={rowBusy === 'screenshot'}
                    title={windowOpen ? 'Take screenshot' : 'Screenshot available once the browser window is open'}
                    onClick={() => onScreenshot(session)}
                    aria-label={`Take screenshot of ${name}`}
                  >
                    {rowBusy === 'screenshot' ? null : <Camera className="h-4 w-4" aria-hidden="true" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-destructive hover:bg-destructive/10"
                    disabled={rowBusy !== undefined && rowBusy !== 'closing'}
                    loading={rowBusy === 'closing'}
                    title="Terminate session"
                    onClick={() => onTerminate(session)}
                    aria-label={`Terminate ${name}`}
                  >
                    {rowBusy === 'closing' ? null : <X className="h-4 w-4" aria-hidden="true" />}
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, ScrollText, Search, Trash2 } from 'lucide-react'
import type { LogEntry, LogLevel } from '@shared/types'
import { LOG_LEVELS } from '@shared/types'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorAlert } from '@/components/ui/ErrorAlert'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { collectScopes, filterLogs, useLogsStore } from '@/stores/logs'
import type { LogFilter } from '@/stores/logs'
import { toast } from '@/stores/toasts'
import { cn, formatTime } from '@/lib/utils'

const LEVEL_VARIANT: Record<LogLevel, 'info' | 'warning' | 'destructive'> = {
  INFO: 'info',
  WARN: 'warning',
  ERROR: 'destructive',
}

function LogRow({ entry }: { entry: LogEntry }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const hasMeta = entry.meta !== null && Object.keys(entry.meta).length > 0
  return (
    <li className={cn('border-b border-border px-3 py-1.5 font-mono text-xs leading-5 last:border-0', entry.level === 'ERROR' && 'bg-destructive/5')}>
      <div className="flex items-start gap-3">
        <span className="tabular shrink-0 text-muted-foreground">{formatTime(entry.timestamp)}</span>
        <Badge variant={LEVEL_VARIANT[entry.level]} className="w-14 shrink-0 justify-center px-1 py-0 font-mono text-[10px] leading-4">
          {entry.level}
        </Badge>
        <span className="shrink-0 text-muted-foreground">[{entry.scope}]</span>
        <span className="min-w-0 flex-1 break-words">{entry.message}</span>
        {hasMeta ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="focus-ring shrink-0 rounded px-1 text-muted-foreground hover:text-foreground"
          >
            {expanded ? 'hide' : 'meta'}
          </button>
        ) : null}
      </div>
      {expanded && hasMeta ? (
        <pre className="mt-1 overflow-x-auto rounded bg-muted/50 p-2 text-[11px] text-muted-foreground">{JSON.stringify(entry.meta, null, 2)}</pre>
      ) : null}
    </li>
  )
}

/** Live log viewer backed by the logs store (ring buffer fed by event:log-entry). */
export function LogsPanel({ className }: { className?: string }): React.JSX.Element {
  const entries = useLogsStore((s) => s.entries)
  const status = useLogsStore((s) => s.status)
  const error = useLogsStore((s) => s.error)
  const load = useLogsStore((s) => s.load)
  const clear = useLogsStore((s) => s.clear)

  const [filter, setFilter] = useState<LogFilter>({ level: 'all', scope: '', search: '' })
  const [autoScroll, setAutoScroll] = useState(true)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)
  const ids = { level: useId(), scope: useId(), search: useId() }

  useEffect(() => {
    void load()
  }, [load])

  const scopes = useMemo(() => collectScopes(entries), [entries])
  const visible = useMemo(() => filterLogs(entries, filter), [entries, filter])

  useEffect(() => {
    if (!autoScroll || !listRef.current) return
    listRef.current.scrollTop = listRef.current.scrollHeight
  }, [visible.length, autoScroll])

  const handleClear = async (): Promise<void> => {
    setClearing(true)
    try {
      await clear()
      toast.success('Logs cleared')
      setConfirmClear(false)
    } catch (err) {
      toast.fromError(err, 'Could not clear logs')
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col gap-3', className)}>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.level} className="text-xs font-medium text-muted-foreground">
            Level
          </label>
          <Select
            id={ids.level}
            value={filter.level}
            onChange={(event) => setFilter((f) => ({ ...f, level: event.target.value as LogFilter['level'] }))}
            options={[{ value: 'all', label: 'All levels' }, ...LOG_LEVELS.map((level) => ({ value: level, label: level }))]}
            className="w-32"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.scope} className="text-xs font-medium text-muted-foreground">
            Scope
          </label>
          <Select
            id={ids.scope}
            value={filter.scope}
            onChange={(event) => setFilter((f) => ({ ...f, scope: event.target.value }))}
            options={[{ value: '', label: 'All scopes' }, ...scopes.map((scope) => ({ value: scope, label: scope }))]}
            className="w-44"
          />
        </div>
        <div className="flex min-w-[220px] flex-1 flex-col gap-1.5">
          <label htmlFor={ids.search} className="text-xs font-medium text-muted-foreground">
            Search
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              id={ids.search}
              type="search"
              value={filter.search}
              onChange={(event) => setFilter((f) => ({ ...f, search: event.target.value }))}
              placeholder="Search messages and metadata…"
              className="pl-9"
            />
          </div>
        </div>
        <Button
          variant={autoScroll ? 'secondary' : 'outline'}
          aria-pressed={autoScroll}
          onClick={() => setAutoScroll((v) => !v)}
          leftIcon={<ArrowDownToLine className="h-4 w-4" aria-hidden="true" />}
        >
          Auto-scroll
        </Button>
        <Button
          variant="outline"
          onClick={() => setConfirmClear(true)}
          disabled={entries.length === 0}
          leftIcon={<Trash2 className="h-4 w-4 text-destructive" aria-hidden="true" />}
        >
          Clear Logs
        </Button>
      </div>

      {error ? <ErrorAlert error={error} onRetry={() => void load()} compact /> : null}

      <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-border bg-card">
        {status === 'loading' && entries.length === 0 ? (
          <SkeletonRows rows={10} columns={4} />
        ) : entries.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title="No log entries"
            description="Application events, proxy checks and browser launches are recorded here as they happen."
            action={
              <Button variant="outline" onClick={() => void load()}>
                Refresh Logs
              </Button>
            }
            className="m-4 border-0"
          />
        ) : (
          <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto" aria-label="Log entries" aria-live="off">
            {visible.length === 0 ? (
              <li className="px-3 py-8 text-center text-sm text-muted-foreground">No entries match the current filter.</li>
            ) : (
              visible.map((entry) => <LogRow key={entry.id} entry={entry} />)
            )}
          </ul>
        )}
        <div className="tabular flex items-center justify-between border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
          <span>
            {visible.length} shown · {entries.length} buffered
          </span>
          <span>Buffer keeps the latest 2000 entries</span>
        </div>
      </div>

      <ConfirmDialog
        open={confirmClear}
        title="Clear all logs?"
        description="This removes every log entry stored by the application. Diagnostic history for past proxy tests and browser launches will be lost."
        confirmLabel="Clear Logs"
        destructive
        loading={clearing}
        onConfirm={() => void handleClear()}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  )
}

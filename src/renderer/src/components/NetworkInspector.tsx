import { useId, useMemo, useState } from 'react'
import { Network, Search } from 'lucide-react'
import type { NetworkEntry } from '@shared/types'
import { NETWORK_FILTER_KEYWORDS } from '@shared/types'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from '@/components/ui/Table'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { cn, formatDuration, formatTime, truncateMiddle } from '@/lib/utils'
import { filterNetworkEntries, statusVariant } from '@/lib/network'

export interface NetworkInspectorProps {
  entries: NetworkEntry[]
  /** Shown in the empty state when the inspector is disabled in settings. */
  inspectorEnabled?: boolean
  onOpenSettings?: () => void
}

type Keyword = (typeof NETWORK_FILTER_KEYWORDS)[number]

export function NetworkInspector({ entries, inspectorEnabled = true, onOpenSettings }: NetworkInspectorProps): React.JSX.Element {
  const [text, setText] = useState('')
  const [keywords, setKeywords] = useState<ReadonlySet<Keyword>>(new Set())
  const searchId = useId()

  const filtered = useMemo(() => filterNetworkEntries(entries, text, keywords), [entries, text, keywords])
  const idCount = useMemo(() => entries.filter((e) => Object.keys(e.extractedIds).length > 0).length, [entries])

  const toggleKeyword = (keyword: Keyword): void => {
    setKeywords((current) => {
      const next = new Set(current)
      if (next.has(keyword)) next.delete(keyword)
      else next.add(keyword)
      return next
    })
  }

  if (entries.length === 0) {
    return (
      <EmptyState
        icon={Network}
        title={inspectorEnabled ? 'No network requests captured yet' : 'Network inspector is disabled'}
        description={
          inspectorEnabled
            ? 'Requests made by the QA browser appear here as the form loads and submits. Responses containing lead or certificate ids are highlighted.'
            : 'Enable the network inspector in Settings to capture requests and extract lead / certificate ids from responses.'
        }
        action={
          inspectorEnabled ? (
            <Button variant="outline" onClick={() => setText('')} disabled>
              Waiting for requests…
            </Button>
          ) : (
            <Button variant="primary" onClick={onOpenSettings}>
              Open Settings
            </Button>
          )
        }
      />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <label htmlFor={searchId} className="sr-only">
            Filter requests
          </label>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            id={searchId}
            type="search"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Filter by URL, method or status…"
            className="pl-9"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Keyword filters">
          {NETWORK_FILTER_KEYWORDS.map((keyword) => {
            const active = keywords.has(keyword)
            return (
              <button
                key={keyword}
                type="button"
                aria-pressed={active}
                onClick={() => toggleKeyword(keyword)}
                className={cn(
                  'focus-ring h-7 rounded-full border px-2.5 font-mono text-xs transition-colors',
                  active ? 'border-primary bg-primary/15 text-primary' : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {keyword}
              </button>
            )
          })}
        </div>
        <p className="tabular ml-auto text-xs text-muted-foreground">
          {filtered.length} / {entries.length} requests · {idCount} with ids
        </p>
      </div>

      <div className="rounded-lg border border-border">
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell className="w-20">Method</TableHeaderCell>
              <TableHeaderCell>URL</TableHeaderCell>
              <TableHeaderCell className="w-20">Status</TableHeaderCell>
              <TableHeaderCell className="w-24">Request</TableHeaderCell>
              <TableHeaderCell className="w-24">Response</TableHeaderCell>
              <TableHeaderCell className="w-24 text-right">Duration</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  No requests match the current filter.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((entry) => {
                const ids = Object.entries(entry.extractedIds)
                return (
                  <TableRow key={entry.id} highlighted={ids.length > 0}>
                    <TableCell className="font-mono text-xs font-medium">{entry.method}</TableCell>
                    <TableCell className="max-w-0">
                      <span className="block truncate font-mono text-xs" title={entry.url}>
                        {truncateMiddle(entry.url, 120)}
                      </span>
                      {ids.length > 0 ? (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {ids.map(([key, value]) => (
                            <Badge key={key} variant="default" className="font-mono text-[11px]" title={`${key}: ${value}`}>
                              {key}={value}
                            </Badge>
                          ))}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(entry.status)} className="tabular font-mono">
                        {entry.status ?? 'pending'}
                      </Badge>
                    </TableCell>
                    <TableCell className="tabular font-mono text-xs text-muted-foreground">{formatTime(entry.requestTime)}</TableCell>
                    <TableCell className="tabular font-mono text-xs text-muted-foreground">{formatTime(entry.responseTime)}</TableCell>
                    <TableCell className="tabular text-right font-mono text-xs">{formatDuration(entry.durationMs)}</TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

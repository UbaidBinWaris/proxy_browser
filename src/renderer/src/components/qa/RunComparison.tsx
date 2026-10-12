import type { CaseChange, QaRunComparison } from '@shared/qa-history'
import { Badge } from '@/components/ui/Badge'
import { formatDuration } from '@/lib/utils'

export function CaseChangeBadge({ change }: { change: CaseChange | undefined }): React.JSX.Element | null {
  if (!change || change === 'unchanged' || change === 'not-compared') return null
  return <Badge className="ml-2" variant={change === 'new-failure' ? 'destructive' : change === 'recovered' ? 'success' : 'warning'}>
    {change === 'new-failure' ? 'New failure' : change === 'recovered' ? 'Recovered' : 'Still failing'}
  </Badge>
}

export function RunComparison({ comparison }: { comparison: QaRunComparison }): React.JSX.Element {
  const delta = comparison.durationDeltaMs
  return (
    <div className="mt-3 rounded-md border border-border bg-muted/30 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Run comparison</span>
        <Badge variant={comparison.newFailures ? 'destructive' : 'muted'}>{comparison.newFailures} new failure{comparison.newFailures === 1 ? '' : 's'}</Badge>
        <Badge variant={comparison.stillFailing ? 'warning' : 'muted'}>{comparison.stillFailing} still failing</Badge>
        <Badge variant={comparison.recovered ? 'success' : 'muted'}>{comparison.recovered} recovered</Badge>
        <Badge variant={comparison.passedAfterRetry ? 'warning' : 'muted'}>{comparison.passedAfterRetry} passed after retry</Badge>
      </div>
      <p className="mt-2 text-muted-foreground">
        {comparison.previous ? (
          <>Compared {comparison.compared} matching case{comparison.compared === 1 ? '' : 's'} with {new Date(comparison.previous.startedAt).toLocaleString()}.
            {delta !== null ? <> Execution time {delta > 0 ? '+' : delta < 0 ? '−' : ''}{formatDuration(Math.abs(delta))}
              {comparison.durationDeltaPercent !== null ? ` (${comparison.durationDeltaPercent > 0 ? '+' : ''}${comparison.durationDeltaPercent.toFixed(1)}%)` : ''}, including retries.</> : comparison.compared ? ' Retry timing is incomplete for one or more cases.' : ' No matching cases.'}</>
        ) : 'Run this scenario again to compare completed results in the same environment.'}
      </p>
      {comparison.previous ? <p className="mt-1 text-muted-foreground">Unmatched cases are excluded. Changing a scenario or profile can also change results.</p> : null}
    </div>
  )
}

/**
 * History page overview (pure, unit-tested): runs started today and the success rate of finished runs.
 */
import type { TestRun } from '@shared/types'

export interface HistoryOverview {
  /** Runs started on the local calendar day of `now`. */
  runsToday: number
  /** success / (success + failed) over every loaded run; null when none has a verdict yet. Aborted and running runs are left out. */
  successRate: number | null
  /** Runs with a verdict (success or failed). */
  judged: number
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

export function historyOverview(runs: readonly Pick<TestRun, 'startedAt' | 'status'>[], now: Date = new Date()): HistoryOverview {
  let runsToday = 0
  let success = 0
  let failed = 0
  for (const run of runs) {
    const started = new Date(run.startedAt)
    if (!Number.isNaN(started.getTime()) && sameLocalDay(started, now)) runsToday += 1
    if (run.status === 'success') success += 1
    else if (run.status === 'failed') failed += 1
  }
  const judged = success + failed
  return { runsToday, successRate: judged === 0 ? null : success / judged, judged }
}

/** 0.8333 → "83%", null → "—". */
export function formatSuccessRate(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`
}

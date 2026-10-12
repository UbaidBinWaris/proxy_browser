import type { QaBatch, QaCase } from './qa'

export type CaseChange = 'new-failure' | 'still-failing' | 'recovered' | 'unchanged' | 'not-compared'
export interface QaRunComparison {
  previous: QaBatch | null
  changes: Record<string, CaseChange>
  compared: number
  newFailures: number
  stillFailing: number
  recovered: number
  passedAfterRetry: number
  durationDeltaMs: number | null
  durationDeltaPercent: number | null
}

function complete(batch: QaBatch): boolean {
  return (batch.status === 'passed' || batch.status === 'failed') && Boolean(batch.endedAt) &&
    batch.completed === batch.total && batch.cases.length === batch.total &&
    batch.cases.every((item) => item.id !== 'internal' && (item.status === 'passed' || item.status === 'failed'))
}

function sameRunGroup(a: QaBatch, b: QaBatch): boolean {
  return a.workspaceId === b.workspaceId && a.scenarioId === b.scenarioId && a.suiteId === b.suiteId &&
    (a.input.environmentId ?? null) === (b.input.environmentId ?? null) && a.environmentName === b.environmentName
}

function caseKey(batch: QaBatch, item: QaCase): string {
  const target = item.target
  return JSON.stringify([
    item.scenarioId ?? batch.scenarioId, item.engine, item.device, item.datasetId ?? null,
    target ? [target.mode, target.country, target.stateCode, target.state, target.city, target.zip] : null,
  ])
}

/** Retry time is real execution time; legacy records contain only their final attempt. */
export function caseDuration(item: QaCase): number {
  return item.attempts?.length ? item.attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0) : item.durationMs
}

function uniqueCases(batch: QaBatch): Map<string, QaCase> {
  const items = new Map<string, QaCase>()
  const duplicates = new Set<string>()
  for (const item of batch.cases) {
    const key = caseKey(batch, item)
    if (items.has(key)) duplicates.add(key)
    items.set(key, item)
  }
  for (const key of duplicates) items.delete(key)
  return items
}

/** Compare completed runs only, matching the scenario, environment and individual matrix cases. */
export function compareQaRun(batch: QaBatch, history: readonly QaBatch[]): QaRunComparison {
  const comparison: QaRunComparison = {
    previous: null, changes: {}, compared: 0, newFailures: 0, stillFailing: 0, recovered: 0,
    passedAfterRetry: batch.cases.filter((item) => item.status === 'passed' && item.attempt > 1).length,
    durationDeltaMs: null, durationDeltaPercent: null,
  }
  if (!complete(batch)) return comparison
  const candidates = history.filter((item) => item.id !== batch.id && complete(item) && sameRunGroup(batch, item) &&
    Date.parse(item.startedAt) < Date.parse(batch.startedAt) && Date.parse(item.endedAt!) <= Date.parse(batch.startedAt))
  candidates.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || a.id.localeCompare(b.id))
  comparison.previous = candidates[0] ?? null
  const current = uniqueCases(batch)
  const previous = comparison.previous ? uniqueCases(comparison.previous) : new Map<string, QaCase>()
  let currentMs = 0, previousMs = 0, durationsComplete = true
  for (const item of batch.cases) {
    const key = caseKey(batch, item)
    const before = current.has(key) ? previous.get(key) : undefined
    let change: CaseChange = 'not-compared'
    if (before) {
      comparison.compared++
      if ([item, before].some((record) => record.attempt > 1 && (record.attempts?.length ?? 0) < record.attempt))
        durationsComplete = false
      currentMs += caseDuration(item)
      previousMs += caseDuration(before)
      if (item.status === 'failed' && before.status === 'passed') { change = 'new-failure'; comparison.newFailures++ }
      else if (item.status === 'failed' && before.status === 'failed') { change = 'still-failing'; comparison.stillFailing++ }
      else if (item.status === 'passed' && before.status === 'failed') { change = 'recovered'; comparison.recovered++ }
      else change = 'unchanged'
    }
    comparison.changes[item.id] = change
  }
  if (comparison.compared && durationsComplete) {
    comparison.durationDeltaMs = currentMs - previousMs
    comparison.durationDeltaPercent = previousMs > 0 ? (currentMs - previousMs) / previousMs * 100 : null
  }
  return comparison
}

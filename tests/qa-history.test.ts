import { describe, expect, it } from 'vitest'
import type { QaBatch, QaCase } from '../src/shared/qa'
import { MatrixInputSchema } from '../src/shared/qa'
import { caseDuration, compareQaRun } from '../src/shared/qa-history'

function item(id: string, status: QaCase['status'] = 'passed', fields: Partial<QaCase> = {}): QaCase {
  return { id, engine: 'chromium', device: `device-${id}`, target: null, attempt: 1, status, steps: [],
    errors: [], failedRequests: [], finalUrl: 'https://example.test/', durationMs: 100, ...fields }
}
function batch(id: string, day: number, cases: QaCase[], fields: Partial<QaBatch> = {}): QaBatch {
  const date = `2026-10-${String(day).padStart(2, '0')}`
  return { id, workspaceId: 'default', scenarioId: 'scenario', scenarioName: 'Signup', status: cases.some((c) => c.status === 'failed') ? 'failed' : 'passed',
    startedAt: `${date}T10:00:00Z`, endedAt: `${date}T10:01:00Z`, total: cases.length, completed: cases.length,
    cases, input: MatrixInputSchema.parse({ scenarioId: 'scenario' }), ...fields }
}

describe('QA run comparisons', () => {
  it('matches case identities rather than array order or case numbers, and counts retries', () => {
    const before = batch('before', 1, [item('1'), item('2', 'failed'), item('3', 'failed')])
    const after = batch('after', 2, [item('9', 'failed', { device: 'device-1', durationMs: 150 }),
      item('8', 'failed', { device: 'device-2' }), item('7', 'passed', { device: 'device-3', attempt: 2, attempts: [
        { ...item('7', 'failed'), durationMs: 50, attempt: 1 }, { ...item('7'), durationMs: 50, attempt: 2 },
      ] })])
    const result = compareQaRun(after, [after, before])
    expect(result).toMatchObject({ previous: before, compared: 3, newFailures: 1, stillFailing: 1, recovered: 1, passedAfterRetry: 1,
      changes: { '9': 'new-failure', '8': 'still-failing', '7': 'recovered' }, durationDeltaMs: 50 })
    expect(result.durationDeltaPercent).toBeCloseTo(50 / 300 * 100)
  })
  it('selects the most recent completed earlier run regardless of history order', () => {
    const a = batch('a', 1, [item('1')]), b = batch('b', 2, [item('1')]), c = batch('c', 3, [item('1')])
    expect(compareQaRun(c, [a, c, b]).previous?.id).toBe('b')
    expect(compareQaRun(a, [a, b, c]).previous).toBeNull()
  })
  it('excludes cancelled, partial, interrupted, overlapping and internal-error runs', () => {
    const current = batch('current', 3, [item('1')])
    const invalid = [batch('cancel', 2, [item('1')], { status: 'cancelled' }),
      batch('partial', 2, [item('1')], { total: 2 }), batch('active', 2, [item('1')], { endedAt: null }),
      batch('interrupted', 2, [item('1')], { status: 'interrupted' }),
      batch('overlap', 2, [item('1')], { endedAt: '2026-10-04T00:00:00Z' }),
      batch('internal', 2, [item('internal', 'failed')])]
    expect(compareQaRun(current, invalid).previous).toBeNull()
    expect(compareQaRun({ ...current, status: 'running' }, [batch('old', 1, [item('1')])]).compared).toBe(0)
  })
  it('does not compare other workspaces, scenarios, suites or environments', () => {
    const current = batch('current', 3, [item('1')])
    const history = [batch('workspace', 2, [item('1')], { workspaceId: 'other' }),
      batch('scenario', 2, [item('1')], { scenarioId: 'other' }), batch('suite', 2, [item('1')], { suiteId: 'suite' }),
      batch('environment', 2, [item('1')], { input: { ...current.input, environmentId: 'staging' } })]
    expect(compareQaRun(current, history).previous).toBeNull()
  })
  it('excludes changed datasets, browsers, devices, locations and suite scenarios', () => {
    const before = batch('before', 1, [item('1'), item('2'), item('3'), item('4'), item('5')])
    const after = batch('after', 2, [item('1', 'failed', { datasetId: 'new' }), item('2', 'failed', { engine: 'firefox' }),
      item('3', 'failed', { device: 'new' }), item('4', 'failed', { target: { mode: 'state', country: 'us', stateCode: 'CA', state: 'California', city: null, zip: null } }),
      item('5', 'failed', { scenarioId: 'other' })])
    expect(compareQaRun(after, [before])).toMatchObject({ compared: 0, newFailures: 0, durationDeltaMs: null })
  })
  it('handles ambiguous duplicate combinations without claiming a match', () => {
    const before = batch('before', 1, [item('1'), item('2', 'failed', { device: 'device-1' })])
    expect(compareQaRun(batch('after', 2, [item('1', 'failed')]), [before]).compared).toBe(0)
  })
  it('includes all attempt durations and avoids dividing by zero', () => {
    const retried = item('1', 'passed', { attempt: 2, durationMs: 20, attempts: [
      { ...item('1', 'failed'), durationMs: 30, attempt: 1 }, { ...item('1'), durationMs: 20, attempt: 2 },
    ] })
    expect(caseDuration(retried)).toBe(50)
    expect(compareQaRun(batch('after', 2, [retried]), [batch('before', 1, [item('1', 'passed', { durationMs: 0 })])]))
      .toMatchObject({ durationDeltaMs: 50, durationDeltaPercent: null, passedAfterRetry: 1 })
  })
  it('does not compare total execution time when legacy retry records omit attempt durations', () => {
    const before = batch('before', 1, [item('1', 'passed', { attempt: 2 })])
    expect(compareQaRun(batch('after', 2, [item('1')]), [before]))
      .toMatchObject({ compared: 1, durationDeltaMs: null, durationDeltaPercent: null })
  })
})

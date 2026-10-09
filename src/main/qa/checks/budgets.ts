/** Performance budget evaluation and metric formatting for checkPerformance. Pure. */
import { QA_PERFORMANCE_METRICS, QA_PERFORMANCE_METRIC_LABELS } from '@shared/qa-checks'
import type {
  QaCheckAssertion,
  QaPerformanceBudgets,
  QaPerformanceMetric,
  QaPerformanceMetrics,
} from '@shared/qa-checks'

export function formatMetric(metric: QaPerformanceMetric, value: number): string {
  if (metric === 'cls') return (Math.round(value * 1000) / 1000).toString()
  if (metric === 'transferBytes')
    return value >= 1024 * 1024
      ? `${(value / 1024 / 1024).toFixed(2)} MB`
      : value >= 1024
        ? `${(value / 1024).toFixed(1)} KB`
        : `${Math.round(value)} B`
  return `${Math.round(value).toLocaleString('en-US')} ms`
}

/**
 * One assertion per budgeted metric: failed when the value is over budget (equal passes), warning when
 * the browser did not report the metric. Metrics without a budget are recorded but not asserted.
 */
export function evaluateBudgets(metrics: QaPerformanceMetrics, budgets: QaPerformanceBudgets): QaCheckAssertion[] {
  return QA_PERFORMANCE_METRICS.flatMap((metric): QaCheckAssertion[] => {
    const limit = budgets[metric]
    if (limit === undefined) return []
    const label = QA_PERFORMANCE_METRIC_LABELS[metric]
    const value = metrics[metric]
    if (value === undefined || !Number.isFinite(value))
      return [{ name: metric, status: 'warning', message: `${label} not available in this browser or page; budget ${formatMetric(metric, limit)} not evaluated.` }]
    return value > limit
      ? [{ name: metric, status: 'failed', message: `${label} ${formatMetric(metric, value)} > ${formatMetric(metric, limit)}` }]
      : [{ name: metric, status: 'passed', message: `${label} ${formatMetric(metric, value)} ≤ ${formatMetric(metric, limit)}` }]
  })
}

/**
 * Total blocking time approximation from long tasks: the sum of each task's time beyond 50 ms, for tasks
 * that start after first contentful paint (or the start of the document when FCP is unknown).
 */
export function totalBlockingTime(tasks: ReadonlyArray<{ startTime: number; duration: number }>, fcp?: number): number {
  return tasks
    .filter((task) => task.startTime >= (fcp ?? 0))
    .reduce((total, task) => total + Math.max(0, task.duration - 50), 0)
}

/**
 * Cumulative layout shift as defined by Core Web Vitals: the largest session window of shifts without
 * recent input, where a window ends after a 1 s gap or at 5 s.
 */
export function cumulativeLayoutShift(
  shifts: ReadonlyArray<{ startTime: number; value: number; hadRecentInput?: boolean }>,
): number {
  let max = 0
  let current = 0
  let windowStart = -Infinity
  let previous = -Infinity
  for (const shift of [...shifts].sort((a, b) => a.startTime - b.startTime)) {
    if (shift.hadRecentInput) continue
    if (shift.startTime - previous > 1000 || shift.startTime - windowStart > 5000) {
      current = 0
      windowStart = shift.startTime
    }
    current += shift.value
    previous = shift.startTime
    max = Math.max(max, current)
  }
  return max
}

/**
 * Interaction to Next Paint approximation: the longest event-timing duration per interaction, then the
 * worst interaction (Chromium's INP uses the 98th percentile, which equals the worst below 50 interactions).
 */
export function interactionToNextPaint(
  events: ReadonlyArray<{ interactionId?: number; duration: number }>,
): number | undefined {
  const byInteraction = new Map<number, number>()
  for (const event of events) {
    if (!event.interactionId) continue
    byInteraction.set(event.interactionId, Math.max(byInteraction.get(event.interactionId) ?? 0, event.duration))
  }
  if (byInteraction.size === 0) return undefined
  const sorted = [...byInteraction.values()].sort((a, b) => b - a)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length / 50))]
}

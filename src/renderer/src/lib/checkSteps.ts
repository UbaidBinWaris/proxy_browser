/** Pure helpers for editing and displaying check steps (src/shared/qa-checks.ts). */
import { QA_PERFORMANCE_METRICS, QA_PERFORMANCE_METRIC_LABELS, checkCaseLabel, formatCheckSummary, summarizeChecks } from '@shared/qa-checks'
import type { QaCheckResult, QaCheckSummary, QaPerformanceMetric } from '@shared/qa-checks'
import type { QaCase } from '@shared/qa'

/** Empty or whitespace-only text clears an optional field. */
export function optionalText(value: string): string | undefined {
  return value.trim() ? value : undefined
}

/** Blank clears an optional number; anything else is passed through (the schema rejects NaN on save). */
export function optionalNumber(value: string): number | undefined {
  return value.trim() === '' ? undefined : Number(value)
}

/** "wcag2a, wcag2aa" → ['wcag2a', 'wcag2aa'] (lowercased, duplicates removed). */
export function parseTags(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map((tag) => tag.trim().toLowerCase()).filter(Boolean))]
}

export const BUDGET_UNITS: Record<QaPerformanceMetric, string> = {
  lcpMs: 'ms',
  cls: 'score',
  inpMs: 'ms',
  tbtMs: 'ms',
  ttfbMs: 'ms',
  domContentLoadedMs: 'ms',
  loadMs: 'ms',
  transferBytes: 'bytes',
}
export const BUDGET_FIELDS = QA_PERFORMANCE_METRICS.map((metric) => ({
  metric,
  label: `${QA_PERFORMANCE_METRIC_LABELS[metric]} budget (${BUDGET_UNITS[metric]})`,
}))

export function caseChecks(item: Pick<QaCase, 'checks' | 'steps'>): QaCheckSummary[] {
  return item.checks ?? summarizeChecks(item.steps)
}

/** Non-passing checks across a batch: "iPhone SE · WebKit · Texas: consent font 9px FAIL". */
export function matrixCheckLines(
  cases: ReadonlyArray<Pick<QaCase, 'checks' | 'steps' | 'engine' | 'device' | 'target'>>,
  deviceLabel: (id: string) => string | undefined,
): Array<{ key: string; status: QaCheckSummary['status']; text: string }> {
  return cases.flatMap((item, caseIndex) =>
    caseChecks(item)
      .filter((check) => check.status !== 'passed')
      .map((check) => ({
        key: `${caseIndex}-${check.index}`,
        status: check.status,
        text: `${checkCaseLabel(item, deviceLabel)}: ${formatCheckSummary(check)}`,
      })),
  )
}

/** Short evidence lines for the step list in Results. */
export function checkEvidenceLines(check: QaCheckResult): string[] {
  const lines = check.assertions.filter((item) => item.status !== 'passed').map((item) => item.message)
  if (check.performance) {
    const metrics = Object.entries(check.performance.metrics)
      .map(([metric, value]) => `${QA_PERFORMANCE_METRIC_LABELS[metric as QaPerformanceMetric]} ${metric === 'cls' ? value : Math.round(value)}${metric === 'cls' ? '' : metric === 'transferBytes' ? ' B' : ' ms'}`)
      .join(' · ')
    if (metrics) lines.push(metrics)
    if (check.performance.unavailable.length)
      lines.push(`Unavailable: ${check.performance.unavailable.map((metric) => QA_PERFORMANCE_METRIC_LABELS[metric]).join(', ')}`)
  }
  if (check.accessibility)
    for (const violation of check.accessibility.violations.slice(0, 10))
      lines.push(`${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help} — ${violation.targets.join(', ')}`)
  return lines
}

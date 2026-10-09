/**
 * Check outcomes in JUnit and HTML reports (src/main/qa/reports.ts). JSON reports carry the full
 * evidence already: QaStepResult.check per step and QaCase.checks per case.
 */
import type { QaBatch, QaCase } from '@shared/qa'
import { CHECK_STATUS_LABELS, checkCaseLabel, formatCheckSummary, summarizeChecks } from '@shared/qa-checks'
import type { QaCheckSummary } from '@shared/qa-checks'
import { DEVICE_PRESETS } from '../../browser/device-presets'

const escape = (value: unknown): string =>
  String(value).replace(
    /[<>&"']/g,
    (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]!,
  )

export function caseChecks(item: Pick<QaCase, 'steps' | 'checks'>): QaCheckSummary[] {
  return item.checks ?? summarizeChecks(item.steps)
}

const deviceLabel = (id: string): string | undefined => DEVICE_PRESETS.find((preset) => preset.id === id)?.label

/** "step 3 (checkConsent): consent font 9px FAIL" */
export function checkLines(item: Pick<QaCase, 'steps' | 'checks'>): string[] {
  return caseChecks(item).map((check) => `step ${check.index + 1} (${check.action}): ${formatCheckSummary(check)}`)
}

/** JUnit `<property name="check" …>` elements (inside the testcase's `<properties>`). */
export function junitCheckProperties(item: Pick<QaCase, 'steps' | 'checks'>): string {
  return checkLines(item)
    .map((line) => `<property name="check" value="${escape(line)}"/>`)
    .join('')
}

/** Compact "Checks" table for the HTML report; empty when no case ran a check. */
export function htmlChecksSection(batch: Pick<QaBatch, 'cases'>): string {
  const rows = batch.cases.flatMap((item) =>
    caseChecks(item).map((check) => {
      const detail = item.steps.find((step) => step.index === check.index)?.check?.message ?? ''
      const css = check.status === 'failed' ? 'failed' : check.status === 'passed' ? 'passed' : 'warning'
      return `<tr><td>${escape(checkCaseLabel(item, deviceLabel))}</td><td>${check.index + 1}</td><td>${escape(check.headline)}</td><td class="${css}">${CHECK_STATUS_LABELS[check.status]}</td><td>${escape(detail)}</td></tr>`
    }),
  )
  if (!rows.length) return ''
  return `<h2>Checks</h2><table class="checks"><thead><tr><th>Device · browser · location</th><th>Step</th><th>Check</th><th>Result</th><th>Detail</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
}

/** CSS for the checks table, appended to the report's style element. */
export const CHECKS_REPORT_CSS = '.warning{color:#92400e}.checks td{font-size:14px;vertical-align:top}h2{margin-top:32px}'

/** Adds the checks table (before `</body>`) and its CSS (before the first `</style>`) to an HTML report. */
export function withHtmlChecks<T extends { content: string }>(batch: Pick<QaBatch, 'cases'>, report: T): T {
  const section = htmlChecksSection(batch)
  if (!section) return report
  const styled = report.content.replace('</style>', `${CHECKS_REPORT_CSS}</style>`)
  const at = styled.lastIndexOf('</body>')
  return { ...report, content: at < 0 ? styled + section : `${styled.slice(0, at)}${section}${styled.slice(at)}` }
}

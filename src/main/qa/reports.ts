import type { QaBatch, QaCase, QaExport } from '@shared/qa'
import { countHealedSteps } from '@shared/qa'

export const escapeMarkup = (value: unknown): string =>
  String(value).replace(
    /[<>&"']/g,
    (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]!,
  )
/** One line per healed step: "step 2 (click): #old → internal:role=…" */
function healedLines(item: QaCase): string[] {
  return item.steps.flatMap((step) =>
    step.healed
      ? [
          `step ${step.index + 1} (${step.action}${step.healed.blocked ? ', healing set to fail' : ''}): ${step.healed.originalSelector} → ${step.healed.suggestedSelector}`,
        ]
      : [],
  )
}
function junitCase(batch: QaBatch, item: QaCase): string {
  const healed = healedLines(item)
  const properties = healed.length
    ? `<properties>${healed.map((line) => `<property name="healed" value="${escapeMarkup(line)}"/>`).join('')}</properties>`
    : ''
  const outcome =
    item.status === 'cancelled'
      ? '<skipped/>'
      : item.status === 'failed'
        ? `<failure message="${escapeMarkup(item.steps.find((step) => step.error)?.error ?? item.errors[0] ?? 'Failed')}">${escapeMarkup(item.errors.join('\n'))}</failure>`
        : ''
  const out = healed.length ? `<system-out>${escapeMarkup(healed.map((line) => `Healed ${line}`).join('\n'))}</system-out>` : ''
  return `<testcase classname="${escapeMarkup(item.engine)}" name="${escapeMarkup(`${item.scenarioName ?? batch.scenarioName} / ${item.datasetName ?? 'Default data'} / ${item.environmentName ?? 'Default environment'} / ${item.device} / ${item.target?.zip ?? item.target?.city ?? item.target?.state ?? 'default'}`)}" time="${item.durationMs / 1000}">${properties}${outcome}${out}</testcase>`
}
function htmlResult(item: QaCase): string {
  const healed = healedLines(item)
  const badge = healed.length ? ` <span class="badge" title="${escapeMarkup(healed.join('\n'))}">&#x21bb; Healed</span>` : ''
  return `<td class="${item.status}">${item.status}${badge}</td>`
}
function htmlNotes(item: QaCase): string {
  const failure = escapeMarkup(item.steps.find((step) => step.error)?.error ?? item.errors[0] ?? '')
  const healed = healedLines(item)
  return `<td>${failure}${healed.length ? `<ul class="healed">${healed.map((line) => `<li>Healed ${escapeMarkup(line)}</li>`).join('')}</ul>` : ''}</td>`
}
export function exportBatch(batch: QaBatch, format: QaExport['format']): QaExport {
  const name = `qa-${batch.id}`
  const cases = batch.cases
  const healedSteps = batch.healedSteps ?? countHealedSteps(cases)
  if (format === 'json')
    return { format, fileName: `${name}.json`, content: JSON.stringify({ ...batch, healedSteps }, null, 2) }
  const failures = cases.filter((item) => item.status === 'failed').length
  const skipped = cases.filter((item) => item.status === 'cancelled').length + Math.max(0, batch.total - cases.length)
  if (format === 'junit')
    return {
      format,
      fileName: `${name}.xml`,
      content: `<?xml version="1.0" encoding="UTF-8"?><testsuites><testsuite name="${escapeMarkup(batch.scenarioName)}" tests="${batch.total}" failures="${failures}" skipped="${skipped}" time="${cases.reduce((n, item) => n + item.durationMs, 0) / 1000}"><properties><property name="healedSteps" value="${healedSteps}"/></properties>${cases.map((item) => junitCase(batch, item)).join('')}${Array.from({ length: Math.max(0, batch.total - cases.length) }, (_, index) => `<testcase name="Unexecuted ${index + 1}"><skipped/></testcase>`).join('')}</testsuite></testsuites>`,
    }
  return {
    format,
    fileName: `${name}.html`,
    content: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeMarkup(batch.scenarioName)}</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:20px}table{width:100%;border-collapse:collapse}td,th{padding:12px;border-bottom:1px solid #ddd;text-align:left}.failed{color:#b91c1c}.passed{color:#15803d}.badge{display:inline-block;margin-left:8px;padding:0 8px;border:1px solid #92400e;border-radius:999px;color:#92400e;font-size:12px}.healed{margin:4px 0 0;padding-left:16px;font-size:13px;color:#92400e;word-break:break-all}</style></head><body><h1>${escapeMarkup(batch.scenarioName)}</h1><p>${escapeMarkup(batch.status)} · ${batch.completed}/${batch.total} completed${healedSteps ? ` · ${healedSteps} healed step${healedSteps === 1 ? '' : 's'}` : ''} · ${escapeMarkup(batch.startedAt)}</p><table><thead><tr><th>Scenario / data / environment</th><th>Browser</th><th>Device</th><th>Location</th><th>Result</th><th>Time</th><th>Failure / healing</th></tr></thead><tbody>${cases.map((item) => `<tr><td>${escapeMarkup(item.scenarioName ?? batch.scenarioName)} / ${escapeMarkup(item.datasetName ?? 'Default data')} / ${escapeMarkup(item.environmentName ?? 'Default environment')}</td><td>${escapeMarkup(item.engine)}</td><td>${escapeMarkup(item.device)}</td><td>${escapeMarkup(item.target?.zip ?? item.target?.city ?? item.target?.state ?? 'Default')}</td>${htmlResult(item)}<td>${item.durationMs} ms</td>${htmlNotes(item)}</tr>`).join('')}</tbody></table></body></html>`,
  }
}

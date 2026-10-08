import type { QaBatch, QaExport } from '@shared/qa'

export const escapeMarkup = (value: unknown): string =>
  String(value).replace(
    /[<>&"']/g,
    (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]!,
  )
export function exportBatch(batch: QaBatch, format: QaExport['format']): QaExport {
  const name = `qa-${batch.id}`
  if (format === 'json') return { format, fileName: `${name}.json`, content: JSON.stringify(batch, null, 2) }
  const cases = batch.cases
  const failures = cases.filter((item) => item.status === 'failed').length
  const skipped = cases.filter((item) => item.status === 'cancelled').length + Math.max(0, batch.total - cases.length)
  if (format === 'junit')
    return {
      format,
      fileName: `${name}.xml`,
      content: `<?xml version="1.0" encoding="UTF-8"?><testsuites><testsuite name="${escapeMarkup(batch.scenarioName)}" tests="${batch.total}" failures="${failures}" skipped="${skipped}" time="${cases.reduce((n, item) => n + item.durationMs, 0) / 1000}">${cases.map((item) => `<testcase classname="${escapeMarkup(item.engine)}" name="${escapeMarkup(`${item.scenarioName ?? batch.scenarioName} / ${item.datasetName ?? 'Default data'} / ${item.environmentName ?? 'Default environment'} / ${item.device} / ${item.target?.zip ?? item.target?.city ?? item.target?.state ?? 'default'}`)}" time="${item.durationMs / 1000}">${item.status === 'cancelled' ? '<skipped/>' : item.status === 'failed' ? `<failure message="${escapeMarkup(item.steps.find((step) => step.error)?.error ?? item.errors[0] ?? 'Failed')}">${escapeMarkup(item.errors.join('\n'))}</failure>` : ''}</testcase>`).join('')}${Array.from({ length: Math.max(0, batch.total - cases.length) }, (_, index) => `<testcase name="Unexecuted ${index + 1}"><skipped/></testcase>`).join('')}</testsuite></testsuites>`,
    }
  return {
    format,
    fileName: `${name}.html`,
    content: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeMarkup(batch.scenarioName)}</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:20px}table{width:100%;border-collapse:collapse}td,th{padding:12px;border-bottom:1px solid #ddd;text-align:left}.failed{color:#b91c1c}.passed{color:#15803d}</style></head><body><h1>${escapeMarkup(batch.scenarioName)}</h1><p>${escapeMarkup(batch.status)} · ${batch.completed}/${batch.total} completed · ${escapeMarkup(batch.startedAt)}</p><table><thead><tr><th>Scenario / data / environment</th><th>Browser</th><th>Device</th><th>Location</th><th>Result</th><th>Time</th><th>Failure</th></tr></thead><tbody>${cases.map((item) => `<tr><td>${escapeMarkup(item.scenarioName ?? batch.scenarioName)} / ${escapeMarkup(item.datasetName ?? 'Default data')} / ${escapeMarkup(item.environmentName ?? 'Default environment')}</td><td>${escapeMarkup(item.engine)}</td><td>${escapeMarkup(item.device)}</td><td>${escapeMarkup(item.target?.zip ?? item.target?.city ?? item.target?.state ?? 'Default')}</td><td class="${item.status}">${item.status}</td><td>${item.durationMs} ms</td><td>${escapeMarkup(item.steps.find((step) => step.error)?.error ?? item.errors[0] ?? '')}</td></tr>`).join('')}</tbody></table></body></html>`,
  }
}

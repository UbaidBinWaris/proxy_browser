/** Redact evidence before persistence; executable URLs remain unchanged in memory. */
import { redactString } from '../logging/redact'

export const DEFAULT_MASK_SELECTORS = ['input', 'textarea', '[contenteditable="true"]', '[data-qa-sensitive]']
const SENSITIVE_PARAM = /token|secret|password|passwd|authorization|api.?key|session|email|phone|mobile|ssn|address|first.?name|last.?name|full.?name|certificate|lead.?id|code|signature|credential/i

export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw)
    if (url.username || url.password) { url.username = ''; url.password = '' }
    for (const key of [...url.searchParams.keys()]) if (SENSITIVE_PARAM.test(key)) url.searchParams.set(key, '[REDACTED]')
    // Fragments can contain OAuth tokens or application state.
    url.hash = ''
    return url.toString()
  } catch { return redactString(raw, null) }
}

export function redactEvidence(raw: string): string {
  return redactString(raw.replace(/https?:\/\/[^\s"'<>]+/g, (url) => redactUrl(url)), null)
}

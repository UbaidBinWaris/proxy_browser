/**
 * Third-party lead-certificate script presets for checkScriptLoaded, and URL matching. The check only
 * inspects what the operator's page loaded; it never contacts these services itself.
 *
 * - TrustedForm (ActiveProspect): the page embeds a script from api.trustedform.com, which adds a hidden
 *   input named xxTrustedFormCertUrl (field name configurable by the page) holding the certificate URL.
 * - Jornaya LeadiD (Verisk): the page embeds a campaign script from create.lidstatic.com, which writes the
 *   LeadiD token into the hidden input #leadid_token.
 */
import type { QaCheckScriptStep, QaScriptPreset } from '@shared/qa-checks'

export interface ScriptPresetDefinition {
  label: string
  /** Script hosts (the host itself or any subdomain). */
  hosts: string[]
  inputSelector?: string
  /** Optional shape the populated value must have. */
  valuePattern?: RegExp
}

export const SCRIPT_PRESETS: Record<Exclude<QaScriptPreset, 'custom'>, ScriptPresetDefinition> = {
  trustedform: {
    label: 'TrustedForm',
    hosts: ['api.trustedform.com'],
    inputSelector: 'input[name*="TrustedFormCertUrl"], input[id^="xxTrustedFormCertUrl"]',
    valuePattern: /^https:\/\/cert\.trustedform\.com\/\S+$/,
  },
  jornaya: {
    label: 'Jornaya LeadiD',
    hosts: ['create.lidstatic.com'],
    inputSelector: '#leadid_token',
  },
}

/** Glob with `*` wildcards (everything else literal), matched against the whole URL. */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${escaped}$`, 'i')
}

export function hostMatches(url: string, hosts: readonly string[]): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  const host = parsed.hostname.toLowerCase()
  return hosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))
}

/** Whether a script URL belongs to the check: the explicit pattern when given, otherwise the preset hosts. */
export function scriptMatches(url: string, step: Pick<QaCheckScriptStep, 'preset' | 'scriptUrl'>): boolean {
  if (step.scriptUrl) {
    // A pattern without a wildcard or scheme matches anywhere in the URL (e.g. "trustedform.js").
    const pattern = step.scriptUrl.includes('*') || /^[a-z]+:\/\//i.test(step.scriptUrl) ? step.scriptUrl : `*${step.scriptUrl}*`
    return globToRegExp(pattern).test(url)
  }
  return step.preset !== 'custom' && hostMatches(url, SCRIPT_PRESETS[step.preset].hosts)
}

export interface ScriptPlan {
  label: string
  inputSelector?: string
  valuePattern?: RegExp
  globalName?: string
}
export function scriptPlan(step: QaCheckScriptStep): ScriptPlan {
  const preset = step.preset === 'custom' ? undefined : SCRIPT_PRESETS[step.preset]
  return {
    label: preset?.label ?? 'Custom script',
    inputSelector: step.inputSelector ?? preset?.inputSelector,
    // A page-specific input selector may hold another format, so the preset's value shape applies only to its own input.
    valuePattern: step.inputSelector ? undefined : preset?.valuePattern,
    globalName: step.globalName,
  }
}

export interface ScriptFacts {
  /** Script element sources and script resource-timing URLs (raw). */
  scriptUrls: string[]
  /** Script resource-timing URLs only: these finished loading. */
  loadedUrls: string[]
  globalDefined?: boolean
  inputFound?: boolean
  inputValue?: string
}
export interface ScriptVerdict {
  matched: string[]
  loaded: boolean
  globalOk: boolean
  inputOk: boolean
  complete: boolean
  problems: string[]
}
export function evaluateScriptFacts(step: QaCheckScriptStep, plan: ScriptPlan, facts: ScriptFacts): ScriptVerdict {
  const matched = [...new Set([...facts.scriptUrls, ...facts.loadedUrls].filter((url) => scriptMatches(url, step)))]
  const globalOk = !plan.globalName || facts.globalDefined === true
  const value = facts.inputValue?.trim() ?? ''
  const inputOk = !plan.inputSelector || (facts.inputFound === true && value.length > 0 && (!plan.valuePattern || plan.valuePattern.test(value)))
  // Resource timing proves the download finished. Some engines omit entries for intercepted or cached
  // responses, so a matching script element whose global/input effects are present also counts.
  const loaded =
    facts.loadedUrls.some((url) => scriptMatches(url, step)) ||
    (matched.length > 0 && Boolean(plan.inputSelector || plan.globalName) && globalOk && inputOk)
  const problems: string[] = []
  if (!matched.length) problems.push(`no ${plan.label} script on the page`)
  else if (!loaded) problems.push(`${plan.label} script tag present but it did not finish loading`)
  if (!globalOk) problems.push(`global ${plan.globalName} not initialized`)
  if (!inputOk)
    problems.push(
      !facts.inputFound
        ? `input ${plan.inputSelector} not found`
        : !value
          ? `input ${plan.inputSelector} is empty`
          : `input ${plan.inputSelector} does not hold a ${plan.label} value`,
    )
  return { matched, loaded, globalOk, inputOk, complete: loaded && globalOk && inputOk, problems }
}

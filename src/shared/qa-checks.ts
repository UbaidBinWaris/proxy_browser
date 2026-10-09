/**
 * "Checks": compliance (consent/TCPA wording and conspicuousness, consent checkbox, lead-certificate
 * scripts), accessibility (axe-core) and performance (Core Web Vitals and timings with budgets).
 *
 * Checks are assertion steps of the scenario step union (src/shared/qa.ts). They never heal, they only
 * read the operator's own page, and every field added here is optional or defaulted so scenarios,
 * backups and CI manifests saved before checks existed keep parsing unchanged.
 *
 * This module must not import ./qa (qa.ts imports it).
 */
import { z } from 'zod'
import { BROWSER_ENGINE_LABELS } from './types'

const selector = z.string().trim().min(1).max(1000)
/** Continue with the next steps after this check fails; the case still fails. */
const continueOnFailure = z.boolean().optional()

export const QA_CHECK_ACTIONS = [
  'checkConsent',
  'checkConsentCheckbox',
  'checkScriptLoaded',
  'checkAccessibility',
  'checkPerformance',
] as const
export type QaCheckAction = (typeof QA_CHECK_ACTIONS)[number]

export const QA_CHECK_LABELS: Record<QaCheckAction, string> = {
  checkConsent: 'Check consent disclosure',
  checkConsentCheckbox: 'Check consent checkbox',
  checkScriptLoaded: 'Check script loaded',
  checkAccessibility: 'Check accessibility (axe)',
  checkPerformance: 'Check performance budget',
}

export const CONSENT_DEFAULTS = { minFontPx: 10, minContrastRatio: 4.5, maxDistancePx: 200 } as const

export const QaCheckConsentStepSchema = z
  .object({
    action: z.literal('checkConsent'),
    /** CSS selector of the consent/disclosure block. One of blockSelector or blockText is required. */
    blockSelector: selector.optional(),
    /** Text that identifies the block (the smallest element containing it is checked). */
    blockText: z.string().trim().min(1).max(500).optional(),
    /** Approved disclosure wording; may contain {{variables}}. Compared after whitespace normalization. */
    approvedText: z.string().max(10000).optional(),
    /** `exact`: the block's text must equal the approved wording; `contains`: it must contain it. */
    wordingMatch: z.enum(['exact', 'contains']).optional(),
    minFontPx: z.number().min(1).max(100).default(CONSENT_DEFAULTS.minFontPx),
    minContrastRatio: z.number().min(1).max(21).default(CONSENT_DEFAULTS.minContrastRatio),
    /** e.g. the submit button: the disclosure must be within maxDistancePx of it. */
    nearSelector: selector.optional(),
    maxDistancePx: z.number().min(0).max(5000).default(CONSENT_DEFAULTS.maxDistancePx),
    continueOnFailure,
  })
  .refine((step) => Boolean(step.blockSelector || step.blockText), {
    message: 'Give the consent block a selector or its matching text.',
    path: ['blockSelector'],
  })
export const QaCheckConsentCheckboxStepSchema = z.object({
  action: z.literal('checkConsentCheckbox'),
  checkboxSelector: selector,
  continueOnFailure,
})
export const QA_SCRIPT_PRESETS = ['trustedform', 'jornaya', 'custom'] as const
export type QaScriptPreset = (typeof QA_SCRIPT_PRESETS)[number]
export const QaCheckScriptStepSchema = z
  .object({
    action: z.literal('checkScriptLoaded'),
    preset: z.enum(QA_SCRIPT_PRESETS),
    /** Script URL pattern; `*` matches any characters. Required for custom; overrides the preset host otherwise. */
    scriptUrl: z.string().trim().min(1).max(2000).optional(),
    /** Global the script initializes, as a dotted path (e.g. `LeadiD` or `myVendor.ready`). */
    globalName: z
      .string()
      .regex(/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*){0,4}$/, 'Use a dotted JavaScript name, e.g. vendor.ready.')
      .optional(),
    /** Hidden input the script must populate; overrides the preset input. */
    inputSelector: selector.optional(),
    continueOnFailure,
  })
  .refine((step) => step.preset !== 'custom' || Boolean(step.scriptUrl), {
    message: 'A custom script check needs a script URL pattern.',
    path: ['scriptUrl'],
  })
export const QA_AXE_IMPACTS = ['minor', 'moderate', 'serious', 'critical'] as const
export type QaAxeImpact = (typeof QA_AXE_IMPACTS)[number]
export const QaCheckAccessibilityStepSchema = z.object({
  action: z.literal('checkAccessibility'),
  /** Limit the scan to this element (and its descendants). */
  scopeSelector: selector.optional(),
  /** axe-core rule tags, e.g. wcag2a, wcag2aa, wcag21aa, best-practice. */
  tags: z
    .array(z.string().regex(/^[a-z0-9.-]{1,40}$/, 'Use axe rule tags such as wcag2aa.'))
    .min(1)
    .max(20)
    .default(['wcag2a', 'wcag2aa']),
  /** Violations at or above this impact fail the step; lower ones are recorded as warnings. */
  failOn: z.enum(QA_AXE_IMPACTS).default('serious'),
  /** Node targets recorded per violation. */
  maxNodes: z.int().min(1).max(50).default(5),
  continueOnFailure,
})
export const QA_PERFORMANCE_METRICS = [
  'lcpMs',
  'cls',
  'inpMs',
  'tbtMs',
  'ttfbMs',
  'domContentLoadedMs',
  'loadMs',
  'transferBytes',
] as const
export type QaPerformanceMetric = (typeof QA_PERFORMANCE_METRICS)[number]
export const QA_PERFORMANCE_METRIC_LABELS: Record<QaPerformanceMetric, string> = {
  lcpMs: 'LCP',
  cls: 'CLS',
  inpMs: 'INP',
  tbtMs: 'TBT',
  ttfbMs: 'TTFB',
  domContentLoadedMs: 'DOMContentLoaded',
  loadMs: 'Load',
  transferBytes: 'Transfer size',
}
const budget = z.number().min(0).max(1e10).optional()
export const QaPerformanceBudgetsSchema = z.object({
  lcpMs: budget,
  cls: budget,
  inpMs: budget,
  tbtMs: budget,
  ttfbMs: budget,
  domContentLoadedMs: budget,
  loadMs: budget,
  transferBytes: budget,
})
export type QaPerformanceBudgets = z.infer<typeof QaPerformanceBudgetsSchema>
export const QaCheckPerformanceStepSchema = z.object({
  action: z.literal('checkPerformance'),
  budgets: QaPerformanceBudgetsSchema.default({}),
  /** Quiet time after the load event before metrics are read, so late layout shifts and LCP candidates count. */
  settleMs: z.int().min(0).max(10000).default(1000),
  continueOnFailure,
})
/** Step schemas appended to QaStepSchema's discriminated union. */
export const QA_CHECK_STEP_SCHEMAS = [
  QaCheckConsentStepSchema,
  QaCheckConsentCheckboxStepSchema,
  QaCheckScriptStepSchema,
  QaCheckAccessibilityStepSchema,
  QaCheckPerformanceStepSchema,
] as const
export type QaCheckConsentStep = z.infer<typeof QaCheckConsentStepSchema>
export type QaCheckConsentCheckboxStep = z.infer<typeof QaCheckConsentCheckboxStepSchema>
export type QaCheckScriptStep = z.infer<typeof QaCheckScriptStepSchema>
export type QaCheckAccessibilityStep = z.infer<typeof QaCheckAccessibilityStepSchema>
export type QaCheckPerformanceStep = z.infer<typeof QaCheckPerformanceStepSchema>
export type QaCheckStep =
  | QaCheckConsentStep
  | QaCheckConsentCheckboxStep
  | QaCheckScriptStep
  | QaCheckAccessibilityStep
  | QaCheckPerformanceStep

/** Chromium-only network throttling for every case of a scenario (DevTools preset values). */
export const QA_NETWORK_PROFILES = ['slow-3g', 'fast-3g', '4g'] as const
export const QaNetworkProfileSchema = z.enum(QA_NETWORK_PROFILES)
export type QaNetworkProfile = z.infer<typeof QaNetworkProfileSchema>
export const QA_NETWORK_PROFILE_LABELS: Record<QaNetworkProfile, string> = {
  'slow-3g': 'Slow 3G (2 s latency, 400 kbit/s)',
  'fast-3g': 'Fast 3G (563 ms latency, 1.44 Mbit/s)',
  '4g': '4G (165 ms latency, 8.1 Mbit/s)',
}

export function isCheckAction(action: string): action is QaCheckAction {
  return (QA_CHECK_ACTIONS as readonly string[]).includes(action)
}
export function isCheckStep(step: { action: string }): step is QaCheckStep {
  return isCheckAction(step.action)
}
/** True when a failed step should not stop the scenario (a check with continueOnFailure). */
export function continuesAfterFailure(step: { action: string }): boolean {
  return isCheckStep(step) && step.continueOnFailure === true
}

/** A new check step with the editor's defaults. */
export function newCheckStep(action: QaCheckAction): QaCheckStep {
  switch (action) {
    case 'checkConsent':
      return { action, blockSelector: '', ...CONSENT_DEFAULTS }
    case 'checkConsentCheckbox':
      return { action, checkboxSelector: '' }
    case 'checkScriptLoaded':
      return { action, preset: 'trustedform' }
    case 'checkAccessibility':
      return { action, tags: ['wcag2a', 'wcag2aa'], failOn: 'serious', maxNodes: 5 }
    case 'checkPerformance':
      return { action, budgets: { lcpMs: 2500, cls: 0.1 }, settleMs: 1000 }
  }
}

/**
 * Applies {{variable}} substitution to a check step's selectors and approved wording (the fields the
 * generic resolver in src/main/qa/variables.ts does not know). Returns only the changed fields.
 */
export function resolveCheckStepTemplates(
  step: { action: string },
  replace: (text: string) => string,
): Partial<QaCheckStep> {
  if (!isCheckStep(step)) return {}
  const map = (record: object, keys: string[]): Partial<QaCheckStep> => {
    const out: Record<string, string> = {}
    for (const key of keys) {
      const value = (record as Record<string, unknown>)[key]
      if (typeof value === 'string') out[key] = replace(value)
    }
    return out as Partial<QaCheckStep>
  }
  switch (step.action) {
    case 'checkConsent':
      return map(step, ['blockSelector', 'blockText', 'approvedText', 'nearSelector'])
    case 'checkConsentCheckbox':
      return map(step, ['checkboxSelector'])
    case 'checkScriptLoaded':
      return map(step, ['scriptUrl', 'inputSelector'])
    case 'checkAccessibility':
      return map(step, ['scopeSelector'])
    case 'checkPerformance':
      return {}
  }
}

// ---------------------------------------------------------------------------------------------------
// Evidence recorded on QaStepResult.check
// ---------------------------------------------------------------------------------------------------

/** warning = recorded but not failing (e.g. contrast not measurable over a background image). */
export type QaCheckStatus = 'passed' | 'failed' | 'warning'
export interface QaCheckAssertion {
  /** Stable id, e.g. present, wording, visible, fontSize, contrast, near, notPrechecked, labelled. */
  name: string
  status: QaCheckStatus
  message: string
}
export interface QaWordDiffOp {
  op: 'same' | 'added' | 'removed'
  /** Words joined by single spaces. `added` = on the page only; `removed` = in the approved text only. */
  text: string
}
export interface QaConsentEvidence {
  /** Normalized rendered text of the block (at most 2,000 characters). */
  text: string
  matchedElements: number
  /** Smallest rendered font size of the block's visible text, in CSS px. */
  minFontPx?: number
  /** Lowest text/background contrast ratio found, when measurable. */
  minContrastRatio?: number
  contrastMeasurable: boolean
  hiddenReasons: string[]
  distancePx?: number
  /** Word-level diff against the approved wording, when it did not match. */
  wordingDiff?: QaWordDiffOp[]
}
export interface QaCheckboxEvidence {
  checked: boolean
  label: string
}
export interface QaScriptEvidence {
  preset: QaScriptPreset
  /** Matching script URLs seen on the page (redacted), at most 5. */
  scripts: string[]
  loaded: boolean
  globalDefined?: boolean
  /** The input exists and has a value. The value itself is never recorded. */
  inputPopulated?: boolean
  inputValueLength?: number
}
export interface QaAxeViolation {
  id: string
  impact: QaAxeImpact | null
  help: string
  helpUrl: string
  /** Total failing nodes; `targets` holds at most maxNodes of them. */
  nodeCount: number
  targets: string[]
}
export interface QaAccessibilityEvidence {
  tags: string[]
  failOn: QaAxeImpact
  axeVersion: string
  violations: QaAxeViolation[]
  passes: number
  incomplete: number
}
export type QaPerformanceMetrics = Partial<Record<QaPerformanceMetric, number>>
export interface QaPerformanceEvidence {
  metrics: QaPerformanceMetrics
  budgets: QaPerformanceBudgets
  /** Metrics this browser did not report (e.g. CLS and TBT outside Chromium, INP without interactions). */
  unavailable: QaPerformanceMetric[]
  networkProfile?: QaNetworkProfile
  /** 'applied', or why it was not (e.g. 'not supported on firefox'). */
  throttling?: string
}
export interface QaCheckResult {
  action: QaCheckAction
  status: QaCheckStatus
  /** Short outcome for matrix views, e.g. "consent font 9px" or "LCP 3,100 ms > 2,500 ms". */
  headline: string
  /** First failing (or warning) assertion's message, or a pass summary. */
  message: string
  assertions: QaCheckAssertion[]
  consent?: QaConsentEvidence
  checkbox?: QaCheckboxEvidence
  script?: QaScriptEvidence
  accessibility?: QaAccessibilityEvidence
  performance?: QaPerformanceEvidence
}
/** One check of a case, for matrix results and reports. */
export interface QaCheckSummary {
  /** 0-based step index. */
  index: number
  action: QaCheckAction
  status: QaCheckStatus
  headline: string
}
export function summarizeChecks(
  steps: ReadonlyArray<{ index: number; check?: QaCheckResult }>,
): QaCheckSummary[] {
  return steps.flatMap((step) =>
    step.check
      ? [{ index: step.index, action: step.check.action, status: step.check.status, headline: step.check.headline }]
      : [],
  )
}
export const CHECK_STATUS_LABELS: Record<QaCheckStatus, string> = { passed: 'PASS', failed: 'FAIL', warning: 'WARN' }
/** "consent font 9px FAIL" */
export function formatCheckSummary(summary: Pick<QaCheckSummary, 'headline' | 'status'>): string {
  return `${summary.headline} ${CHECK_STATUS_LABELS[summary.status]}`
}
/** "iPhone SE · WebKit · Texas" for a matrix case; `deviceLabel` maps a preset id to its label. */
export function checkCaseLabel(
  item: {
    engine: string
    device: string
    target: { zip: string | null; city: string | null; state: string | null } | null
  },
  deviceLabel: (id: string) => string | undefined = () => undefined,
): string {
  const engine = (BROWSER_ENGINE_LABELS as Record<string, string | undefined>)[item.engine]
  const engineName = engine ? (engine.replace(/\s*\([^)]*\)\s*$/, '').split(' / ')[0]?.trim() ?? item.engine) : item.engine
  const location = item.target?.zip ?? item.target?.city ?? item.target?.state ?? 'Default location'
  return `${deviceLabel(item.device) ?? item.device} · ${engineName} · ${location}`
}

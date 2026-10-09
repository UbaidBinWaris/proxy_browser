/** Pure logic of the compliance, accessibility and performance checks, and schema back-compat. */
import { describe, expect, it } from 'vitest'
import { QaStepSchema, ScenarioInputSchema } from '../src/shared/qa'
import type { QaBatch, QaCase } from '../src/shared/qa'
import {
  QaCheckConsentStepSchema,
  checkCaseLabel,
  continuesAfterFailure,
  formatCheckSummary,
  isCheckStep,
  newCheckStep,
  QA_CHECK_ACTIONS,
  summarizeChecks,
} from '../src/shared/qa-checks'
import type { QaCheckConsentStep, QaCheckResult, QaCheckScriptStep } from '../src/shared/qa-checks'
import {
  blend,
  contrastRatio,
  effectiveBackground,
  formatRatio,
  measureTextContrast,
  parseCssColor,
  relativeLuminance,
} from '../src/main/qa/checks/contrast'
import { compareWording, describeWordDiff, diffWords, formatWordDiff, normalizeWording } from '../src/main/qa/checks/wording'
import { hiddenReasons, rectDistance } from '../src/main/qa/checks/visibility'
import type { VisibilityFacts } from '../src/main/qa/checks/visibility'
import {
  cumulativeLayoutShift,
  evaluateBudgets,
  formatMetric,
  interactionToNextPaint,
  totalBlockingTime,
} from '../src/main/qa/checks/budgets'
import { evaluateScriptFacts, globToRegExp, hostMatches, scriptMatches, scriptPlan } from '../src/main/qa/checks/scripts'
import { evaluateCheckbox, evaluateConsent } from '../src/main/qa/checks/compliance'
import type { ConsentFacts } from '../src/main/qa/checks/compliance'
import { evaluateAxe } from '../src/main/qa/checks/a11y'
import { evaluatePerformance, performanceMetrics } from '../src/main/qa/checks/performance'
import { resolveScenario } from '../src/main/qa/variables'
import { exportBatch } from '../src/main/qa/reports'
import { DEVICE_PRESETS } from '../src/main/browser/device-presets'
import { matrixCheckLines, optionalNumber, optionalText, parseTags } from '../src/renderer/src/lib/checkSteps'

describe('contrast math', () => {
  it('parses computed colors', () => {
    expect(parseCssColor('rgb(255, 0, 10)')).toEqual({ r: 255, g: 0, b: 10, a: 1 })
    expect(parseCssColor('rgba(0, 0, 0, 0.5)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 })
    expect(parseCssColor('rgb(0 128 255 / 25%)')).toEqual({ r: 0, g: 128, b: 255, a: 0.25 })
    expect(parseCssColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 })
    expect(parseCssColor('color(srgb 1 0.5 0 / 0.5)')).toEqual({ r: 255, g: 127.5, b: 0, a: 0.5 })
    expect(parseCssColor('oklch(0.5 0.1 200)')).toBeNull()
    expect(parseCssColor('rgb(1, 2)')).toBeNull()
  })
  it('implements the WCAG luminance and ratio formulas', () => {
    const black = { r: 0, g: 0, b: 0, a: 1 }
    const white = { r: 255, g: 255, b: 255, a: 1 }
    expect(relativeLuminance(white)).toBeCloseTo(1, 6)
    expect(contrastRatio(black, white)).toBeCloseTo(21, 6)
    expect(contrastRatio(white, black)).toBeCloseTo(21, 6)
    // #777 on white is the classic just-below-AA example (4.48:1); #767676 is the lightest AA gray (4.54:1).
    expect(contrastRatio(parseCssColor('rgb(119, 119, 119)')!, white)).toBeCloseTo(4.48, 2)
    expect(contrastRatio(parseCssColor('rgb(118, 118, 118)')!, white)).toBeCloseTo(4.54, 2)
    expect(formatRatio(4.499)).toBe('4.49:1')
  })
  it('alpha-blends text and stacked semi-transparent backgrounds over the canvas', () => {
    expect(blend({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 })).toEqual({ r: 127.5, g: 127.5, b: 127.5, a: 1 })
    // Innermost first: 50% white over 50% black over the white canvas = 75% gray... (0.5*255 + 0.5*127.5).
    expect(
      effectiveBackground([
        { r: 255, g: 255, b: 255, a: 0.5 },
        { r: 0, g: 0, b: 0, a: 0.5 },
      ]),
    ).toEqual({ r: 191.25, g: 191.25, b: 191.25, a: 1 })
    // Fully transparent ancestors show the white canvas.
    const onCanvas = measureTextContrast({ color: 'rgb(0, 0, 0)', backgrounds: ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'] })
    expect(onCanvas.measurable && onCanvas.ratio).toBeCloseTo(21, 6)
    // Half-transparent black text on white is mid-gray: about 3.95:1.
    const faded = measureTextContrast({ color: 'rgba(0, 0, 0, 0.5)', backgrounds: ['rgb(255, 255, 255)'] })
    expect(faded.measurable && faded.ratio).toBeCloseTo(3.95, 1)
    // Element opacity fades the text the same way.
    const opacity = measureTextContrast({ color: 'rgb(0, 0, 0)', backgrounds: ['rgb(255, 255, 255)'], opacity: 0.5 })
    expect(opacity.measurable && opacity.ratio).toBeCloseTo(3.95, 1)
  })
  it('reports background images and unsupported color spaces as not measurable', () => {
    expect(measureTextContrast({ color: 'rgb(0, 0, 0)', backgrounds: [], backgroundImage: true })).toEqual({
      measurable: false,
      reason: 'a background image or gradient is behind the text',
    })
    expect(measureTextContrast({ color: 'lab(50 0 0)', backgrounds: [] }).measurable).toBe(false)
    expect(measureTextContrast({ color: 'rgb(0, 0, 0)', backgrounds: ['oklch(1 0 0)'] }).measurable).toBe(false)
  })
})

describe('approved wording', () => {
  it('normalizes whitespace, non-breaking and zero-width spaces only', () => {
    expect(normalizeWording('  I agree\n\tto  be​ called. ')).toBe('I agree to be called.')
    expect(compareWording('I agree to be called.', 'I  agree\nto be called.').matches).toBe(true)
    expect(compareWording('I agree to be called.', 'I Agree to be called.').matches).toBe(false)
    expect(compareWording('I agree.', 'I agree').matches).toBe(false)
  })
  it('produces a merged word-level diff', () => {
    const ops = diffWords('I agree to receive calls and texts from Example', 'I agree to get calls from Example')
    expect(ops).toEqual([
      { op: 'same', text: 'I agree to' },
      { op: 'removed', text: 'receive' },
      { op: 'added', text: 'get' },
      { op: 'same', text: 'calls' },
      { op: 'removed', text: 'and texts' },
      { op: 'same', text: 'from Example' },
    ])
    expect(formatWordDiff(ops)).toBe('I agree to [-receive-] {+get+} calls [-and texts-] from Example')
    expect(describeWordDiff(ops)).toBe('3 approved words missing, 1 extra word')
  })
  it('supports contains matching and shortens long unchanged runs', () => {
    expect(compareWording('Consent is not required.', 'Header text. Consent is not required. Footer', 'contains').matches).toBe(true)
    const verdict = compareWording('one two three four five six seven eight nine ten eleven', 'one two three four five six seven eight nine ten twelve')
    expect(formatWordDiff(verdict.diff!)).toBe('… eight nine ten [-eleven-] {+twelve+}')
  })
  it('handles empty and very long texts', () => {
    expect(diffWords('', 'new words')).toEqual([{ op: 'added', text: 'new words' }])
    const long = Array.from({ length: 3000 }, (_, index) => `w${index}`).join(' ')
    const ops = diffWords(long, `${long} extra`)
    expect(ops.at(-1)).toEqual({ op: 'added', text: 'extra' })
  })
})

const visible: VisibilityFacts = {
  displayNone: false,
  visibility: 'visible',
  opacity: 1,
  rect: { x: 10, y: 10, width: 300, height: 40 },
  visibleRect: { x: 10, y: 10, width: 300, height: 40 },
  viewport: { width: 800, height: 600 },
  centerHit: 'self',
}
describe('visibility decision', () => {
  it('passes a rendered, on-screen, uncovered block', () => {
    expect(hiddenReasons(visible)).toEqual([])
    expect(hiddenReasons({ ...visible, centerHit: 'descendant' })).toEqual([])
    expect(hiddenReasons({ ...visible, centerHit: 'ancestor' })).toEqual([])
  })
  it('names each hiding technique', () => {
    expect(hiddenReasons({ ...visible, displayNone: true })).toEqual(['display:none (element or an ancestor)'])
    expect(hiddenReasons({ ...visible, visibility: 'hidden' })).toEqual(['visibility:hidden'])
    expect(hiddenReasons({ ...visible, opacity: 0.05 })).toEqual(['opacity 0.05'])
    expect(hiddenReasons({ ...visible, rect: { x: 0, y: 0, width: 1, height: 1 }, visibleRect: null })[0]).toMatch(/^zero size/)
    expect(hiddenReasons({ ...visible, visibleRect: null })).toEqual(['clipped (overflow, clip or clip-path)'])
    expect(hiddenReasons({ ...visible, visibleRect: { x: -9999, y: 0, width: 300, height: 40 } })[0]).toMatch(/^offscreen/)
    expect(hiddenReasons({ ...visible, centerHit: 'other', coveredBy: 'div#modal' })).toEqual(['covered by div#modal at its center'])
  })
  it('measures the gap between boxes', () => {
    const a = { x: 0, y: 0, width: 100, height: 20 }
    expect(rectDistance(a, { x: 50, y: 10, width: 100, height: 20 })).toBe(0)
    expect(rectDistance(a, { x: 0, y: 50, width: 100, height: 20 })).toBe(30)
    expect(rectDistance(a, { x: 130, y: 60, width: 10, height: 10 })).toBe(50)
  })
})

const consentStep = (overrides: Partial<QaCheckConsentStep> = {}): QaCheckConsentStep =>
  QaCheckConsentStepSchema.parse({ action: 'checkConsent', blockSelector: '#consent', ...overrides })
const consentFacts = (overrides: Partial<ConsentFacts> = {}): ConsentFacts => ({
  ...visible,
  text: 'I agree to be called.',
  pageRect: visible.rect,
  runs: [{ fontPx: 12, color: 'rgb(0, 0, 0)', backgrounds: ['rgb(255, 255, 255)'], backgroundImage: false, opacity: 1, sample: 'I agree' }],
  ...overrides,
})
describe('consent decision', () => {
  it('passes and summarizes a compliant block', () => {
    const result = evaluateConsent(consentStep({ approvedText: 'I agree to be called.' }), consentFacts(), { matchedElements: 1 })
    expect(result.status).toBe('passed')
    expect(result.headline).toBe('consent ok (font 12px, contrast 21.00:1)')
  })
  it('fails small, low-contrast, reworded and distant blocks with a combined headline', () => {
    const result = evaluateConsent(
      consentStep({ approvedText: 'I agree to be called by Example.', nearSelector: '#submit', maxDistancePx: 100 }),
      consentFacts({ runs: [{ fontPx: 9, color: 'rgb(200, 200, 200)', backgrounds: ['rgb(255, 255, 255)'], backgroundImage: false, opacity: 1, sample: 'tiny' }] }),
      { matchedElements: 1, nearFound: true, distancePx: 340 },
    )
    expect(result.status).toBe('failed')
    expect(result.headline).toBe('consent wording differs, font 9px, contrast 1.67:1')
    expect(result.assertions.filter((item) => item.status === 'failed').map((item) => item.name)).toEqual([
      'wording',
      'fontSize',
      'contrast',
      'near',
    ])
    expect(result.consent?.wordingDiff).toEqual([
      { op: 'same', text: 'I agree to be' },
      { op: 'removed', text: 'called by Example.' },
      { op: 'added', text: 'called.' },
    ])
  })
  it('warns when contrast is not measurable and when several elements match', () => {
    const result = evaluateConsent(
      consentStep(),
      consentFacts({ runs: [{ fontPx: 12, color: 'rgb(0, 0, 0)', backgrounds: [], backgroundImage: true, opacity: 1, sample: 'x' }] }),
      { matchedElements: 2 },
    )
    expect(result.status).toBe('warning')
    expect(result.consent?.contrastMeasurable).toBe(false)
    expect(result.headline).toBe('consent contrast not measurable')
    expect(result.assertions[0]).toMatchObject({ name: 'present', status: 'warning' })
  })
  it('sanitizes page text in evidence', () => {
    const result = evaluateConsent(consentStep(), consentFacts({ text: 'Call 555-0100 secret' }), { matchedElements: 1 }, (text) => text.replace('secret', '[REDACTED]'))
    expect(result.consent?.text).toBe('Call 555-0100 [REDACTED]')
  })
  it('judges the consent checkbox', () => {
    const step = { action: 'checkConsentCheckbox' as const, checkboxSelector: '#agree' }
    expect(evaluateCheckbox(step, { isCheckbox: true, checked: false, label: 'I agree' }).status).toBe('passed')
    expect(evaluateCheckbox(step, { isCheckbox: true, checked: true, label: 'I agree' }).headline).toBe('consent checkbox pre-checked')
    expect(evaluateCheckbox(step, { isCheckbox: true, checked: false, label: ' ' }).headline).toBe('consent checkbox unlabeled')
    expect(evaluateCheckbox(step, { isCheckbox: true, checked: false, defaultChecked: true, label: 'I agree' }).status).toBe('warning')
    expect(evaluateCheckbox(step, null).headline).toBe('consent checkbox missing')
  })
})

describe('performance budgets', () => {
  it('fails over budget, passes at or under, warns when unavailable, ignores unbudgeted metrics', () => {
    const assertions = evaluateBudgets({ lcpMs: 3100, cls: 0.1, ttfbMs: 200 }, { lcpMs: 2500, cls: 0.1, inpMs: 200 })
    expect(assertions.map((item) => [item.name, item.status])).toEqual([
      ['lcpMs', 'failed'],
      ['cls', 'passed'],
      ['inpMs', 'warning'],
    ])
    expect(assertions[0]!.message).toBe('LCP 3,100 ms > 2,500 ms')
    expect(formatMetric('transferBytes', 1536)).toBe('1.5 KB')
    expect(formatMetric('transferBytes', 3 * 1024 * 1024)).toBe('3.00 MB')
    expect(formatMetric('cls', 0.12345)).toBe('0.123')
  })
  it('approximates TBT, CLS session windows and INP', () => {
    expect(totalBlockingTime([{ startTime: 10, duration: 200 }, { startTime: 500, duration: 120 }, { startTime: 600, duration: 40 }], 100)).toBe(70)
    expect(totalBlockingTime([{ startTime: 10, duration: 200 }])).toBe(150)
    expect(
      cumulativeLayoutShift([
        { startTime: 100, value: 0.05 },
        { startTime: 600, value: 0.05 },
        { startTime: 3000, value: 0.02 },
        { startTime: 3100, value: 0.5, hadRecentInput: true },
      ]),
    ).toBeCloseTo(0.1, 6)
    expect(interactionToNextPaint([])).toBeUndefined()
    expect(interactionToNextPaint([{ interactionId: 1, duration: 40 }, { interactionId: 1, duration: 80 }, { interactionId: 2, duration: 24 }, { duration: 500 }])).toBe(80)
  })
  it('derives metrics from page facts and marks the missing ones unavailable', () => {
    const { metrics, unavailable } = performanceMetrics({
      store: { supported: ['largest-contentful-paint', 'paint'], lcp: 900, fcp: 300, shifts: [], events: [], longTasks: [] },
      navigation: { responseStart: 0, domContentLoadedEventEnd: 400, loadEventEnd: 0, transferSize: 1000 },
      resourceBytes: 500,
    })
    expect(metrics).toEqual({ lcpMs: 900, domContentLoadedMs: 400, transferBytes: 1500 })
    expect(unavailable).toEqual(['cls', 'inpMs', 'tbtMs', 'ttfbMs', 'loadMs'])
    const result = evaluatePerformance(
      { action: 'checkPerformance', budgets: { lcpMs: 2500 }, settleMs: 0 },
      { store: null, navigation: null, resourceBytes: 0 },
      { networkProfile: 'slow-3g', throttling: 'not supported on webkit' },
    )
    expect(result.status).toBe('warning')
    expect(result.assertions.map((item) => item.name)).toEqual(['lcpMs', 'throttling'])
    expect(result.performance).toMatchObject({ networkProfile: 'slow-3g', throttling: 'not supported on webkit' })
  })
})

describe('lead-certificate script presets', () => {
  const tf: QaCheckScriptStep = { action: 'checkScriptLoaded', preset: 'trustedform' }
  it('matches preset hosts and custom patterns', () => {
    expect(hostMatches('https://api.trustedform.com/trustedform.js?field=x', ['api.trustedform.com'])).toBe(true)
    expect(hostMatches('https://cdn.api.trustedform.com/x.js', ['api.trustedform.com'])).toBe(true)
    expect(hostMatches('https://api.trustedform.com.evil.test/x.js', ['api.trustedform.com'])).toBe(false)
    expect(hostMatches('data:text/javascript,api.trustedform.com', ['api.trustedform.com'])).toBe(false)
    expect(scriptMatches('http://create.lidstatic.com/campaign/abc.js?snippet_version=2', { preset: 'jornaya' })).toBe(true)
    expect(scriptMatches('https://cdn.example.com/v2/tag.js', { preset: 'custom', scriptUrl: 'https://cdn.example.com/*/tag.js' })).toBe(true)
    expect(scriptMatches('https://cdn.example.com/v2/tag.js?x=1', { preset: 'custom', scriptUrl: 'tag.js' })).toBe(true)
    expect(scriptMatches('https://cdn.example.com/v2/other.js', { preset: 'custom', scriptUrl: 'tag.js' })).toBe(false)
    expect(globToRegExp('a.b*').test('aXb')).toBe(false)
  })
  it('requires the TrustedForm certificate URL shape and a populated Jornaya token', () => {
    const script = ['https://api.trustedform.com/trustedform.js']
    const ok = evaluateScriptFacts(tf, scriptPlan(tf), {
      scriptUrls: script,
      loadedUrls: script,
      inputFound: true,
      inputValue: 'https://cert.trustedform.com/abc123',
    })
    expect(ok.complete).toBe(true)
    const wrong = evaluateScriptFacts(tf, scriptPlan(tf), { scriptUrls: script, loadedUrls: script, inputFound: true, inputValue: 'pending' })
    expect(wrong.problems).toEqual(['input input[name*="TrustedFormCertUrl"], input[id^="xxTrustedFormCertUrl"] does not hold a TrustedForm value'])
    const notLoaded = evaluateScriptFacts(tf, scriptPlan(tf), { scriptUrls: [], loadedUrls: [], inputFound: false })
    expect(notLoaded.loaded).toBe(false)
    expect(notLoaded.problems[0]).toBe('no TrustedForm script on the page')
    const jornaya: QaCheckScriptStep = { action: 'checkScriptLoaded', preset: 'jornaya' }
    const tag = ['https://create.lidstatic.com/campaign/x.js']
    // No resource-timing entry, but the script element exists and did its work.
    expect(evaluateScriptFacts(jornaya, scriptPlan(jornaya), { scriptUrls: tag, loadedUrls: [], inputFound: true, inputValue: 'TOKEN' }).complete).toBe(true)
    expect(evaluateScriptFacts(jornaya, scriptPlan(jornaya), { scriptUrls: tag, loadedUrls: tag, inputFound: true, inputValue: '' }).complete).toBe(false)
    // A page-specific input drops the preset's value shape.
    expect(scriptPlan({ ...tf, inputSelector: '#cert' })).toMatchObject({ inputSelector: '#cert', valuePattern: undefined })
  })
})

describe('axe evaluation', () => {
  const violation = (id: string, impact: 'minor' | 'moderate' | 'serious' | 'critical' | null) => ({ id, impact, help: id, helpUrl: '', nodeCount: 1, targets: ['#x'] })
  it('fails at or above the threshold and warns below it', () => {
    const step = { action: 'checkAccessibility' as const, tags: ['wcag2a'], failOn: 'serious' as const, maxNodes: 5 }
    const run = { version: '4.13.0', passes: 10, incomplete: 0, violations: [violation('label', 'critical'), violation('region', 'moderate')] }
    const failed = evaluateAxe(step, run)
    expect(failed.status).toBe('failed')
    expect(failed.headline).toBe('a11y 1 serious+ violation (label)')
    const lenient = evaluateAxe({ ...step, failOn: 'critical' }, { ...run, violations: [violation('region', 'moderate'), violation('x', null)] })
    expect(lenient.status).toBe('warning')
    expect(lenient.headline).toBe('a11y 2 violations below critical')
    expect(evaluateAxe(step, { ...run, violations: [] }).headline).toBe('a11y no violations')
  })
})

const legacyScenario = {
  workspaceId: 'default',
  name: 'Legacy',
  profileId: 'p1',
  gatewayId: null,
  startUrl: 'https://staging.example.test/form',
  allowedOrigins: ['https://staging.example.test'],
  steps: [
    { action: 'fill', selector: '#email', value: 'a@example.test' },
    { action: 'click', selector: '#submit' },
    { action: 'assertText', selector: '#result', value: 'Thanks' },
  ],
  timeoutMs: 15000,
  maskSelectors: [],
  captureTrace: false,
  healing: 'warn',
}
describe('schema back-compat and check steps', () => {
  it('parses scenarios saved before checks unchanged', () => {
    expect(ScenarioInputSchema.parse(legacyScenario)).toStrictEqual(legacyScenario)
    expect(ScenarioInputSchema.parse(legacyScenario).networkProfile).toBeUndefined()
  })
  it('applies check defaults and validates required fields', () => {
    expect(QaStepSchema.parse({ action: 'checkConsent', blockText: 'Consent is not a condition' })).toEqual({
      action: 'checkConsent',
      blockText: 'Consent is not a condition',
      minFontPx: 10,
      minContrastRatio: 4.5,
      maxDistancePx: 200,
    })
    expect(QaStepSchema.parse({ action: 'checkAccessibility' })).toEqual({ action: 'checkAccessibility', tags: ['wcag2a', 'wcag2aa'], failOn: 'serious', maxNodes: 5 })
    expect(QaStepSchema.parse({ action: 'checkPerformance' })).toEqual({ action: 'checkPerformance', budgets: {}, settleMs: 1000 })
    expect(QaStepSchema.safeParse({ action: 'checkConsent' }).success).toBe(false)
    expect(QaStepSchema.safeParse({ action: 'checkScriptLoaded', preset: 'custom' }).success).toBe(false)
    expect(QaStepSchema.safeParse({ action: 'checkScriptLoaded', preset: 'custom', scriptUrl: '*tag.js' }).success).toBe(true)
    expect(QaStepSchema.safeParse({ action: 'checkScriptLoaded', preset: 'trustedform', globalName: 'a b' }).success).toBe(false)
    expect(QaStepSchema.safeParse({ action: 'checkAccessibility', tags: ['WCAG 2'] }).success).toBe(false)
    expect(ScenarioInputSchema.safeParse({ ...legacyScenario, networkProfile: '5g' }).success).toBe(false)
    expect(ScenarioInputSchema.parse({ ...legacyScenario, networkProfile: 'slow-3g' }).networkProfile).toBe('slow-3g')
  })
  it('editor defaults are valid once the required selector is filled', () => {
    for (const action of QA_CHECK_ACTIONS) {
      const step = newCheckStep(action)
      expect(isCheckStep(step)).toBe(true)
      const filled = { ...step, ...(action === 'checkConsent' ? { blockSelector: '#c' } : {}), ...(action === 'checkConsentCheckbox' ? { checkboxSelector: '#c' } : {}) }
      expect(QaStepSchema.safeParse(filled).success, action).toBe(true)
    }
    expect(continuesAfterFailure({ action: 'checkAccessibility', continueOnFailure: true } as never)).toBe(true)
    expect(continuesAfterFailure({ action: 'assertText' })).toBe(false)
  })
  it('substitutes variables in check selectors and approved wording, and refuses missing ones', () => {
    const scenario = ScenarioInputSchema.parse({
      ...legacyScenario,
      variables: { brand: 'Example', sel: '#tcpa' },
      steps: [
        { action: 'checkConsent', blockSelector: '{{sel}}', approvedText: 'I agree {{brand}} may call.' },
        { action: 'checkScriptLoaded', preset: 'custom', scriptUrl: '*{{brand}}*' },
      ],
    })
    const resolved = resolveScenario(scenario)
    expect(resolved.steps[0]).toMatchObject({ blockSelector: '#tcpa', approvedText: 'I agree Example may call.' })
    expect(resolved.steps[1]).toMatchObject({ scriptUrl: '*Example*' })
    expect(() => resolveScenario({ ...scenario, variables: {} })).toThrow(/Missing test variable: sel/)
  })
})

const checkResult = (overrides: Partial<QaCheckResult>): QaCheckResult => ({
  action: 'checkConsent',
  status: 'failed',
  headline: 'consent font 9px',
  message: 'Font size 9px is below 10px ("<b>tiny</b>").',
  assertions: [],
  ...overrides,
})
const checkCase = (): QaCase => ({
  id: '1',
  engine: 'webkit',
  device: 'iphone-se-3',
  target: { mode: 'state', country: 'us', state: 'Texas', stateCode: 'TX', city: null, zip: null },
  attempt: 1,
  status: 'failed',
  steps: [
    { index: 0, action: 'checkConsent', status: 'failed', durationMs: 5, check: checkResult({}) },
    { index: 1, action: 'checkAccessibility', status: 'passed', durationMs: 5, check: checkResult({ action: 'checkAccessibility', status: 'passed', headline: 'a11y no violations', message: 'ok' }) },
  ],
  errors: [],
  failedRequests: [],
  finalUrl: 'https://staging.example.test/form',
  durationMs: 10,
})
describe('check summaries in results and reports', () => {
  it('summarizes per case and formats matrix lines', () => {
    const item = checkCase()
    expect(summarizeChecks(item.steps)).toEqual([
      { index: 0, action: 'checkConsent', status: 'failed', headline: 'consent font 9px' },
      { index: 1, action: 'checkAccessibility', status: 'passed', headline: 'a11y no violations' },
    ])
    expect(formatCheckSummary({ headline: 'consent font 9px', status: 'failed' })).toBe('consent font 9px FAIL')
    expect(checkCaseLabel(item, () => 'iPhone SE')).toBe('iPhone SE · WebKit · Texas')
    expect(matrixCheckLines([item], () => 'iPhone SE')).toEqual([
      { key: '0-0', status: 'failed', text: 'iPhone SE · WebKit · Texas: consent font 9px FAIL' },
    ])
  })
  it('adds check outcomes to JSON, JUnit and HTML exports, escaped', () => {
    const item = checkCase()
    const batch: QaBatch = {
      id: 'batch-1',
      workspaceId: 'default',
      scenarioId: 's1',
      scenarioName: 'Consent QA',
      status: 'failed',
      startedAt: '2026-10-09T00:00:00.000Z',
      endedAt: '2026-10-09T00:01:00.000Z',
      total: 1,
      completed: 1,
      cases: [{ ...item, checks: summarizeChecks(item.steps) }],
      input: { scenarioId: 's1', engines: [], devices: [], targets: [], concurrency: 1, retries: 0 },
    }
    const json = JSON.parse(exportBatch(batch, 'json').content) as QaBatch
    expect(json.cases[0]!.checks?.[0]).toMatchObject({ headline: 'consent font 9px', status: 'failed' })
    expect(json.cases[0]!.steps[0]!.check?.message).toContain('9px')
    const junit = exportBatch(batch, 'junit').content
    expect(junit).toContain('<property name="check" value="step 1 (checkConsent): consent font 9px FAIL"/>')
    expect(junit).toContain('Check step 2 (checkAccessibility): a11y no violations PASS')
    const html = exportBatch(batch, 'html').content
    const label = DEVICE_PRESETS.find((preset) => preset.id === 'iphone-se-3')!.label
    expect(html).toContain('<h2>Checks</h2>')
    expect(html).toContain(`<td>${label} · WebKit · Texas</td><td>1</td><td>consent font 9px</td><td class="failed">FAIL</td>`)
    expect(html).toContain('&lt;b&gt;tiny&lt;/b&gt;')
    expect(html).not.toContain('<b>tiny</b>')
    expect(html.indexOf('.checks td')).toBeLessThan(html.indexOf('</style>'))
    // Reports without checks are unchanged.
    const plain = exportBatch({ ...batch, cases: [{ ...item, steps: [], checks: undefined }] }, 'html').content
    expect(plain).not.toContain('Checks')
  })
})

describe('renderer check-step helpers', () => {
  it('parses editor inputs', () => {
    expect(parseTags('WCAG2A, wcag2aa  best-practice,,wcag2a')).toEqual(['wcag2a', 'wcag2aa', 'best-practice'])
    expect(optionalText('  ')).toBeUndefined()
    expect(optionalText(' #x')).toBe(' #x')
    expect(optionalNumber('')).toBeUndefined()
    expect(optionalNumber('2500')).toBe(2500)
  })
})

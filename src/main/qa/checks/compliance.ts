/// <reference lib="dom" />
/**
 * Compliance checks (pre-launch consent / TCPA QA of the operator's own forms):
 * - checkConsent: the disclosure is present, worded as approved, visibly rendered, large enough,
 *   legible against its background and (optionally) near the submit button;
 * - checkConsentCheckbox: the consent checkbox is not pre-checked and has a label;
 * - checkScriptLoaded: a lead-certificate script (TrustedForm, Jornaya LeadiD or custom) loaded and
 *   did its work on the page.
 *
 * Facts are gathered in the page with read-only DOM calls; decisions are made by the pure helpers in
 * contrast.ts, wording.ts, visibility.ts and scripts.ts. Nothing here contacts a third-party service.
 */
import type { Locator, Page } from 'playwright-core'
import type {
  QaCheckAssertion,
  QaCheckConsentCheckboxStep,
  QaCheckConsentStep,
  QaCheckResult,
  QaCheckScriptStep,
  QaConsentEvidence,
} from '@shared/qa-checks'
import { redactUrl } from '../../security/data-privacy'
import { formatRatio, measureTextContrast } from './contrast'
import { compareWording, describeWordDiff, formatWordDiff, normalizeWording } from './wording'
import { hiddenReasons, rectDistance } from './visibility'
import type { Rect, VisibilityFacts } from './visibility'
import { evaluateScriptFacts, scriptPlan } from './scripts'
import type { ScriptFacts } from './scripts'
import { checkMessage, errorLine, pause, worstStatus } from './result'
import type { CheckContext } from './result'

/** Rendered text run inside the consent block, as measured in the page. */
export interface TextRunFacts {
  fontPx: number
  color: string
  backgrounds: string[]
  backgroundImage: boolean
  opacity: number
  sample: string
}
export interface ConsentFacts extends VisibilityFacts {
  text: string
  /** Border box in page coordinates (viewport + scroll), for distance checks. */
  pageRect: Rect
  runs: TextRunFacts[]
}

const MAX_RUNS = 200

/**
 * Scrolls the block into view (instantly, centered) and measures it. Runs in the page; keep it
 * self-contained (no imports, arrow functions only).
 */
async function collectConsentFacts(element: Element, maxRuns: number): Promise<ConsentFacts> {
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 150)
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(timer)
        resolve()
      }),
    )
  })
  const style = (node: Element): CSSStyleDeclaration => getComputedStyle(node)
  const chain = (node: Element): Element[] => {
    const nodes: Element[] = []
    for (let current: Element | null = node; current; current = current.parentElement) nodes.push(current)
    return nodes
  }
  const toRect = (r: DOMRect | { x: number; y: number; width: number; height: number }) => ({
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
  })
  const intersect = (
    a: { x: number; y: number; width: number; height: number } | null,
    b: { x: number; y: number; width: number; height: number },
  ) => {
    if (!a) return null
    const x = Math.max(a.x, b.x)
    const y = Math.max(a.y, b.y)
    const right = Math.min(a.x + a.width, b.x + b.width)
    const bottom = Math.min(a.y + a.height, b.y + b.height)
    return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
  }
  const length = (raw: string, basis: number): number =>
    raw.endsWith('%') ? (parseFloat(raw) / 100) * basis : parseFloat(raw) || 0
  /** The box `clip` (absolute/fixed elements) and `clip-path: inset()` leave visible, or null when they hide it. */
  const clipBox = (node: Element, cs: CSSStyleDeclaration) => {
    const box = toRect(node.getBoundingClientRect())
    let result: ReturnType<typeof intersect> = box
    const clip = /^rect\((.*)\)$/.exec(cs.clip ?? '')
    if (clip && (cs.position === 'absolute' || cs.position === 'fixed')) {
      const [top, right, bottom, left] = clip[1]!.split(/[\s,]+/)
      const value = (raw: string | undefined, auto: number) => (!raw || raw === 'auto' ? auto : parseFloat(raw))
      const t = value(top, 0)
      const l = value(left, 0)
      const r = value(right, box.width)
      const b = value(bottom, box.height)
      result = intersect(result, { x: box.x + l, y: box.y + t, width: Math.max(0, r - l), height: Math.max(0, b - t) })
    }
    const inset = /^inset\(([^)]*)\)/.exec(cs.clipPath ?? '')
    if (inset) {
      const parts = inset[1]!.split(/\s+round\s+/)[0]!.trim().split(/\s+/)
      const [t = '0', r = t, b = t, l = r] = parts
      const top = length(t, box.height)
      const right = length(r, box.width)
      const bottom = length(b, box.height)
      const left = length(l, box.width)
      result = intersect(result, {
        x: box.x + left,
        y: box.y + top,
        width: Math.max(0, box.width - left - right),
        height: Math.max(0, box.height - top - bottom),
      })
    }
    if (/^circle\(\s*0(px|%)?[\s)]/.test(cs.clipPath ?? '')) result = null
    return result
  }
  const describe = (node: Element): string => {
    const id = node.id ? `#${node.id}` : ''
    const classes = Array.from(node.classList)
      .slice(0, 3)
      .map((name) => `.${name}`)
      .join('')
    return `${node.localName}${id}${classes}`.slice(0, 80)
  }
  const isOpaque = (color: string): boolean =>
    /^rgb\(/.test(color) ||
    /^rgba\(.*,\s*1\s*\)$/.test(color) ||
    /^rgba?\([^/]*\/\s*1\s*\)$/.test(color) ||
    (/^color\(srgb/.test(color) && !color.includes('/'))
  const opacityOf = (node: Element): number => chain(node).reduce((product, item) => product * (parseFloat(style(item).opacity) || 0), 1)

  const nodes = chain(element)
  const own = style(element)
  const rect = toRect(element.getBoundingClientRect())
  const displayNone = nodes.some((node) => style(node).display === 'none')
  let visibleRect: ReturnType<typeof intersect> = clipBox(element, own)
  for (const ancestor of nodes.slice(1)) {
    const cs = style(ancestor)
    if (ancestor !== document.documentElement && (cs.overflowX !== 'visible' || cs.overflowY !== 'visible'))
      visibleRect = intersect(visibleRect, toRect(ancestor.getBoundingClientRect()))
    if (cs.clip !== 'auto' || cs.clipPath !== 'none') {
      const box = clipBox(ancestor, cs)
      visibleRect = box ? intersect(visibleRect, box) : null
    }
  }
  const viewport = { width: document.documentElement.clientWidth || innerWidth, height: document.documentElement.clientHeight || innerHeight }
  const onScreen = intersect(visibleRect, { x: 0, y: 0, ...viewport })
  let centerHit: VisibilityFacts['centerHit'] = 'none'
  let coveredBy: string | undefined
  if (onScreen) {
    const hit = document.elementFromPoint(onScreen.x + onScreen.width / 2, onScreen.y + onScreen.height / 2)
    if (hit === element) centerHit = 'self'
    else if (hit && element.contains(hit)) centerHit = 'descendant'
    else if (hit && hit.contains(element)) centerHit = 'ancestor'
    else if (hit) {
      centerHit = 'other'
      coveredBy = describe(hit)
    }
  }
  // Text runs: parents of non-blank text nodes that render.
  const parents = new Set<Element>()
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node && parents.size < maxRuns; node = walker.nextNode())
    if (node.textContent?.trim() && node.parentElement) parents.add(node.parentElement)
  if (!parents.size) parents.add(element)
  const runs = Array.from(parents)
    .filter((node) => node.getClientRects().length > 0 && style(node).visibility === 'visible')
    .map((node) => {
      const cs = style(node)
      const box = node.getBoundingClientRect()
      const offset = node instanceof HTMLElement ? node.offsetWidth : 0
      const scale = offset > 0 && Math.abs(box.width / offset - 1) > 0.05 ? box.width / offset : 1
      const backgrounds: string[] = []
      let backgroundImage = false
      for (const item of chain(node)) {
        const layer = style(item)
        if (layer.backgroundImage && layer.backgroundImage !== 'none') {
          backgroundImage = true
          break
        }
        backgrounds.push(layer.backgroundColor)
        if (isOpaque(layer.backgroundColor)) break
      }
      return {
        fontPx: parseFloat(cs.fontSize) * scale,
        color: cs.color,
        backgrounds,
        backgroundImage,
        opacity: opacityOf(node),
        sample: (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
      }
    })
  return {
    text: (element instanceof HTMLElement ? element.innerText : element.textContent) ?? '',
    displayNone,
    visibility: own.visibility,
    opacity: opacityOf(element),
    rect,
    visibleRect,
    viewport,
    centerHit,
    ...(coveredBy ? { coveredBy } : {}),
    pageRect: { ...rect, x: rect.x + scrollX, y: rect.y + scrollY },
    runs,
  }
}

/** Waits for at least one match within the timeout; returns the match count (0 = absent). */
async function waitForAttached(locator: Locator, timeoutMs: number): Promise<number> {
  try {
    await locator.first().waitFor({ state: 'attached', timeout: timeoutMs })
  } catch {
    return 0
  }
  return locator.count()
}

const blockLocator = (page: Page, step: QaCheckConsentStep): Locator =>
  step.blockSelector ? page.locator(step.blockSelector) : page.getByText(step.blockText ?? '', { exact: false })

/** Pure decision from measured facts (exported for tests). */
export function evaluateConsent(
  step: QaCheckConsentStep,
  facts: ConsentFacts,
  extra: { matchedElements: number; distancePx?: number; nearFound?: boolean },
  sanitize: (text: string) => string = (text) => text,
): QaCheckResult {
  const assertions: QaCheckAssertion[] = []
  const fragments: string[] = []
  const text = normalizeWording(facts.text)
  const evidence: QaConsentEvidence = {
    text: sanitize(text).slice(0, 2000),
    matchedElements: extra.matchedElements,
    contrastMeasurable: true,
    hiddenReasons: [],
  }
  assertions.push({
    name: 'present',
    status: extra.matchedElements > 1 ? 'warning' : 'passed',
    message:
      extra.matchedElements > 1
        ? `${extra.matchedElements} elements matched the consent block; the first was checked.`
        : 'Consent block found.',
  })
  if (step.approvedText !== undefined && step.approvedText.trim()) {
    const verdict = compareWording(step.approvedText, facts.text, step.wordingMatch ?? 'exact')
    if (verdict.matches) assertions.push({ name: 'wording', status: 'passed', message: 'Wording matches the approved text.' })
    else {
      evidence.wordingDiff = verdict.diff!.map((item) => ({ ...item, text: sanitize(item.text) }))
      assertions.push({
        name: 'wording',
        status: 'failed',
        message: `Wording differs from the approved text (${describeWordDiff(verdict.diff!)}): ${sanitize(formatWordDiff(verdict.diff!))}`,
      })
      fragments.push('wording differs')
    }
  }
  const reasons = hiddenReasons(facts)
  evidence.hiddenReasons = reasons
  if (reasons.length) {
    assertions.push({ name: 'visible', status: 'failed', message: `Consent block is not visible: ${reasons.join('; ')}.` })
    fragments.push(`hidden (${reasons[0]!.split(' (')[0]})`)
  } else assertions.push({ name: 'visible', status: 'passed', message: 'Visible in the viewport and not covered.' })
  const runs = facts.runs
  if (!runs.length) {
    // display:none already failed `visible`; there is simply nothing to measure.
    if (!facts.displayNone) {
      assertions.push({ name: 'fontSize', status: 'failed', message: 'No rendered text found in the consent block.' })
      fragments.push('no rendered text')
    }
  } else {
    const smallest = runs.reduce((min, run) => (run.fontPx < min.fontPx ? run : min))
    evidence.minFontPx = Math.round(smallest.fontPx * 100) / 100
    const shown = `${Number(smallest.fontPx.toFixed(2))}px`
    if (smallest.fontPx + 1e-6 < step.minFontPx) {
      assertions.push({
        name: 'fontSize',
        status: 'failed',
        message: `Font size ${shown} is below ${step.minFontPx}px ("${sanitize(smallest.sample)}").`,
      })
      fragments.push(`font ${shown}`)
    } else assertions.push({ name: 'fontSize', status: 'passed', message: `Smallest font ${shown} ≥ ${step.minFontPx}px.` })
    const measured = runs.map((run) => ({ run, result: measureTextContrast(run) }))
    const measurable = measured.flatMap((item) => (item.result.measurable ? [{ run: item.run, ratio: item.result.ratio }] : []))
    const unmeasurable = measured.flatMap((item) => (item.result.measurable ? [] : [item.result.reason]))
    if (measurable.length) {
      const worst = measurable.reduce((min, item) => (item.ratio < min.ratio ? item : min))
      evidence.minContrastRatio = Math.round(worst.ratio * 100) / 100
      if (worst.ratio + 1e-9 < step.minContrastRatio) {
        assertions.push({
          name: 'contrast',
          status: 'failed',
          message: `Contrast ${formatRatio(worst.ratio)} is below ${step.minContrastRatio}:1 ("${sanitize(worst.run.sample)}").`,
        })
        fragments.push(`contrast ${formatRatio(worst.ratio)}`)
      } else
        assertions.push({ name: 'contrast', status: 'passed', message: `Lowest contrast ${formatRatio(worst.ratio)} ≥ ${step.minContrastRatio}:1.` })
    }
    if (unmeasurable.length) {
      evidence.contrastMeasurable = measurable.length > 0
      assertions.push({
        name: 'contrast',
        status: 'warning',
        message: `Contrast not measurable for ${unmeasurable.length} text run${unmeasurable.length === 1 ? '' : 's'}: ${unmeasurable[0]}. Verify it manually.`,
      })
      if (!measurable.length) fragments.push('contrast not measurable')
    }
  }
  if (step.nearSelector) {
    if (!extra.nearFound) {
      assertions.push({ name: 'near', status: 'failed', message: `Reference element ${step.nearSelector} not found.` })
      fragments.push('reference element missing')
    } else {
      evidence.distancePx = Math.round(extra.distancePx ?? 0)
      if ((extra.distancePx ?? 0) > step.maxDistancePx) {
        assertions.push({
          name: 'near',
          status: 'failed',
          message: `Consent block is ${evidence.distancePx}px from ${step.nearSelector} (maximum ${step.maxDistancePx}px).`,
        })
        fragments.push(`${evidence.distancePx}px from ${step.nearSelector}`)
      } else
        assertions.push({ name: 'near', status: 'passed', message: `${evidence.distancePx}px from ${step.nearSelector} ≤ ${step.maxDistancePx}px.` })
    }
  }
  const status = worstStatus(assertions)
  return {
    action: 'checkConsent',
    status,
    headline:
      fragments.length > 0
        ? `consent ${fragments.slice(0, 3).join(', ')}`
        : `consent ok${evidence.minFontPx !== undefined ? ` (font ${evidence.minFontPx}px${evidence.minContrastRatio !== undefined ? `, contrast ${formatRatio(evidence.minContrastRatio)}` : ''})` : ''}`,
    message: checkMessage(assertions, 'Consent disclosure passed all checks.'),
    assertions,
    consent: evidence,
  }
}

export async function runConsentCheck(page: Page, step: QaCheckConsentStep, ctx: CheckContext): Promise<QaCheckResult> {
  const locator = blockLocator(page, step)
  const count = await waitForAttached(locator, ctx.timeoutMs)
  if (count === 0) {
    const what = step.blockSelector ? `selector ${step.blockSelector}` : `text "${ctx.sanitize(step.blockText ?? '')}"`
    const assertions: QaCheckAssertion[] = [{ name: 'present', status: 'failed', message: `Consent block not found (${what}).` }]
    return { action: 'checkConsent', status: 'failed', headline: 'consent missing', message: assertions[0]!.message, assertions }
  }
  const facts = await locator.first().evaluate(collectConsentFacts, MAX_RUNS)
  let nearFound: boolean | undefined
  let distancePx: number | undefined
  if (step.nearSelector) {
    const near = page.locator(step.nearSelector).first()
    nearFound = (await waitForAttached(page.locator(step.nearSelector), Math.min(ctx.timeoutMs, 2000))) > 0
    if (nearFound) {
      const rect = await near.evaluate((element) => {
        const box = element.getBoundingClientRect()
        return { x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height }
      })
      distancePx = rectDistance(facts.pageRect, rect)
    }
  }
  return evaluateConsent(step, facts, { matchedElements: count, nearFound, distancePx }, ctx.sanitize)
}

export interface CheckboxFacts {
  isCheckbox: boolean
  checked: boolean
  defaultChecked?: boolean
  label: string
}
export function evaluateCheckbox(step: QaCheckConsentCheckboxStep, facts: CheckboxFacts | null, sanitize = (text: string) => text): QaCheckResult {
  if (!facts) {
    const message = `Consent checkbox not found (${step.checkboxSelector}).`
    return {
      action: 'checkConsentCheckbox',
      status: 'failed',
      headline: 'consent checkbox missing',
      message,
      assertions: [{ name: 'present', status: 'failed', message }],
    }
  }
  const assertions: QaCheckAssertion[] = []
  const fragments: string[] = []
  if (!facts.isCheckbox) {
    assertions.push({ name: 'checkbox', status: 'failed', message: `${step.checkboxSelector} is not a checkbox (input type=checkbox or role=checkbox).` })
    fragments.push('not a checkbox')
  }
  if (facts.checked) {
    assertions.push({ name: 'notPrechecked', status: 'failed', message: 'The consent checkbox is pre-checked; consent must be an affirmative action.' })
    fragments.push('pre-checked')
  } else
    assertions.push({
      name: 'notPrechecked',
      status: facts.defaultChecked ? 'warning' : 'passed',
      message: facts.defaultChecked
        ? 'Not checked now, but the HTML marks it checked by default (a script unchecked it).'
        : 'Not pre-checked.',
    })
  const label = normalizeWording(facts.label)
  if (!label) {
    assertions.push({ name: 'labelled', status: 'failed', message: 'The consent checkbox has no label (label element, aria-label or aria-labelledby).' })
    fragments.push('unlabeled')
  } else assertions.push({ name: 'labelled', status: 'passed', message: 'Labelled.' })
  return {
    action: 'checkConsentCheckbox',
    status: worstStatus(assertions),
    headline: fragments.length ? `consent checkbox ${fragments.join(', ')}` : 'consent checkbox ok',
    message: checkMessage(assertions, 'Consent checkbox is unchecked and labelled.'),
    assertions,
    checkbox: { checked: facts.checked, label: sanitize(label).slice(0, 300) },
  }
}

export async function runCheckboxCheck(page: Page, step: QaCheckConsentCheckboxStep, ctx: CheckContext): Promise<QaCheckResult> {
  const locator = page.locator(step.checkboxSelector)
  if ((await waitForAttached(locator, ctx.timeoutMs)) === 0) return evaluateCheckbox(step, null)
  const facts = await locator.first().evaluate((element): CheckboxFacts => {
    const text = (node: Element | null): string => (node?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const native = element instanceof HTMLInputElement && element.type === 'checkbox'
    let label = element.getAttribute('aria-label')?.trim() ?? ''
    const labelledBy = element.getAttribute('aria-labelledby')
    if (!label && labelledBy)
      label = labelledBy
        .split(/\s+/)
        .map((id) => text(document.getElementById(id)))
        .join(' ')
        .trim()
    if (!label && native) label = Array.from(element.labels ?? []).map(text).join(' ').trim()
    if (!label) label = element.getAttribute('title')?.trim() ?? ''
    return {
      isCheckbox: native || element.getAttribute('role') === 'checkbox',
      checked: native ? element.checked : element.getAttribute('aria-checked') === 'true',
      ...(native ? { defaultChecked: element.defaultChecked } : {}),
      label,
    }
  })
  return evaluateCheckbox(step, facts, ctx.sanitize)
}

const POLL_MS = 200

export async function runScriptCheck(page: Page, step: QaCheckScriptStep, ctx: CheckContext): Promise<QaCheckResult> {
  const plan = scriptPlan(step)
  const deadline = Date.now() + ctx.timeoutMs
  let facts: ScriptFacts
  let error: string | undefined
  for (;;) {
    try {
      facts = await page.evaluate(
        ({ inputSelector, globalName }): ScriptFacts => {
          const scriptUrls = Array.from(document.scripts)
            .map((script) => script.src)
            .filter(Boolean)
          const loadedUrls = performance
            .getEntriesByType('resource')
            .filter((entry) => (entry as PerformanceResourceTiming).initiatorType === 'script')
            .map((entry) => entry.name)
          const result: ScriptFacts = { scriptUrls, loadedUrls }
          if (globalName) {
            let value: unknown = window
            for (const key of globalName.split('.')) value = value == null ? undefined : (value as Record<string, unknown>)[key]
            result.globalDefined = value !== undefined && value !== null
          }
          if (inputSelector) {
            const input = document.querySelector(inputSelector)
            result.inputFound = input !== null
            if (input) result.inputValue = (input as HTMLInputElement).value ?? input.getAttribute('value') ?? ''
          }
          return result
        },
        { inputSelector: plan.inputSelector, globalName: plan.globalName },
      )
    } catch (err) {
      error = errorLine(err, 'Could not inspect the page.')
      facts = { scriptUrls: [], loadedUrls: [] }
    }
    const verdict = evaluateScriptFacts(step, plan, facts)
    if (verdict.complete || error || Date.now() >= deadline || ctx.signal.aborted) {
      const problems = error ? [`could not inspect the page: ${error}`] : verdict.problems
      const assertions: QaCheckAssertion[] = [
        {
          name: 'loaded',
          status: verdict.loaded ? 'passed' : 'failed',
          message: verdict.loaded ? `${plan.label} script loaded.` : `${plan.label}: ${problems.find((item) => item.includes('script')) ?? problems[0] ?? 'script not loaded'}.`,
        },
        ...(plan.globalName
          ? [{ name: 'global', status: verdict.globalOk ? 'passed' : 'failed', message: verdict.globalOk ? `Global ${plan.globalName} initialized.` : `Global ${plan.globalName} not initialized.` } as const]
          : []),
        ...(plan.inputSelector
          ? [
              {
                name: 'input',
                status: verdict.inputOk ? 'passed' : 'failed',
                message: verdict.inputOk
                  ? `${plan.inputSelector} populated.`
                  : `${problems.find((item) => item.startsWith('input')) ?? `input ${plan.inputSelector} not populated`}.`,
              } as const,
            ]
          : []),
      ]
      const status = worstStatus(assertions)
      const value = facts.inputValue?.trim() ?? ''
      return {
        action: 'checkScriptLoaded',
        status,
        headline:
          status === 'passed'
            ? `${plan.label} ok`
            : !verdict.loaded
              ? `${plan.label} not loaded`
              : !verdict.inputOk
                ? `${plan.label} input ${facts.inputFound ? 'empty' : 'missing'}`
                : `${plan.label} not initialized`,
        message: checkMessage(assertions, `${plan.label} loaded and initialized.`),
        assertions,
        script: {
          preset: step.preset,
          scripts: verdict.matched.slice(0, 5).map((url) => ctx.sanitize(redactUrl(url))),
          loaded: verdict.loaded,
          ...(plan.globalName ? { globalDefined: verdict.globalOk } : {}),
          ...(plan.inputSelector ? { inputPopulated: value.length > 0, inputValueLength: value.length } : {}),
        },
      }
    }
    await pause(Math.min(POLL_MS, Math.max(0, deadline - Date.now())), ctx.signal)
  }
}

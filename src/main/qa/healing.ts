/**
 * Self-healing selectors for QA action steps.
 *
 * Pure helpers decide which fallbacks exist, how they translate to Playwright selectors, how the
 * step timeout is shared and whether a candidate is acceptable. `locateWithHealing` is the thin
 * Playwright adapter used by the executor; `applyHealedSelector` rewrites a saved scenario from a
 * reviewed run. Assertion and navigation steps never heal: a healed assertion can hide a real bug.
 */
import { QA_FALLBACK_KINDS, QaFallbackSchema } from '@shared/qa'
import type { QaFallback, QaHealedSelector, QaHealingMode, QaScenario, QaStep } from '@shared/qa'
import { AppException } from '../contracts'
import type { QaStore } from './store'

export const HEALABLE_ACTIONS = ['click', 'fill', 'select', 'check', 'uncheck', 'upload'] as const
export type HealableStep = Extract<QaStep, { action: (typeof HEALABLE_ACTIONS)[number] }>
/** Share of the step timeout the primary selector gets before fallbacks are considered. */
export const PRIMARY_SHARE = 0.6
export const MAX_FALLBACKS = 4

export function isHealableStep(step: QaStep): step is HealableStep {
  return (HEALABLE_ACTIONS as readonly string[]).includes(step.action)
}

/** Fallbacks the executor may try for this step under the given mode (empty = no healing). */
export function effectiveFallbacks(step: QaStep, mode: QaHealingMode): QaFallback[] {
  if (mode === 'off' || !isHealableStep(step)) return []
  return step.fallbacks ?? []
}

const quote = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/**
 * The Playwright selector string a fallback resolves to. Test IDs and placeholders use plain CSS;
 * role, label and text use Playwright's exact (case-sensitive) engines, as `getByRole`/`getByLabel`/
 * `getByText` with `exact: true` would. This string is also the suggested replacement selector.
 */
export function fallbackSelector(fallback: QaFallback): string {
  switch (fallback.kind) {
    case 'testid':
      return `[${fallback.name ?? 'data-testid'}=${quote(fallback.value)}]`
    case 'role':
      return fallback.name ? `internal:role=${fallback.value}[name=${quote(fallback.name)}s]` : `internal:role=${fallback.value}`
    case 'label':
      return `internal:label=${JSON.stringify(fallback.value)}s`
    case 'placeholder':
      return `[placeholder=${quote(fallback.value)}]`
    case 'text':
      return `internal:text=${JSON.stringify(fallback.value)}s`
    case 'css':
      return fallback.value
  }
}

/**
 * Validates untrusted fallback candidates (from the recorder page), drops invalid ones, duplicates
 * and anything equal to the primary selector, orders them most-stable first and keeps at most four.
 */
export function normalizeFallbacks(primary: string, candidates: unknown): QaFallback[] {
  if (!Array.isArray(candidates)) return []
  const seen = new Set([primary.trim()])
  const valid: QaFallback[] = []
  for (const candidate of candidates.slice(0, 20)) {
    const parsed = QaFallbackSchema.safeParse(candidate)
    if (!parsed.success) continue
    const selector = fallbackSelector(parsed.data)
    if (seen.has(selector)) continue
    seen.add(selector)
    valid.push(parsed.data)
  }
  const rank = (fallback: QaFallback): number => QA_FALLBACK_KINDS.indexOf(fallback.kind)
  // Array.prototype.sort is stable, so equal kinds keep the recorder's order.
  return valid.sort((a, b) => rank(a) - rank(b)).slice(0, MAX_FALLBACKS)
}

/** Splits one step timeout between the primary selector and the fallbacks; the parts never exceed the total. */
export function splitBudget(totalMs: number): { primaryMs: number; fallbackMs: number } {
  const total = Math.max(1, Math.floor(totalMs))
  const primaryMs = Math.max(1, Math.floor(total * PRIMARY_SHARE))
  return { primaryMs, fallbackMs: Math.max(0, total - primaryMs) }
}

/** The leading role of a Playwright ARIA snapshot such as `- button "Submit"`. */
export function roleFromAriaSnapshot(snapshot: string): string | null {
  return /^\s*-\s+([a-z]+)\b/.exec(snapshot)?.[1] ?? null
}

/** A fallback is accepted only when it matches exactly one element (and, for roles, that role). */
export function acceptFallback(fallback: QaFallback, probe: { count: number; role?: string | null }): boolean {
  if (probe.count !== 1) return false
  return fallback.kind !== 'role' || probe.role === fallback.value
}

export function describeFallback(fallback: QaFallback): string {
  switch (fallback.kind) {
    case 'role':
      return fallback.name ? `role "${fallback.value}" named "${fallback.name}"` : `role "${fallback.value}"`
    case 'testid':
      return `${fallback.name ?? 'data-testid'} "${fallback.value}"`
    case 'css':
      return `CSS "${fallback.value}"`
    default:
      return `${fallback.kind} "${fallback.value}"`
  }
}

/** Whether a healed step passes (warn) or fails (fail). Off never produces a healed step. */
export function healingVerdict(mode: QaHealingMode): 'passed' | 'failed' {
  return mode === 'fail' ? 'failed' : 'passed'
}

export function healingFailureMessage(healed: QaHealedSelector): string {
  return `Selector ${healed.originalSelector} matched no elements; ${describeFallback(healed.usedFallback)} matched one. Self-healing is set to fail: update the selector to ${healed.suggestedSelector}.`
}

export function healingMissMessage(budgetMs: number): string {
  return `No element matched the selector within ${budgetMs} ms, and no fallback matched exactly one element.`
}

const isTimeoutError = (err: unknown): boolean => err instanceof Error && err.name === 'TimeoutError'

/** The subset of Playwright's Locator the adapter needs; tests supply fakes. */
export interface HealingLocator {
  waitFor(options: { state: 'attached'; timeout: number }): Promise<void>
  count(): Promise<number>
  ariaSnapshot(options: { timeout: number }): Promise<string>
}
export interface HealingOptions {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
}

/**
 * Finds the element for an action step within one shared timeout budget.
 *
 * Without fallbacks (healing off, assertion steps, legacy steps) this is exactly `page.locator(selector)`
 * with the full budget. Otherwise the primary selector gets `PRIMARY_SHARE` of the budget to attach. Only
 * when it matched zero elements are fallbacks polled, in order, for the rest of the budget; the primary is
 * re-checked first on every poll so a late element still wins. A primary that is found but not
 * actionable is never healed: the returned locator fails the action as it would without healing.
 */
export async function locateWithHealing<L extends HealingLocator>(
  page: { locator(selector: string): L },
  step: QaStep & { selector: string },
  mode: QaHealingMode,
  budgetMs: number,
  options: HealingOptions = {},
): Promise<{ locator: L; remainingMs: number; healed?: QaHealedSelector }> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const pollMs = options.pollMs ?? 100
  const deadline = now() + budgetMs
  const remaining = (): number => Math.max(0, deadline - now())
  // Playwright treats timeout 0 as "no timeout", so an exhausted budget must stay positive.
  const left = (): number => Math.max(1, remaining())
  const primary = page.locator(step.selector)
  const fallbacks = effectiveFallbacks(step, mode)
  if (!fallbacks.length) return { locator: primary, remainingMs: budgetMs }
  try {
    await primary.waitFor({ state: 'attached', timeout: splitBudget(budgetMs).primaryMs })
    return { locator: primary, remainingMs: left() }
  } catch (err) {
    if (!isTimeoutError(err)) throw err
  }
  for (;;) {
    if ((await primary.count()) > 0) return { locator: primary, remainingMs: left() }
    for (const [index, fallback] of fallbacks.entries()) {
      const selector = fallbackSelector(fallback)
      const candidate = page.locator(selector)
      // A malformed fallback selector is skipped rather than failing the step.
      const count = await candidate.count().catch(() => 0)
      if (count !== 1) continue
      const role =
        fallback.kind === 'role'
          ? roleFromAriaSnapshot(await candidate.ariaSnapshot({ timeout: Math.min(left(), 1000) }).catch(() => ''))
          : undefined
      if (!acceptFallback(fallback, { count, role })) continue
      return {
        locator: candidate,
        remainingMs: left(),
        healed: { originalSelector: step.selector, usedFallback: fallback, fallbackIndex: index, suggestedSelector: selector },
      }
    }
    const wait = Math.min(pollMs, remaining())
    if (wait <= 0) break
    await sleep(wait)
  }
  throw new Error(healingMissMessage(budgetMs))
}

/**
 * The step after promoting one fallback to the primary selector. The previous primary becomes the
 * first CSS fallback (after the non-CSS fallbacks, which stay more stable), and the list stays ≤ 4.
 */
export function promoteFallback(step: HealableStep, fallbackIndex: number): HealableStep {
  const used = step.fallbacks?.[fallbackIndex]
  if (!used) throw new AppException('NOT_FOUND', 'That fallback no longer exists in the scenario.')
  const rest = step.fallbacks!.filter((_, index) => index !== fallbackIndex)
  const selector = fallbackSelector(used)
  const previous: QaFallback = { kind: 'css', value: step.selector }
  const others = rest.filter((fallback) => fallbackSelector(fallback) !== step.selector && fallbackSelector(fallback) !== selector)
  return {
    ...step,
    selector,
    fallbacks: [
      ...others.filter((fallback) => fallback.kind !== 'css'),
      previous,
      ...others.filter((fallback) => fallback.kind === 'css'),
    ].slice(0, MAX_FALLBACKS),
  }
}

/**
 * Applies a reviewed heal from a finished run to its saved scenario. Callers pass identifiers only;
 * the new selector is derived from the scenario's own fallback, never from caller-supplied text.
 */
export function applyHealedSelector(store: QaStore, batchId: string, caseId: string, stepIndex: number): QaScenario {
  const batch = store.batch(batchId)
  if (!batch.endedAt) throw new AppException('INVALID_INPUT', 'Wait for the run to finish before updating selectors.')
  const item = batch.cases.find((entry) => entry.id === caseId)
  const healed = item?.steps.find((entry) => entry.index === stepIndex)?.healed
  if (!item || !healed) throw new AppException('NOT_FOUND', 'This step did not heal, so there is no selector to update.')
  const scenario = store.scenario(item.scenarioId ?? batch.scenarioId)
  const step = scenario.steps[stepIndex]
  if (!step || !isHealableStep(step))
    throw new AppException('INVALID_INPUT', 'Only click, fill, select, check, uncheck and upload steps can be updated.')
  const fallback = step.fallbacks?.[healed.fallbackIndex]
  const changed =
    !fallback ||
    fallback.kind !== healed.usedFallback.kind ||
    item.steps.find((entry) => entry.index === stepIndex)?.action !== step.action ||
    (!fallback.value.includes('{{') && fallbackSelector(fallback) !== healed.suggestedSelector)
  if (changed)
    throw new AppException('INVALID_INPUT', 'The scenario changed since this run. Run it again before updating this selector.')
  const { id, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = scenario
  const saved = store.saveScenario(
    { ...input, steps: scenario.steps.map((entry, index) => (index === stepIndex ? promoteFallback(step, healed.fallbackIndex) : entry)) },
    id,
  )
  store.recordAudit(saved.workspaceId, 'scenario.selector-healed', id)
  return saved
}

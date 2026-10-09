/// <reference lib="dom" />
/**
 * Accessibility check: runs axe-core (MPL-2.0, Deque Systems; npm dependency `axe-core`) inside the
 * page under test and maps its violations to step evidence. The axe source is read from the installed
 * package and evaluated in the main frame only; frames are not scanned.
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { Page } from 'playwright-core'
import { QA_AXE_IMPACTS } from '@shared/qa-checks'
import type { QaAxeImpact, QaAxeViolation, QaCheckAccessibilityStep, QaCheckAssertion, QaCheckResult } from '@shared/qa-checks'
import { checkMessage, errorLine, worstStatus } from './result'
import type { CheckContext } from './result'

let axeSource: Promise<string> | undefined
/** The axe-core browser bundle, read once per process. */
export function loadAxeSource(): Promise<string> {
  axeSource ??= readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8').catch((err: unknown) => {
    axeSource = undefined
    throw err
  })
  return axeSource
}

export function impactRank(impact: QaAxeImpact | null | undefined): number {
  return impact ? QA_AXE_IMPACTS.indexOf(impact) : -1
}

export interface AxeRunSummary {
  version: string
  passes: number
  incomplete: number
  violations: QaAxeViolation[]
}

/** Pure mapping from an axe summary to the step outcome (exported for tests). */
export function evaluateAxe(step: QaCheckAccessibilityStep, run: AxeRunSummary): QaCheckResult {
  const threshold = impactRank(step.failOn)
  const blocking = run.violations.filter((violation) => impactRank(violation.impact) >= threshold)
  const minor = run.violations.filter((violation) => impactRank(violation.impact) < threshold)
  const list = (items: QaAxeViolation[]): string =>
    items
      .slice(0, 5)
      .map((item) => `${item.id} (${item.impact ?? 'unknown'}, ${item.nodeCount} node${item.nodeCount === 1 ? '' : 's'})`)
      .join(', ')
  const assertions: QaCheckAssertion[] = [
    blocking.length
      ? { name: 'violations', status: 'failed', message: `${blocking.length} axe violation${blocking.length === 1 ? '' : 's'} at ${step.failOn} or above: ${list(blocking)}.` }
      : { name: 'violations', status: 'passed', message: `No axe violations at ${step.failOn} or above.` },
    ...(minor.length
      ? [{ name: 'minorViolations', status: 'warning', message: `${minor.length} violation${minor.length === 1 ? '' : 's'} below ${step.failOn}: ${list(minor)}.` } as const]
      : []),
  ]
  const status = worstStatus(assertions)
  return {
    action: 'checkAccessibility',
    status,
    headline: blocking.length
      ? `a11y ${blocking.length} ${step.failOn}+ violation${blocking.length === 1 ? '' : 's'} (${blocking[0]!.id})`
      : minor.length
        ? `a11y ${minor.length} violation${minor.length === 1 ? '' : 's'} below ${step.failOn}`
        : 'a11y no violations',
    message: checkMessage(assertions, 'No accessibility violations.'),
    assertions,
    accessibility: {
      tags: step.tags,
      failOn: step.failOn,
      axeVersion: run.version,
      violations: run.violations,
      passes: run.passes,
      incomplete: run.incomplete,
    },
  }
}

interface AxeGlobal {
  version: string
  run: (
    context: unknown,
    options: unknown,
  ) => Promise<{
    passes: unknown[]
    incomplete: unknown[]
    violations: Array<{
      id: string
      impact?: string | null
      help: string
      helpUrl: string
      nodes: Array<{ target: Array<string | string[]> }>
    }>
  }>
}

export async function runAccessibilityCheck(page: Page, step: QaCheckAccessibilityStep, ctx: CheckContext): Promise<QaCheckResult> {
  const fail = (message: string): QaCheckResult => ({
    action: 'checkAccessibility',
    status: 'failed',
    headline: 'a11y scan failed',
    message,
    assertions: [{ name: 'scan', status: 'failed', message }],
  })
  let run: AxeRunSummary | { error: string }
  try {
    const source = await loadAxeSource()
    // Evaluated as an expression in the page's main world (not a <script> tag, so the page CSP does not block it).
    await page.evaluate(`${source}\n;void 0`)
    run = await page.evaluate(
      async ({ tags, scope, maxNodes, timeoutMs }) => {
        const axe = (window as unknown as { axe?: AxeGlobal }).axe
        if (!axe?.run) return { error: 'axe-core did not initialize on this page.' }
        if (scope && !document.querySelector(scope)) return { error: `Scope ${scope} matched no element.` }
        const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('axe-core timed out.')), timeoutMs))
        const results = await Promise.race([
          axe.run(scope ? { include: [scope] } : document, {
            runOnly: { type: 'tag', values: tags },
            resultTypes: ['violations'],
            iframes: false,
            elementRef: false,
          }),
          timer,
        ])
        return {
          version: axe.version,
          passes: results.passes.length,
          incomplete: results.incomplete.length,
          violations: results.violations.slice(0, 100).map((violation) => ({
            id: violation.id,
            impact: (['minor', 'moderate', 'serious', 'critical'].includes(violation.impact ?? '') ? violation.impact : null) as QaAxeImpact | null,
            help: violation.help,
            helpUrl: violation.helpUrl,
            nodeCount: violation.nodes.length,
            targets: violation.nodes
              .slice(0, maxNodes)
              .map((node) => node.target.map((part) => (Array.isArray(part) ? part.join(' >>> ') : part)).join(' ')),
          })),
        }
      },
      { tags: step.tags, scope: step.scopeSelector, maxNodes: step.maxNodes, timeoutMs: ctx.timeoutMs },
    )
  } catch (err) {
    return fail(`Accessibility scan failed: ${ctx.sanitize(errorLine(err, 'axe-core could not run.'))}`)
  }
  if ('error' in run) return fail(ctx.sanitize(run.error))
  return evaluateAxe(step, {
    ...run,
    violations: run.violations.map((violation) => ({
      ...violation,
      help: ctx.sanitize(violation.help).slice(0, 500),
      targets: violation.targets.map((target) => ctx.sanitize(target).slice(0, 300)),
    })),
  })
}

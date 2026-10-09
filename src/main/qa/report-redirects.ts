/**
 * Redirect evidence lines for HTML and JUnit reports. URLs are already redacted by the executor;
 * callers still escape every line for their markup.
 */
import type { QaCase, QaRedirectHop } from '@shared/qa'

export function redirectHopText(hop: QaRedirectHop): string {
  return `${hop.status} ${hop.from} → ${hop.to}${hop.blocked ? ' (blocked)' : ''}`
}

/**
 * One line per hop in run order: "start: 302 https://a/start → https://a/form" for the start navigation,
 * "step 2 (click): 303 https://a/submit → https://a/thanks" for hops seen while a step ran.
 */
export function redirectLines(item: Pick<QaCase, 'redirects' | 'steps'>): Array<{ text: string; blocked: boolean }> {
  const all = item.redirects ?? []
  const stepHops = item.steps.reduce((count, step) => count + (step.redirects?.length ?? 0), 0)
  // The case list starts with the start navigation's hops, followed by the steps' hops.
  const start = all.slice(0, Math.max(0, all.length - stepHops))
  return [
    ...start.map((hop) => ({ text: `start: ${redirectHopText(hop)}`, blocked: !!hop.blocked })),
    ...item.steps.flatMap((step) =>
      (step.redirects ?? []).map((hop) => ({
        text: `step ${step.index + 1} (${step.action}): ${redirectHopText(hop)}`,
        blocked: !!hop.blocked,
      })),
    ),
  ]
}

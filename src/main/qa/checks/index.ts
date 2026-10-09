/**
 * Entry points the executor calls for check steps (src/shared/qa-checks.ts). Checks are assertions:
 * they never heal, never act on the page beyond scrolling the checked element into view, and only
 * read what the operator's own page rendered or loaded.
 */
import type { BrowserContext, Page } from 'playwright-core'
import type { QaCheckResult, QaCheckStep, QaNetworkProfile } from '@shared/qa-checks'
import { runCheckboxCheck, runConsentCheck, runScriptCheck } from './compliance'
import { runAccessibilityCheck } from './a11y'
import { PERFORMANCE_STORE_KEY, applyNetworkProfile, installPerformanceObservers, runPerformanceCheck } from './performance'
import type { CheckContext } from './result'

export interface CheckSetup {
  networkProfile?: QaNetworkProfile
  throttling?: string
  /** Case notes, e.g. that throttling is not supported on this engine. */
  notes: string[]
}

/**
 * Before the first navigation of a case: installs the performance observers when the scenario has a
 * checkPerformance step, and applies its network profile (Chromium only).
 */
export async function prepareChecks(
  context: BrowserContext,
  page: Page,
  scenario: { steps: ReadonlyArray<{ action: string }>; networkProfile?: QaNetworkProfile },
): Promise<CheckSetup> {
  const setup: CheckSetup = { notes: [] }
  if (scenario.steps.some((step) => step.action === 'checkPerformance'))
    await page.addInitScript(installPerformanceObservers, PERFORMANCE_STORE_KEY)
  if (scenario.networkProfile) {
    setup.networkProfile = scenario.networkProfile
    setup.throttling = await applyNetworkProfile(context, page, scenario.networkProfile)
    setup.notes.push(
      setup.throttling === 'applied'
        ? `network throttling ${scenario.networkProfile} applied (Chromium DevTools emulation; documents fetched by the origin guard are not throttled)`
        : `network throttling ${scenario.networkProfile} ${setup.throttling}; the case ran unthrottled`,
    )
  }
  return setup
}

export async function runCheckStep(
  page: Page,
  step: QaCheckStep,
  ctx: Omit<CheckContext, 'networkProfile' | 'throttling'> & { setup?: CheckSetup },
): Promise<QaCheckResult> {
  const context: CheckContext = {
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
    sanitize: ctx.sanitize,
    ...(ctx.setup?.networkProfile ? { networkProfile: ctx.setup.networkProfile } : {}),
    ...(ctx.setup?.throttling ? { throttling: ctx.setup.throttling } : {}),
  }
  switch (step.action) {
    case 'checkConsent':
      return runConsentCheck(page, step, context)
    case 'checkConsentCheckbox':
      return runCheckboxCheck(page, step, context)
    case 'checkScriptLoaded':
      return runScriptCheck(page, step, context)
    case 'checkAccessibility':
      return runAccessibilityCheck(page, step, context)
    case 'checkPerformance':
      return runPerformanceCheck(page, step, context)
  }
}

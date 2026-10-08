import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserContext, ConsoleMessage, Locator, Request, Response } from 'playwright-core'
import type { QaExecution, QaStepResult, ScenarioInput } from '@shared/qa'
import type { VisualStore } from './visual'
import { visualKey } from './visual'
import { healingFailureMessage, healingVerdict, locateWithHealing } from './healing'
import type { HealableStep } from './healing'
import { navigationGuard } from './navigation'
import { DEFAULT_MASK_SELECTORS, redactEvidence, redactUrl } from '../security/data-privacy'
import { compileSecrets, redactString } from '../logging/redact'

export async function executeScenario(
  context: BrowserContext,
  scenario: ScenarioInput,
  artifactDir: string,
  signal: AbortSignal,
  externalSanitize = redactEvidence,
  visual?: { store: VisualStore; fingerprint: unknown[] },
): Promise<QaExecution> {
  const testValues = compileSecrets(scenario.steps.filter((step) => step.action === 'fill').map((step) => step.value))
  const sanitize = (text: string): string => redactString(externalSanitize(text), testValues)
  const started = Date.now()
  // Scenarios saved before self-healing existed have no mode; the schema default is 'warn'.
  const healing = scenario.healing ?? 'warn'
  const result: QaExecution = {
    status: 'passed',
    steps: [],
    errors: [],
    failedRequests: [],
    finalUrl: '',
    durationMs: 0,
  }
  await mkdir(artifactDir, { recursive: true, mode: 0o700 })
  const page = await context.newPage()
  page.setDefaultTimeout(scenario.timeoutMs)
  page.setDefaultNavigationTimeout(scenario.timeoutMs)
  let lastStatus: number | null = null
  let tracing = false
  const onResponse = (response: Response): void => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame())
      lastStatus = response.status()
    if (response.status() >= 400 && result.failedRequests.length < 100)
      result.failedRequests.push(`HTTP ${response.status()} ${redactUrl(response.url())}`)
  }
  const onConsole = (message: ConsoleMessage): void => {
    if (message.type() === 'error' && result.errors.length < 100)
      result.errors.push(sanitize(message.text()).slice(0, 2000))
  }
  const onPageError = (error: Error): void => {
    if (result.errors.length < 100) result.errors.push(sanitize(error.message).slice(0, 2000))
  }
  const onFailed = (request: Request): void => {
    if (result.failedRequests.length < 100)
      result.failedRequests.push(`${request.method()} ${redactUrl(request.url())}`)
  }
  const guard = navigationGuard(scenario.allowedOrigins, scenario.timeoutMs, (message) => { result.status = 'failed'; result.errors.push(message) })
  const abort = (): void => {
    void context.close().catch(() => undefined)
  }
  const assertOrigin = (): void => {
    if (!scenario.allowedOrigins.includes(new URL(page.url()).origin))
      throw new Error('Navigation left the approved origins.')
  }
  const screenshot = async (index: number): Promise<string | undefined> => {
    if (page.isClosed()) return undefined
    try {
      const file = join(artifactDir, `step-${index + 1}.png`)
      await page.screenshot({
        path: file,
        timeout: Math.min(scenario.timeoutMs, 5000),
        mask: [...DEFAULT_MASK_SELECTORS, ...scenario.maskSelectors].map((selector) => page.locator(selector)),
        animations: 'disabled',
      })
      return file
    } catch {
      return undefined
    }
  }
  // Action steps may heal; assertions and navigation always use their selector/value as written.
  const target = async (step: HealableStep, entry: QaStepResult): Promise<{ locator: Locator; timeout: number }> => {
    const found = await locateWithHealing(page, step, healing, scenario.timeoutMs)
    if (found.healed) {
      const { usedFallback } = found.healed
      entry.healed = {
        originalSelector: sanitize(found.healed.originalSelector),
        usedFallback: {
          ...usedFallback,
          value: sanitize(usedFallback.value),
          ...(usedFallback.name ? { name: sanitize(usedFallback.name) } : {}),
        },
        fallbackIndex: found.healed.fallbackIndex,
        suggestedSelector: sanitize(found.healed.suggestedSelector),
      }
      if (healingVerdict(healing) === 'failed') {
        entry.healed.blocked = true
        throw new Error(healingFailureMessage(entry.healed))
      }
    }
    return { locator: found.locator, timeout: found.remainingMs }
  }
  page.on('response', onResponse)
  page.on('console', onConsole)
  page.on('pageerror', onPageError)
  page.on('requestfailed', onFailed)
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    await context.route('**/*', guard)
    if (scenario.captureTrace) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false })
      tracing = true
    }
    await page.goto(scenario.startUrl, { waitUntil: 'domcontentloaded' })
    assertOrigin()
    for (const [index, step] of scenario.steps.entries()) {
      signal.throwIfAborted()
      const began = Date.now()
      const entry: QaStepResult = { index, action: step.action, status: 'passed', durationMs: 0 }
      try {
        assertOrigin()
        switch (step.action) {
          case 'goto':
            await page.goto(step.value, { waitUntil: 'domcontentloaded' })
            break
          case 'fill': {
            const { locator, timeout } = await target(step, entry)
            await locator.fill(step.value, { timeout })
            break
          }
          case 'click': {
            const { locator, timeout } = await target(step, entry)
            await locator.click({ timeout })
            break
          }
          case 'select': {
            const { locator, timeout } = await target(step, entry)
            await locator.selectOption(step.value, { timeout })
            break
          }
          case 'check': {
            const { locator, timeout } = await target(step, entry)
            await locator.check({ timeout })
            break
          }
          case 'uncheck': {
            const { locator, timeout } = await target(step, entry)
            await locator.uncheck({ timeout })
            break
          }
          case 'assertScreenshot': {
            if (!visual) throw new Error('Visual comparisons are unavailable for this runner.')
            await page.waitForFunction(() => document.fonts.status === 'loaded', undefined, { timeout: scenario.timeoutMs })
            const actual = await screenshot(index)
            if (!actual) throw new Error('Could not capture the masked comparison screenshot.')
            entry.screenshot = actual
            const key = visualKey([scenario.visualKey, step.name, scenario.maskSelectors, ...visual.fingerprint])
            entry.visual = await visual.store.compare(key, step.name, actual, step.maxDiffRatio)
            if (entry.visual.status === 'missing') throw new Error('No approved visual baseline. Review this screenshot and approve it in Results.')
            if (entry.visual.status === 'changed') throw new Error(`Visual difference ${((entry.visual.diffRatio ?? 1) * 100).toFixed(2)}% exceeds ${(step.maxDiffRatio * 100).toFixed(2)}%.`)
            break
          }
          case 'assertVisible':
            await page.locator(step.selector).waitFor({ state: 'visible' })
            break
          case 'assertText':
            await page.waitForFunction(
              ({ selector, text }) => document.querySelector(selector)?.textContent?.includes(text) === true,
              { selector: step.selector, text: step.value },
              { timeout: scenario.timeoutMs },
            )
            break
          case 'assertUrl':
            await page.waitForURL((url) => url.href.includes(step.value), { timeout: scenario.timeoutMs })
            break
          case 'assertStatus':
            if (lastStatus !== step.value)
              throw new Error(`Expected HTTP ${step.value}; received ${lastStatus ?? 'no navigation response'}.`)
            break
        }
        assertOrigin()
      } catch (err) {
        entry.status = 'failed'
        // Playwright call logs can echo filled test data. Keep an action-specific summary.
        entry.error = signal.aborted
          ? 'Cancelled.'
          : `${step.action} failed: ${sanitize(err instanceof Error ? (err.message.split('\n')[0] ?? 'Action failed.') : 'Action failed.').slice(0, 500)}`
        if ('value' in step && typeof step.value === 'string' && step.value)
          entry.error = entry.error.split(step.value).join('[REDACTED]')
        result.status = signal.aborted ? 'cancelled' : 'failed'
      }
      entry.durationMs = Date.now() - began
      entry.screenshot ??= await screenshot(index)
      result.steps.push(entry)
      if (entry.status === 'failed') break
    }
  } catch (err) {
    result.status = signal.aborted ? 'cancelled' : 'failed'
    result.errors.push(
      sanitize(err instanceof Error ? (err.message.split('\n')[0] ?? 'Execution failed.') : 'Execution failed.').slice(
        0,
        500,
      ),
    )
  } finally {
    result.finalUrl = redactUrl(page.url())
    if (tracing) {
      try {
        const trace = join(artifactDir, 'trace.zip')
        await context.tracing.stop({ path: trace })
        result.trace = trace
      } catch {
        result.errors.push('Trace could not be saved.')
      }
    }
    signal.removeEventListener('abort', abort)
    page.off('response', onResponse)
    page.off('console', onConsole)
    page.off('pageerror', onPageError)
    page.off('requestfailed', onFailed)
    await context.unroute('**/*', guard).catch(() => undefined)
    result.durationMs = Date.now() - started
  }
  return result
}

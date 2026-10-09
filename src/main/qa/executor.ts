import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserContext, ConsoleMessage, Frame, Locator, Page, Request, Response } from 'playwright-core'
import type { QaExecution, QaRedirectHop, QaStepResult, ScenarioInput } from '@shared/qa'
import type { VisualStore } from './visual'
import { visualKey } from './visual'
import { healingFailureMessage, healingVerdict, isHealableStep, locateWithHealing } from './healing'
import type { HealableStep } from './healing'
import { navigationGuard } from './navigation'
import type { NavigationRedirectEvent } from './navigation'
import { pageRefIndex } from '@shared/qa-targets'
import { createFixtureFiles } from './fixtures'
import { restoreMultipartFiles } from './upload-body'
import { resolveFrame } from './frames'
import { createPopupRegistry } from './pages'
import { NAVIGATION_GRACE_MS, trackPage } from './page-tracker'
import type { PageTracker } from './page-tracker'
import { DEFAULT_MASK_SELECTORS, redactEvidence, redactUrl } from '../security/data-privacy'
import { compileSecrets, redactString } from '../logging/redact'
// Checks: compliance, accessibility and performance assertions (./checks, @shared/qa-checks).
import { prepareChecks, runCheckStep } from './checks'
import { continuesAfterFailure } from '@shared/qa-checks'

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
  const main = await context.newPage()
  // The page steps run on: the main page, or a pop-up a switchPage step selected.
  let page = main
  let tracing = false
  // Redirect evidence: every hop of the case, and the hops seen while the current step ran.
  const redirects: QaRedirectHop[] = []
  let stepRedirects: QaRedirectHop[] | null = null
  // Per page: document status and waiting for main-frame navigations/redirect chains (page-tracker.ts).
  const trackers = new Map<Page, PageTracker>()
  const popups = createPopupRegistry<Page>()
  const fixtures = createFixtureFiles(join(artifactDir, 'fixtures'), scenario.fixtures ?? [])
  // Classic multipart form posts: refill file parts the engine left empty with the fixture's bytes (upload-body.ts).
  const uploadBytes = new Map((scenario.fixtures ?? []).map((item) => [item.name, Buffer.from(item.data, 'base64')]))
  const restoreUploads = (request: Request): Buffer | null => {
    try {
      return restoreMultipartFiles(request.headers()['content-type'], request.postDataBuffer(), uploadBytes)
    } catch {
      return null
    }
  }
  const tracker = (target: Page): PageTracker => trackers.get(target) ?? watch(target)
  const settleRedirects = (options?: { graceMs?: number }): Promise<void> =>
    tracker(page).settle(scenario.timeoutMs, signal, options)
  const onRedirect = (event: NavigationRedirectEvent): void => {
    const hop: QaRedirectHop = {
      status: event.status,
      from: sanitize(redactUrl(event.from)),
      to: event.to ? sanitize(redactUrl(event.to)) : '(invalid location)',
      ...(event.followed ? {} : { blocked: true }),
    }
    if (redirects.length < 50) redirects.push(hop)
    if (stepRedirects && stepRedirects.length < 50) stepRedirects.push(hop)
    let owner: Page | null
    try {
      owner = event.request.frame().page()
    } catch {
      owner = null
    }
    if (owner) trackers.get(owner)?.redirect(event)
  }
  const onResponse = (response: Response): void => {
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
  /** Evidence listeners and navigation tracking for the main page and every pop-up of the context. */
  function watch(target: Page): PageTracker {
    const created = trackPage(target)
    trackers.set(target, created)
    target.setDefaultTimeout(scenario.timeoutMs)
    target.setDefaultNavigationTimeout(scenario.timeoutMs)
    target.on('response', onResponse)
    target.on('console', onConsole)
    target.on('pageerror', onPageError)
    target.on('requestfailed', onFailed)
    return created
  }
  const unwatch = (target: Page): void => {
    trackers.get(target)?.dispose()
    target.off('response', onResponse)
    target.off('console', onConsole)
    target.off('pageerror', onPageError)
    target.off('requestfailed', onFailed)
  }
  // Pop-ups are routed by the same context-level navigation guard as the main page.
  const onNewPage = (opened: Page): void => {
    watch(opened)
    popups.add(opened)
  }
  /** The page a switchPage step selects, once it has loaded its first document. */
  const switchTo = async (ref: string): Promise<Page> => {
    const index = pageRefIndex(ref)
    if (index === 0) return main
    const began = Date.now()
    const popup = await popups.get(index, scenario.timeoutMs, signal)
    if (popup.isClosed()) throw new Error(`Pop-up ${index} is already closed.`)
    await popup.waitForLoadState('domcontentloaded', { timeout: Math.max(1, scenario.timeoutMs - (Date.now() - began)) })
    return popup
  }
  const guard = navigationGuard(
    scenario.allowedOrigins,
    scenario.timeoutMs,
    (message) => {
      result.status = 'failed'
      result.errors.push(message)
    },
    { followRedirects: scenario.followRedirects ?? true, onRedirect, ...(uploadBytes.size ? { requestBody: restoreUploads } : {}) },
  )
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
  // Inside a frame, the frame path is resolved (and its origins checked) first, within the same budget.
  const target = async (step: HealableStep, entry: QaStepResult): Promise<{ locator: Locator; timeout: number }> => {
    let root: Page | Frame = page
    let budget = scenario.timeoutMs
    if (step.frame?.length) {
      const resolved = await resolveFrame(page, step.frame, scenario.allowedOrigins, budget)
      root = resolved.frame
      budget = resolved.remainingMs
    }
    const found = await locateWithHealing<Locator>(root, step, healing, budget)
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
  watch(main)
  context.on('page', onNewPage)
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    await context.route('**/*', guard)
    if (scenario.captureTrace) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false })
      tracing = true
    }
    // Checks: performance observers and network throttling must be in place before the first navigation.
    const checkSetup = await prepareChecks(context, page, scenario)
    if (checkSetup.notes.length) result.notes = [...(result.notes ?? []), ...checkSetup.notes]
    await page.goto(scenario.startUrl, { waitUntil: 'domcontentloaded' })
    await settleRedirects()
    assertOrigin()
    for (const [index, step] of scenario.steps.entries()) {
      signal.throwIfAborted()
      const began = Date.now()
      const entry: QaStepResult = { index, action: step.action, status: 'passed', durationMs: 0 }
      const hops: QaRedirectHop[] = []
      stepRedirects = hops
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
          case 'upload': {
            const { locator, timeout } = await target(step, entry)
            await locator.setInputFiles(await fixtures.paths(step.fixtures), { timeout })
            break
          }
          case 'switchPage':
            page = await switchTo(step.page)
            break
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
          case 'assertStatus': {
            // The status of the final document: a navigation the previous action started or scheduled, and
            // any redirect chain still in progress, are awaited first.
            await settleRedirects({ graceMs: NAVIGATION_GRACE_MS })
            const lastStatus = tracker(page).lastStatus()
            if (lastStatus !== step.value)
              throw new Error(`Expected HTTP ${step.value}; received ${lastStatus ?? 'no navigation response'}.`)
            break
          }
          default:
            // Checks (./checks): assertions with evidence; never healed.
            entry.check = await runCheckStep(page, step, { timeoutMs: scenario.timeoutMs, signal, sanitize, setup: checkSetup })
            if (entry.check.status === 'failed') throw new Error(entry.check.message)
            break
        }
        await settleRedirects()
        if (isHealableStep(step)) tracker(page).markAction()
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
      // Hops that start while the step's screenshot is taken (e.g. a click that navigates from a timer) are its own.
      stepRedirects = null
      if (hops.length > 0) entry.redirects = hops
      result.steps.push(entry)
      if (entry.status === 'failed' && (signal.aborted || !continuesAfterFailure(step))) break
    }
  } catch (err) {
    result.status = signal.aborted ? 'cancelled' : 'failed'
    const message = sanitize(err instanceof Error ? (err.message.split('\n')[0] ?? 'Execution failed.') : 'Execution failed.').slice(0, 500)
    // A blocked redirect of the start navigation has already been reported by the guard.
    if (!result.errors.includes(message)) result.errors.push(message)
  } finally {
    result.finalUrl = redactUrl(page.url())
    if (redirects.length > 0) result.redirects = redirects
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
    context.off('page', onNewPage)
    for (const watched of trackers.keys()) unwatch(watched)
    await fixtures.remove().catch(() => undefined)
    await context.unroute('**/*', guard).catch(() => undefined)
    result.durationMs = Date.now() - started
  }
  return result
}

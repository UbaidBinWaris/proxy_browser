/// <reference lib="dom" />
/**
 * Performance check: Core Web Vitals and Navigation Timing of the current document, with budgets.
 *
 * `installPerformanceObservers` runs as an init script (added before the first navigation when the
 * scenario has a checkPerformance step) so buffered LCP, layout-shift, event and long-task entries are
 * collected from the start of every document. Metrics a browser does not expose are reported as
 * unavailable, never as zero: CLS and TBT need Chromium, INP needs at least one interaction.
 *
 * Network throttling (scenario `networkProfile`) uses Chromium's DevTools protocol
 * (Network.emulateNetworkConditions) and is applied to the whole case.
 */
import type { BrowserContext, Page } from 'playwright-core'
import type {
  QaCheckAssertion,
  QaCheckPerformanceStep,
  QaCheckResult,
  QaNetworkProfile,
  QaPerformanceMetric,
  QaPerformanceMetrics,
} from '@shared/qa-checks'
import { QA_PERFORMANCE_METRIC_LABELS, QA_PERFORMANCE_METRICS } from '@shared/qa-checks'
import { cumulativeLayoutShift, evaluateBudgets, formatMetric, interactionToNextPaint, totalBlockingTime } from './budgets'
import { checkMessage, errorLine, pause, worstStatus } from './result'
import type { CheckContext } from './result'

/** Key of the page-side store (a registered symbol, so it is not an enumerable page global). */
export const PERFORMANCE_STORE_KEY = 'proxy-qa.performance'

export interface PagePerformanceStore {
  supported: string[]
  lcp?: number
  fcp?: number
  shifts: Array<{ startTime: number; value: number; hadRecentInput: boolean }>
  events: Array<{ interactionId: number; duration: number }>
  longTasks: Array<{ startTime: number; duration: number }>
}

/** Init script (serialized into the page): no imports, arrow functions only. */
export function installPerformanceObservers(key: string): void {
  if (window.top !== window) return
  const symbol = Symbol.for(key)
  if ((window as unknown as Record<symbol, unknown>)[symbol]) return
  const store = { supported: [] as string[], shifts: [], events: [], longTasks: [] } as {
    supported: string[]
    lcp?: number
    fcp?: number
    shifts: Array<{ startTime: number; value: number; hadRecentInput: boolean }>
    events: Array<{ interactionId: number; duration: number }>
    longTasks: Array<{ startTime: number; duration: number }>
  }
  Object.defineProperty(window, symbol, { value: store, enumerable: false })
  const cap = 2000
  const observe = (type: string, onEntry: (entry: PerformanceEntry) => void, extra: Record<string, unknown> = {}): void => {
    try {
      if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return
      new PerformanceObserver((list) => list.getEntries().forEach(onEntry)).observe({ type, buffered: true, ...extra } as PerformanceObserverInit)
      store.supported.push(type)
    } catch {
      // Unsupported option or entry type: the metric is reported as unavailable.
    }
  }
  observe('largest-contentful-paint', (entry) => {
    store.lcp = entry.startTime
  })
  observe('paint', (entry) => {
    if (entry.name === 'first-contentful-paint') store.fcp = entry.startTime
  })
  observe('layout-shift', (entry) => {
    const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean }
    if (store.shifts.length < cap) store.shifts.push({ startTime: shift.startTime, value: shift.value, hadRecentInput: shift.hadRecentInput })
  })
  observe(
    'event',
    (entry) => {
      const event = entry as PerformanceEntry & { interactionId?: number }
      if (event.interactionId && store.events.length < cap) store.events.push({ interactionId: event.interactionId, duration: event.duration })
    },
    { durationThreshold: 16 },
  )
  observe('longtask', (entry) => {
    if (store.longTasks.length < cap) store.longTasks.push({ startTime: entry.startTime, duration: entry.duration })
  })
}

/** DevTools network presets (Chrome DevTools throttling values; throughput in bytes per second). */
export const NETWORK_CONDITIONS: Record<QaNetworkProfile, { latency: number; downloadThroughput: number; uploadThroughput: number }> = {
  'slow-3g': { latency: 2000, downloadThroughput: (500 * 1000 * 0.8) / 8, uploadThroughput: (500 * 1000 * 0.8) / 8 },
  'fast-3g': { latency: 562.5, downloadThroughput: (1.6 * 1000 * 1000 * 0.9) / 8, uploadThroughput: (750 * 1000 * 0.9) / 8 },
  '4g': { latency: 165, downloadThroughput: (9 * 1000 * 1000 * 0.9) / 8, uploadThroughput: (1.5 * 1000 * 1000 * 0.9) / 8 },
}

/**
 * Applies the scenario's network profile to the case's page. Returns the throttling status recorded
 * in evidence and notes: 'applied', or why not (non-Chromium engine, protocol error).
 */
export async function applyNetworkProfile(context: BrowserContext, page: Page, profile: QaNetworkProfile): Promise<string> {
  const engine = context.browser()?.browserType().name() ?? 'unknown'
  if (engine !== 'chromium') return `not supported on ${engine}`
  try {
    const session = await context.newCDPSession(page)
    await session.send('Network.enable')
    await session.send('Network.emulateNetworkConditions', { offline: false, ...NETWORK_CONDITIONS[profile] })
    return 'applied'
  } catch (err) {
    return `failed (${errorLine(err, 'DevTools protocol error')})`
  }
}

export interface RawPerformanceFacts {
  store: PagePerformanceStore | null
  navigation: { responseStart: number; domContentLoadedEventEnd: number; loadEventEnd: number; transferSize: number } | null
  resourceBytes: number
}

/** Pure: metrics and the list of unavailable metrics from page facts (exported for tests). */
export function performanceMetrics(facts: RawPerformanceFacts): { metrics: QaPerformanceMetrics; unavailable: QaPerformanceMetric[] } {
  const metrics: QaPerformanceMetrics = {}
  const store = facts.store
  const supports = (type: string): boolean => store?.supported.includes(type) === true
  if (store?.lcp !== undefined) metrics.lcpMs = store.lcp
  if (store && supports('layout-shift')) metrics.cls = cumulativeLayoutShift(store.shifts)
  if (store && supports('event')) {
    const inp = interactionToNextPaint(store.events)
    if (inp !== undefined) metrics.inpMs = inp
  }
  if (store && supports('longtask')) metrics.tbtMs = totalBlockingTime(store.longTasks, store.fcp)
  const nav = facts.navigation
  if (nav) {
    if (nav.responseStart > 0) metrics.ttfbMs = nav.responseStart
    if (nav.domContentLoadedEventEnd > 0) metrics.domContentLoadedMs = nav.domContentLoadedEventEnd
    if (nav.loadEventEnd > 0) metrics.loadMs = nav.loadEventEnd
    const bytes = nav.transferSize + facts.resourceBytes
    if (bytes > 0) metrics.transferBytes = bytes
  }
  const unavailable = QA_PERFORMANCE_METRICS.filter((metric) => metrics[metric] === undefined)
  return { metrics, unavailable }
}

export function evaluatePerformance(
  step: QaCheckPerformanceStep,
  facts: RawPerformanceFacts,
  network: { networkProfile?: QaNetworkProfile; throttling?: string } = {},
): QaCheckResult {
  const { metrics, unavailable } = performanceMetrics(facts)
  const assertions: QaCheckAssertion[] = evaluateBudgets(metrics, step.budgets)
  if (network.networkProfile && network.throttling !== 'applied')
    assertions.push({ name: 'throttling', status: 'warning', message: `Network profile ${network.networkProfile} ${network.throttling ?? 'not applied'}; metrics are unthrottled.` })
  const status = worstStatus(assertions)
  const failed = assertions.filter((item) => item.status === 'failed')
  const warning = assertions.find((item) => item.status === 'warning')
  const headlineMetric = metrics.lcpMs !== undefined ? `LCP ${formatMetric('lcpMs', metrics.lcpMs)}` : metrics.loadMs !== undefined ? `load ${formatMetric('loadMs', metrics.loadMs)}` : ''
  return {
    action: 'checkPerformance',
    status,
    headline: failed.length
      ? failed
          .slice(0, 2)
          .map((item) => item.message)
          .join(', ')
      : warning
        ? warning.name === 'throttling'
          ? 'perf unthrottled'
          : `perf ${QA_PERFORMANCE_METRIC_LABELS[warning.name as QaPerformanceMetric]} unavailable`
        : `perf within budget${headlineMetric ? ` (${headlineMetric})` : ''}`,
    message: checkMessage(assertions, `Performance within budget.${headlineMetric ? ` ${headlineMetric}.` : ''}`),
    assertions,
    performance: {
      metrics: Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, Math.round(value * 1000) / 1000])),
      budgets: step.budgets,
      unavailable,
      ...(network.networkProfile ? { networkProfile: network.networkProfile } : {}),
      ...(network.throttling ? { throttling: network.throttling } : {}),
    },
  }
}

export async function runPerformanceCheck(page: Page, step: QaCheckPerformanceStep, ctx: CheckContext): Promise<QaCheckResult> {
  try {
    await page.waitForLoadState('load', { timeout: ctx.timeoutMs })
  } catch {
    // Recorded below: loadMs stays unavailable when the load event never fired.
  }
  await pause(step.settleMs, ctx.signal)
  let facts: RawPerformanceFacts
  try {
    facts = await page.evaluate((key): RawPerformanceFacts => {
      const store = (window as unknown as Record<symbol, PagePerformanceStore | undefined>)[Symbol.for(key)] ?? null
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
      const resourceBytes = performance
        .getEntriesByType('resource')
        .reduce((total, entry) => {
          const resource = entry as PerformanceResourceTiming
          return total + (resource.transferSize || resource.encodedBodySize || 0)
        }, 0)
      return {
        store: store ? JSON.parse(JSON.stringify(store)) : null,
        navigation: nav
          ? {
              responseStart: nav.responseStart - nav.startTime,
              domContentLoadedEventEnd: nav.domContentLoadedEventEnd - nav.startTime,
              loadEventEnd: nav.loadEventEnd - nav.startTime,
              transferSize: nav.transferSize || nav.encodedBodySize || 0,
            }
          : null,
        resourceBytes,
      }
    }, PERFORMANCE_STORE_KEY)
  } catch (err) {
    const message = `Could not read performance metrics: ${ctx.sanitize(errorLine(err, 'page evaluation failed'))}`
    return { action: 'checkPerformance', status: 'failed', headline: 'perf not measurable', message, assertions: [{ name: 'metrics', status: 'failed', message }] }
  }
  return evaluatePerformance(step, facts, {
    ...(ctx.networkProfile ? { networkProfile: ctx.networkProfile } : {}),
    ...(ctx.throttling ? { throttling: ctx.throttling } : {}),
  })
}

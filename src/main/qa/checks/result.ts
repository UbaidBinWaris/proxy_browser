import type { QaCheckAssertion, QaCheckStatus, QaNetworkProfile } from '@shared/qa-checks'

/** Shared by every check runner. */
export interface CheckContext {
  timeoutMs: number
  signal: AbortSignal
  /** Evidence sanitizer of the run (redacts secrets and filled test values). */
  sanitize: (text: string) => string
  /** Set up before the first navigation by prepareChecks. */
  networkProfile?: QaNetworkProfile
  /** 'applied', or why throttling was not applied. */
  throttling?: string
}

export function worstStatus(assertions: readonly Pick<QaCheckAssertion, 'status'>[]): QaCheckStatus {
  if (assertions.some((item) => item.status === 'failed')) return 'failed'
  if (assertions.some((item) => item.status === 'warning')) return 'warning'
  return 'passed'
}

/** The message a failed check step reports: its failing assertions, or the first warning. */
export function checkMessage(assertions: readonly QaCheckAssertion[], passMessage: string): string {
  const failed = assertions.filter((item) => item.status === 'failed')
  if (failed.length) return failed.map((item) => item.message).join('; ')
  return assertions.find((item) => item.status === 'warning')?.message ?? passMessage
}

/** Resolves after `ms`, or early when the run is cancelled. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/** First line of an error, without Playwright's call log (which can echo page data). */
export function errorLine(err: unknown, fallback: string): string {
  return err instanceof Error ? (err.message.split('\n')[0] ?? fallback) : fallback
}

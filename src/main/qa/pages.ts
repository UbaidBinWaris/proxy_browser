/**
 * Pop-up windows of a QA run, numbered in the order the context opened them (popup:1 … popup:9), the same
 * order the recorder numbers them in. Generic so the waiting logic is unit-testable without a browser.
 */
import { QA_MAX_POPUPS } from '@shared/qa-targets'

export interface PopupRegistry<P> {
  /** Register a page the context opened after the main page; pages beyond the limit are not addressable. */
  add(page: P): void
  /** The n-th pop-up (1-based), waiting for it to open within `timeoutMs`. */
  get(index: number, timeoutMs: number, signal?: AbortSignal): Promise<P>
  count(): number
}

export function popupTimeoutMessage(index: number, timeoutMs: number): string {
  return `Pop-up ${index} did not open within ${timeoutMs} ms.`
}

export function createPopupRegistry<P>(max = QA_MAX_POPUPS): PopupRegistry<P> {
  const popups: P[] = []
  let waiters: Array<() => void> = []
  return {
    add(page) {
      if (popups.length >= max) return
      popups.push(page)
      const pending = waiters
      waiters = []
      for (const wake of pending) wake()
    },
    async get(index, timeoutMs, signal) {
      if (!Number.isInteger(index) || index < 1 || index > max) throw new Error(`Use popup:1 to popup:${max}.`)
      const deadline = Date.now() + timeoutMs
      while (!popups[index - 1]) {
        signal?.throwIfAborted()
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error(popupTimeoutMessage(index, timeoutMs))
        let timer: ReturnType<typeof setTimeout> | undefined
        let onAbort: (() => void) | undefined
        await new Promise<void>((resolve) => {
          timer = setTimeout(resolve, remaining)
          onAbort = resolve
          signal?.addEventListener('abort', onAbort, { once: true })
          waiters.push(resolve)
        })
        clearTimeout(timer)
        if (onAbort) signal?.removeEventListener('abort', onAbort)
      }
      return popups[index - 1]!
    },
    count: () => popups.length,
  }
}

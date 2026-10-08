/**
 * Inactivity handling of the "Manage proxy keys" window (pure, unit-tested with
 * fake timers). The window closes itself after `KEYS_INACTIVITY_TIMEOUT_MS`
 * without user input; the main process enforces a separate hard limit.
 */

export const KEYS_INACTIVITY_TIMEOUT_MS = 5 * 60_000
/** The countdown appears in the footer once less than this is left. */
export const KEYS_COUNTDOWN_THRESHOLD_MS = 60_000
/** DOM events that count as activity. */
export const KEYS_ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'focusin', 'input'] as const

export interface InactivityTracker {
  /** Record activity now (cheap: called for every input event). */
  touch(): void
  /** Milliseconds until the window would close without further activity. */
  remainingMs(): number
  /** Stop the timer; `onExpire` is never called afterwards. */
  dispose(): void
}

export interface InactivityTrackerOptions {
  timeoutMs: number
  onExpire: () => void
  now?: () => number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/**
 * One timer for the whole window: `touch()` only moves the deadline; when the timer fires it
 * re-arms for whatever is left, so input events never churn timers. `onExpire` runs at most once.
 */
export function createInactivityTracker(opts: InactivityTrackerOptions): InactivityTracker {
  const now = opts.now ?? ((): number => Date.now())
  const setTimer = opts.setTimer ?? ((callback: () => void, ms: number): unknown => setTimeout(callback, ms))
  const clearTimer = opts.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let lastActivity = now()
  let handle: unknown = null
  let done = false

  const remainingMs = (): number => Math.max(0, lastActivity + opts.timeoutMs - now())

  const arm = (ms: number): void => {
    handle = setTimer(check, ms)
  }

  function check(): void {
    handle = null
    if (done) return
    const left = remainingMs()
    if (left > 0) {
      arm(left)
      return
    }
    done = true
    opts.onExpire()
  }

  arm(opts.timeoutMs)

  return {
    touch: () => {
      if (!done) lastActivity = now()
    },
    remainingMs,
    dispose: () => {
      done = true
      if (handle !== null) clearTimer(handle)
      handle = null
    },
  }
}

/** 299_500 → "5:00", 45_000 → "0:45" (rounded up to whole seconds, never negative). */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** Footer note: always says the rule; adds the countdown in the last minute. */
export function inactivityNote(remainingMs: number, timeoutMs: number = KEYS_INACTIVITY_TIMEOUT_MS): string {
  const base = `Closes automatically after ${Math.round(timeoutMs / 60_000)} min of inactivity`
  return remainingMs < KEYS_COUNTDOWN_THRESHOLD_MS ? `${base} · closing in ${formatCountdown(remainingMs)}` : base
}

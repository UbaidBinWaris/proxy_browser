/**
 * Watches for a browser the user is installing by hand (after "Get <Browser>"
 * opened the vendor page): every `intervalMs` the injected probe checks whether
 * the engine can be found; on success `onFound` runs once and the watch ends;
 * after `timeoutMs` it expires. One watch per engine — starting a new one for
 * the same engine replaces (cancels) the previous one. `cancelAll()` is called
 * on app quit. Timers are injectable so tests run with fake ones.
 */
import type { InstalledBrowserEngine } from '@shared/types'

export const WATCH_INTERVAL_MS = 5_000
export const WATCH_TIMEOUT_MS = 15 * 60_000

export type WatchEndReason = 'found' | 'expired' | 'cancelled'

export interface InstallWatcherOptions {
  /** True once the engine is installed. Errors count as "not yet". */
  probe: (engine: InstalledBrowserEngine) => boolean | Promise<boolean>
  onFound: (engine: InstalledBrowserEngine) => void | Promise<void>
  /** Called when a watch ends for any reason ('found' after onFound settled). */
  onEnd?: (engine: InstalledBrowserEngine, reason: WatchEndReason) => void
  intervalMs?: number
  timeoutMs?: number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  now?: () => number
}

export interface InstallWatcher {
  start(engine: InstalledBrowserEngine): void
  cancel(engine: InstalledBrowserEngine): void
  cancelAll(): void
  isWatching(engine: InstalledBrowserEngine): boolean
  watching(): InstalledBrowserEngine[]
}

export function createInstallWatcher(options: InstallWatcherOptions): InstallWatcher {
  const intervalMs = options.intervalMs ?? WATCH_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? WATCH_TIMEOUT_MS
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number): unknown => setTimeout(callback, ms))
  const clearTimer = options.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const now = options.now ?? Date.now

  interface Watch {
    token: number
    timer: unknown
    deadline: number
  }
  const active = new Map<InstalledBrowserEngine, Watch>()
  let nextToken = 1

  const end = (engine: InstalledBrowserEngine, token: number, reason: WatchEndReason): void => {
    const watch = active.get(engine)
    if (!watch || watch.token !== token) return
    clearTimer(watch.timer)
    active.delete(engine)
    options.onEnd?.(engine, reason)
  }

  const schedule = (engine: InstalledBrowserEngine, token: number): void => {
    const watch = active.get(engine)
    if (!watch || watch.token !== token) return
    watch.timer = setTimer(() => {
      void tick(engine, token)
    }, intervalMs)
  }

  const tick = async (engine: InstalledBrowserEngine, token: number): Promise<void> => {
    const watch = active.get(engine)
    if (!watch || watch.token !== token) return
    let found: boolean
    try {
      found = await options.probe(engine)
    } catch {
      found = false
    }
    if (active.get(engine)?.token !== token) return
    if (found) {
      try {
        await options.onFound(engine)
      } finally {
        end(engine, token, 'found')
      }
      return
    }
    if (now() >= watch.deadline) {
      end(engine, token, 'expired')
      return
    }
    schedule(engine, token)
  }

  return {
    start(engine) {
      const previous = active.get(engine)
      if (previous) end(engine, previous.token, 'cancelled')
      const token = nextToken
      nextToken += 1
      active.set(engine, { token, timer: null, deadline: now() + timeoutMs })
      schedule(engine, token)
    },
    cancel(engine) {
      const watch = active.get(engine)
      if (watch) end(engine, watch.token, 'cancelled')
    },
    cancelAll() {
      for (const [engine, watch] of [...active]) end(engine, watch.token, 'cancelled')
    },
    isWatching: (engine) => active.has(engine),
    watching: () => [...active.keys()],
  }
}

/**
 * Push events from main to every open renderer window.
 */
import type { EventChannel, EventPayloads } from '@shared/ipc'

/** Structural subset of Electron's `WebContents` used for broadcasting. */
export interface SendTarget {
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
}

export type Broadcast = <C extends EventChannel>(channel: C, payload: EventPayloads[C]) => void

/**
 * Build a broadcaster over a live list of targets. `getTargets` is evaluated on
 * every call so windows opened later are included and destroyed ones skipped.
 */
export function createBroadcaster(getTargets: () => readonly SendTarget[], onError?: (err: unknown) => void): Broadcast {
  return (channel, payload) => {
    for (const target of getTargets()) {
      try {
        if (target.isDestroyed()) continue
        target.send(channel, payload)
      } catch (err) {
        onError?.(err)
      }
    }
  }
}

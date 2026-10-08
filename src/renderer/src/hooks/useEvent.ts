import { useEffect, useRef } from 'react'
import type { EventChannel, EventPayloads } from '@shared/ipc'
import { getApi } from '../lib/api'

/**
 * Subscribe to a main-process push event for the lifetime of the component.
 * The latest listener is always invoked (no stale closures) and the subscription
 * is removed on unmount or when the channel changes.
 */
export function useEvent<C extends EventChannel>(
  channel: C,
  listener: (payload: EventPayloads[C]) => void,
  enabled = true,
): void {
  const listenerRef = useRef(listener)
  listenerRef.current = listener

  useEffect(() => {
    if (!enabled) return undefined
    const unsubscribe = getApi().events.on(channel, (payload) => {
      listenerRef.current(payload)
    })
    return () => {
      unsubscribe()
    }
  }, [channel, enabled])
}

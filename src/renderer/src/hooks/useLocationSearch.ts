import { useEffect, useRef, useState } from 'react'
import type { AppError, LocationEntry, TargetMode } from '@shared/types'
import { getApi, toAppError, unwrap } from '../lib/api'

export interface LocationSearchState {
  results: LocationEntry[]
  /** Uncapped number of matches (the page holds at most `limit`). */
  total: number
  loading: boolean
  error: AppError | null
}

export interface LocationSearchOptions {
  /** When false nothing is queried and the results are cleared (closed listbox). */
  enabled?: boolean
  limit?: number
  debounceMs?: number
  /** Only cities / ZIP codes in this state ("NJ"). */
  stateCode?: string | null
}

const EMPTY: LocationSearchState = { results: [], total: 0, loading: false, error: null }

/**
 * Type-to-search over the bundled location dataset. Calls `locations.query` with the current mode,
 * debounced, and drops answers that arrive after a newer query was sent (cancellation).
 */
export function useLocationSearch(mode: TargetMode, query: string, options: LocationSearchOptions = {}): LocationSearchState {
  const { enabled = true, limit = 50, debounceMs = 150, stateCode = null } = options
  const [state, setState] = useState<LocationSearchState>(EMPTY)
  const callId = useRef(0)

  useEffect(() => {
    if (!enabled || mode === 'country') {
      callId.current += 1
      setState((current) => (current.results.length === 0 && !current.loading && !current.error ? current : EMPTY))
      return undefined
    }
    const id = ++callId.current
    setState((current) => (current.loading ? current : { ...current, loading: true }))
    const timer = window.setTimeout(() => {
      const input = { mode, query: query.trim().slice(0, 80), limit, ...(stateCode && mode !== 'state' ? { stateCode } : {}) }
      Promise.resolve()
        .then(() => unwrap(getApi().locations.query(input)))
        .then((page) => {
          if (id !== callId.current) return
          setState({ results: page.entries, total: page.total, loading: false, error: null })
        })
        .catch((err: unknown) => {
          if (id !== callId.current) return
          setState({ results: [], total: 0, loading: false, error: toAppError(err) })
        })
    }, debounceMs)
    return () => {
      window.clearTimeout(timer)
    }
  }, [mode, query, enabled, limit, debounceMs, stateCode])

  return state
}

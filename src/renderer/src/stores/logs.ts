import { create } from 'zustand'
import type { AppError, LogEntry, LogLevel, LogQuery } from '@shared/types'
import { getApi, toAppError, unwrap } from '../lib/api'
import type { LoadStatus } from '../lib/result'

export const MAX_LOG_ENTRIES = 2000

interface LogsState {
  /** Oldest first, capped at MAX_LOG_ENTRIES (ring buffer). */
  entries: LogEntry[]
  status: LoadStatus
  error: AppError | null
  load: (query?: LogQuery) => Promise<void>
  append: (entry: LogEntry) => void
  /** Clears both the main-process log store and the local buffer. */
  clear: () => Promise<void>
  reset: () => void
}

export function appendCapped(entries: LogEntry[], entry: LogEntry, max: number = MAX_LOG_ENTRIES): LogEntry[] {
  if (entries.some((e) => e.id === entry.id)) return entries
  const next = entries.length >= max ? entries.slice(entries.length - max + 1) : entries.slice()
  next.push(entry)
  return next
}

export const useLogsStore = create<LogsState>((set) => ({
  entries: [],
  status: 'idle',
  error: null,

  load: async (query) => {
    set((state) => ({ status: state.entries.length > 0 ? state.status : 'loading', error: null }))
    try {
      const fetched = await unwrap(getApi().logs.list({ limit: MAX_LOG_ENTRIES, ...query }))
      const ordered = [...fetched].sort((a, b) => a.id - b.id).slice(-MAX_LOG_ENTRIES)
      set({ entries: ordered, status: 'ready', error: null })
    } catch (err) {
      set({ status: 'error', error: toAppError(err) })
    }
  },

  append: (entry) => set((state) => ({ entries: appendCapped(state.entries, entry) })),

  clear: async () => {
    await unwrap(getApi().logs.clear())
    set({ entries: [] })
  },

  reset: () => set({ entries: [], status: 'idle', error: null }),
}))

export interface LogFilter {
  level: LogLevel | 'all'
  scope: string
  search: string
}

export function filterLogs(entries: LogEntry[], filter: LogFilter): LogEntry[] {
  const search = filter.search.trim().toLowerCase()
  return entries.filter((entry) => {
    if (filter.level !== 'all' && entry.level !== filter.level) return false
    if (filter.scope !== '' && entry.scope !== filter.scope) return false
    if (search !== '') {
      const haystack = `${entry.message} ${entry.scope} ${entry.meta ? JSON.stringify(entry.meta) : ''}`.toLowerCase()
      if (!haystack.includes(search)) return false
    }
    return true
  })
}

export function collectScopes(entries: LogEntry[]): string[] {
  return Array.from(new Set(entries.map((e) => e.scope))).sort()
}

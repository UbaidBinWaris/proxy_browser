import { create } from 'zustand'
import type { AppError, TestRun, TestRunPatch } from '@shared/types'
import { getApi, toAppError, unwrap } from '../lib/api'
import type { LoadStatus } from '../lib/result'

interface RunsState {
  /** Newest first. */
  runs: TestRun[]
  status: LoadStatus
  error: AppError | null
  load: (limit?: number) => Promise<void>
  /** Cached run or fetch from main. Throws ApiError on failure (e.g. NOT_FOUND). */
  fetch: (id: string) => Promise<TestRun>
  update: (id: string, patch: TestRunPatch) => Promise<TestRun>
  remove: (id: string) => Promise<void>
  upsert: (run: TestRun) => void
}

export function sortRunsNewestFirst(runs: TestRun[]): TestRun[] {
  return [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export function upsertRun(runs: TestRun[], run: TestRun): TestRun[] {
  const exists = runs.some((r) => r.id === run.id)
  return sortRunsNewestFirst(exists ? runs.map((r) => (r.id === run.id ? run : r)) : [run, ...runs])
}

export const useRunsStore = create<RunsState>((set, get) => ({
  runs: [],
  status: 'idle',
  error: null,

  load: async (limit) => {
    set((state) => ({ status: state.runs.length > 0 ? state.status : 'loading', error: null }))
    try {
      const runs = await unwrap(getApi().runs.list(limit))
      set({ runs: sortRunsNewestFirst(runs), status: 'ready', error: null })
    } catch (err) {
      set({ status: 'error', error: toAppError(err) })
    }
  },

  fetch: async (id) => {
    const cached = get().runs.find((r) => r.id === id)
    if (cached) return cached
    const run = await unwrap(getApi().runs.get(id))
    set((state) => ({ runs: upsertRun(state.runs, run) }))
    return run
  },

  update: async (id, patch) => {
    const run = await unwrap(getApi().runs.update(id, patch))
    set((state) => ({ runs: upsertRun(state.runs, run) }))
    return run
  },

  remove: async (id) => {
    await unwrap(getApi().runs.delete(id))
    set((state) => ({ runs: state.runs.filter((r) => r.id !== id) }))
  },

  upsert: (run) => set((state) => ({ runs: upsertRun(state.runs, run) })),
}))

export function selectRunById(runs: TestRun[], id: string | undefined): TestRun | null {
  if (!id) return null
  return runs.find((r) => r.id === id) ?? null
}

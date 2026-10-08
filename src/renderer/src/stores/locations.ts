import { create } from 'zustand'
import type { AppError, LocationEntry, LocationStats, TargetMode } from '@shared/types'
import { getApi, toAppError, unwrap } from '../lib/api'
import type { LoadStatus } from '../lib/result'

interface LocationsState {
  /** Every US state, loaded once (timezone auto-fill, compact pickers). */
  states: LocationEntry[]
  statesStatus: LoadStatus
  statesError: AppError | null
  /** Dataset size for the picker's start hint; null until loaded (or when loading failed). */
  stats: LocationStats | null
  /** Modes with a random draw in flight. */
  randomBusy: Partial<Record<TargetMode, boolean>>
  loadStates: () => Promise<LocationEntry[]>
  loadStats: () => Promise<LocationStats | null>
  /** One random entry of the given kind, optionally inside one state. Throws ApiError on failure. */
  random: (mode: TargetMode, stateCode?: string | null) => Promise<LocationEntry>
}

export const useLocationsStore = create<LocationsState>((set, get) => ({
  states: [],
  statesStatus: 'idle',
  statesError: null,
  stats: null,
  randomBusy: {},

  loadStates: async () => {
    if (get().statesStatus === 'ready') return get().states
    set({ statesStatus: 'loading', statesError: null })
    try {
      const states = await unwrap(getApi().locations.states())
      set({ states, statesStatus: 'ready' })
      return states
    } catch (err) {
      set({ statesStatus: 'error', statesError: toAppError(err) })
      return []
    }
  },

  loadStats: async () => {
    const cached = get().stats
    if (cached) return cached
    try {
      const stats = await unwrap(getApi().locations.stats())
      set({ stats })
      return stats
    } catch {
      // The hint falls back to generic wording; searching still works.
      return null
    }
  },

  random: async (mode, stateCode = null) => {
    set((state) => ({ randomBusy: { ...state.randomBusy, [mode]: true } }))
    try {
      return await unwrap(getApi().locations.random(mode, stateCode))
    } finally {
      set((state) => ({ randomBusy: { ...state.randomBusy, [mode]: false } }))
    }
  },
}))

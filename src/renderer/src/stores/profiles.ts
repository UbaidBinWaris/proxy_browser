import { create } from 'zustand'
import type { AppError, DevicePresetInfo, Profile, ProfileInput } from '@shared/types'
import { getApi, toAppError, unwrap } from '../lib/api'
import type { LoadStatus } from '../lib/result'

interface ProfilesState {
  items: Profile[]
  status: LoadStatus
  error: AppError | null
  presets: DevicePresetInfo[]
  presetsStatus: LoadStatus
  presetsError: AppError | null
  load: () => Promise<void>
  loadPresets: () => Promise<void>
  /** Returns the cached profile, fetching it when unknown. Throws ApiError on failure. */
  fetch: (id: string) => Promise<Profile>
  create: (input: ProfileInput) => Promise<Profile>
  update: (id: string, input: ProfileInput) => Promise<Profile>
  duplicate: (id: string) => Promise<Profile>
  remove: (id: string) => Promise<void>
  upsert: (profile: Profile) => void
}

function sortByName(items: Profile[]): Profile[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

function upsertInto(items: Profile[], profile: Profile): Profile[] {
  const exists = items.some((p) => p.id === profile.id)
  return sortByName(exists ? items.map((p) => (p.id === profile.id ? profile : p)) : [...items, profile])
}

export const useProfilesStore = create<ProfilesState>((set, get) => ({
  items: [],
  status: 'idle',
  error: null,
  presets: [],
  presetsStatus: 'idle',
  presetsError: null,

  load: async () => {
    set((state) => ({ status: state.items.length > 0 ? state.status : 'loading', error: null }))
    try {
      const items = await unwrap(getApi().profiles.list())
      set({ items: sortByName(items), status: 'ready', error: null })
    } catch (err) {
      set({ status: 'error', error: toAppError(err) })
    }
  },

  loadPresets: async () => {
    if (get().presetsStatus === 'ready') return
    set({ presetsStatus: 'loading', presetsError: null })
    try {
      const presets = await unwrap(getApi().profiles.presets())
      set({ presets, presetsStatus: 'ready' })
    } catch (err) {
      set({ presetsStatus: 'error', presetsError: toAppError(err) })
    }
  },

  fetch: async (id) => {
    const cached = get().items.find((p) => p.id === id)
    if (cached) return cached
    const profile = await unwrap(getApi().profiles.get(id))
    set((state) => ({ items: upsertInto(state.items, profile) }))
    return profile
  },

  create: async (input) => {
    const profile = await unwrap(getApi().profiles.create(input))
    set((state) => ({ items: upsertInto(state.items, profile), status: 'ready' }))
    return profile
  },

  update: async (id, input) => {
    const profile = await unwrap(getApi().profiles.update(id, input))
    set((state) => ({ items: upsertInto(state.items, profile) }))
    return profile
  },

  duplicate: async (id) => {
    const profile = await unwrap(getApi().profiles.duplicate(id))
    set((state) => ({ items: upsertInto(state.items, profile) }))
    return profile
  },

  remove: async (id) => {
    await unwrap(getApi().profiles.delete(id))
    set((state) => ({ items: state.items.filter((p) => p.id !== id) }))
  },

  upsert: (profile) => set((state) => ({ items: upsertInto(state.items, profile) })),
}))

/** Lookup helper for joins (proxy sessions, runs). */
export function selectProfileById(items: Profile[], id: string | null): Profile | null {
  if (!id) return null
  return items.find((p) => p.id === id) ?? null
}

/**
 * Profiles shown on the Profiles page. The API already hides quick-launch (ephemeral) profiles from
 * `profiles.list`, but `profiles.get` (used by run pages) can bring one into the cache.
 */
export function selectVisibleProfiles(items: Profile[]): Profile[] {
  return items.filter((p) => !p.ephemeral)
}

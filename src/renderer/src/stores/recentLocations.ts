import { create } from 'zustand'
import type { LocationEntry } from '@shared/types'
import { browserStorage } from '../lib/devicePicker'
import { pushRecentLocation, readStoredLocations, writeStoredLocations } from '../lib/locationPicker'

interface RecentLocationsState {
  /** Last picked locations of every kind, most recent first. */
  recent: LocationEntry[]
  add: (entry: LocationEntry) => void
}

/** Recent picks of the location picker (Launch and the profile editor), persisted in localStorage. */
export const useRecentLocationsStore = create<RecentLocationsState>((set, get) => ({
  recent: readStoredLocations(browserStorage()),
  add: (entry) => {
    const recent = pushRecentLocation(get().recent, entry)
    set({ recent })
    writeStoredLocations(browserStorage(), recent)
  },
}))

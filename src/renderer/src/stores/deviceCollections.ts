import { create } from 'zustand'
import type { DevicePresetId } from '@shared/types'
import { FAVORITE_DEVICES_KEY, RECENT_DEVICES_KEY, browserStorage, pushRecent, readStoredIds, toggleFavorite, writeStoredIds } from '../lib/devicePicker'

interface DeviceCollectionsState {
  /** Last picked presets, most recent first (max 8). */
  recent: DevicePresetId[]
  favorites: DevicePresetId[]
  addRecent: (id: DevicePresetId) => void
  toggleFavorite: (id: DevicePresetId) => void
}

/** Recent and favorite devices of the device picker, shared by Launch and the profile editor, persisted in localStorage. */
export const useDeviceCollectionsStore = create<DeviceCollectionsState>((set, get) => ({
  recent: readStoredIds(browserStorage(), RECENT_DEVICES_KEY),
  favorites: readStoredIds(browserStorage(), FAVORITE_DEVICES_KEY),

  addRecent: (id) => {
    const recent = pushRecent(get().recent, id)
    set({ recent })
    writeStoredIds(browserStorage(), RECENT_DEVICES_KEY, recent)
  },

  toggleFavorite: (id) => {
    const favorites = toggleFavorite(get().favorites, id)
    set({ favorites })
    writeStoredIds(browserStorage(), FAVORITE_DEVICES_KEY, favorites)
  },
}))

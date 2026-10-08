import { create } from 'zustand'
import type { AppError, AppSettings, AppSettingsPatch } from '@shared/types'
import { getApi, toAppError, unwrap } from '../lib/api'
import type { LoadStatus } from '../lib/result'

interface SettingsState {
  settings: AppSettings | null
  status: LoadStatus
  error: AppError | null
  load: () => Promise<void>
  update: (patch: AppSettingsPatch) => Promise<AppSettings>
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  status: 'idle',
  error: null,

  load: async () => {
    set((state) => ({ status: state.settings ? state.status : 'loading', error: null }))
    try {
      const settings = await unwrap(getApi().settings.get())
      set({ settings, status: 'ready' })
    } catch (err) {
      set({ status: 'error', error: toAppError(err) })
    }
  },

  update: async (patch) => {
    const settings = await unwrap(getApi().settings.update(patch))
    set({ settings, status: 'ready', error: null })
    return settings
  },
}))

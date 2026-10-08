import { create } from 'zustand'
import type { AppError, AppSettings, BrowserSession, GeoTarget, QuickLaunchInput, TargetMode, TargetingPreview } from '@shared/types'
import { getApi, toAppError, unwrap } from '../lib/api'
import type { LoadStatus } from '../lib/result'
import { applyLauncherPrefs, defaultLauncherForm, prefsFromForm, readLauncherPrefs, writeLauncherPrefs } from '../lib/launcherForm'
import type { LauncherFormState, PrefsStorage } from '../lib/launcherForm'

interface LauncherState {
  form: LauncherFormState
  /** True once remembered choices (and the settings defaults) have been applied. */
  hydrated: boolean
  preview: TargetingPreview | null
  previewStatus: LoadStatus
  previewError: AppError | null
  launching: boolean
  launchError: AppError | null
  /** The last launch was refused with SESSION_LIMIT (single-session mode); the page offers to replace the open session. */
  sessionLimitHit: boolean
  /** Apply settings defaults, then whatever the user last used (localStorage). Runs once. */
  hydrate: (settings: AppSettings) => void
  setField: <K extends keyof LauncherFormState>(key: K, value: LauncherFormState[K]) => void
  patch: (changes: Partial<LauncherFormState>) => void
  /** Switching "Connect by" clears the picked location (its kind no longer fits). */
  setMode: (mode: TargetMode) => void
  setTarget: (target: GeoTarget | null) => void
  loadPreview: (input: QuickLaunchInput) => Promise<void>
  clearPreview: () => void
  /** Resolves with the new session; throws ApiError (SESSION_LIMIT flips `sessionLimitHit`). */
  quickLaunch: (input: QuickLaunchInput) => Promise<BrowserSession>
  dismissSessionLimit: () => void
  resetForm: () => void
}

function resolveStorage(): PrefsStorage | null {
  try {
    const holder = globalThis as { localStorage?: PrefsStorage }
    return holder.localStorage ?? null
  } catch {
    return null
  }
}

let previewCallId = 0

export const useLauncherStore = create<LauncherState>((set, get) => ({
  form: applyLauncherPrefs(defaultLauncherForm(), readLauncherPrefs(resolveStorage())),
  hydrated: false,
  preview: null,
  previewStatus: 'idle',
  previewError: null,
  launching: false,
  launchError: null,
  sessionLimitHit: false,

  hydrate: (settings) => {
    if (get().hydrated) return
    const prefs = readLauncherPrefs(resolveStorage())
    const base = defaultLauncherForm({ defaultProviderId: settings.defaultProviderId, defaultProxyPool: settings.defaultProxyPool, defaultTargetCountry: settings.defaultTargetCountry })
    const current = get().form
    // Keep anything the user already changed on this visit (target, URL…) while filling defaults in.
    set({
      form: applyLauncherPrefs({ ...base, target: current.target, startUrl: current.startUrl, saveAsProfile: current.saveAsProfile, profileName: current.profileName }, prefs),
      hydrated: true,
    })
  },

  setField: (key, value) => {
    const form = { ...get().form, [key]: value }
    writeLauncherPrefs(resolveStorage(), prefsFromForm(form))
    set({ form, launchError: null })
  },

  patch: (changes) => {
    const form = { ...get().form, ...changes }
    writeLauncherPrefs(resolveStorage(), prefsFromForm(form))
    set({ form, launchError: null })
  },

  setMode: (mode) => {
    const current = get().form
    if (current.mode === mode) return
    const form = { ...current, mode, target: null }
    writeLauncherPrefs(resolveStorage(), prefsFromForm(form))
    set({ form, preview: null, previewStatus: 'idle', previewError: null, launchError: null })
  },

  setTarget: (target) => set((state) => ({ form: { ...state.form, target }, launchError: null })),

  loadPreview: async (input) => {
    const id = ++previewCallId
    set((state) => ({ previewStatus: state.preview ? state.previewStatus : 'loading', previewError: null }))
    try {
      const preview = await unwrap(getApi().launcher.preview(input))
      if (id !== previewCallId) return
      set({ preview, previewStatus: 'ready', previewError: null })
    } catch (err) {
      if (id !== previewCallId) return
      set({ previewStatus: 'error', previewError: toAppError(err) })
    }
  },

  clearPreview: () => {
    previewCallId += 1
    set({ preview: null, previewStatus: 'idle', previewError: null })
  },

  quickLaunch: async (input) => {
    set({ launching: true, launchError: null, sessionLimitHit: false })
    try {
      const session = await unwrap(getApi().launcher.quickLaunch(input))
      return session
    } catch (err) {
      const error = toAppError(err)
      set({ launchError: error, sessionLimitHit: error.code === 'SESSION_LIMIT' })
      throw err
    } finally {
      set({ launching: false })
    }
  },

  dismissSessionLimit: () => set({ sessionLimitHit: false, launchError: null }),

  resetForm: () => {
    const form = defaultLauncherForm()
    writeLauncherPrefs(resolveStorage(), prefsFromForm(form))
    set({ form, preview: null, previewStatus: 'idle', previewError: null, launchError: null, sessionLimitHit: false })
  },
}))

import { create } from 'zustand'
import type { AppError, SetupStatus } from '@shared/types'
import { getApi, toAppError, unwrap } from '../lib/api'
import type { LoadStatus } from '../lib/result'

interface SetupState {
  status: SetupStatus | null
  loadStatus: LoadStatus
  error: AppError | null
  completing: boolean
  load: () => Promise<void>
  /** Marks first-run setup as finished for this installation; idempotent on the main side. */
  complete: () => Promise<SetupStatus>
}

export const useSetupStore = create<SetupState>((set) => ({
  status: null,
  loadStatus: 'idle',
  error: null,
  completing: false,

  load: async () => {
    set((state) => ({ loadStatus: state.status ? state.loadStatus : 'loading', error: null }))
    try {
      const status = await unwrap(getApi().setup.status())
      set({ status, loadStatus: 'ready' })
    } catch (err) {
      set({ loadStatus: 'error', error: toAppError(err) })
    }
  },

  complete: async () => {
    set({ completing: true })
    try {
      const status = await unwrap(getApi().setup.complete())
      set({ status, loadStatus: 'ready', error: null })
      return status
    } finally {
      set({ completing: false })
    }
  },
}))

/** True only once the status is known and says this installation has not finished first-run setup. */
export function selectFirstRun(status: SetupStatus | null): boolean {
  return status?.firstRun === true
}

/** True while the very first setup.status() call is still outstanding (nothing to decide on yet). */
export function selectSetupPending(status: SetupStatus | null, loadStatus: LoadStatus): boolean {
  return status === null && (loadStatus === 'idle' || loadStatus === 'loading')
}

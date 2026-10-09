import { create } from 'zustand'
import type { UpdateAvailability, UpdateOutcome } from '@shared/desktop'
import type { UpdateStatus } from '@shared/qa'
import { getApi, unwrap } from '../lib/api'
import { availabilityFromCheck } from '../lib/updates'
import { toast } from './toasts'

/**
 * The update notice (how the last update ended) and the startup check's result for the sidebar badge.
 * Loading never toasts: builds without computer setup or a feed simply show neither.
 */
interface UpdatesState {
  notice: UpdateOutcome | null
  availability: UpdateAvailability | null
  /** A Retry of the pending update is running. */
  retrying: boolean
  load: () => Promise<void>
  /** Apply a pushed `event:update-available`. */
  applyAvailability: (availability: UpdateAvailability) => void
  /** Apply the result of a manual "Check for updates". */
  applyCheck: (status: UpdateStatus) => void
  dismiss: () => Promise<void>
  /** Finish the pending update again; resolves true when it succeeded. */
  retry: () => Promise<boolean>
}

export const useUpdatesStore = create<UpdatesState>((set, get) => ({
  notice: null,
  availability: null,
  retrying: false,

  load: async () => {
    const [status, availability] = await Promise.allSettled([
      Promise.resolve().then(() => unwrap(getApi().desktop.status())),
      Promise.resolve().then(() => unwrap(getApi().desktop.updateAvailability())),
    ])
    if (status.status === 'fulfilled') set({ notice: status.value.lastUpdate ?? null })
    // A pushed result that arrived while loading is at least as fresh as this answer.
    if (availability.status === 'fulfilled' && availability.value && !get().availability) set({ availability: availability.value })
  },

  applyAvailability: (availability) => set({ availability }),

  applyCheck: (status) => set({ availability: availabilityFromCheck(status) }),

  dismiss: async () => {
    const previous = get().notice
    set({ notice: null })
    try {
      await unwrap(getApi().desktop.dismissUpdateNotice())
    } catch (err) {
      set({ notice: previous })
      toast.fromError(err, 'Could not dismiss the update notice')
    }
  },

  retry: async () => {
    if (get().retrying) return false
    set({ retrying: true })
    try {
      const status = await unwrap(getApi().desktop.retryPendingUpdate())
      set({ notice: status.lastUpdate ?? null })
      return true
    } catch (err) {
      toast.fromError(err, 'The update still did not finish')
      // The stored message may have changed (or the record is gone); show what main has now.
      await unwrap(getApi().desktop.status())
        .then((status) => set({ notice: status.lastUpdate ?? null }))
        .catch(() => undefined)
      return false
    } finally {
      set({ retrying: false })
    }
  },
}))

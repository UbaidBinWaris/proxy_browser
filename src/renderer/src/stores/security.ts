import { create } from 'zustand'
import type { AppError, ProxyCredentialsInput, ProxyCredentialsUpdate, ProxyPool, ProxyTestResult, SecurityStatus } from '@shared/types'
import { getApi, toAppError, unwrap } from '../lib/api'
import type { LoadStatus } from '../lib/result'
import { useProxyStore } from './proxy'

/** Mutations are exclusive: the UI disables the other actions while one runs. */
export type SecurityBusy = 'testing' | 'saving' | 'clearing' | 'rotating'

interface SecurityState {
  status: SecurityStatus | null
  loadStatus: LoadStatus
  error: AppError | null
  /** A local health check (security.status) is in flight. */
  checking: boolean
  busy: SecurityBusy | null
  /** Local, network-free health check. */
  load: () => Promise<void>
  /** Apply a pushed `event:security-update`. */
  apply: (status: SecurityStatus) => void
  /** Live proxy test of unsaved credentials; never throws, failures come back as a failed result. */
  testCredentials: (input: ProxyCredentialsInput) => Promise<ProxyTestResult>
  saveCredentials: (input: ProxyCredentialsInput) => Promise<SecurityStatus>
  /** Partial update merged with the stored vault entry in the main process (Manage keys window). */
  updateCredentials: (update: ProxyCredentialsUpdate) => Promise<SecurityStatus>
  /** Live test of the merged (stored + partial) credentials; never throws, nothing is persisted. */
  testCredentialsPartial: (update: ProxyCredentialsUpdate) => Promise<ProxyTestResult>
  /** Open (or focus) the secure "Manage proxy keys" window. */
  openKeysWindow: () => Promise<void>
  /** Close the "Manage proxy keys" window (from inside it). */
  closeKeysWindow: () => Promise<void>
  /** Remove one pool's credentials from the vault. */
  clearCredentials: (pool: ProxyPool) => Promise<SecurityStatus>
  rotateKey: () => Promise<SecurityStatus>
  reveal: (which: 'key' | 'vault') => Promise<void>
}

/** Pushed events and request responses can interleave; keep whichever was checked last. */
export function newerSecurityStatus(current: SecurityStatus | null, incoming: SecurityStatus): SecurityStatus {
  if (!current) return incoming
  return incoming.lastCheckedAt.localeCompare(current.lastCheckedAt) >= 0 ? incoming : current
}

export const useSecurityStore = create<SecurityState>((set) => ({
  status: null,
  loadStatus: 'idle',
  error: null,
  checking: false,
  busy: null,

  load: async () => {
    set((state) => ({ loadStatus: state.status ? state.loadStatus : 'loading', checking: true, error: null }))
    try {
      const status = await unwrap(getApi().security.status())
      set((state) => ({ status: newerSecurityStatus(state.status, status), loadStatus: 'ready' }))
    } catch (err) {
      set({ loadStatus: 'error', error: toAppError(err) })
    } finally {
      set({ checking: false })
    }
  },

  apply: (status) => set((state) => ({ status: newerSecurityStatus(state.status, status), loadStatus: 'ready', error: null })),

  testCredentials: async (input) => {
    set({ busy: 'testing' })
    try {
      return await unwrap(getApi().security.testCredentials(input))
    } catch (err) {
      return { status: 'failed', sessionId: null, ip: null, error: toAppError(err) }
    } finally {
      set({ busy: null })
    }
  },

  saveCredentials: async (input) => {
    set({ busy: 'saving' })
    try {
      const status = await unwrap(getApi().security.saveCredentials(input))
      set({ status, loadStatus: 'ready', error: null })
      // The active credentials changed: refresh host/port/masked username and the sidebar badge.
      void useProxyStore.getState().loadConfig()
      return status
    } finally {
      set({ busy: null })
    }
  },

  updateCredentials: async (update) => {
    set({ busy: 'saving' })
    try {
      const status = await unwrap(getApi().security.updateCredentials(update))
      set({ status, loadStatus: 'ready', error: null })
      void useProxyStore.getState().loadConfig()
      return status
    } finally {
      set({ busy: null })
    }
  },

  testCredentialsPartial: async (update) => {
    set({ busy: 'testing' })
    try {
      return await unwrap(getApi().security.testCredentialsPartial(update))
    } catch (err) {
      return { status: 'failed', sessionId: null, ip: null, error: toAppError(err) }
    } finally {
      set({ busy: null })
    }
  },

  openKeysWindow: async () => unwrap(getApi().security.openKeysWindow()),

  closeKeysWindow: async () => unwrap(getApi().security.closeKeysWindow()),

  clearCredentials: async (pool) => {
    set({ busy: 'clearing' })
    try {
      const status = await unwrap(getApi().security.clearCredentials(pool))
      set({ status, loadStatus: 'ready', error: null })
      void useProxyStore.getState().loadConfig()
      return status
    } finally {
      set({ busy: null })
    }
  },

  rotateKey: async () => {
    set({ busy: 'rotating' })
    try {
      const status = await unwrap(getApi().security.rotateKey())
      set({ status, loadStatus: 'ready', error: null })
      return status
    } finally {
      set({ busy: null })
    }
  },

  reveal: async (which) => unwrap(getApi().security.revealLocations(which)),
}))

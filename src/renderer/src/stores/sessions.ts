import { create } from 'zustand'
import type { AppError, BrowserSession, SessionStatus } from '@shared/types'
import { getApi, toAppError, unwrap } from '../lib/api'
import type { LoadStatus } from '../lib/result'

interface SessionsState {
  /** Keyed by session id. Closed/errored sessions are kept so run pages can show the final state. */
  sessions: Record<string, BrowserSession>
  /**
   * For sessions that reached 'error': the status observed right before the error event.
   * Lets the launch panel mark the step that was actually in progress when the failure happened.
   */
  statusBeforeError: Record<string, SessionStatus>
  status: LoadStatus
  error: AppError | null
  load: () => Promise<void>
  upsert: (session: BrowserSession) => void
  remove: (id: string) => void
  /** Per-session in-flight flags for Close / Screenshot / Bring to front buttons. */
  busy: Record<string, 'closing' | 'screenshot' | 'focusing' | undefined>
  /** True while `launcher.closeAll` runs. */
  closingAll: boolean
  close: (sessionId: string) => Promise<void>
  /** Close several sessions; resolves with the ids that failed (never throws). */
  closeMany: (sessionIds: readonly string[]) => Promise<string[]>
  /** Terminate every open browser session through the launcher. Throws ApiError on failure. */
  closeAll: () => Promise<void>
  screenshot: (sessionId: string) => Promise<string>
  /** Bring the session's browser window to the front. Throws ApiError on failure. */
  focus: (sessionId: string) => Promise<void>
}

/**
 * A session is "live" until the main process reports it closed. An 'error' session is NOT dead:
 * after a navigation failure the browser window stays open for inspection, and even a session that
 * failed before the browser started remains in the main process's live list until it is dismissed
 * with Close. Only 'closed' sessions leave the live list.
 */
export function isSessionLive(session: BrowserSession | null | undefined): boolean {
  return !!session && session.status !== 'closed'
}

/** A session that is starting, open or closing — i.e. counted as "active" (mirrors the dashboard.stats count). */
export function isSessionActive(session: BrowserSession | null | undefined): boolean {
  return !!session && session.status !== 'closed' && session.status !== 'error'
}

/** Merge a session update into the map by id, recording the pre-error status when a session fails. */
export function mergeSessionUpdate(
  state: Pick<SessionsState, 'sessions' | 'statusBeforeError'>,
  session: BrowserSession,
): Pick<SessionsState, 'sessions' | 'statusBeforeError'> {
  const previous = state.sessions[session.id]
  const statusBeforeError = { ...state.statusBeforeError }
  if (session.status === 'error') {
    if (previous && previous.status !== 'error' && previous.status !== 'closed') statusBeforeError[session.id] = previous.status
  } else if (session.status === 'closed') {
    delete statusBeforeError[session.id]
  } else if (previous?.status === 'error') {
    // Recovered from error (not something the main process does today, but keep the record consistent).
    delete statusBeforeError[session.id]
  }
  return { sessions: { ...state.sessions, [session.id]: session }, statusBeforeError }
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: {},
  statusBeforeError: {},
  status: 'idle',
  error: null,
  busy: {},
  closingAll: false,

  load: async () => {
    set({ status: 'loading', error: null })
    try {
      const active = await unwrap(getApi().browser.listActive())
      set((state) => {
        let next: Pick<SessionsState, 'sessions' | 'statusBeforeError'> = { sessions: state.sessions, statusBeforeError: state.statusBeforeError }
        for (const session of active) next = mergeSessionUpdate(next, session)
        return { ...next, status: 'ready' }
      })
    } catch (err) {
      set({ status: 'error', error: toAppError(err) })
    }
  },

  upsert: (session) => set((state) => mergeSessionUpdate(state, session)),

  remove: (id) =>
    set((state) => {
      if (!(id in state.sessions)) return state
      const sessions = { ...state.sessions }
      delete sessions[id]
      const statusBeforeError = { ...state.statusBeforeError }
      delete statusBeforeError[id]
      return { sessions, statusBeforeError }
    }),

  close: async (sessionId) => {
    set((state) => ({ busy: { ...state.busy, [sessionId]: 'closing' } }))
    try {
      await unwrap(getApi().browser.close(sessionId))
    } finally {
      set((state) => ({ busy: { ...state.busy, [sessionId]: undefined } }))
    }
  },

  closeMany: async (sessionIds) => {
    const results = await Promise.allSettled(sessionIds.map((id) => get().close(id)))
    return sessionIds.filter((_, index) => results[index]?.status === 'rejected')
  },

  closeAll: async () => {
    set({ closingAll: true })
    try {
      await unwrap(getApi().launcher.closeAll())
    } finally {
      set({ closingAll: false })
    }
  },

  focus: async (sessionId) => {
    set((state) => ({ busy: { ...state.busy, [sessionId]: 'focusing' } }))
    try {
      await unwrap(getApi().browser.focus(sessionId))
    } finally {
      set((state) => ({ busy: { ...state.busy, [sessionId]: undefined } }))
    }
  },

  screenshot: async (sessionId) => {
    set((state) => ({ busy: { ...state.busy, [sessionId]: 'screenshot' } }))
    try {
      return await unwrap(getApi().browser.screenshot(sessionId))
    } finally {
      set((state) => ({ busy: { ...state.busy, [sessionId]: undefined } }))
    }
  },
}))

export function selectSessionList(sessions: Record<string, BrowserSession>): BrowserSession[] {
  return Object.values(sessions).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

/** Every session that has not been closed (includes 'error' sessions, which still offer Close / Screenshot). */
export function selectLiveSessions(sessions: Record<string, BrowserSession>): BrowserSession[] {
  return selectSessionList(sessions).filter((s) => isSessionLive(s))
}

/** Sessions that are starting, open or closing — for "active sessions" counters. */
export function selectActiveSessions(sessions: Record<string, BrowserSession>): BrowserSession[] {
  return selectSessionList(sessions).filter((s) => isSessionActive(s))
}

/** The most recent session for a run (live preferred). */
export function selectSessionForRun(sessions: Record<string, BrowserSession>, runId: string): BrowserSession | null {
  const matches = selectSessionList(sessions).filter((s) => s.runId === runId)
  return matches.find((s) => isSessionLive(s)) ?? matches[0] ?? null
}

/** The single session the SESSION_LIMIT notice talks about: the newest active one, else the newest live one. */
export function selectActiveSession(sessions: Record<string, BrowserSession>): BrowserSession | null {
  return selectActiveSessions(sessions)[0] ?? selectLiveSessions(sessions)[0] ?? null
}

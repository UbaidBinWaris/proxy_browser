import { create } from 'zustand'
import type { AppError, IpInfo, ProductKey, ProviderId, ProviderInfo, ProxyConfigStatus, ProxySession, ProxyTestResult } from '@shared/types'
import { getApi, toAppError, unwrap } from '../lib/api'
import type { LoadStatus } from '../lib/result'

interface ProxyState {
  /** Configuration of the default provider (settings.defaultProviderId). */
  config: ProxyConfigStatus | null
  /** Every registered provider with capabilities and status (no secrets), in picker order; null until loaded. */
  providers: ProviderInfo[] | null
  configStatus: LoadStatus
  configError: AppError | null
  sessions: ProxySession[]
  sessionsStatus: LoadStatus
  sessionsError: AppError | null
  /** Result of the last raw gateway test (Settings → Advanced → Proxy keys). */
  gatewayTest: ProxyTestResult | null
  gatewayTesting: boolean
  /** Product of the gateway test in flight (or of the last one). */
  gatewayPool: ProductKey | null
  /** Provider of the gateway test in flight (or of the last one). */
  gatewayProvider: ProviderId | null
  /** Profile ids with an in-flight test or rotate call. */
  busyProfiles: Record<string, 'testing' | 'rotating' | undefined>
  loadConfig: () => Promise<void>
  loadSessions: () => Promise<void>
  upsertSession: (session: ProxySession) => void
  /** Raw gateway test through a provider product (default: the settings' default provider/product). Never throws. */
  testGateway: (pool?: ProductKey, providerId?: ProviderId) => Promise<ProxyTestResult>
  testProfile: (profileId: string) => Promise<ProxyTestResult>
  rotateProfile: (profileId: string) => Promise<ProxySession>
  getCurrentIp: (profileId: string | null) => Promise<IpInfo>
}

export function upsertProxySession(sessions: ProxySession[], session: ProxySession): ProxySession[] {
  const exists = sessions.some((s) => s.id === session.id)
  const next = exists ? sessions.map((s) => (s.id === session.id ? session : s)) : [session, ...sessions]
  return next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export const useProxyStore = create<ProxyState>((set) => ({
  config: null,
  providers: null,
  configStatus: 'idle',
  configError: null,
  sessions: [],
  sessionsStatus: 'idle',
  sessionsError: null,
  gatewayTest: null,
  gatewayTesting: false,
  gatewayPool: null,
  gatewayProvider: null,
  busyProfiles: {},

  loadConfig: async () => {
    set((state) => ({ configStatus: state.config ? state.configStatus : 'loading', configError: null }))
    try {
      const [config, providers] = await Promise.all([unwrap(getApi().proxy.getConfigStatus()), unwrap(getApi().proxy.providers())])
      set({ config, providers, configStatus: 'ready' })
    } catch (err) {
      set({ configStatus: 'error', configError: toAppError(err) })
    }
  },

  loadSessions: async () => {
    set((state) => ({ sessionsStatus: state.sessions.length > 0 ? state.sessionsStatus : 'loading', sessionsError: null }))
    try {
      const sessions = await unwrap(getApi().proxy.listSessions())
      set({ sessions: sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), sessionsStatus: 'ready' })
    } catch (err) {
      set({ sessionsStatus: 'error', sessionsError: toAppError(err) })
    }
  },

  upsertSession: (session) => set((state) => ({ sessions: upsertProxySession(state.sessions, session) })),

  testGateway: async (pool, providerId) => {
    set({ gatewayTesting: true, gatewayPool: pool ?? null, gatewayProvider: providerId ?? null })
    try {
      const result = await unwrap(
        pool === undefined
          ? getApi().proxy.testConnection(null)
          : providerId === undefined
            ? getApi().proxy.testConnection(null, pool)
            : getApi().proxy.testConnection(null, pool, providerId),
      )
      set({ gatewayTest: result })
      return result
    } catch (err) {
      const error = toAppError(err)
      const result: ProxyTestResult = { status: 'failed', sessionId: null, ip: null, error }
      set({ gatewayTest: result })
      return result
    } finally {
      set({ gatewayTesting: false })
    }
  },

  testProfile: async (profileId) => {
    set((state) => ({ busyProfiles: { ...state.busyProfiles, [profileId]: 'testing' } }))
    try {
      return await unwrap(getApi().proxy.testConnection(profileId))
    } finally {
      set((state) => ({ busyProfiles: { ...state.busyProfiles, [profileId]: undefined } }))
    }
  },

  rotateProfile: async (profileId) => {
    set((state) => ({ busyProfiles: { ...state.busyProfiles, [profileId]: 'rotating' } }))
    try {
      const session = await unwrap(getApi().proxy.rotateSession(profileId))
      set((state) => ({ sessions: upsertProxySession(state.sessions, session) }))
      return session
    } finally {
      set((state) => ({ busyProfiles: { ...state.busyProfiles, [profileId]: undefined } }))
    }
  },

  getCurrentIp: async (profileId) => unwrap(getApi().proxy.getCurrentIp(profileId)),
}))

export function selectProxySessionForProfile(sessions: ProxySession[], profileId: string): ProxySession | null {
  return sessions.find((s) => s.profileId === profileId) ?? null
}

/** The most recently checked proxy session whose last verified exit IP is `ip` (sessions are kept newest-first). */
export function selectProxySessionForIp(sessions: ProxySession[], ip: string | null | undefined): ProxySession | null {
  if (!ip) return null
  return sessions.find((s) => s.lastIp === ip) ?? null
}

/** True only for the raw gateway record: no profile and no sticky session id. */
export function isGatewaySession(session: Pick<ProxySession, 'profileId' | 'sessionId'>): boolean {
  return session.profileId === null && session.sessionId === null
}

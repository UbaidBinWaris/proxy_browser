import { IPC } from '@shared/ipc'
import type { DashboardStats, IpInfo, ProxySession, SessionStatus } from '@shared/types'

import type { IpcDeps } from './deps'
import { NoArgs, spec } from './handle'
import type { HandlerSpec } from './handle'

/** Session statuses counted as "active" on the dashboard. */
export const ACTIVE_SESSION_STATUSES: readonly SessionStatus[] = ['starting', 'verifying-proxy', 'launching', 'open', 'closing']

const RECENT_RUNS_LIMIT = 10

/** Rebuild an `IpInfo` from the most recently *checked* working proxy session (profile or gateway), if any. */
export function currentIpFromSessions(sessions: readonly ProxySession[], provider: IpInfo['provider']): IpInfo | null {
  const checkedAt = (session: ProxySession): number => Date.parse(session.lastCheckedAt ?? session.updatedAt) || 0
  const latest = sessions
    .filter((session) => session.status === 'working' && session.lastIp !== null)
    .sort((a, b) => checkedAt(b) - checkedAt(a))[0]
  if (!latest || latest.lastIp === null) return null
  return {
    ip: latest.lastIp,
    country: latest.country,
    countryCode: latest.countryCode,
    region: latest.region,
    city: latest.city,
    postalCode: latest.postalCode,
    isp: latest.isp,
    asn: latest.asn,
    latencyMs: latest.latencyMs ?? 0,
    provider,
    checkedAt: latest.lastCheckedAt ?? latest.updatedAt,
  }
}

export function dashboardHandlers(deps: IpcDeps): HandlerSpec[] {
  return [
    spec(IPC.dashboard.stats, NoArgs, async (): Promise<DashboardStats> => {
      const settings = deps.db.settings.get()
      const sessions = deps.proxy.listSessions()
      return {
        totalProfiles: deps.db.profiles.count(),
        activeSessions: deps.browser.listActive().filter((s) => ACTIVE_SESSION_STATUSES.includes(s.status)).length,
        workingProxies: deps.db.proxySessions.countByStatus('working'),
        failedProxies: deps.db.proxySessions.countByStatus('failed'),
        currentIp: currentIpFromSessions(sessions, settings.ipCheckProvider),
        recentRuns: deps.db.testRuns.list(RECENT_RUNS_LIMIT),
        proxyConfigured: deps.proxy.providers().some((provider) => provider.status.configured),
        browsers: await deps.provisioner.status(),
      }
    }),
  ]
}

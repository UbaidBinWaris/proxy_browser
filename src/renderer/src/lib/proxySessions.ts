import type { Profile, ProxySession } from '@shared/types'
import { isGatewaySession } from '../stores/proxy'

/** Display name for a proxy session row. "Gateway" only for the raw gateway record (no profile, no sticky id). */
export function proxySessionName(session: ProxySession, profile: Profile | null): string {
  if (profile) return profile.name
  if (session.profileId) return 'Deleted profile'
  return isGatewaySession(session) ? 'Gateway' : 'Unassigned sticky session'
}

/** Why Rotate is unavailable for a row, or null when it can rotate (a sticky profile that still exists). */
export function rotateDisabledReason(session: ProxySession, profile: Profile | null): string | null {
  if (!session.profileId) return isGatewaySession(session) ? 'The gateway has no sticky session to rotate.' : 'This session is not assigned to a profile.'
  if (!profile) return 'The profile for this session was deleted.'
  if (profile.proxyMode === 'none') return 'This profile connects directly (no proxy).'
  if (profile.proxyMode === 'dataimpulse-rotating') return 'Rotating profiles get a new exit IP on every connection; there is no sticky session to rotate.'
  return null
}

/** Why Test is unavailable for a row, or null when the profile can be tested. */
export function testDisabledReason(session: ProxySession, profile: Profile | null): string | null {
  if (!session.profileId) return 'Test the gateway from Settings → Advanced → Proxy keys.'
  if (!profile) return 'The profile for this session was deleted.'
  if (profile.proxyMode === 'none') return 'This profile connects directly (no proxy).'
  return null
}

/** Session id column: the sticky id, "rotating" for the gateway and rotating profiles, "none" for direct, otherwise a dash. */
export function proxySessionIdLabel(session: ProxySession, profile: Profile | null): string {
  if (session.sessionId) return session.sessionId
  if (isGatewaySession(session) || profile?.proxyMode === 'dataimpulse-rotating') return 'rotating'
  if (profile?.proxyMode === 'none') return 'none'
  return '—'
}

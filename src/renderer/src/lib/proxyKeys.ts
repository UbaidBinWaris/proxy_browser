/**
 * Presentation of proxy credentials without ever handling them (pure, unit-tested):
 * the sidebar status pill, the one-line per-pool status and which pools can be
 * updated partially (only vault entries: the main process merges with them).
 */
import type { ProxyConfigStatus, ProxyPool, ProxyPoolStatus, ProxySession, ProxyStatus } from '@shared/types'
import { PROXY_POOLS } from '@shared/types'
import type { StatusTone } from './security'
import { CREDENTIAL_SOURCE_META } from './setup'

export const POOL_TAB_LABELS: Record<ProxyPool, string> = { residential: 'Residential', mobile: 'Mobile' }

export interface ProxyPill {
  label: string
  tone: StatusTone
}

/** Sidebar footer pill: "Proxy ready" when any pool has credentials, "Proxy not set" otherwise. */
export function proxyStatusPill(config: Pick<ProxyConfigStatus, 'configured'> | null): ProxyPill {
  if (!config) return { label: 'Proxy …', tone: 'muted' }
  return config.configured ? { label: 'Proxy ready', tone: 'success' } : { label: 'Proxy not set', tone: 'warning' }
}

export function poolStatusFor(pools: readonly ProxyPoolStatus[] | null | undefined, pool: ProxyPool): ProxyPoolStatus | null {
  return pools?.find((status) => status.pool === pool) ?? null
}

/** Pools without credentials (all of them while the status is unknown is NOT assumed: unknown → []). */
export function unconfiguredPools(pools: readonly ProxyPoolStatus[] | null | undefined): ProxyPool[] {
  if (!pools) return []
  return PROXY_POOLS.filter((pool) => !(poolStatusFor(pools, pool)?.configured ?? false))
}

/** True when the pool's credentials live in the vault, so empty fields can mean "keep the stored value". */
export function supportsPartialUpdate(status: Pick<ProxyPoolStatus, 'configured' | 'source'> | null | undefined): boolean {
  return status?.configured === true && status.source === 'vault'
}

/** "Configured · be****91 · Encrypted vault" / "Not set up". */
export function poolKeyLine(status: ProxyPoolStatus | null): string {
  if (!status?.configured) return 'Not set up'
  return ['Configured', status.usernameMasked, CREDENTIAL_SOURCE_META[status.source].label].filter((part): part is string => Boolean(part)).join(' · ')
}

/** Placeholder of a write-only field whose stored value is kept when left empty. */
export function unchangedPlaceholder(masked: string | null | undefined): string {
  return masked ? `unchanged: ${masked}` : 'unchanged'
}

export interface PoolTest {
  status: ProxyStatus
  at: string
}

/**
 * Last raw-gateway test of a pool. There is one gateway session row; it records the pool it last
 * tested, so only that pool has a "last tested" time.
 */
export function lastPoolTest(sessions: readonly ProxySession[], pool: ProxyPool): PoolTest | null {
  const gateway = sessions.find((session) => session.profileId === null && session.sessionId === null)
  if (!gateway || gateway.pool !== pool || !gateway.lastCheckedAt) return null
  return { status: gateway.status, at: gateway.lastCheckedAt }
}

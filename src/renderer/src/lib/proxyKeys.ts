/**
 * Presentation of proxy credentials without ever handling them (pure, unit-tested):
 * the sidebar status pill, the one-line per-product status and which products can be
 * updated partially (only vault entries: the main process merges with them).
 */
import type { ProductKey, ProviderId, ProxyConfigStatus, ProxyPoolStatus, ProxySession, ProxyStatus } from '@shared/types'
import { DEFAULT_PROVIDER_ID } from '@shared/types'
import type { ProviderLike } from './providers'
import type { StatusTone } from './security'
import { CREDENTIAL_SOURCE_META } from './setup'

export interface ProxyPill {
  label: string
  tone: StatusTone
}

/** Sidebar footer pill: "Proxy ready" when any product has credentials, "Proxy not set" otherwise. */
export function proxyStatusPill(config: Pick<ProxyConfigStatus, 'configured'> | null): ProxyPill {
  if (!config) return { label: 'Proxy …', tone: 'muted' }
  return config.configured ? { label: 'Proxy ready', tone: 'success' } : { label: 'Proxy not set', tone: 'warning' }
}

/** The pill over every provider: ready when any of them has credentials. */
export function providersStatusPill(providers: readonly Pick<ProviderLike, 'status'>[] | null): ProxyPill {
  if (!providers) return proxyStatusPill(null)
  return proxyStatusPill({ configured: providers.some((provider) => provider.status?.configured === true) })
}

export function poolStatusFor(pools: readonly ProxyPoolStatus[] | null | undefined, pool: ProductKey): ProxyPoolStatus | null {
  return pools?.find((status) => status.pool === pool) ?? null
}

/** Products without credentials, in status order (unknown status → []). */
export function unconfiguredPools(pools: readonly ProxyPoolStatus[] | null | undefined): ProductKey[] {
  if (!pools) return []
  return pools.filter((status) => !status.configured).map((status) => status.pool)
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
 * Last raw-gateway test of a provider product. There is one gateway session row; it records the
 * provider and product it last tested, so only that one has a "last tested" time.
 */
export function lastPoolTest(sessions: readonly ProxySession[], pool: ProductKey, providerId: ProviderId = DEFAULT_PROVIDER_ID): PoolTest | null {
  const gateway = sessions.find((session) => session.profileId === null && session.sessionId === null)
  if (!gateway || gateway.pool !== pool || gateway.provider !== providerId || !gateway.lastCheckedAt) return null
  return { status: gateway.status, at: gateway.lastCheckedAt }
}

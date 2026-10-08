import type { ProviderId, ProviderInfo } from '@shared/types'
import { DEFAULT_PROVIDER_ID } from '@shared/types'
import { findProvider } from '@/lib/providers'
import { useProxyStore } from '@/stores/proxy'

/** Registered proxy providers (capabilities + status, no secrets); null until `proxy.providers()` answered. */
export function useProviders(): ProviderInfo[] | null {
  return useProxyStore((s) => s.providers)
}

/**
 * The provider a record names (profiles, runs and sessions recorded before providers existed are
 * DataImpulse ones); null while loading or when this build does not know the id.
 */
export function useProvider(id: ProviderId | null | undefined): ProviderInfo | null {
  const providers = useProviders()
  return findProvider(providers, id ?? DEFAULT_PROVIDER_ID)
}

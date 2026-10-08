/**
 * Provider-driven presentation (pure, unit-tested). Every provider name, product label, default
 * gateway, extra credential field, target mode and encoding option shown in the UI comes from the
 * capabilities the main process reports through `proxy.providers()` — never from constants that
 * name one provider.
 */
import type { ProductKey, ProviderCapabilities, ProviderId, ProviderInfo, TargetMode } from '@shared/types'
import { DEFAULT_PROVIDER_ID } from '@shared/types'

/** The parts of a provider the presentation helpers need (tests pass plain objects). */
export type ProviderLike = Pick<ProviderInfo, 'id' | 'displayName' | 'capabilities'> & {
  status?: Pick<ProviderInfo['status'], 'configured' | 'pools'>
  sessionTemplate?: string | null
}

export function findProvider<P extends ProviderLike>(providers: readonly P[] | null | undefined, id: ProviderId | null | undefined): P | null {
  if (!providers || !id) return null
  return providers.find((provider) => provider.id === id) ?? null
}

/** "DataImpulse"; the id itself for a provider this build does not know; em dash for none. */
export function providerName(providers: readonly ProviderLike[] | null | undefined, id: ProviderId | null | undefined): string {
  if (!id) return '—'
  return findProvider(providers, id)?.displayName ?? id
}

/** "Residential" → "Residential", "isp-static" → "Isp static" (fallback when the provider does not declare the product). */
function titleCase(key: string): string {
  const spaced = key.replace(/-/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** The provider's label for a product ("Residential"); a readable form of the key when unknown. */
export function productLabelFor(provider: Pick<ProviderLike, 'capabilities'> | null | undefined, product: ProductKey): string {
  return provider?.capabilities.products.find((candidate) => candidate.key === product)?.label ?? titleCase(product)
}

/** "DataImpulse Residential" (or just "Residential" when the provider is unknown). */
export function providerProductLabel(provider: Pick<ProviderLike, 'displayName' | 'capabilities'> | null | undefined, product: ProductKey): string {
  const label = productLabelFor(provider, product)
  return provider ? `${provider.displayName} ${label}` : label
}

/** "DataImpulse · Residential" for status cards, run details and history; "Direct (no proxy)" without a product. */
export function connectionLabel(providers: readonly ProviderLike[] | null | undefined, providerId: ProviderId | null | undefined, product: ProductKey | null | undefined): string {
  if (!product) return 'Direct (no proxy)'
  const provider = findProvider(providers, providerId ?? DEFAULT_PROVIDER_ID)
  return `${provider?.displayName ?? providerId ?? DEFAULT_PROVIDER_ID} · ${productLabelFor(provider, product)}`
}

/** Products a provider offers, in capability order. */
export function productKeys(provider: Pick<ProviderLike, 'capabilities'> | null | undefined): ProductKey[] {
  return provider?.capabilities.products.map((product) => product.key) ?? []
}

/** Products with saved credentials (empty while the status is unknown). */
export function configuredProductKeys(provider: ProviderLike | null | undefined): ProductKey[] {
  return provider?.status?.pools.filter((pool) => pool.configured).map((pool) => pool.pool) ?? []
}

/** Providers with at least one configured product, in picker order. */
export function configuredProviders<P extends ProviderLike>(providers: readonly P[] | null | undefined): P[] {
  return (providers ?? []).filter((provider) => provider.status?.configured === true)
}

/**
 * Providers to offer in a profile / launcher picker: the configured ones, plus `current` (so an
 * existing selection stays visible even when its credentials were removed). Falls back to every
 * provider while none is configured, so the picker is never empty.
 */
export function selectableProviders<P extends ProviderLike>(providers: readonly P[] | null | undefined, current?: ProviderId | null): P[] {
  const all = providers ?? []
  const configured = configuredProviders(all)
  const base = configured.length > 0 ? configured : [...all]
  if (current && !base.some((provider) => provider.id === current)) {
    const extra = all.find((provider) => provider.id === current)
    if (extra) return [...base, extra]
  }
  return base
}

/** Target modes the provider supports (all of `fallback` while it is unknown). */
export function supportedTargetModes(provider: Pick<ProviderLike, 'capabilities'> | null | undefined, fallback: readonly TargetMode[]): TargetMode[] {
  return provider ? [...provider.capabilities.targetModes] : [...fallback]
}

/** The provider's default gateway, or null while unknown. */
export function providerDefaults(provider: Pick<ProviderLike, 'capabilities'> | null | undefined): ProviderCapabilities['defaults'] | null {
  return provider?.capabilities.defaults ?? null
}

/** Human labels for the encoding values the built-in dialects use; unknown values are shown as they are. */
const ENCODING_LABELS: Record<string, string> = {
  'remove-spaces': 'Remove spaces',
  underscore: 'Replace spaces with underscores',
  keep: 'Keep spaces',
}

/** Select options for a provider's encodings; the first (the provider's default) says so: "Remove spaces (DataImpulse default)". */
export function encodingOptionsFor(provider: Pick<ProviderLike, 'displayName' | 'capabilities'>): Array<{ value: string; label: string }> {
  return (provider.capabilities.encodingOptions ?? []).map((value, index) => {
    const label = ENCODING_LABELS[value] ?? value
    return { value, label: index === 0 ? `${label} (${provider.displayName} default)` : label }
  })
}

/** Providers that let the user choose how multi-word place names are written. */
export function providersWithEncodings<P extends ProviderLike>(providers: readonly P[] | null | undefined): P[] {
  return (providers ?? []).filter((provider) => (provider.capabilities.encodingOptions?.length ?? 0) > 0)
}

/**
 * Compact label for a run/session/profile in tables and badges: the product ("Residential") while
 * a single provider is registered, "<Provider> · <product>" once there are several; "Direct (no
 * proxy)" without a product.
 */
export function recordPoolLabel(providers: readonly ProviderLike[] | null | undefined, providerId: ProviderId | null | undefined, product: ProductKey | null | undefined): string {
  if (!product) return 'Direct (no proxy)'
  if ((providers?.length ?? 0) > 1) return connectionLabel(providers, providerId, product)
  return productLabelFor(findProvider(providers, providerId ?? DEFAULT_PROVIDER_ID), product)
}

/** "DataImpulse · sticky", "DataImpulse · rotating", "Direct (no proxy)". */
export function proxyModeLabel(mode: 'none' | 'sticky' | 'rotating', providerDisplayName: string | null | undefined): string {
  if (mode === 'none') return 'Direct (no proxy)'
  return `${providerDisplayName ?? 'Proxy'} · ${mode}`
}

/**
 * Provider-neutral targeting text helpers.
 *
 * Used by neutral code (proxy manager location comparison, the locations
 * service, the launcher) that must not depend on any one provider's dialect.
 * Provider dialects may use them too; `providers/dataimpulse.ts` re-exports
 * them so existing imports keep working. User-facing messages take the
 * provider's display name and product label instead of naming a provider.
 */
import { productLabel } from '../../shared/types'
import type { ProductKey, ProviderCapabilities } from '../../shared/types'

/** How multi-word place names are joined (a provider's `encoding` option). */
export type TargetingEncoding = 'remove-spaces' | 'underscore' | 'keep'
export const TARGETING_ENCODINGS: readonly TargetingEncoding[] = ['remove-spaces', 'underscore', 'keep']
export const DEFAULT_TARGETING_ENCODING: TargetingEncoding = 'remove-spaces'

/** The provider facts a not-configured message needs. */
export interface ProviderLabels {
  displayName: string
  capabilities: Pick<ProviderCapabilities, 'products'>
}

/** Message for a provider without any saved credentials. */
export function notConfiguredMessage(displayName: string): string {
  return `Proxy credentials are not configured. Enter and save your ${displayName} credentials in the app (first-run setup or Settings) to use the proxy modes.`
}

/**
 * Message for a request against a product that has no credentials ("DataImpulse Mobile
 * credentials are not configured…"), or one the provider does not offer at all.
 */
export function productNotConfiguredMessage(provider: ProviderLabels, product: ProductKey): string {
  const offered = provider.capabilities.products.some((candidate) => candidate.key === product)
  if (!offered) {
    const available = provider.capabilities.products.map((candidate) => candidate.label).join(', ')
    return `${provider.displayName} does not offer a "${product}" product${available ? ` (available: ${available})` : ''}. Pick another product in the profile or launcher.`
  }
  return `${provider.displayName} ${productLabel(provider.capabilities, product)} credentials are not configured. Add them under Settings → Advanced → Proxy keys.`
}

/**
 * Encode a human place name as ASCII, lower-case, no punctuation/apostrophes,
 * words joined according to `encoding`. Also the comparison key for place names.
 *   "New Jersey"  → "newjersey"  ('remove-spaces', the default)
 *   "'Ewa Beach"  → "ewabeach"
 *   "St. Louis"   → "stlouis"    ('underscore' → "st_louis", 'keep' → "st louis")
 *   "Winston-Salem" → "winstonsalem"
 */
export function encodePlaceName(name: string, encoding: TargetingEncoding = DEFAULT_TARGETING_ENCODING): string {
  const words = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
  switch (encoding) {
    case 'underscore':
      return words.join('_')
    case 'keep':
      return words.join(' ')
    case 'remove-spaces':
      return words.join('')
  }
}

/** State name in the same encoding ("New Jersey" → "newjersey"). */
export function encodeStateName(state: string, encoding: TargetingEncoding = DEFAULT_TARGETING_ENCODING): string {
  return encodePlaceName(state, encoding)
}

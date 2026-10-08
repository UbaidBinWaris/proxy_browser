/**
 * Provider registry: maps a provider id to the `GatewayProvider` that runs its
 * dialect. Providers are built-in modules only (no runtime loading): a dialect
 * sees credentials, so third-party code must never be loaded into this path.
 *
 * Adding a provider: write its dialect (./<id>.ts, official docs URL in the
 * header) with a golden-table test, add its id to `PROVIDER_IDS`
 * (src/shared/types.ts) and append the dialect to `BUILT_IN_DIALECTS` below.
 * tests/provider-dialect-contract.test.ts then runs the contract suite on it.
 */
import { AppException } from '../../contracts'
import type { IpChecker, Logger, ProxyProviderResolver } from '../../contracts'
import { dataImpulseDialect } from './dataimpulse'
import type { ProviderCapabilities, ProviderDialect, ProviderId } from './dialect'
import { GatewayProvider } from './gateway-provider'
import type { GatewayProviderSettings } from './gateway-provider'

/** Every built-in dialect, in picker order. */
export const BUILT_IN_DIALECTS: readonly ProviderDialect[] = [dataImpulseDialect]

export interface ProviderRegistryDeps {
  ipChecker: IpChecker
  logger: Logger
}

/** Public, credential-free description of a registered provider. */
export interface ProviderSummary {
  id: ProviderId
  displayName: string
  docsUrl: string
  capabilities: ProviderCapabilities
}

export class ProviderRegistry implements ProxyProviderResolver {
  private readonly deps: ProviderRegistryDeps
  private readonly providers = new Map<ProviderId, GatewayProvider>()

  constructor(deps: ProviderRegistryDeps) {
    this.deps = deps
  }

  /** Create the gateway provider for a dialect. A dialect id can be registered once. */
  register(dialect: ProviderDialect, settings: GatewayProviderSettings = {}): GatewayProvider {
    if (this.providers.has(dialect.id)) {
      throw new AppException('INTERNAL', `Proxy provider "${dialect.id}" is already registered.`)
    }
    const provider = new GatewayProvider({ dialect, ipChecker: this.deps.ipChecker, logger: this.deps.logger, ...settings })
    this.providers.set(dialect.id, provider)
    return provider
  }

  has(id: string): boolean {
    return this.providers.has(id)
  }

  /** Registered provider ids in registration (picker) order. */
  ids(): ProviderId[] {
    return [...this.providers.keys()]
  }

  /** Every registered gateway provider, in registration order. */
  all(): GatewayProvider[] {
    return [...this.providers.values()]
  }

  /** The provider for an id; INVALID_INPUT naming the id when it is unknown (never a silent fallback). */
  get(id: string): GatewayProvider {
    const provider = this.providers.get(id)
    if (!provider) {
      const known = [...this.providers.keys()]
      throw new AppException(
        'INVALID_INPUT',
        `Unknown proxy provider "${id}".`,
        known.length > 0 ? `registered providers: ${known.join(', ')}` : 'no providers are registered',
      )
    }
    return provider
  }

  /** Registered providers in registration order. */
  list(): ProviderSummary[] {
    return [...this.providers.values()].map(({ dialect }) => ({
      id: dialect.id,
      displayName: dialect.displayName,
      docsUrl: dialect.docsUrl,
      capabilities: structuredClone(dialect.capabilities),
    }))
  }
}

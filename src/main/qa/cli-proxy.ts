/**
 * Proxy set-up of the QA CLI (`npm run qa`), kept free of side effects so it can be unit-tested
 * (cli.ts runs on import).
 *
 * Credentials come from the environment only:
 *   QA_PROVIDER, QA_PROVIDER_PRODUCT, QA_PROVIDER_HOST / _PORT / _USERNAME / _PASSWORD,
 *   QA_PROVIDER_EXTRA_<KEY>
 * with `DATAIMPULSE_PROXY_HOST/_PORT/_USERNAME/_PASSWORD` as a documented alias for
 * `QA_PROVIDER=dataimpulse`. The product defaults to QA_PROVIDER_PRODUCT, else the product of
 * the first proxied manifest profile, else the provider's first product.
 */
import { DEFAULT_PROVIDER_ID } from '@shared/types'
import type { ProfileInput, ProviderCapabilities, ProviderId } from '@shared/types'

import { PROVIDER_ENV_KEYS, readProviderEnv } from '../config/env'
import type { ProviderEnvInfo } from '../config/env'
import type { ProxyCredentials } from '../contracts'

/** The provider facts the CLI needs (the provider registry). */
export interface CliProviderLookup {
  has(id: string): boolean
  get(id: string): { name: ProviderId; displayName: string; capabilities: ProviderCapabilities }
}

export interface CliProxySetup {
  /** Provider the environment credentials belong to (DataImpulse when nothing is configured). */
  providerId: ProviderId
  /** Credentials for that provider's product, or null when the environment has none. */
  credentials: ProxyCredentials | null
  /** Values to redact from every report and log line. */
  secrets: string[]
  /** Which variable family supplied the credentials. */
  source: 'QA_PROVIDER' | 'DATAIMPULSE_PROXY' | null
  warnings: string[]
}

type ManifestProfile = Pick<ProfileInput, 'proxyMode' | 'proxyPool'> & { providerId?: string }

function envInfo(providers: CliProviderLookup, id: string): ProviderEnvInfo | null {
  if (!providers.has(id)) return null
  const { capabilities } = providers.get(id)
  return {
    defaults: capabilities.defaults,
    extraFieldKeys: capabilities.extraCredentialFields.map((field) => field.key),
    productKeys: capabilities.products.map((product) => product.key),
  }
}

/**
 * Read the proxy credentials for a CLI run. Throws an Error with a configuration message
 * (variable names only, never values) when QA_PROVIDER* variables are incomplete or invalid, or
 * when a proxied manifest profile names another provider than the environment's credentials.
 */
export function resolveCliProxy(env: NodeJS.ProcessEnv, providers: CliProviderLookup, profiles: readonly ManifestProfile[]): CliProxySetup {
  const read = readProviderEnv(env, (id) => envInfo(providers, id))
  if (read.source === 'QA_PROVIDER' && !read.config) {
    throw new Error(`Proxy variables are incomplete or invalid: ${read.missing.join(', ')}. Set ${PROVIDER_ENV_KEYS.provider} to a supported provider and supply its credentials.`)
  }
  const proxied = profiles.filter((profile) => profile.proxyMode !== 'none')
  const config = read.config
  const providerId = config?.providerId ?? proxied[0]?.providerId ?? DEFAULT_PROVIDER_ID

  if (config) {
    const other = proxied.find((profile) => (profile.providerId ?? DEFAULT_PROVIDER_ID) !== config.providerId)
    if (other) {
      throw new Error(
        `The manifest uses the proxy provider "${other.providerId ?? DEFAULT_PROVIDER_ID}", but the proxy credentials are for "${config.providerId}". Set ${PROVIDER_ENV_KEYS.provider} to match the manifest or export the scenario again with the other provider.`,
      )
    }
  }
  if (!config || !providers.has(providerId)) return { providerId, credentials: null, secrets: [], source: read.source, warnings: read.warnings }

  const provider = providers.get(providerId)
  const product = config.product ?? proxied[0]?.proxyPool ?? provider.capabilities.products[0]?.key
  if (!product) throw new Error(`${provider.displayName} offers no products.`)
  const secretKeys = new Set(provider.capabilities.extraCredentialFields.filter((field) => field.secret).map((field) => field.key))
  const secrets = [config.password, config.username, `${config.username}:${config.password}`, ...Object.entries(config.extras).filter(([key]) => secretKeys.has(key)).map(([, value]) => value)]
  return {
    providerId,
    credentials: { pool: product, host: config.host, port: config.port, username: config.username, password: config.password, sessionTemplate: null, extras: config.extras },
    secrets,
    source: read.source,
    warnings: read.warnings,
  }
}

/** A lookup over dialects (no gateway objects needed), so the CLI can validate its environment before creating anything. */
export function lookupFromDialects(dialects: ReadonlyArray<{ id: ProviderId; displayName: string; capabilities: ProviderCapabilities }>): CliProviderLookup {
  const byId = new Map(dialects.map((dialect) => [dialect.id, dialect]))
  return {
    has: (id) => byId.has(id),
    get: (id) => {
      const dialect = byId.get(id)
      if (!dialect) throw new Error(`Unknown proxy provider "${id}".`)
      return { name: dialect.id, displayName: dialect.displayName, capabilities: dialect.capabilities }
    },
  }
}

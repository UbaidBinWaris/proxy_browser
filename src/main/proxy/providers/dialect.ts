/**
 * Proxy provider dialects.
 *
 * A dialect is the only provider-specific code: it turns credentials plus a
 * request (pool, sticky session, geo target) into the connection the gateway
 * expects, and describes what the provider supports. It is pure, stateless and
 * synchronous: no I/O, no logging, no stored credentials.
 *
 * Everything generic (per-pool credentials, status, connection and credential
 * tests, exit-IP lookup, secret registration) lives in `GatewayProvider`, which
 * implements the `ProxyProvider` contract for any dialect. `ProviderRegistry`
 * maps provider ids to gateway providers.
 *
 * Adding a provider = one dialect file in this folder (official docs URL in its
 * header), a golden-table test, its id in `PROVIDER_IDS` and one line in
 * `registry.ts` (`BUILT_IN_DIALECTS`). See docs/ARCHITECTURE.md → "Proxy providers".
 */
import type { AppError, ProviderCapabilities, ProviderId } from '../../../shared/types'
import type { ProxyCredentials, ProxyRequest } from '../../contracts'

// Capability types are shared with the renderer (they cross IPC in `proxy.providers()`).
export type { ExtraCredentialField, ProviderCapabilities, ProviderId, ProviderProduct, StickyCapabilities } from '../../../shared/types'

/**
 * Decrypted credentials for one product, as handed to a dialect.
 * `extras` carries provider-specific fields declared in
 * `capabilities.extraCredentialFields` (e.g. a Bright Data zone).
 */
export interface ProviderCredentials extends ProxyCredentials {
  extras?: Record<string, string>
}

/** A full connection for one request. Targeting may go in the username OR the password. */
export interface ComposedConnection {
  /** Proxy server URL, e.g. "http://gw.dataimpulse.com:823". */
  server: string
  username: string
  password: string
  /** Human-readable provider parameters; safe to log and show, never contains secrets. */
  targetingString: string
}

/** Per-provider options the gateway resolves at request time (from settings). */
export interface DialectOptions {
  /** One of `capabilities.encodingOptions`; unknown or missing values fall back to the dialect's default. */
  encoding?: string
}

/** User-editable sticky-session template support (placeholders `{username}` and `{session}`). */
export interface SessionTemplateSupport {
  /** Template used when neither the credentials nor the gateway options set one. */
  default: string
  /** Name of the setting/env variable that overrides the default, used in validation errors. */
  settingName: string
}

export interface ProviderDialect {
  readonly id: ProviderId
  readonly displayName: string
  /** Official parameter documentation. */
  readonly docsUrl: string
  readonly capabilities: ProviderCapabilities
  /** Present when the provider's session syntax can be customised with a template. */
  readonly sessionTemplate?: SessionTemplateSupport
  /**
   * Full connection for a request. `credentials.sessionTemplate` has already
   * been resolved by the gateway (saved override → gateway default → dialect default).
   */
  compose(credentials: ProviderCredentials, request: ProxyRequest, options?: DialectOptions): ComposedConnection
  /**
   * Connection for a live check of candidate credentials exactly as entered
   * (rotating, no target). Defaults to `compose()` with a rotating, untargeted request.
   */
  composeCredentialCheck?(credentials: ProviderCredentials): ComposedConnection
  /** Parameter-only description of a request (no login, no password), for previews and records. */
  targetingString(request: ProxyRequest, options?: DialectOptions): string
  /** Deterministic sticky session id for a profile. */
  createSession(profileName: string): string
  /** A new id that always differs from `current`. */
  rotateSession(current: string | null, profileName: string): string
  /**
   * Optional: is this failed check worth re-rolling the sticky session for?
   * Returning false stops the location re-roll early (e.g. the location pool
   * is exhausted and the gateway keeps refusing new sessions). When absent,
   * every failure except rejected credentials is retried.
   */
  isRetryableLocationFailure?(error: AppError): boolean
}

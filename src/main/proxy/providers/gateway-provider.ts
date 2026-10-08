/**
 * Generic gateway proxy provider: implements the `ProxyProvider` contract for
 * any `ProviderDialect`.
 *
 * Holds everything that does not depend on the provider's parameter syntax:
 * the per-pool credential map, runtime credential swaps, the password-free
 * configuration status, connection and candidate-credential tests, the exit-IP
 * lookup and secret registration. The dialect composes the actual connection.
 *
 * Secrets: every saved and candidate password (and `login:password`) is
 * registered with the logger as soon as it is known, and so is every composed
 * password, because some providers put parameters in the password.
 */
import { ProxyCredentialsInputSchema, isValidSessionTemplate } from '../../../shared/types'
import type {
  AppError,
  CredentialSource,
  IpInfo,
  ProductKey,
  ProviderCapabilities,
  ProxyConfigStatus,
  ProxyCredentialsInput,
  ProxyPoolStatus,
  ProxyTestResult,
} from '../../../shared/types'
import { AppException } from '../../contracts'
import type { IpChecker, Logger, ProxyConnection, ProxyProvider, ProxyRequest } from '../../contracts'
import { proxyAuthMessage, stripCredentials } from '../ip-checker'
import { notConfiguredMessage, productNotConfiguredMessage } from '../targeting-text'
import type { ComposedConnection, DialectOptions, ProviderCredentials, ProviderDialect, ProviderId } from './dialect'

/** Fields reported as missing while no credentials are active. */
export const REQUIRED_CREDENTIAL_FIELDS = ['host', 'port', 'username', 'password'] as const

/** Gateway behaviour that is configured per provider, not per credential set. */
export interface GatewayProviderSettings {
  /** Default sticky-session template (dialects with template support only); a template saved with the credentials overrides it. */
  sessionTemplate?: string
  /** Provider encoding option (one of `capabilities.encodingOptions`), read at request time. */
  getEncoding?: () => string
}

export interface GatewayProviderOptions extends GatewayProviderSettings {
  dialect: ProviderDialect
  ipChecker: IpChecker
  logger: Logger
  /** Initial credentials (same as calling `setCredentials` right after construction). */
  credentials?: ProviderCredentials[]
  source?: CredentialSource
}

/** Mask a username as "ab****yz"; very short usernames are fully masked. */
export function maskUsername(username: string): string {
  if (username.length <= 4) return '*'.repeat(Math.max(username.length, 4))
  return `${username.slice(0, 2)}****${username.slice(-2)}`
}

const ROTATING_UNTARGETED = { sessionId: null, target: null, ttlMinutes: null } as const

interface PoolState {
  /** Credentials as saved (status, logging). */
  credentials: ProviderCredentials
  /** Credentials handed to the dialect: `sessionTemplate` resolved (override → gateway default → dialect default). */
  effective: ProviderCredentials
}

export class GatewayProvider implements ProxyProvider {
  readonly name: ProviderId
  readonly dialect: ProviderDialect

  private readonly ipChecker: IpChecker
  private readonly logger: Logger
  private readonly logScope: string
  private readonly defaultTemplate: string | null
  private readonly getEncoding: (() => string) | null
  private readonly pools = new Map<ProductKey, PoolState>()
  private source: CredentialSource = 'none'

  constructor(options: GatewayProviderOptions) {
    this.dialect = options.dialect
    this.name = options.dialect.id
    this.ipChecker = options.ipChecker
    this.logger = options.logger
    this.logScope = `proxy.${options.dialect.id}`
    this.defaultTemplate = this.validateDefaultTemplate(options.sessionTemplate)
    this.getEncoding = options.getEncoding ?? null
    if (options.credentials !== undefined) {
      this.setCredentials(options.credentials, options.source ?? 'vault')
    }
  }

  get displayName(): string {
    return this.dialect.displayName
  }

  get docsUrl(): string {
    return this.dialect.docsUrl
  }

  /** The resolved default template (gateway option → dialect default); null for dialects without template support. */
  get sessionTemplateDefault(): string | null {
    return this.defaultTemplate
  }

  get capabilities(): ProviderCapabilities {
    return this.dialect.capabilities
  }

  isConfigured(): boolean {
    return this.pools.size > 0
  }

  isPoolConfigured(pool: ProductKey): boolean {
    return this.pools.has(pool)
  }

  /** True when the dialect lists the product in its capabilities. */
  offersProduct(product: ProductKey): boolean {
    return this.dialect.capabilities.products.some((candidate) => candidate.key === product)
  }

  /** Replace the whole product set. An empty list clears every product; products the dialect does not offer are skipped. */
  setCredentials(credentials: ProviderCredentials[], source: CredentialSource): void {
    const had = [...this.pools.keys()]
    this.pools.clear()
    for (const entry of credentials) {
      if (!this.offersProduct(entry.pool)) {
        this.logger.warn(this.logScope, `Ignoring saved credentials for "${entry.pool}": ${this.dialect.displayName} does not offer that product`)
        continue
      }
      if (this.pools.has(entry.pool)) {
        this.logger.warn(this.logScope, `Duplicate credentials for the ${entry.pool} pool; keeping the first entry`)
        continue
      }
      const saved: ProviderCredentials = { ...entry, ...(entry.extras ? { extras: { ...entry.extras } } : {}) }
      this.pools.set(entry.pool, { credentials: saved, effective: { ...saved, sessionTemplate: this.resolveTemplate(entry.sessionTemplate, entry.pool) } })
      this.registerCredentialSecrets(entry)
    }
    this.source = this.pools.size > 0 ? source : 'none'
    if (this.pools.size === 0) {
      if (had.length > 0) this.logger.info(this.logScope, 'Proxy credentials cleared; proxy modes are unavailable until credentials are saved again')
      return
    }
    for (const [pool, state] of this.pools) {
      this.logger.info(this.logScope, `Proxy credentials activated for the ${pool} pool`, {
        pool,
        source: this.source,
        host: state.credentials.host,
        port: state.credentials.port,
        username: maskUsername(state.credentials.username),
        templateOverride: state.credentials.sessionTemplate !== null,
      })
    }
    const dropped = had.filter((pool) => !this.pools.has(pool))
    if (dropped.length > 0) this.logger.info(this.logScope, `Proxy credentials removed for pool(s): ${dropped.join(', ')}`)
  }

  getConfigStatus(): ProxyConfigStatus {
    const pools: ProxyPoolStatus[] = this.dialect.capabilities.products.map(({ key: pool }) => {
      const state = this.pools.get(pool)
      return {
        pool,
        configured: state !== undefined,
        host: state?.credentials.host ?? null,
        port: state?.credentials.port ?? null,
        usernameMasked: state ? maskUsername(state.credentials.username) : null,
        source: state ? this.source : 'none',
      }
    })
    // Summary fields describe the primary product: the first configured one in capability order.
    const firstConfigured = this.dialect.capabilities.products.find(({ key }) => this.pools.has(key))
    const primary = (firstConfigured ? this.pools.get(firstConfigured.key) : undefined) ?? null
    return {
      configured: primary !== null,
      pools,
      provider: this.name,
      host: primary?.credentials.host ?? null,
      port: primary?.credentials.port ?? null,
      usernameMasked: primary ? maskUsername(primary.credentials.username) : null,
      missing: primary ? [] : [...REQUIRED_CREDENTIAL_FIELDS],
      source: this.source,
    }
  }

  buildTargetingString(request: ProxyRequest): string {
    return this.dialect.targetingString(request, this.dialectOptions())
  }

  buildProxyConfig(request: ProxyRequest): ProxyConnection {
    const state = this.requirePool(request.pool)
    const composed = this.dialect.compose(state.effective, request, this.dialectOptions())
    // Some providers carry parameters in the password: the composed one is a secret too.
    this.logger.registerSecret(composed.password)
    return this.toConnection(composed, request)
  }

  async testConnection(request: ProxyRequest): Promise<ProxyTestResult> {
    try {
      const ip = await this.getCurrentIp(request)
      return { status: 'working', sessionId: request.sessionId, ip, error: null }
    } catch (err) {
      const error = err instanceof AppException ? err.toAppError() : toInternalError(err)
      this.logger.warn(this.logScope, 'Proxy test failed', { pool: request.pool, sessionId: request.sessionId, code: error.code, message: error.message })
      return { status: 'failed', sessionId: request.sessionId, ip: null, error }
    }
  }

  /**
   * Live check of candidate credentials through the gateway (rotating mode, no
   * targeting). The active credentials are untouched and nothing is persisted;
   * the input password is registered as a secret so it can never appear in a
   * log line.
   */
  async testCredentials(input: ProxyCredentialsInput): Promise<ProxyTestResult> {
    const parsed = ProxyCredentialsInputSchema.safeParse(input)
    if (!parsed.success) throw new AppException('INVALID_INPUT', firstIssue(parsed.error.issues))
    const c = parsed.data
    if (c.providerId !== this.name) {
      throw new AppException('INVALID_INPUT', `These credentials are for "${c.providerId}", not ${this.dialect.displayName}.`, `provider=${this.name}`)
    }
    if (!this.offersProduct(c.pool)) throw new AppException('INVALID_INPUT', productNotConfiguredMessage(this.dialect, c.pool))
    const candidate: ProviderCredentials = {
      pool: c.pool,
      host: c.host,
      port: c.port,
      username: c.username,
      password: c.password,
      sessionTemplate: null,
      extras: this.declaredExtras(c.extras),
    }
    this.registerCredentialSecrets(candidate)
    const meta = { pool: c.pool, host: c.host, port: c.port, username: maskUsername(c.username) }
    const composed = this.dialect.composeCredentialCheck
      ? this.dialect.composeCredentialCheck(candidate)
      : this.dialect.compose(candidate, { pool: c.pool, ...ROTATING_UNTARGETED }, this.dialectOptions())
    this.logger.registerSecret(composed.password)
    const connection = this.toConnection(composed, { pool: c.pool, ...ROTATING_UNTARGETED })
    this.logger.info(this.logScope, 'Testing candidate proxy credentials (not saved)', meta)
    try {
      const ip = await this.lookup(connection)
      this.logger.info(this.logScope, 'Candidate proxy credentials work', { ...meta, ip: ip.ip, country: ip.countryCode, latencyMs: ip.latencyMs })
      return { status: 'working', sessionId: null, ip, error: null }
    } catch (err) {
      const error = err instanceof AppException ? err.toAppError() : toInternalError(err)
      this.logger.warn(this.logScope, 'Candidate proxy credentials failed', { ...meta, code: error.code, message: error.message })
      return { status: 'failed', sessionId: null, ip: null, error }
    }
  }

  async getCurrentIp(request: ProxyRequest): Promise<IpInfo> {
    const connection = this.buildProxyConfig(request)
    return this.lookup(connection)
  }

  /** Exit-IP lookup through a connection of this provider; a rejected login names the provider. */
  private async lookup(connection: ProxyConnection): Promise<IpInfo> {
    try {
      return await this.ipChecker.lookup(connection)
    } catch (err) {
      if (err instanceof AppException && err.code === 'PROXY_AUTH_FAILED') {
        throw new AppException('PROXY_AUTH_FAILED', proxyAuthMessage(this.dialect.displayName), err.detail)
      }
      throw err
    }
  }

  createSession(profileName: string): string {
    return this.dialect.createSession(profileName)
  }

  rotateSession(currentSessionId: string | null, profileName: string): string {
    return this.dialect.rotateSession(currentSessionId, profileName)
  }

  isRetryableLocationFailure(error: AppError): boolean {
    if (error.code === 'PROXY_AUTH_FAILED') return false
    return this.dialect.isRetryableLocationFailure ? this.dialect.isRetryableLocationFailure(error) : true
  }

  private toConnection(composed: ComposedConnection, request: ProxyRequest): ProxyConnection {
    return {
      server: composed.server,
      username: composed.username,
      password: composed.password,
      pool: request.pool,
      sessionId: request.sessionId,
      target: request.target ? { ...request.target } : null,
      targetingString: composed.targetingString,
    }
  }

  private dialectOptions(): DialectOptions {
    return this.getEncoding ? { encoding: this.getEncoding() } : {}
  }

  private registerCredentialSecrets(credentials: ProviderCredentials): void {
    this.logger.registerSecret(credentials.password)
    this.logger.registerSecret(`${credentials.username}:${credentials.password}`)
    for (const field of this.dialect.capabilities.extraCredentialFields) {
      const value = credentials.extras?.[field.key]
      if (field.secret && value) this.logger.registerSecret(value)
    }
  }

  private validateDefaultTemplate(override: string | undefined): string | null {
    const support = this.dialect.sessionTemplate
    if (!support) return null
    const template = override?.trim() || support.default
    if (!isValidSessionTemplate(template)) {
      throw new AppException('INVALID_INPUT', `${support.settingName} must contain both {username} and {session} placeholders.`, `template="${template}"`)
    }
    return template
  }

  /** Only the extra fields the dialect declares, without empty values. */
  private declaredExtras(extras: Record<string, string> | undefined): Record<string, string> {
    const declared: Record<string, string> = {}
    for (const field of this.dialect.capabilities.extraCredentialFields) {
      const value = extras?.[field.key]
      if (value !== undefined && value !== '') declared[field.key] = value
    }
    return declared
  }

  private resolveTemplate(override: string | null, pool: ProductKey): string | null {
    if (this.defaultTemplate === null) return null
    const candidate = override?.trim()
    if (!candidate) return this.defaultTemplate
    if (!isValidSessionTemplate(candidate)) {
      this.logger.warn(this.logScope, `Ignoring the session template saved with the ${pool} credentials (missing {username}/{session}); using the default`, {
        pool,
        template: candidate,
      })
      return this.defaultTemplate
    }
    return candidate
  }

  private requirePool(pool: ProductKey): PoolState {
    const state = this.pools.get(pool)
    if (!state) {
      throw new AppException(
        'PROXY_NOT_CONFIGURED',
        this.pools.size === 0 && this.offersProduct(pool) ? notConfiguredMessage(this.dialect.displayName) : productNotConfiguredMessage(this.dialect, pool),
        this.pools.size === 0 ? `missing: ${REQUIRED_CREDENTIAL_FIELDS.join(', ')}` : `pool=${pool}; configured: ${[...this.pools.keys()].join(', ')}`,
      )
    }
    return state
  }
}

function firstIssue(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  const issue = issues[0]
  if (!issue) return 'Invalid credentials.'
  const path = issue.path.map(String).join('.')
  return path ? `${path}: ${issue.message}` : issue.message
}

function toInternalError(err: unknown): { code: 'INTERNAL'; message: string; detail: string } {
  const detail = stripCredentials(err instanceof Error ? err.message : String(err))
  return { code: 'INTERNAL', message: 'Unexpected error while testing the proxy. Check the logs for details.', detail }
}

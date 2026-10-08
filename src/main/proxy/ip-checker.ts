/**
 * Exit-IP lookup through (optionally) a proxy, using playwright-core's APIRequest.
 *
 * Providers (selected via settings.ipCheckProvider, with one fallback to the
 * next provider in the list when the configured one fails after retries):
 *   - ip-api  → http://ip-api.com/json/?fields=...   (HTTP only on the free tier; `zip` is requested)
 *   - ipinfo  → https://ipinfo.io/json                (`postal`)
 *   - ipwhois → https://ipwho.is/                     (`postal`)
 *
 * Every provider reports the exit IP's postal code, which is what lets a ZIP
 * target be verified exactly (IpInfo.postalCode).
 *
 * Nothing in this module ever logs or includes the proxy password in an error.
 */
import { request } from 'playwright-core'
import type { APIRequestContext } from 'playwright-core'
import { IP_CHECK_PROVIDERS } from '../../shared/types'
import type { AppSettings, IpCheckProvider, IpInfo } from '../../shared/types'
import { AppException } from '../contracts'
import type { IpChecker, Logger, ProxyConnection } from '../contracts'

export interface IpCheckerOptions {
  getSettings: () => AppSettings
  logger: Logger
}

export const IP_CHECK_ENDPOINTS: Record<IpCheckProvider, string> = {
  'ip-api': 'http://ip-api.com/json/?fields=status,message,country,countryCode,regionName,city,zip,isp,as,query',
  ipinfo: 'https://ipinfo.io/json',
  ipwhois: 'https://ipwho.is/',
}

const LOG_SCOPE = 'proxy.ip-check'
const BACKOFF_BASE_MS = 500

type JsonRecord = Record<string, unknown>

/** Remove `user:pass@` credential blocks and bare password-looking tokens from a message. */
export function stripCredentials(message: string): string {
  return message
    .replace(/\/\/[^\s/@]+:[^\s/@]+@/g, '//***:***@')
    .replace(/(^|[\s"'(])[^\s"'(@/]+:[^\s"')@/]+@/g, '$1***:***@')
    .replace(/(password|passwd|pwd)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1$2***')
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

const PROXY_AUTH_MESSAGE =
  'Proxy rejected the credentials (HTTP 407). Re-enter and test the DataImpulse username and password in the app (first-run setup or Settings) and make sure your DataImpulse plan is active.'
const PROXY_DEAD_MESSAGE =
  'Could not connect through the proxy gateway. The proxy may be down or the host/port may be wrong. Verify the proxy host and port in your saved credentials.'

/** Upstream statuses that mean "the proxy gateway failed", not "the IP service failed". */
const PROXY_GATEWAY_STATUSES = new Set([502, 503, 504])

/**
 * Interpret the HTTP status of an IP-check response. Through a proxy, 407 and
 * 502/503/504 come from the gateway itself and are proxy errors; any other
 * non-2xx is the IP service misbehaving. Returns null for a usable response.
 */
export function classifyHttpStatus(status: number, viaProxy: boolean, provider: IpCheckProvider): AppException | null {
  if (status >= 200 && status < 300) return null
  if (status === 407) {
    return new AppException('PROXY_AUTH_FAILED', PROXY_AUTH_MESSAGE, `HTTP 407 from ${provider} request`)
  }
  if (viaProxy && status === 503) {
    // The gateway answered, so host/port/credentials are fine: it had no exit IP for
    // this session + location right now (common for a brand-new sticky id or a ZIP
    // with very few IPs in the pool).
    return new AppException(
      'PROXY_DEAD',
      'The proxy gateway had no exit IP available for this session and location right now (HTTP 503). Launch again for a new session, or widen the target (city or state instead of ZIP).',
      `HTTP 503 from the proxy gateway during the ${provider} request`,
    )
  }
  if (viaProxy && PROXY_GATEWAY_STATUSES.has(status)) {
    return new AppException('PROXY_DEAD', PROXY_DEAD_MESSAGE, `HTTP ${status} from the proxy gateway during the ${provider} request`)
  }
  return new AppException('IP_VERIFY_FAILED', `The IP-check service (${provider}) responded with HTTP ${status}.`, `HTTP ${status}`)
}

/** Map a transport/proxy failure to a human-readable AppException (never leaks credentials). */
export function classifyNetworkError(err: unknown): AppException {
  if (err instanceof AppException) return err
  const raw = errorMessage(err)
  const detail = stripCredentials(raw)
  const lower = detail.toLowerCase()

  if (
    /\b407\b/.test(detail) ||
    lower.includes('proxy authentication required') ||
    lower.includes('proxy auth') ||
    lower.includes('err_proxy_auth_unsupported') ||
    lower.includes('err_proxy_auth_requested') ||
    lower.includes('ns_error_proxy_authentication_failed')
  ) {
    return new AppException('PROXY_AUTH_FAILED', PROXY_AUTH_MESSAGE, detail)
  }
  if (lower.includes('enotfound') || lower.includes('eai_again') || lower.includes('getaddrinfo') || lower.includes('name_not_resolved')) {
    return new AppException(
      'DNS_FAILURE',
      'Could not resolve the proxy or IP-check host name. Check your internet connection and the proxy host in your saved credentials.',
      detail,
    )
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('etimedout')) {
    return new AppException(
      'PROXY_TIMEOUT',
      'The proxy did not respond in time. The exit node may be slow or offline — retry, rotate the session, or increase the IP check timeout in Settings.',
      detail,
    )
  }
  if (
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('tunnel') ||
    lower.includes('socket hang up') ||
    lower.includes('epipe') ||
    lower.includes('ehostunreach') ||
    lower.includes('enetunreach') ||
    lower.includes('proxy_connection_failed') ||
    lower.includes('tunnel_connection_failed') ||
    lower.includes('ns_error_proxy_connection_refused') ||
    lower.includes('connection terminated unexpectedly') ||
    lower.includes('connection closed')
  ) {
    return new AppException('PROXY_DEAD', PROXY_DEAD_MESSAGE, detail)
  }
  return new AppException('IP_VERIFY_FAILED', 'Could not verify the exit IP. The IP-check service returned an unexpected response.', detail)
}

/** Expand an ISO 3166-1 alpha-2 code to an English country name; falls back to the code itself. */
export function countryNameFromCode(code: string | null): string | null {
  if (!code) return null
  const upper = code.trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(upper)) return code
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(upper)
    return name && name !== upper ? name : code
  } catch {
    return code
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null
}

function str(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
const IPV6 = /^[0-9a-f:]+$/i

function requireIp(value: unknown, provider: IpCheckProvider): string {
  const ip = str(value)
  if (!ip || !(IPV4.test(ip) || (ip.includes(':') && IPV6.test(ip)))) {
    throw new AppException(
      'IP_VERIFY_FAILED',
      `The IP-check service (${provider}) did not return a valid IP address.`,
      `received=${JSON.stringify(value)}`,
    )
  }
  return ip
}

/** Normalise an IP-check provider response into IpInfo. Throws IP_VERIFY_FAILED on bad bodies. */
export function parseIpResponse(provider: IpCheckProvider, json: unknown, latencyMs: number): IpInfo {
  const body = asRecord(json)
  if (!body) {
    throw new AppException('IP_VERIFY_FAILED', `The IP-check service (${provider}) returned an unexpected body.`, 'body is not a JSON object')
  }
  const checkedAt = new Date().toISOString()
  const base = { latencyMs: Math.max(0, Math.round(latencyMs)), provider, checkedAt }

  switch (provider) {
    case 'ip-api': {
      if (body.status !== 'success') {
        throw new AppException(
          'IP_VERIFY_FAILED',
          'The IP-check service (ip-api) reported a failure.',
          `status=${String(body.status)} message=${str(body.message) ?? 'none'}`,
        )
      }
      return {
        ip: requireIp(body.query, provider),
        country: str(body.country),
        countryCode: str(body.countryCode),
        region: str(body.regionName),
        city: str(body.city),
        postalCode: str(body.zip),
        isp: str(body.isp),
        asn: str(body.as),
        ...base,
      }
    }
    case 'ipinfo': {
      if (body.error !== undefined) {
        const error = asRecord(body.error)
        throw new AppException(
          'IP_VERIFY_FAILED',
          'The IP-check service (ipinfo) reported a failure.',
          str(error?.message) ?? str(error?.title) ?? 'unknown error',
        )
      }
      const org = str(body.org)
      // ipinfo reports `country` as a 2-letter code; keep the code and expand the readable name.
      const countryCode = str(body.country)
      return {
        ip: requireIp(body.ip, provider),
        country: countryNameFromCode(countryCode),
        countryCode: countryCode ? countryCode.toUpperCase() : null,
        region: str(body.region),
        city: str(body.city),
        postalCode: str(body.postal),
        isp: org,
        asn: org,
        ...base,
      }
    }
    case 'ipwhois': {
      if (body.success === false) {
        throw new AppException('IP_VERIFY_FAILED', 'The IP-check service (ipwho.is) reported a failure.', str(body.message) ?? 'unknown error')
      }
      const connection = asRecord(body.connection)
      const asnNumber = str(connection?.asn)
      return {
        ip: requireIp(body.ip, provider),
        country: str(body.country),
        countryCode: str(body.country_code),
        region: str(body.region),
        city: str(body.city),
        postalCode: str(body.postal),
        isp: str(connection?.isp) ?? str(connection?.org),
        asn: asnNumber ? `AS${asnNumber.replace(/^as/i, '')}` : str(connection?.org),
        ...base,
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Ordered list: the configured provider first, then the others as fallbacks. */
export function providerOrder(preferred: IpCheckProvider): IpCheckProvider[] {
  return [preferred, ...IP_CHECK_PROVIDERS.filter((p) => p !== preferred)]
}

export function createIpChecker(opts: IpCheckerOptions): IpChecker {
  const { getSettings, logger } = opts

  async function fetchOnce(provider: IpCheckProvider, proxy: ProxyConnection | null, timeoutMs: number): Promise<IpInfo> {
    let context: APIRequestContext | null = null
    try {
      context = await request.newContext({
        timeout: timeoutMs,
        ignoreHTTPSErrors: false,
        ...(proxy ? { proxy: { server: proxy.server, username: proxy.username, password: proxy.password } } : {}),
      })
      // Latency covers only the round trip through the proxy, not Playwright's context setup.
      const startedAt = Date.now()
      const response = await context.get(IP_CHECK_ENDPOINTS[provider], { timeout: timeoutMs })
      const latencyMs = Date.now() - startedAt
      const statusError = classifyHttpStatus(response.status(), proxy !== null, provider)
      if (statusError) throw statusError
      let json: unknown
      try {
        json = await response.json()
      } catch (err) {
        throw new AppException('IP_VERIFY_FAILED', `The IP-check service (${provider}) returned a non-JSON body.`, stripCredentials(errorMessage(err)))
      }
      return parseIpResponse(provider, json, latencyMs)
    } catch (err) {
      throw classifyNetworkError(err)
    } finally {
      if (context) {
        await context.dispose().catch(() => undefined)
      }
    }
  }

  async function lookupWithRetries(provider: IpCheckProvider, proxy: ProxyConnection | null, retries: number, timeoutMs: number): Promise<IpInfo> {
    let lastError: AppException | null = null
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await fetchOnce(provider, proxy, timeoutMs)
      } catch (err) {
        lastError = err instanceof AppException ? err : classifyNetworkError(err)
        // Credential problems will not fix themselves — do not retry them.
        if (lastError.code === 'PROXY_AUTH_FAILED' || attempt === retries) break
        const delay = BACKOFF_BASE_MS * 2 ** attempt
        logger.warn(LOG_SCOPE, `IP check attempt ${attempt + 1}/${retries + 1} failed, retrying`, {
          provider,
          sessionId: proxy?.sessionId ?? null,
          code: lastError.code,
          detail: lastError.detail ?? null,
          retryInMs: delay,
        })
        await sleep(delay)
      }
    }
    throw lastError ?? new AppException('IP_VERIFY_FAILED', 'IP check failed without a reported cause.')
  }

  return {
    async lookup(proxy: ProxyConnection | null): Promise<IpInfo> {
      const settings = getSettings()
      const [primary, fallback] = providerOrder(settings.ipCheckProvider)
      if (!primary) {
        throw new AppException('INTERNAL', 'No IP-check provider is configured.')
      }
      try {
        return await lookupWithRetries(primary, proxy, settings.ipCheckRetries, settings.ipCheckTimeoutMs)
      } catch (err) {
        const primaryError = err instanceof AppException ? err : classifyNetworkError(err)
        // A credential rejection is a proxy problem, not an IP-service problem — no fallback can help.
        if (!fallback || primaryError.code === 'PROXY_AUTH_FAILED') {
          throw primaryError
        }
        logger.warn(LOG_SCOPE, `IP-check provider ${primary} failed, falling back to ${fallback}`, {
          sessionId: proxy?.sessionId ?? null,
          code: primaryError.code,
          detail: primaryError.detail ?? null,
        })
        try {
          return await lookupWithRetries(fallback, proxy, 0, settings.ipCheckTimeoutMs)
        } catch (fallbackErr) {
          const fallbackError = fallbackErr instanceof AppException ? fallbackErr : classifyNetworkError(fallbackErr)
          logger.error(LOG_SCOPE, 'IP check failed on primary and fallback providers', {
            primary,
            fallback,
            primaryCode: primaryError.code,
            fallbackCode: fallbackError.code,
          })
          throw fallbackError
        }
      }
    },
  }
}

import { describe, expect, it } from 'vitest'
import { AppException } from '../src/main/contracts'
import {
  IP_CHECK_ENDPOINTS,
  classifyHttpStatus,
  classifyNetworkError,
  countryNameFromCode,
  parseIpResponse,
  providerOrder,
  stripCredentials,
} from '../src/main/proxy/ip-checker'

const PASSWORD = 'Hunter2!Secret'

describe('parseIpResponse', () => {
  it('normalises an ip-api success response', () => {
    const info = parseIpResponse(
      'ip-api',
      {
        status: 'success',
        country: 'United States',
        countryCode: 'US',
        regionName: 'California',
        city: 'Los Angeles',
        zip: '90012',
        isp: 'Example Fiber',
        as: 'AS64500 Example Fiber LLC',
        query: '198.51.100.7',
      },
      133.6,
    )
    expect(info).toMatchObject({
      ip: '198.51.100.7',
      country: 'United States',
      countryCode: 'US',
      region: 'California',
      city: 'Los Angeles',
      postalCode: '90012',
      isp: 'Example Fiber',
      asn: 'AS64500 Example Fiber LLC',
      latencyMs: 134,
      provider: 'ip-api',
    })
    expect(Number.isNaN(Date.parse(info.checkedAt))).toBe(false)
  })

  it('throws IP_VERIFY_FAILED for an ip-api failure body', () => {
    expect(() => parseIpResponse('ip-api', { status: 'fail', message: 'reserved range', query: '10.0.0.1' }, 10)).toThrowError(AppException)
    try {
      parseIpResponse('ip-api', { status: 'fail', message: 'reserved range' }, 10)
    } catch (err) {
      expect(err).toBeInstanceOf(AppException)
      expect((err as AppException).code).toBe('IP_VERIFY_FAILED')
      expect((err as AppException).detail).toContain('reserved range')
    }
  })

  it('normalises an ipinfo response (country code expanded to a name, org doubles as isp + asn)', () => {
    const info = parseIpResponse(
      'ipinfo',
      { ip: '198.51.100.8', city: 'Berlin', region: 'Berlin', country: 'DE', postal: '10115', org: 'AS3320 Deutsche Telekom AG', loc: '52.5,13.4' },
      80,
    )
    expect(info).toMatchObject({
      ip: '198.51.100.8',
      country: 'Germany',
      countryCode: 'DE',
      region: 'Berlin',
      city: 'Berlin',
      postalCode: '10115',
      isp: 'AS3320 Deutsche Telekom AG',
      asn: 'AS3320 Deutsche Telekom AG',
      provider: 'ipinfo',
      latencyMs: 80,
    })
  })

  it('throws for an ipinfo error body', () => {
    expect(() => parseIpResponse('ipinfo', { error: { title: 'Wrong ip', message: 'Please provide a valid IP address' } }, 5)).toThrowError(
      /ipinfo/,
    )
  })

  it('normalises an ipwho.is response (connection.asn → ASnnnn)', () => {
    const info = parseIpResponse(
      'ipwhois',
      {
        ip: '198.51.100.9',
        success: true,
        country: 'Canada',
        country_code: 'CA',
        region: 'Ontario',
        city: 'Toronto',
        postal: 'M5H',
        connection: { asn: 577, org: 'Bell Canada', isp: 'Bell Canada' },
      },
      42,
    )
    expect(info).toMatchObject({
      ip: '198.51.100.9',
      country: 'Canada',
      countryCode: 'CA',
      region: 'Ontario',
      city: 'Toronto',
      postalCode: 'M5H',
      isp: 'Bell Canada',
      asn: 'AS577',
      provider: 'ipwhois',
    })
  })

  it('throws for an ipwho.is failure body', () => {
    expect(() => parseIpResponse('ipwhois', { success: false, message: 'Invalid IP address' }, 1)).toThrowError(/ipwho\.is/)
  })

  it('rejects bodies without a valid IP or that are not objects', () => {
    expect(() => parseIpResponse('ip-api', { status: 'success', query: 'not-an-ip' }, 1)).toThrowError(/valid IP/)
    expect(() => parseIpResponse('ipinfo', 'plain text', 1)).toThrowError(/unexpected body/)
    expect(() => parseIpResponse('ipwhois', null, 1)).toThrowError(/unexpected body/)
  })

  it('reads the postal code from every provider and reports null when it is missing or blank', () => {
    // Live shapes: ip-api `zip`, ipinfo and ipwho.is `postal` (ZIP 07102 pool, Newark NJ).
    expect(parseIpResponse('ip-api', { status: 'success', countryCode: 'US', regionName: 'New Jersey', city: 'Newark', zip: '07103', query: '198.51.100.20' }, 1).postalCode).toBe('07103')
    expect(parseIpResponse('ipinfo', { ip: '198.51.100.20', country: 'US', region: 'New Jersey', city: 'Newark', postal: '07103' }, 1).postalCode).toBe('07103')
    expect(parseIpResponse('ipwhois', { ip: '198.51.100.20', success: true, country_code: 'US', region: 'New Jersey', city: 'Newark', postal: '07103' }, 1).postalCode).toBe('07103')
    // Leading zeros survive (strings are kept verbatim).
    expect(parseIpResponse('ip-api', { status: 'success', zip: '01001', query: '198.51.100.1' }, 1).postalCode).toBe('01001')
    expect(parseIpResponse('ip-api', { status: 'success', zip: '', query: '198.51.100.1' }, 1).postalCode).toBeNull()
    expect(parseIpResponse('ipinfo', { ip: '198.51.100.1', country: 'US' }, 1).postalCode).toBeNull()
    expect(parseIpResponse('ipwhois', { ip: '198.51.100.1', success: true, postal: '  ' }, 1).postalCode).toBeNull()
  })

  it('accepts IPv6 addresses', () => {
    expect(parseIpResponse('ipinfo', { ip: '2001:db8::1', country: 'US' }, 1).ip).toBe('2001:db8::1')
  })

  it('keeps an unknown ipinfo country code as-is and tolerates a missing one', () => {
    expect(parseIpResponse('ipinfo', { ip: '2001:db8::1', country: 'XX' }, 1)).toMatchObject({ country: 'XX', countryCode: 'XX' })
    expect(parseIpResponse('ipinfo', { ip: '2001:db8::1', country: 'us' }, 1)).toMatchObject({ country: 'United States', countryCode: 'US' })
    expect(parseIpResponse('ipinfo', { ip: '2001:db8::1' }, 1)).toMatchObject({ country: null, countryCode: null })
  })
})

describe('countryNameFromCode', () => {
  it('expands ISO codes via Intl.DisplayNames and falls back to the input', () => {
    expect(countryNameFromCode('US')).toBe('United States')
    expect(countryNameFromCode('de')).toBe('Germany')
    expect(countryNameFromCode('XX')).toBe('XX')
    expect(countryNameFromCode('United States')).toBe('United States')
    expect(countryNameFromCode(null)).toBeNull()
  })
})

describe('classifyHttpStatus', () => {
  it('accepts 2xx', () => {
    expect(classifyHttpStatus(200, true, 'ip-api')).toBeNull()
    expect(classifyHttpStatus(204, false, 'ipinfo')).toBeNull()
  })

  it('maps 407 to PROXY_AUTH_FAILED and gateway 5xx to PROXY_DEAD when going through a proxy', () => {
    expect(classifyHttpStatus(407, true, 'ip-api')?.code).toBe('PROXY_AUTH_FAILED')
    expect(classifyHttpStatus(407, false, 'ip-api')?.code).toBe('PROXY_AUTH_FAILED')
    for (const status of [502, 503, 504]) {
      expect(classifyHttpStatus(status, true, 'ipwhois')?.code, `status ${status}`).toBe('PROXY_DEAD')
    }
  })

  it('explains a gateway 503 as "no exit IP for this session/location", not a host/port problem', () => {
    const err = classifyHttpStatus(503, true, 'ip-api')
    expect(err?.message).toContain('no exit IP available')
    expect(err?.message).not.toContain('host/port')
    expect(classifyHttpStatus(502, true, 'ip-api')?.message).toContain('host/port')
  })

  it('treats other failures (and 5xx without a proxy) as IP-service problems', () => {
    expect(classifyHttpStatus(503, false, 'ip-api')?.code).toBe('IP_VERIFY_FAILED')
    expect(classifyHttpStatus(429, true, 'ip-api')?.code).toBe('IP_VERIFY_FAILED')
    expect(classifyHttpStatus(500, true, 'ip-api')?.code).toBe('IP_VERIFY_FAILED')
    expect(classifyHttpStatus(429, true, 'ip-api')?.message).toContain('HTTP 429')
  })
})

describe('classifyNetworkError', () => {
  it('maps HTTP 407 / proxy auth failures', () => {
    expect(classifyNetworkError(new Error('Proxy responded with 407 Proxy Authentication Required')).code).toBe('PROXY_AUTH_FAILED')
    expect(classifyNetworkError(new Error('apiRequestContext.get: 407')).code).toBe('PROXY_AUTH_FAILED')
    expect(classifyNetworkError(new Error('net::ERR_PROXY_AUTH_UNSUPPORTED')).code).toBe('PROXY_AUTH_FAILED')
    expect(classifyNetworkError(new Error('net::ERR_PROXY_AUTH_REQUESTED')).code).toBe('PROXY_AUTH_FAILED')
    expect(classifyNetworkError(new Error('NS_ERROR_PROXY_AUTHENTICATION_FAILED')).code).toBe('PROXY_AUTH_FAILED')
  })

  it('maps engine-specific proxy failures (Chromium, Firefox, WebKit prose) to PROXY_DEAD', () => {
    expect(classifyNetworkError(new Error('apiRequestContext.get: net::ERR_PROXY_CONNECTION_FAILED')).code).toBe('PROXY_DEAD')
    expect(classifyNetworkError(new Error('net::ERR_TUNNEL_CONNECTION_FAILED at https://example.com/')).code).toBe('PROXY_DEAD')
    expect(classifyNetworkError(new Error('NS_ERROR_PROXY_CONNECTION_REFUSED')).code).toBe('PROXY_DEAD')
    expect(classifyNetworkError(new Error('apiRequestContext.get: Connection terminated unexpectedly')).code).toBe('PROXY_DEAD')
  })

  it('maps DNS failures', () => {
    expect(classifyNetworkError(new Error('getaddrinfo ENOTFOUND gw.dataimpulse.com')).code).toBe('DNS_FAILURE')
    expect(classifyNetworkError(new Error('getaddrinfo EAI_AGAIN ip-api.com')).code).toBe('DNS_FAILURE')
  })

  it('maps timeouts', () => {
    expect(classifyNetworkError(new Error('apiRequestContext.get: Request timed out after 15000ms')).code).toBe('PROXY_TIMEOUT')
    expect(classifyNetworkError(new Error('Timeout 15000ms exceeded')).code).toBe('PROXY_TIMEOUT')
    expect(classifyNetworkError(new Error('connect ETIMEDOUT 1.2.3.4:823')).code).toBe('PROXY_TIMEOUT')
  })

  it('maps dead proxies', () => {
    expect(classifyNetworkError(new Error('connect ECONNREFUSED 127.0.0.1:823')).code).toBe('PROXY_DEAD')
    expect(classifyNetworkError(new Error('read ECONNRESET')).code).toBe('PROXY_DEAD')
    expect(classifyNetworkError(new Error('tunneling socket could not be established, statusCode=502')).code).toBe('PROXY_DEAD')
    expect(classifyNetworkError(new Error('socket hang up')).code).toBe('PROXY_DEAD')
  })

  it('falls back to IP_VERIFY_FAILED for unknown errors and non-Error values', () => {
    expect(classifyNetworkError(new Error('Unexpected token < in JSON')).code).toBe('IP_VERIFY_FAILED')
    expect(classifyNetworkError('weird string').code).toBe('IP_VERIFY_FAILED')
    expect(classifyNetworkError({ some: 'object' }).code).toBe('IP_VERIFY_FAILED')
  })

  it('passes AppException through untouched', () => {
    const original = new AppException('PROXY_NOT_CONFIGURED', 'nope')
    expect(classifyNetworkError(original)).toBe(original)
  })

  it('strips credentials from the detail', () => {
    const err = classifyNetworkError(new Error(`connect ECONNREFUSED http://acme_login:${PASSWORD}@gw.dataimpulse.com:823`))
    expect(err.detail).toBeDefined()
    expect(err.detail).not.toContain(PASSWORD)
    expect(err.detail).not.toContain('acme_login')
    expect(err.message).not.toContain(PASSWORD)
  })
})

describe('stripCredentials', () => {
  it('redacts user:pass@ patterns in URLs and bare form', () => {
    expect(stripCredentials(`http://user:${PASSWORD}@host:823/path`)).toBe('http://***:***@host:823/path')
    expect(stripCredentials(`proxy user:${PASSWORD}@gw.dataimpulse.com failed`)).toBe('proxy ***:***@gw.dataimpulse.com failed')
  })

  it('redacts password key/value pairs', () => {
    expect(stripCredentials(`password=${PASSWORD} rejected`)).toBe('password=*** rejected')
    expect(stripCredentials(`"password": "${PASSWORD}"`)).not.toContain(PASSWORD)
  })

  it('leaves ordinary messages untouched', () => {
    expect(stripCredentials('connect ECONNREFUSED 127.0.0.1:823')).toBe('connect ECONNREFUSED 127.0.0.1:823')
    expect(stripCredentials('Timeout 15000ms exceeded at 12:30')).toBe('Timeout 15000ms exceeded at 12:30')
  })
})

describe('provider configuration', () => {
  it('orders the configured provider first and lists all three', () => {
    expect(providerOrder('ipinfo')).toEqual(['ipinfo', 'ip-api', 'ipwhois'])
    expect(providerOrder('ip-api')).toEqual(['ip-api', 'ipinfo', 'ipwhois'])
  })

  it('uses the documented endpoints', () => {
    expect(IP_CHECK_ENDPOINTS['ip-api']).toMatch(/^http:\/\/ip-api\.com\/json\/\?fields=/)
    // The postal code is requested explicitly from ip-api (ipinfo and ipwho.is always include it).
    expect(new URL(IP_CHECK_ENDPOINTS['ip-api']).searchParams.get('fields')?.split(',')).toEqual(expect.arrayContaining(['countryCode', 'regionName', 'city', 'zip', 'query']))
    expect(IP_CHECK_ENDPOINTS.ipinfo).toBe('https://ipinfo.io/json')
    expect(IP_CHECK_ENDPOINTS.ipwhois).toBe('https://ipwho.is/')
  })
})

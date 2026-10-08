import { describe, expect, it } from 'vitest'
import { mapLaunchError, mapNavigationError, sanitizeErrorText } from '../src/main/browser/error-mapping'
import { extractIds, runPatchFromIds } from '../src/main/browser/network-inspector'

const nav = (message: string, name = 'Error', viaProxy = true): string => {
  const err = new Error(message)
  err.name = name
  return mapNavigationError(err, { timeoutMs: 60000, viaProxy, secrets: [] }).code
}

describe('mapNavigationError', () => {
  it('maps engine-specific failures to AppErrorCodes', () => {
    expect(nav('page.goto: Timeout 60000ms exceeded.', 'TimeoutError')).toBe('SITE_TIMEOUT')
    expect(nav('page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://x/')).toBe('SSL_ERROR')
    expect(nav('page.goto: net::ERR_NAME_NOT_RESOLVED at https://x/')).toBe('DNS_FAILURE')
    expect(nav('page.goto: NS_ERROR_UNKNOWN_HOST')).toBe('DNS_FAILURE')
    expect(nav('page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://x/')).toBe('PROXY_DEAD')
    expect(nav('page.goto: net::ERR_PROXY_CONNECTION_FAILED')).toBe('PROXY_DEAD')
    expect(nav('page.goto: net::ERR_PROXY_AUTH_REQUESTED')).toBe('PROXY_AUTH_FAILED')
    expect(nav('page.goto: net::ERR_CONNECTION_REFUSED', 'Error', false)).toBe('INTERNAL')
    expect(nav('page.goto: net::ERR_CONNECTION_RESET', 'Error', true)).toBe('PROXY_DEAD')
    expect(nav('something odd')).toBe('INTERNAL')
  })

  it('maps proxy failures from every engine, including WebKit prose and the local relay', () => {
    // Chromium
    expect(nav('page.goto: net::ERR_PROXY_CONNECTION_FAILED at https://x/')).toBe('PROXY_DEAD')
    expect(nav('page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://x/')).toBe('PROXY_DEAD')
    expect(nav('page.goto: net::ERR_PROXY_AUTH_UNSUPPORTED at https://x/')).toBe('PROXY_AUTH_FAILED')
    expect(nav('page.goto: net::ERR_PROXY_AUTH_REQUESTED at https://x/')).toBe('PROXY_AUTH_FAILED')
    // Firefox
    expect(nav('page.goto: NS_ERROR_PROXY_CONNECTION_REFUSED')).toBe('PROXY_DEAD')
    expect(nav('page.goto: NS_ERROR_PROXY_AUTHENTICATION_FAILED')).toBe('PROXY_AUTH_FAILED')
    // WebKit / relay
    expect(nav('page.goto: Connection terminated unexpectedly')).toBe('PROXY_DEAD')
    expect(nav('page.goto: Connection terminated unexpectedly', 'Error', false)).toBe('INTERNAL')
    expect(nav('page.goto: 407 Proxy Authentication Required')).toBe('PROXY_AUTH_FAILED')
    expect(nav('page.goto: HTTP 407')).toBe('PROXY_AUTH_FAILED')
    // Port numbers containing 407 are not an auth failure.
    expect(nav('page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:40700/')).toBe('PROXY_DEAD')
  })

  it('uses the existing human messages for proxy failures', () => {
    const dead = mapNavigationError(new Error('page.goto: Connection terminated unexpectedly'), { timeoutMs: 1000, viaProxy: true, secrets: [] })
    expect(dead.message).toContain('Re-test the proxy or rotate the session')
    const auth = mapNavigationError(new Error('407 Proxy Authentication Required'), { timeoutMs: 1000, viaProxy: true, secrets: [] })
    expect(auth.message).toContain('username and password')
    expect(auth.message).not.toMatch(/\.env/)
  })

  it('includes the timeout in seconds in the message', () => {
    const err = new Error('Timeout 60000ms exceeded')
    err.name = 'TimeoutError'
    expect(mapNavigationError(err, { timeoutMs: 60000, viaProxy: false, secrets: [] }).message).toContain('60s')
  })
})

describe('mapLaunchError', () => {
  it('maps a missing executable to BROWSER_MISSING and everything else to BROWSER_LAUNCH_FAILED', () => {
    expect(mapLaunchError(new Error("browserType.launch: Executable doesn't exist at /x/chrome"), []).code).toBe(
      'BROWSER_MISSING',
    )
    expect(mapLaunchError(new Error('browserType.launch: Failed to launch: spawn EACCES'), []).code).toBe(
      'BROWSER_LAUNCH_FAILED',
    )
  })
})

describe('sanitizeErrorText', () => {
  it('removes registered secrets and inline credentials', () => {
    expect(sanitizeErrorText('proxy pw hunter2 failed', ['hunter2'])).toBe('proxy pw *** failed')
    expect(sanitizeErrorText('http://user:s3cret@gw.example.com:823/', [])).toBe('http://user:***@gw.example.com:823/')
  })
})

describe('extractIds', () => {
  it('finds top-level and one-level-nested id keys', () => {
    expect(extractIds({ leadId: 'L1', data: { certificate_id: 42 } })).toEqual({ leadId: 'L1', certificate_id: '42' })
    expect(extractIds({ result: { lead_id: 'L2' }, meta: { certificateId: 'C2' } })).toEqual({
      lead_id: 'L2',
      certificateId: 'C2',
    })
    expect(extractIds({ deep: { deeper: { leadId: 'nope' } } })).toEqual({})
    expect(extractIds([{ leadId: 'array-ignored' }])).toEqual({})
    expect(extractIds('text')).toEqual({})
  })

  it('maps extracted keys onto run fields', () => {
    expect(runPatchFromIds({ lead_id: 'L', certificate_id: 'C' })).toEqual({ leadId: 'L', certificateId: 'C' })
    expect(runPatchFromIds({ leadId: 'L' })).toEqual({ leadId: 'L' })
    expect(runPatchFromIds({})).toEqual({})
  })
})

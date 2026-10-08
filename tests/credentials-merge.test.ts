/**
 * Partial credential updates (Manage keys window) are merged with the stored
 * vault entry in the main process and validated as a whole.
 */
import { describe, expect, it } from 'vitest'

import type { ProxyCredentials } from '../src/main/contracts'
import { isEmptyCredentialsUpdate, mergeCredentialsUpdate } from '../src/main/security/credentials-merge'

const stored: ProxyCredentials = {
  pool: 'residential',
  host: 'gw.dataimpulse.com',
  port: 823,
  username: 'stored_login',
  password: 'stored-password',
  sessionTemplate: '{username}__{session}',
}

describe('mergeCredentialsUpdate', () => {
  it('rotates only the password and keeps every stored value', () => {
    expect(mergeCredentialsUpdate(stored, { pool: 'residential', password: 'new-password' })).toEqual({
      pool: 'residential',
      host: 'gw.dataimpulse.com',
      port: 823,
      username: 'stored_login',
      password: 'new-password',
      sessionTemplate: '{username}__{session}',
    })
  })

  it('treats empty strings as "unchanged" and trims host/username but never the password', () => {
    const merged = mergeCredentialsUpdate(stored, { pool: 'residential', host: '  ', username: '', password: ' spaced pass ' })
    expect(merged).toMatchObject({ host: 'gw.dataimpulse.com', username: 'stored_login', password: ' spaced pass ' })
    expect(mergeCredentialsUpdate(stored, { pool: 'residential', host: ' other.example.com ', username: ' new_login ' })).toMatchObject({
      host: 'other.example.com',
      username: 'new_login',
      password: 'stored-password',
    })
  })

  it('updates the port and the session template; null or empty removes the template override', () => {
    expect(mergeCredentialsUpdate(stored, { pool: 'residential', port: 10000 }).port).toBe(10000)
    expect(mergeCredentialsUpdate(stored, { pool: 'residential', sessionTemplate: null }).sessionTemplate).toBeNull()
    expect(mergeCredentialsUpdate(stored, { pool: 'residential', sessionTemplate: '' }).sessionTemplate).toBeNull()
    expect(mergeCredentialsUpdate(stored, { pool: 'residential', sessionTemplate: '{username}-s-{session}' }).sessionTemplate).toBe('{username}-s-{session}')
  })

  it('requires every field when nothing is stored for the pool, without echoing any value', () => {
    expect(() => mergeCredentialsUpdate(null, { pool: 'mobile', password: 'only-password' })).toThrowError(/host: Proxy host is required — nothing is stored for the mobile pool yet/)
    expect(() => mergeCredentialsUpdate(null, { pool: 'mobile', host: 'gw.dataimpulse.com', port: 823, username: 'm_login' })).toThrowError(/password: Proxy password is required/)
    try {
      mergeCredentialsUpdate(null, { pool: 'mobile', host: 'gw.dataimpulse.com', port: 823, password: 'secret-value' })
    } catch (err) {
      expect(String(err)).not.toContain('secret-value')
      expect(err).toMatchObject({ code: 'INVALID_INPUT' })
    }
    expect(mergeCredentialsUpdate(null, { pool: 'mobile', host: 'gw.dataimpulse.com', port: 823, username: 'm_login', password: 'p' })).toEqual({
      pool: 'mobile',
      host: 'gw.dataimpulse.com',
      port: 823,
      username: 'm_login',
      password: 'p',
      sessionTemplate: null,
    })
  })

  it('validates the update and the merged result with the shared schemas', () => {
    expect(() => mergeCredentialsUpdate(stored, { pool: 'residential', port: 0 })).toThrowError(/port/)
    expect(() => mergeCredentialsUpdate(stored, { pool: 'residential', sessionTemplate: 'no-placeholders' })).toThrowError(/Session template must contain/)
    expect(() => mergeCredentialsUpdate(stored, { pool: 'datacenter' } as never)).toThrowError(/pool/)
  })

  it('refuses a stored entry of another pool', () => {
    expect(() => mergeCredentialsUpdate(stored, { pool: 'mobile', password: 'x' })).toThrowError(/another pool/)
  })
})

describe('isEmptyCredentialsUpdate', () => {
  it('is true only when nothing would change', () => {
    expect(isEmptyCredentialsUpdate({ pool: 'residential' })).toBe(true)
    expect(isEmptyCredentialsUpdate({ pool: 'residential', host: ' ', username: '', password: '' })).toBe(true)
    expect(isEmptyCredentialsUpdate({ pool: 'residential', password: 'x' })).toBe(false)
    expect(isEmptyCredentialsUpdate({ pool: 'residential', sessionTemplate: null })).toBe(false)
    expect(isEmptyCredentialsUpdate({ pool: 'residential', port: 823 })).toBe(false)
  })
})

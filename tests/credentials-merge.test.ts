/**
 * Partial credential updates (Manage keys window) are merged with the stored
 * vault entry in the main process and validated as a whole.
 */
import { describe, expect, it } from 'vitest'

import type { StoredProxyCredentials } from '../src/main/contracts'
import { isEmptyCredentialsUpdate, mergeCredentialsUpdate } from '../src/main/security/credentials-merge'

const stored: StoredProxyCredentials = {
  providerId: 'dataimpulse',
  pool: 'residential',
  extras: {},
  host: 'gw.dataimpulse.com',
  port: 823,
  username: 'stored_login',
  password: 'stored-password',
  sessionTemplate: '{username}__{session}',
}

describe('mergeCredentialsUpdate', () => {
  it('rotates only the password and keeps every stored value', () => {
    expect(mergeCredentialsUpdate(stored, { pool: 'residential', password: 'new-password' })).toEqual({
      providerId: 'dataimpulse',
      pool: 'residential',
      extras: {},
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
      providerId: 'dataimpulse',
      pool: 'mobile',
      extras: {},
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
    expect(() => mergeCredentialsUpdate(stored, { pool: 'Data Center' } as never)).toThrowError(/pool/)
  })

  it('refuses a stored entry of another pool or provider', () => {
    expect(() => mergeCredentialsUpdate(stored, { pool: 'mobile', password: 'x' })).toThrowError(/another provider or pool/)
    expect(() => mergeCredentialsUpdate(stored, { providerId: 'acme', pool: 'residential', password: 'x' })).toThrowError(/another provider or pool/)
  })

  it('merges extra credential fields per field: absent or empty keeps the stored value', () => {
    const withExtras: StoredProxyCredentials = { ...stored, providerId: 'acme', extras: { zone: 'z1', apiKey: 'Stored-Api-Key' } }
    expect(mergeCredentialsUpdate(withExtras, { providerId: 'acme', pool: 'residential', password: 'p2' }).extras).toEqual({ zone: 'z1', apiKey: 'Stored-Api-Key' })
    expect(mergeCredentialsUpdate(withExtras, { providerId: 'acme', pool: 'residential', extras: { zone: 'z2', apiKey: '' } }).extras).toEqual({ zone: 'z2', apiKey: 'Stored-Api-Key' })
    expect(mergeCredentialsUpdate(null, { providerId: 'acme', pool: 'residential', host: 'gw.example.com', port: 1, username: 'u', password: 'p', extras: { zone: 'z9' } })).toMatchObject({
      providerId: 'acme',
      extras: { zone: 'z9' },
    })
    expect(() => mergeCredentialsUpdate(withExtras, { providerId: 'acme', pool: 'residential', extras: { 'bad key': 'x' } })).toThrowError(/extras/)
  })
})

describe('isEmptyCredentialsUpdate', () => {
  it('is true only when nothing would change', () => {
    expect(isEmptyCredentialsUpdate({ pool: 'residential' })).toBe(true)
    expect(isEmptyCredentialsUpdate({ pool: 'residential', host: ' ', username: '', password: '' })).toBe(true)
    expect(isEmptyCredentialsUpdate({ pool: 'residential', password: 'x' })).toBe(false)
    expect(isEmptyCredentialsUpdate({ pool: 'residential', sessionTemplate: null })).toBe(false)
    expect(isEmptyCredentialsUpdate({ pool: 'residential', port: 823 })).toBe(false)
    expect(isEmptyCredentialsUpdate({ pool: 'residential', extras: { zone: '' } })).toBe(true)
    expect(isEmptyCredentialsUpdate({ pool: 'residential', extras: { zone: 'z1' } })).toBe(false)
  })
})

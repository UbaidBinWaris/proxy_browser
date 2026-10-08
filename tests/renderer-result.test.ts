import { afterEach, describe, expect, it } from 'vitest'
import type { ProxyQaApi } from '../src/shared/ipc'
import { fail, ok } from '../src/shared/types'
import { ApiError, toAppError, unwrap } from '../src/renderer/src/lib/result'
import { getApi } from '../src/renderer/src/lib/api'

const bridgeHolder = globalThis as unknown as { api?: ProxyQaApi }

afterEach(() => {
  delete bridgeHolder.api
})

describe('unwrap', () => {
  it('resolves the data of an ok envelope', async () => {
    await expect(unwrap(Promise.resolve(ok({ id: '1' })))).resolves.toEqual({ id: '1' })
  })

  it('throws an ApiError carrying the code for a failed envelope', async () => {
    const promise = unwrap(Promise.resolve(fail<string>({ code: 'PROXY_TIMEOUT', message: 'Gateway timed out', detail: 'ETIMEDOUT' })))
    await expect(promise).rejects.toBeInstanceOf(ApiError)
    await promise.catch((err: unknown) => {
      const apiError = err as ApiError
      expect(apiError.code).toBe('PROXY_TIMEOUT')
      expect(apiError.message).toBe('Gateway timed out')
      expect(apiError.detail).toBe('ETIMEDOUT')
      expect(apiError.toAppError()).toEqual({ code: 'PROXY_TIMEOUT', message: 'Gateway timed out', detail: 'ETIMEDOUT' })
    })
  })

  it('wraps a rejected IPC promise as an INTERNAL ApiError', async () => {
    const promise = unwrap(Promise.reject(new Error('channel closed')))
    await expect(promise).rejects.toMatchObject({ code: 'INTERNAL', message: 'channel closed' })
  })
})

describe('toAppError', () => {
  it('passes through ApiError and AppError-shaped objects', () => {
    expect(toAppError(new ApiError({ code: 'NOT_FOUND', message: 'Missing' }))).toEqual({ code: 'NOT_FOUND', message: 'Missing' })
    expect(toAppError({ code: 'BROWSER_MISSING', message: 'Install chromium', detail: 'rev 1243' })).toEqual({
      code: 'BROWSER_MISSING',
      message: 'Install chromium',
      detail: 'rev 1243',
    })
  })

  it('maps unknown codes, plain errors, strings and junk to INTERNAL', () => {
    expect(toAppError({ code: 'SOMETHING_ELSE', message: 'x' })).toMatchObject({ code: 'INTERNAL' })
    expect(toAppError(new Error('boom'))).toEqual({ code: 'INTERNAL', message: 'boom' })
    expect(toAppError('plain string')).toEqual({ code: 'INTERNAL', message: 'plain string' })
    expect(toAppError(undefined).code).toBe('INTERNAL')
    expect(toAppError(undefined).message.length).toBeGreaterThan(0)
  })
})

describe('getApi', () => {
  it('throws an actionable INTERNAL ApiError when the preload bridge is absent', () => {
    expect(() => getApi()).toThrowError(ApiError)
    try {
      getApi()
    } catch (err) {
      expect((err as ApiError).code).toBe('INTERNAL')
      expect((err as ApiError).message).toMatch(/bridge/i)
    }
  })

  it('returns the injected bridge', () => {
    const bridge = { app: {} } as unknown as ProxyQaApi
    bridgeHolder.api = bridge
    expect(getApi()).toBe(bridge)
  })
})

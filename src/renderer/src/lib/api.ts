import { useCallback, useRef, useState } from 'react'
import type { ProxyQaApi } from '@shared/ipc'
import type { AppError, IpcResult } from '@shared/types'
import { ApiError, toAppError, unwrap } from './result'

export { ApiError, toAppError, unwrap } from './result'
export type { LoadStatus } from './result'

/**
 * Access the preload bridge. Read through `globalThis` so the module stays DOM-agnostic
 * (unit tests inject a fake bridge the same way the preload script does).
 */
export function getApi(): ProxyQaApi {
  const bridge = (globalThis as unknown as { api?: ProxyQaApi }).api
  if (!bridge) {
    throw new ApiError({
      code: 'INTERNAL',
      message: 'The application bridge is unavailable. Restart Proxy QA Browser; if this persists, reinstall the app.',
    })
  }
  return bridge
}

export type ApiCallState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; error: AppError }

export interface ApiCall<TArgs extends unknown[], T> {
  state: ApiCallState<T>
  loading: boolean
  data: T | null
  error: AppError | null
  /** Runs the call. Resolves to the data, or `undefined` when it failed (the error is in state). */
  run: (...args: TArgs) => Promise<T | undefined>
  reset: () => void
}

/**
 * Hook-friendly wrapper around an IPC call returning `IpcResult<T>`.
 * Tracks idle/loading/success/error and ignores stale results from superseded calls.
 */
export function useApiCall<TArgs extends unknown[], T>(
  fn: (...args: TArgs) => Promise<IpcResult<T>>,
  options: { onSuccess?: (data: T) => void; onError?: (error: AppError) => void } = {},
): ApiCall<TArgs, T> {
  const [state, setState] = useState<ApiCallState<T>>({ status: 'idle' })
  const callId = useRef(0)
  const fnRef = useRef(fn)
  fnRef.current = fn
  const optionsRef = useRef(options)
  optionsRef.current = options

  const run = useCallback(async (...args: TArgs): Promise<T | undefined> => {
    const id = ++callId.current
    setState({ status: 'loading' })
    try {
      const data = await unwrap(fnRef.current(...args))
      if (id !== callId.current) return data
      setState({ status: 'success', data })
      optionsRef.current.onSuccess?.(data)
      return data
    } catch (err) {
      if (id !== callId.current) return undefined
      const error = toAppError(err)
      setState({ status: 'error', error })
      optionsRef.current.onError?.(error)
      return undefined
    }
  }, [])

  const reset = useCallback(() => {
    callId.current += 1
    setState({ status: 'idle' })
  }, [])

  return {
    state,
    loading: state.status === 'loading',
    data: state.status === 'success' ? state.data : null,
    error: state.status === 'error' ? state.error : null,
    run,
    reset,
  }
}

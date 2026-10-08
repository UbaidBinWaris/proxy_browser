import type { AppError, AppErrorCode, IpcResult } from '@shared/types'
import { APP_ERROR_CODES } from '@shared/types'

/** Generic async lifecycle used by stores and pages. */
export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

/** Thrown by `unwrap` when an IPC call returns `{ ok: false }`. Carries the AppError code. */
export class ApiError extends Error {
  readonly code: AppErrorCode
  readonly detail: string | undefined

  constructor(error: AppError) {
    super(error.message)
    this.name = 'ApiError'
    this.code = error.code
    this.detail = error.detail
  }

  toAppError(): AppError {
    return { code: this.code, message: this.message, ...(this.detail ? { detail: this.detail } : {}) }
  }
}

/** Resolve the data of an IPC envelope or throw an `ApiError`. */
export async function unwrap<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  let result: IpcResult<T>
  try {
    result = await promise
  } catch (err) {
    throw new ApiError(toAppError(err))
  }
  if (result.ok) return result.data
  throw new ApiError(result.error)
}

function isAppErrorCode(value: unknown): value is AppErrorCode {
  return typeof value === 'string' && (APP_ERROR_CODES as readonly string[]).includes(value)
}

/** Normalise any thrown value into an `AppError` suitable for display. */
export function toAppError(err: unknown): AppError {
  if (err instanceof ApiError) return err.toAppError()
  if (err && typeof err === 'object') {
    const record = err as { code?: unknown; message?: unknown; detail?: unknown }
    if (isAppErrorCode(record.code) && typeof record.message === 'string') {
      return {
        code: record.code,
        message: record.message,
        ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
      }
    }
    if (err instanceof Error) {
      return { code: 'INTERNAL', message: err.message || 'Unexpected error.' }
    }
  }
  if (typeof err === 'string' && err.length > 0) return { code: 'INTERNAL', message: err }
  return { code: 'INTERNAL', message: 'Unexpected error. Check Settings → Advanced → Logs for details.' }
}

/**
 * Short human labels for error codes, shown next to the message.
 *
 * Keyed by string (not `AppErrorCode`) on purpose: the shared contract gains codes over time
 * (e.g. `SITE_HTTP_ERROR` for navigations that return HTTP >= 400) and the renderer must keep
 * compiling and rendering a sensible label either way. Use `errorLabel()` to read it.
 */
const ERROR_LABELS: Readonly<Record<string, string>> = {
  PROXY_NOT_CONFIGURED: 'Proxy not configured',
  VAULT_ERROR: 'Credential vault error',
  PROXY_AUTH_FAILED: 'Proxy authentication failed',
  PROXY_TIMEOUT: 'Proxy timeout',
  PROXY_DEAD: 'Proxy unreachable',
  DNS_FAILURE: 'DNS failure',
  IP_VERIFY_FAILED: 'IP verification failed',
  BROWSER_MISSING: 'Browser not installed',
  BROWSER_LAUNCH_FAILED: 'Browser launch failed',
  SITE_TIMEOUT: 'Site timeout',
  SITE_HTTP_ERROR: 'Site returned an HTTP error',
  SSL_ERROR: 'SSL error',
  INVALID_PROFILE: 'Invalid profile',
  INVALID_INPUT: 'Invalid input',
  NOT_FOUND: 'Not found',
  SESSION_CLOSED: 'Session closed',
  ENGINE_BUSY: 'Browser is being installed',
  INTERNAL: 'Internal error',
}

/** Human label for an error code; unknown codes are humanised ("SOME_NEW_CODE" → "Some new code"). */
export function errorLabel(code: AppErrorCode | string): string {
  const known = ERROR_LABELS[code]
  if (known) return known
  const words = code.toLowerCase().replace(/_+/g, ' ').trim()
  return words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : 'Error'
}

import type { ProxyConfigStatus, ProxyCredentialsInput, ProxyCredentialsUpdate, ProxyPool } from '@shared/types'
import { ProxyCredentialsInputSchema, ProxyCredentialsUpdateSchema } from '@shared/types'

export const DEFAULT_PROXY_HOST = 'gw.dataimpulse.com'
export const DEFAULT_PROXY_PORT = 823

/** Everything is kept as text while editing; `validateCredentialsForm` converts and checks. */
export interface CredentialsFormState {
  host: string
  port: string
  username: string
  /** Write-only: cleared after a successful save and never pre-filled. */
  password: string
  sessionTemplate: string
}

export type CredentialsFormErrors = Partial<Record<keyof CredentialsFormState, string>>

export const HOST_MESSAGE = 'Enter the hostname only, e.g. gw.dataimpulse.com — no http://, path or port'
export const PORT_MESSAGE = 'Port must be a whole number between 1 and 65535'

/** RFC 1123 hostname: dot-separated labels of letters, digits and inner dashes, 253 chars max. */
const HOSTNAME_PATTERN = /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/
const IPV4_PATTERN = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/** Fresh form: host/port pre-filled from the active configuration when known, DataImpulse defaults otherwise. */
export function emptyCredentialsForm(current?: Pick<ProxyConfigStatus, 'host' | 'port'> | null): CredentialsFormState {
  return {
    host: current?.host ?? DEFAULT_PROXY_HOST,
    port: String(current?.port ?? DEFAULT_PROXY_PORT),
    username: '',
    password: '',
    sessionTemplate: '',
  }
}

/** Hostname or IPv4 literal only. Users often paste a URL or "host:port"; both are rejected with a hint. */
export function validateHost(host: string): string | null {
  const value = host.trim()
  if (value.length === 0) return 'Proxy host is required'
  if (/\s/.test(value) || value.includes('://') || value.includes('/') || value.includes(':') || value.includes('@')) return HOST_MESSAGE
  if (!HOSTNAME_PATTERN.test(value) && !IPV4_PATTERN.test(value)) return HOST_MESSAGE
  return null
}

function portOrNaN(value: string): number {
  const trimmed = value.trim()
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN
}

function friendly(key: keyof CredentialsFormState, issue: { code: string; message: string }): string {
  switch (key) {
    case 'host':
      return issue.code === 'too_big' ? 'Proxy host must be 253 characters or fewer' : issue.message
    case 'port':
      return PORT_MESSAGE
    case 'username':
      return issue.code === 'too_big' ? 'Proxy username must be 256 characters or fewer' : issue.message
    case 'password':
      return issue.code === 'too_big' ? 'Proxy password must be 512 characters or fewer' : issue.message
    case 'sessionTemplate':
      // The shared schema's refine supplies SESSION_TEMPLATE_MESSAGE ({username} + {session} placeholders).
      return issue.code === 'too_big' ? 'Session template must be 200 characters or fewer' : issue.message
  }
}

/**
 * Validate the credentials form against the shared `ProxyCredentialsInputSchema`, plus the stricter
 * host rule (hostname/IPv4 only). Host and username are trimmed; the password is sent as typed.
 * `pool` names the DataImpulse plan these credentials belong to (each pool has its own login).
 */
export function validateCredentialsForm(
  form: CredentialsFormState,
  pool: ProxyPool = 'residential',
): { input: ProxyCredentialsInput; errors: null } | { input: null; errors: CredentialsFormErrors } {
  const errors: CredentialsFormErrors = {}
  const hostError = validateHost(form.host)
  if (hostError) errors.host = hostError

  const sessionTemplate = form.sessionTemplate.trim()
  const parsed = ProxyCredentialsInputSchema.safeParse({
    pool,
    host: form.host.trim(),
    port: portOrNaN(form.port),
    username: form.username.trim(),
    password: form.password,
    sessionTemplate: sessionTemplate.length > 0 ? sessionTemplate : null,
  })

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]
      if (typeof key === 'string' && key in form && !(key in errors)) {
        errors[key as keyof CredentialsFormState] = friendly(key as keyof CredentialsFormState, issue)
      }
    }
  }

  if (Object.keys(errors).length > 0) return { input: null, errors }
  if (!parsed.success) return { input: null, errors: { host: 'Credentials are invalid' } }
  return { input: parsed.data, errors: null }
}

export const NOTHING_TO_UPDATE_MESSAGE = 'Enter a new password or change another field.'

export interface CredentialsUpdateContext {
  /** Stored host/port (pre-filled into the form); used to tell whether anything changed. */
  current: { host: string | null; port: number | null }
  /** The session template field was edited (an untouched empty field keeps the stored template). */
  templateTouched: boolean
}

/**
 * Validate the form as a PARTIAL update of a pool whose credentials are in the vault: an empty
 * username or password keeps the stored value (merged in the main process). Host and port are
 * always sent; the template only when edited. Refuses an update that changes nothing.
 */
export function validateCredentialsUpdateForm(
  form: CredentialsFormState,
  pool: ProxyPool,
  context: CredentialsUpdateContext,
): { input: ProxyCredentialsUpdate; errors: null } | { input: null; errors: CredentialsFormErrors } {
  const errors: CredentialsFormErrors = {}
  const hostError = validateHost(form.host)
  if (hostError) errors.host = hostError
  const port = portOrNaN(form.port)
  const sessionTemplate = form.sessionTemplate.trim()
  const candidate: ProxyCredentialsUpdate = {
    pool,
    host: form.host.trim(),
    port,
    ...(form.username.trim() !== '' ? { username: form.username.trim() } : {}),
    ...(form.password !== '' ? { password: form.password } : {}),
    ...(context.templateTouched ? { sessionTemplate: sessionTemplate === '' ? null : sessionTemplate } : {}),
  }
  const parsed = ProxyCredentialsUpdateSchema.safeParse(candidate)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]
      if (typeof key === 'string' && key in form && !(key in errors)) {
        errors[key as keyof CredentialsFormState] = friendly(key as keyof CredentialsFormState, issue)
      }
    }
  }
  if (Object.keys(errors).length > 0) return { input: null, errors }
  if (!parsed.success) return { input: null, errors: { host: 'Credentials are invalid' } }
  const unchanged =
    candidate.username === undefined &&
    candidate.password === undefined &&
    candidate.sessionTemplate === undefined &&
    candidate.host === context.current.host &&
    candidate.port === context.current.port
  if (unchanged) return { input: null, errors: { password: NOTHING_TO_UPDATE_MESSAGE } }
  return { input: parsed.data, errors: null }
}

/**
 * Secret redaction for log output.
 *
 * Two layers, always applied together:
 *  1. Exact replacement of every registered secret (proxy password, full auth
 *     strings, ...) anywhere inside strings, including nested meta values.
 *  2. Pattern scrubbing for credential shapes that could appear even when the
 *     exact secret is unknown: `scheme://user:pass@host`, bare `user:pass@host`,
 *     `Authorization` / `Proxy-Authorization` header values, and
 *     `password=...` / `"password":"..."` pairs.
 */

export const REDACTED = '[REDACTED]'

const MAX_DEPTH = 16

/** `scheme://user:pass@host` */
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@"'`]+):([^/\s@"'`]+)@/gi

/** Bare `user:pass@host` (no scheme); anchored to a token start to avoid eating prose. */
const BARE_CREDENTIALS = /(^|[\s"'`=,;([{])([^\s:@/"'`=,;()[\]{}]+):([^\s@/"'`=,;(){}]+)@(?=[A-Za-z0-9[])/g

/** Object keys whose entire value is sensitive regardless of its shape. */
const SENSITIVE_KEYS = /^(?:proxy[-_]?authorization|authorization|password|passwd|pwd|pass|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|token)$/i

/** `Authorization: Basic xyz`, `"proxy-authorization": "..."`, `authorization=...` */
const AUTH_HEADER = /((?:proxy-)?authorization\b["']?\s*[:=]\s*["']?)([^"'\r\n,}]+)/gi

/** `password=hunter2`, `"password": "hunter2"`, `passwd=...`, `pwd=...`, `pass:...` */
const PASSWORD_PAIR = /(\b(?:password|passwd|pwd|pass)\b["']?\s*[:=]\s*["']?)([^"'\s&,;}]+)/gi
const PRIVATE_PAIR = /(\b(?:access[-_]?token|refresh[-_]?token|id[-_]?token|token|api[-_]?key|secret|email|phone|ssn)\b["']?\s*[:=]\s*["']?)([^"'\s&,;}]+)/gi

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Build one alternation regex for all secrets, longest first so prefixes never win. */
export function compileSecrets(secrets: readonly string[]): RegExp | null {
  const unique = Array.from(new Set(secrets.filter((s) => typeof s === 'string' && s.length > 0)))
  if (unique.length === 0) return null
  unique.sort((a, b) => b.length - a.length)
  return new RegExp(unique.map(escapeRegExp).join('|'), 'g')
}

export function redactString(input: string, secretPattern: RegExp | null): string {
  let out = input
  if (secretPattern) out = out.replace(secretPattern, REDACTED)
  out = out.replace(URL_CREDENTIALS, `$1${REDACTED}:${REDACTED}@`)
  out = out.replace(BARE_CREDENTIALS, `$1${REDACTED}:${REDACTED}@`)
  out = out.replace(AUTH_HEADER, `$1${REDACTED}`)
  out = out.replace(PASSWORD_PAIR, `$1${REDACTED}`)
  out = out.replace(PRIVATE_PAIR, `$1${REDACTED}`)
  return out
}

function redactValue(value: unknown, pattern: RegExp | null, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value, pattern)
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'function' || typeof value === 'symbol') return undefined
    return value
  }
  if (depth >= MAX_DEPTH) return '[MaxDepth]'
  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: redactString(value.message, pattern),
    }
    if (value.stack) out.stack = redactString(value.stack, pattern)
    const code = (value as { code?: unknown }).code
    if (code !== undefined) out.code = redactValue(code, pattern, depth + 1, seen)
    if (value.cause !== undefined) out.cause = redactValue(value.cause, pattern, depth + 1, seen)
    return out
  }
  if (value instanceof Date) return value.toISOString()
  if (value instanceof URL) return redactString(value.toString(), pattern)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, pattern, depth + 1, seen))
  if (value instanceof Map) {
    return redactValue(Object.fromEntries(value.entries()), pattern, depth, seen)
  }
  if (value instanceof Set) {
    return redactValue(Array.from(value.values()), pattern, depth, seen)
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `[Binary ${value.byteLength} bytes]`

  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEYS.test(key) && item !== null && item !== undefined) {
      out[key] = REDACTED
      continue
    }
    const redacted = redactValue(item, pattern, depth + 1, seen)
    if (redacted !== undefined) out[redactString(key, pattern)] = redacted
  }
  return out
}

/**
 * Deep-redact any value. Strings are scrubbed in place; objects and arrays
 * are rebuilt (never mutated), errors become plain `{ name, message, stack }`.
 */
export function redactSecrets(input: unknown, secrets: readonly string[]): unknown {
  return redactValue(input, compileSecrets(secrets), 0, new WeakSet())
}

/** Same as `redactSecrets` but with a pre-compiled secret pattern (hot path). */
export function redactWithPattern(input: unknown, pattern: RegExp | null): unknown {
  return redactValue(input, pattern, 0, new WeakSet())
}

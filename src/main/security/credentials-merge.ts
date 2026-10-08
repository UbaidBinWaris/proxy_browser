/**
 * Partial credential updates from the "Manage proxy keys" window.
 *
 * The renderer never receives the stored username, password or secret extra
 * fields, so rotating one value must not require retyping the others: the
 * update is merged with the provider product's vault entry here, in the main
 * process, and the merged result is validated with the same
 * `ProxyCredentialsInputSchema` a full save uses.
 *
 * Rules
 *   - host / username / password: absent or empty (after trimming; the password
 *     is never trimmed) keep the stored value.
 *   - port: absent keeps the stored value.
 *   - sessionTemplate: absent keeps the stored template; null or '' removes it.
 *   - extras: per field, absent or empty keeps the stored value.
 *   - Nothing stored for the product: every required field must be in the update.
 */
import { ProxyCredentialsInputSchema, ProxyCredentialsUpdateSchema } from '@shared/types'
import type { ProxyCredentialsData, ProxyCredentialsUpdate } from '@shared/types'

import { AppException } from '../contracts'
import type { StoredProxyCredentials } from '../contracts'

const REQUIRED_LABELS = { host: 'Proxy host', port: 'Port', username: 'Proxy username', password: 'Proxy password' } as const
type RequiredField = keyof typeof REQUIRED_LABELS

function text(value: string | undefined, trim: boolean): string | undefined {
  if (value === undefined) return undefined
  const candidate = trim ? value.trim() : value
  return candidate === '' ? undefined : candidate
}

/** True when the update would change nothing about the stored entry (all fields absent or empty). */
export function isEmptyCredentialsUpdate(update: ProxyCredentialsUpdate): boolean {
  return (
    text(update.host, true) === undefined &&
    update.port === undefined &&
    text(update.username, true) === undefined &&
    text(update.password, false) === undefined &&
    update.sessionTemplate === undefined &&
    Object.values(update.extras ?? {}).every((value) => value === '')
  )
}

/** Parse an update (defaults applied); INVALID_INPUT naming the field, never a value. */
export function parseCredentialsUpdate(rawUpdate: ProxyCredentialsUpdate): ReturnType<typeof ProxyCredentialsUpdateSchema.parse> {
  const parsedUpdate = ProxyCredentialsUpdateSchema.safeParse(rawUpdate)
  if (!parsedUpdate.success) {
    const issue = parsedUpdate.error.issues[0]
    throw new AppException('INVALID_INPUT', issue ? `${issue.path.map(String).join('.') || 'credentials'}: ${issue.message}` : 'Invalid credentials update.')
  }
  return parsedUpdate.data
}

/**
 * Merge `update` onto `stored` (the product's vault entry, or null when the vault has none)
 * and validate. Throws `INVALID_INPUT` with a field-specific message; never includes a
 * credential value in the message.
 */
export function mergeCredentialsUpdate(stored: StoredProxyCredentials | null, rawUpdate: ProxyCredentialsUpdate): ProxyCredentialsData {
  const update = parseCredentialsUpdate(rawUpdate)
  if (stored && (stored.pool !== update.pool || stored.providerId !== update.providerId)) {
    throw new AppException(
      'INTERNAL',
      'Stored credentials belong to another provider or pool.',
      `stored=${stored.providerId}/${stored.pool} update=${update.providerId}/${update.pool}`,
    )
  }

  const extras: Record<string, string> = { ...(stored?.extras ?? {}) }
  for (const [key, value] of Object.entries(update.extras ?? {})) {
    if (value !== '') extras[key] = value
  }

  const merged = {
    providerId: update.providerId,
    pool: update.pool,
    host: text(update.host, true) ?? stored?.host,
    port: update.port ?? stored?.port,
    username: text(update.username, true) ?? stored?.username,
    password: text(update.password, false) ?? stored?.password,
    sessionTemplate: update.sessionTemplate === undefined ? (stored?.sessionTemplate ?? null) : update.sessionTemplate === '' ? null : update.sessionTemplate,
    extras,
  }

  const missing = (Object.keys(REQUIRED_LABELS) as RequiredField[]).find((key) => merged[key] === undefined)
  if (missing) {
    throw new AppException('INVALID_INPUT', `${missing}: ${REQUIRED_LABELS[missing]} is required — nothing is stored for the ${update.pool} pool yet.`)
  }

  const parsed = ProxyCredentialsInputSchema.safeParse(merged)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new AppException('INVALID_INPUT', issue ? `${issue.path.map(String).join('.') || 'credentials'}: ${issue.message}` : 'Invalid credentials.')
  }
  return parsed.data
}

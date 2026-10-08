import type { DatabaseSync } from 'node:sqlite'

import { DEFAULT_PRODUCT_KEY, DEFAULT_PROVIDER_ID, TARGET_MATCHES } from '@shared/types'
import type { ProxySession, ProxyStatus, TargetMatch } from '@shared/types'

import { AppException } from '../../contracts'
import type { ProxySessionContext, ProxySessionRepository } from '../../contracts'
import { asNumber, asNumberOrNull, asString, asStringOrNull, guarded, newId, nowIso, nullable } from '../sql'
import type { Cell, Row } from '../sql'
import { parseTargetJson, targetToJson } from './profiles'

const COLUMNS = `id, profile_id, provider, pool, target_json, targeting_string, target_match, session_id, status, last_ip, country,
  country_code, region, city, postal_code, isp, asn, latency_ms, last_checked_at, last_error, created_at, updated_at`

const DEFAULT_CONTEXT: ProxySessionContext = { providerId: DEFAULT_PROVIDER_ID, pool: DEFAULT_PRODUCT_KEY, target: null, targetingString: null }

export function parseTargetMatch(value: Cell): TargetMatch | null {
  const text = asStringOrNull(value)
  return text !== null && (TARGET_MATCHES as readonly string[]).includes(text) ? (text as TargetMatch) : null
}

function rowToSession(row: Row): ProxySession {
  return {
    id: asString(row.id),
    profileId: asStringOrNull(row.profile_id),
    provider: asStringOrNull(row.provider) ?? DEFAULT_PROVIDER_ID,
    pool: asStringOrNull(row.pool) ?? DEFAULT_PRODUCT_KEY,
    target: parseTargetJson(row.target_json),
    targetingString: asStringOrNull(row.targeting_string),
    targetMatch: parseTargetMatch(row.target_match),
    sessionId: asStringOrNull(row.session_id),
    status: asString(row.status) as ProxyStatus,
    lastIp: asStringOrNull(row.last_ip),
    country: asStringOrNull(row.country),
    countryCode: asStringOrNull(row.country_code),
    region: asStringOrNull(row.region),
    city: asStringOrNull(row.city),
    postalCode: asStringOrNull(row.postal_code),
    isp: asStringOrNull(row.isp),
    asn: asStringOrNull(row.asn),
    latencyMs: asNumberOrNull(row.latency_ms),
    lastCheckedAt: asStringOrNull(row.last_checked_at),
    lastError: asStringOrNull(row.last_error),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  }
}

function notFound(id: string): AppException {
  return new AppException('NOT_FOUND', 'Proxy session not found. Re-test the proxy to create a new one.', `proxy session id ${id}`)
}

function providerOf(context: ProxySessionContext): string {
  return context.providerId ?? DEFAULT_PROVIDER_ID
}

function sameContext(session: ProxySession, context: ProxySessionContext): boolean {
  return session.provider === providerOf(context) && session.pool === context.pool && session.targetingString === context.targetingString && targetToJson(session.target) === targetToJson(context.target)
}

export function createProxySessionRepository(db: DatabaseSync): ProxySessionRepository {
  const selectAll = db.prepare(`SELECT ${COLUMNS} FROM proxy_sessions ORDER BY updated_at DESC`)
  const selectOne = db.prepare(`SELECT ${COLUMNS} FROM proxy_sessions WHERE id = ?`)
  const selectByProfile = db.prepare(
    `SELECT ${COLUMNS} FROM proxy_sessions WHERE profile_id = ? ORDER BY updated_at DESC LIMIT 1`,
  )
  const selectGateway = db.prepare(
    `SELECT ${COLUMNS} FROM proxy_sessions WHERE profile_id IS NULL ORDER BY updated_at DESC LIMIT 1`,
  )
  const insert = db.prepare(`
    INSERT INTO proxy_sessions (id, profile_id, provider, pool, target_json, targeting_string, session_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'untested', ?, ?)
  `)
  /** A new session id or a new provider/pool/target means a new exit IP: the cached result is reset. */
  const resetContext = db.prepare(`
    UPDATE proxy_sessions SET
      session_id = ?, provider = ?, pool = ?, target_json = ?, targeting_string = ?, target_match = NULL, status = 'untested', last_ip = NULL,
      country = NULL, country_code = NULL, region = NULL, city = NULL, postal_code = NULL, isp = NULL, asn = NULL, latency_ms = NULL,
      last_checked_at = NULL, last_error = NULL, updated_at = ?
    WHERE id = ?
  `)
  const touch = db.prepare('UPDATE proxy_sessions SET updated_at = ? WHERE id = ?')
  const updateStatusWithIp = db.prepare(`
    UPDATE proxy_sessions SET
      status = ?, last_ip = ?, country = ?, country_code = ?, region = ?, city = ?, postal_code = ?, isp = ?, asn = ?, latency_ms = ?,
      last_checked_at = ?, last_error = ?, target_match = ?, updated_at = ?
    WHERE id = ?
  `)
  const updateStatusOnly = db.prepare(`
    UPDATE proxy_sessions SET status = ?, last_error = ?, last_checked_at = ?, updated_at = ? WHERE id = ?
  `)
  const updateTargetMatch = db.prepare('UPDATE proxy_sessions SET target_match = ? WHERE id = ?')
  const countByStatus = db.prepare('SELECT COUNT(*) AS n FROM proxy_sessions WHERE status = ?')
  const remove = db.prepare('DELETE FROM proxy_sessions WHERE id = ?')

  const get = (id: string): ProxySession | null =>
    guarded('load proxy session', () => {
      const row = selectOne.get(id) as Row | undefined
      return row ? rowToSession(row) : null
    })

  const getByProfile = (profileId: string | null): ProxySession | null =>
    guarded('load proxy session for profile', () => {
      const row = (profileId === null ? selectGateway.get() : selectByProfile.get(profileId)) as Row | undefined
      return row ? rowToSession(row) : null
    })

  return {
    list: () => guarded('list proxy sessions', () => (selectAll.all() as Row[]).map(rowToSession)),
    get,
    getByProfile,

    /**
     * One row per profile. A changed sticky session id, provider, pool or target means a
     * new exit IP, so the cached IP/status is reset to `untested`; an unchanged
     * context only bumps `updatedAt`.
     */
    upsertForProfile: (profileId, sessionId, context = DEFAULT_CONTEXT) =>
      guarded('save proxy session', () => {
        const ts = nowIso()
        const existing = getByProfile(profileId)
        if (existing) {
          if (existing.sessionId === sessionId && sameContext(existing, context)) {
            touch.run(ts, existing.id)
          } else {
            resetContext.run(nullable(sessionId), providerOf(context), context.pool, targetToJson(context.target), nullable(context.targetingString), ts, existing.id)
          }
          const updated = get(existing.id)
          if (!updated) throw notFound(existing.id)
          return updated
        }
        const id = newId()
        insert.run(id, profileId, providerOf(context), context.pool, targetToJson(context.target), nullable(context.targetingString), nullable(sessionId), ts, ts)
        const created = get(id)
        if (!created) throw new AppException('INTERNAL', 'Proxy session was not saved. Try again.')
        return created
      }),

    updateStatus: (id, patch) =>
      guarded('update proxy session status', () => {
        const ts = nowIso()
        const error = patch.error === undefined ? null : patch.error
        let changes: number
        if (patch.ip !== undefined) {
          const ip = patch.ip
          const result = updateStatusWithIp.run(
            patch.status,
            ip ? ip.ip : null,
            ip ? ip.country : null,
            ip ? ip.countryCode : null,
            ip ? ip.region : null,
            ip ? ip.city : null,
            ip ? ip.postalCode : null,
            ip ? ip.isp : null,
            ip ? ip.asn : null,
            ip ? ip.latencyMs : null,
            ip ? ip.checkedAt : ts,
            error,
            nullable(patch.targetMatch),
            ts,
            id,
          )
          changes = Number(result.changes)
        } else {
          const result = updateStatusOnly.run(patch.status, error, ts, ts, id)
          changes = Number(result.changes)
          if (changes > 0 && patch.targetMatch !== undefined) updateTargetMatch.run(patch.targetMatch, id)
        }
        if (changes === 0) throw notFound(id)
        const updated = get(id)
        if (!updated) throw notFound(id)
        return updated
      }),

    countByStatus: (status) => guarded('count proxy sessions', () => asNumber((countByStatus.get(status) as Row).n)),

    delete: (id) =>
      guarded('delete proxy session', () => {
        const result = remove.run(id)
        if (Number(result.changes) === 0) throw notFound(id)
      }),
  }
}

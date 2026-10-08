import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

import { LOG_LEVELS } from '@shared/types'
import type { LogEntry, LogLevel } from '@shared/types'

import { AppException } from '../../contracts'
import type { LogRepository } from '../../contracts'
import { asNumber, asString, escapeLike, guarded, parseJsonObject, toJson } from '../sql'
import type { Row } from '../sql'

export const DEFAULT_LOG_QUERY_LIMIT = 500
const MAX_LOG_QUERY_LIMIT = 10_000

function rowToEntry(row: Row): LogEntry {
  const meta = row.meta
  return {
    id: asNumber(row.id),
    timestamp: asString(row.timestamp),
    level: asString(row.level) as LogLevel,
    scope: asString(row.scope),
    message: asString(row.message),
    meta: typeof meta === 'string' && meta.length > 0 ? parseJsonObject<Record<string, unknown>>(meta, {}) : null,
  }
}

export function createLogRepository(db: DatabaseSync): LogRepository {
  const insert = db.prepare('INSERT INTO logs (timestamp, level, scope, message, meta) VALUES (?, ?, ?, ?, ?)')
  const selectOne = db.prepare('SELECT id, timestamp, level, scope, message, meta FROM logs WHERE id = ?')
  const clear = db.prepare('DELETE FROM logs')
  const prune = db.prepare('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ?)')

  return {
    insert: (entry) =>
      guarded('write log entry', () => {
        const result = insert.run(
          entry.timestamp,
          entry.level,
          entry.scope,
          entry.message,
          entry.meta === null || entry.meta === undefined ? null : toJson(entry.meta),
        )
        const row = selectOne.get(Number(result.lastInsertRowid)) as Row | undefined
        if (!row) throw new AppException('INTERNAL', 'Log entry was not saved.')
        return rowToEntry(row)
      }),

    query: (query = {}) =>
      guarded('query logs', () => {
        const where: string[] = []
        const params: SQLInputValue[] = []
        if (query.level && (LOG_LEVELS as readonly string[]).includes(query.level)) {
          where.push('level = ?')
          params.push(query.level)
        }
        if (query.scope && query.scope.trim()) {
          where.push('scope = ?')
          params.push(query.scope.trim())
        }
        if (query.search && query.search.trim()) {
          const like = `%${escapeLike(query.search.trim())}%`
          where.push("(message LIKE ? ESCAPE '\\' OR scope LIKE ? ESCAPE '\\' OR meta LIKE ? ESCAPE '\\')")
          params.push(like, like, like)
        }
        const requested = query.limit === undefined ? DEFAULT_LOG_QUERY_LIMIT : Math.trunc(query.limit)
        const limit = Math.min(Math.max(requested > 0 ? requested : DEFAULT_LOG_QUERY_LIMIT, 1), MAX_LOG_QUERY_LIMIT)
        params.push(limit)
        const sql = `SELECT id, timestamp, level, scope, message, meta FROM logs
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY id DESC LIMIT ?`
        return (db.prepare(sql).all(...params) as Row[]).map(rowToEntry)
      }),

    clear: () =>
      guarded('clear logs', () => {
        clear.run()
      }),

    prune: (max) =>
      guarded('prune logs', () => {
        const keep = Math.max(0, Math.trunc(max))
        prune.run(keep)
      }),
  }
}

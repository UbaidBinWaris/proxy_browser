import type { DatabaseSync } from 'node:sqlite'

import type { NetworkEntry } from '@shared/types'

import { AppException } from '../../contracts'
import type { NetworkRepository } from '../../contracts'
import { asNumberOrNull, asString, asStringOrNull, guarded, newId, nullable, parseJsonObject, toJson } from '../sql'
import type { Row } from '../sql'
import { redactUrl } from '../../security/data-privacy'

const COLUMNS = 'id, run_id, method, url, status, resource_type, request_time, response_time, duration_ms, extracted_ids'

function sanitizeIds(ids: Record<string, string> | undefined | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!ids) return out
  for (const [key, value] of Object.entries(ids)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

function rowToEntry(row: Row): NetworkEntry {
  return {
    id: asString(row.id),
    runId: asString(row.run_id),
    method: asString(row.method),
    url: redactUrl(asString(row.url)),
    status: asNumberOrNull(row.status),
    resourceType: asString(row.resource_type),
    requestTime: asString(row.request_time),
    responseTime: asStringOrNull(row.response_time),
    durationMs: asNumberOrNull(row.duration_ms),
    extractedIds: sanitizeIds(parseJsonObject<Record<string, string>>(row.extracted_ids, {})),
  }
}

export function createNetworkRepository(db: DatabaseSync): NetworkRepository {
  const selectByRun = db.prepare(`SELECT ${COLUMNS} FROM network_entries WHERE run_id = ? ORDER BY request_time ASC, rowid ASC`)
  const selectOne = db.prepare(`SELECT ${COLUMNS} FROM network_entries WHERE id = ?`)
  const insert = db.prepare(`INSERT INTO network_entries (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const complete = db.prepare(
    'UPDATE network_entries SET status = ?, response_time = ?, duration_ms = ?, extracted_ids = ? WHERE id = ?',
  )
  const removeByRun = db.prepare('DELETE FROM network_entries WHERE run_id = ?')

  return {
    listByRun: (runId) => guarded('list network entries', () => (selectByRun.all(runId) as Row[]).map(rowToEntry)),

    insert: (entry) =>
      guarded('record network request', () => {
        const id = newId()
        insert.run(
          id,
          entry.runId,
          entry.method,
          redactUrl(entry.url),
          nullable(entry.status),
          entry.resourceType,
          entry.requestTime,
          nullable(entry.responseTime),
          nullable(entry.durationMs),
          toJson(sanitizeIds(entry.extractedIds)),
        )
        const row = selectOne.get(id) as Row | undefined
        if (!row) throw new AppException('INTERNAL', 'Network entry was not saved.')
        return rowToEntry(row)
      }),

    /**
     * Responses can arrive after the run (and its entries) were deleted by the
     * user; that race is not an error, so a missing row is a no-op.
     */
    complete: (id, patch) =>
      guarded('record network response', () => {
        complete.run(nullable(patch.status), nullable(patch.responseTime), nullable(patch.durationMs), toJson(sanitizeIds(patch.extractedIds)), id)
      }),

    deleteByRun: (runId) =>
      guarded('delete network entries', () => {
        removeByRun.run(runId)
      }),
  }
}

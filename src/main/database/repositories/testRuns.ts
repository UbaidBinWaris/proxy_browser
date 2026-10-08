import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

import { TestRunPatchSchema } from '@shared/types'
import type { BrowserEngine, DevicePresetId, ProxyPool, RunStatus, TestRun } from '@shared/types'

import { AppException } from '../../contracts'
import type { TestRunRepository } from '../../contracts'
import { asNumberOrNull, asString, asStringOrNull, guarded, newId, nullable } from '../sql'
import type { Row } from '../sql'
import { parseTargetJson, targetToJson } from './profiles'
import { parseTargetMatch } from './proxySessions'
import { redactUrl } from '../../security/data-privacy'

type RunField = keyof Omit<TestRun, 'id'>

/** Domain field → column. Also the single source of truth for insert/update ordering. */
const COLUMN_OF: Record<RunField, string> = {
  profileId: 'profile_id',
  profileName: 'profile_name',
  engine: 'engine',
  devicePreset: 'device_preset',
  proxyPool: 'pool',
  target: 'target_json',
  targetingString: 'targeting_string',
  targetMatch: 'target_match',
  publicIp: 'public_ip',
  country: 'country',
  region: 'region',
  city: 'city',
  postalCode: 'postal_code',
  locationAttempts: 'location_attempts',
  locationMaxAttempts: 'location_max_attempts',
  locationWarning: 'location_warning',
  proxySessionId: 'proxy_session_id',
  formUrl: 'form_url',
  startedAt: 'started_at',
  endedAt: 'ended_at',
  status: 'status',
  notes: 'notes',
  httpStatus: 'http_status',
  finalUrl: 'final_url',
  screenshotPath: 'screenshot_path',
  leadId: 'lead_id',
  certificateId: 'certificate_id',
  errorMessage: 'error_message',
}
const FIELDS = Object.keys(COLUMN_OF) as RunField[]
const SELECT_COLUMNS = ['id', ...FIELDS.map((f) => COLUMN_OF[f])].join(', ')

function rowToRun(row: Row): TestRun {
  return {
    id: asString(row.id),
    profileId: asStringOrNull(row.profile_id),
    profileName: asString(row.profile_name),
    engine: asString(row.engine) as BrowserEngine,
    devicePreset: asString(row.device_preset) as DevicePresetId,
    proxyPool: asStringOrNull(row.pool) as ProxyPool | null,
    target: parseTargetJson(row.target_json),
    targetingString: asStringOrNull(row.targeting_string),
    targetMatch: parseTargetMatch(row.target_match),
    publicIp: asStringOrNull(row.public_ip),
    country: asStringOrNull(row.country),
    region: asStringOrNull(row.region),
    city: asStringOrNull(row.city),
    postalCode: asStringOrNull(row.postal_code),
    locationAttempts: Math.max(1, asNumberOrNull(row.location_attempts) ?? 1),
    locationMaxAttempts: Math.max(1, asNumberOrNull(row.location_max_attempts) ?? 1),
    locationWarning: asStringOrNull(row.location_warning),
    proxySessionId: asStringOrNull(row.proxy_session_id),
    formUrl: redactUrl(asString(row.form_url)),
    startedAt: asString(row.started_at),
    endedAt: asStringOrNull(row.ended_at),
    status: asString(row.status) as RunStatus,
    notes: asString(row.notes),
    httpStatus: asNumberOrNull(row.http_status),
    finalUrl: row.final_url === null || row.final_url === undefined ? null : redactUrl(asString(row.final_url)),
    screenshotPath: asStringOrNull(row.screenshot_path),
    leadId: asStringOrNull(row.lead_id),
    certificateId: asStringOrNull(row.certificate_id),
    errorMessage: asStringOrNull(row.error_message),
  }
}

/** The GeoTarget object is stored as JSON; every other field is a scalar already. */
function toParam(field: RunField, value: TestRun[RunField]): SQLInputValue {
  if (field === 'target') return targetToJson(value as TestRun['target'])
  if ((field === 'formUrl' || field === 'finalUrl') && typeof value === 'string') return redactUrl(value)
  return nullable(value as Exclude<TestRun[RunField], TestRun['target']>)
}

function notFound(id: string): AppException {
  return new AppException('NOT_FOUND', 'Test run not found. It may have been deleted.', `run id ${id}`)
}

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 5000

export function createTestRunRepository(db: DatabaseSync): TestRunRepository {
  const selectList = db.prepare(`SELECT ${SELECT_COLUMNS} FROM test_runs ORDER BY started_at DESC, rowid DESC LIMIT ?`)
  const selectOne = db.prepare(`SELECT ${SELECT_COLUMNS} FROM test_runs WHERE id = ?`)
  const insert = db.prepare(`
    INSERT INTO test_runs (${SELECT_COLUMNS})
    VALUES (${['?', ...FIELDS.map(() => '?')].join(', ')})
  `)
  const remove = db.prepare('DELETE FROM test_runs WHERE id = ?')

  const get = (id: string): TestRun | null =>
    guarded('load test run', () => {
      const row = selectOne.get(id) as Row | undefined
      return row ? rowToRun(row) : null
    })

  const update = (id: string, patch: Partial<Omit<TestRun, 'id'>>): TestRun =>
    guarded('update test run', () => {
      const fields = FIELDS.filter((f) => patch[f] !== undefined)
      if (fields.length > 0) {
        const setClause = fields.map((f) => `${COLUMN_OF[f]} = ?`).join(', ')
        const params = fields.map((f) => toParam(f, patch[f] as TestRun[RunField]))
        const result = db.prepare(`UPDATE test_runs SET ${setClause} WHERE id = ?`).run(...params, id)
        if (Number(result.changes) === 0) throw notFound(id)
      }
      const updated = get(id)
      if (!updated) throw notFound(id)
      return updated
    })

  return {
    list: (limit = DEFAULT_LIMIT) =>
      guarded('list test runs', () => {
        const n = Math.min(Math.max(Math.trunc(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
        return (selectList.all(n) as Row[]).map(rowToRun)
      }),
    get,

    create: (run) =>
      guarded('create test run', () => {
        const id = newId()
        insert.run(id, ...FIELDS.map((f) => toParam(f, run[f])))
        const created = get(id)
        if (!created) throw new AppException('INTERNAL', 'Test run was not saved. Try again.')
        return created
      }),

    update,

    patch: (id, rawPatch) => {
      const parsed = TestRunPatchSchema.safeParse(rawPatch)
      if (!parsed.success) {
        const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'patch'}: ${i.message}`).join('; ')
        throw new AppException('INVALID_INPUT', 'Test run changes are invalid. Check the fields and try again.', detail)
      }
      return update(id, parsed.data)
    },

    delete: (id) =>
      guarded('delete test run', () => {
        const result = remove.run(id)
        if (Number(result.changes) === 0) throw notFound(id)
      }),
  }
}

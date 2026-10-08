import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { EnvironmentInputSchema, SuiteInputSchema, QaPolicySchema, ScenarioInputSchema } from '@shared/qa'
import type { EnvironmentInput, SuiteInput, QaEnvironment, QaSuite } from '@shared/qa'
import type {
  QaAuditEntry,
  QaBatch,
  QaGateway,
  QaPolicy,
  QaScenario,
  QaSchedule,
  QaSnapshot,
  QaWorkspace,
  ScenarioInput,
  ScheduleInput,
} from '@shared/qa'
import { AppException } from '../contracts'
import { transaction } from '../database/sql'

export function createQaStore(db: DatabaseSync) {
  const read = <T>(table: string): T[] =>
    db
      .prepare(`SELECT body FROM ${table} ORDER BY rowid DESC`)
      .all()
      .map((row) => JSON.parse(String(row.body)) as T)
  const put = (table: string, id: string, body: unknown): void => {
    db.prepare(`INSERT INTO ${table}(id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`).run(
      id,
      JSON.stringify(body),
    )
  }
  const get = <T>(table: string, id: string): T => {
    const row = db.prepare(`SELECT body FROM ${table} WHERE id=?`).get(id)
    if (!row) throw new AppException('NOT_FOUND', 'That QA item no longer exists.')
    return JSON.parse(String(row.body)) as T
  }
  const audit = (workspaceId: string, action: string, entityId: string, actor = 'local'): void => {
    db.prepare('INSERT INTO qa_audit(timestamp,workspace_id,actor,action,entity_id) VALUES(?,?,?,?,?)').run(
      new Date().toISOString(),
      workspaceId,
      actor,
      action,
      entityId,
    )
  }
  const store = {
    environments: () => read<QaEnvironment>('qa_environments'),
    environment: (id: string) => get<QaEnvironment>('qa_environments', id),
    saveEnvironment(input: EnvironmentInput, id?: string): QaEnvironment {
      const parsed = EnvironmentInputSchema.parse(input)
      get<QaWorkspace>('qa_workspaces', parsed.workspaceId)
      if (id) get<QaEnvironment>('qa_environments', id)
      const item = { ...parsed, id: id ?? randomUUID() }
      put('qa_environments', item.id, item)
      audit(item.workspaceId, 'environment.saved', item.id)
      return item
    },
    deleteEnvironment(id: string): void {
      const item = store.environment(id)
      if (store.batches().some((batch) => !batch.endedAt && batch.input.environmentId === id))
        throw new AppException('SESSION_LIMIT', 'Wait for the active run before deleting this environment.')
      if (store.schedules().some((schedule) => schedule.input.environmentId === id))
        throw new AppException('INVALID_INPUT', 'Delete schedules using this environment first.')
      db.prepare('DELETE FROM qa_environments WHERE id=?').run(id)
      audit(item.workspaceId, 'environment.deleted', id)
    },
    suites: () => read<QaSuite>('qa_suites'),
    suite: (id: string) => get<QaSuite>('qa_suites', id),
    saveSuite(input: SuiteInput, id?: string): QaSuite {
      const parsed = SuiteInputSchema.parse(input)
      get<QaWorkspace>('qa_workspaces', parsed.workspaceId)
      if (id) get<QaSuite>('qa_suites', id)
      for (const scenarioId of parsed.scenarioIds)
        if (store.scenario(scenarioId).workspaceId !== parsed.workspaceId)
          throw new AppException('INVALID_INPUT', 'Suite scenarios must belong to the same workspace.')
      const item = { ...parsed, id: id ?? randomUUID() }
      put('qa_suites', item.id, item)
      audit(item.workspaceId, 'suite.saved', item.id)
      return item
    },
    deleteSuite(id: string): void {
      const item = store.suite(id)
      if (store.batches().some((batch) => !batch.endedAt && batch.input.suiteId === id))
        throw new AppException('SESSION_LIMIT', 'Wait for the active run before deleting this suite.')
      if (store.schedules().some((schedule) => schedule.input.suiteId === id))
        throw new AppException('INVALID_INPUT', 'Delete schedules using this suite first.')
      db.prepare('DELETE FROM qa_suites WHERE id=?').run(id)
      audit(item.workspaceId, 'suite.deleted', id)
    },
    transaction: <T>(fn: () => T): T => transaction(db, fn),
    gateways: (): QaGateway[] =>
      read<QaGateway & { encrypted: string }>('qa_gateways').map(({ encrypted: _encrypted, ...gateway }) => gateway),
    gateway: (id: string) => get<QaGateway & { encrypted: string }>('qa_gateways', id),
    saveGateway: (gateway: QaGateway & { encrypted: string }) => put('qa_gateways', gateway.id, gateway),
    deleteGateway(id: string): void {
      if (store.scenarios().some((scenario) => scenario.gatewayId === id))
        throw new AppException('INVALID_INPUT', 'Remove this gateway from its scenarios before deleting it.')
      db.prepare('DELETE FROM qa_gateways WHERE id=?').run(id)
      audit('default', 'gateway.deleted', id)
    },
    workspaces: () => read<QaWorkspace>('qa_workspaces'),
    createWorkspace(name: string): QaWorkspace {
      const workspace = { id: randomUUID(), name, createdAt: new Date().toISOString() }
      put('qa_workspaces', workspace.id, workspace)
      audit(workspace.id, 'workspace.created', workspace.id)
      return workspace
    },
    scenarios: () =>
      read<QaScenario>('qa_scenarios').map((scenario) => ({
        ...scenario,
        visualKey: scenario.visualKey ?? scenario.id,
      })),
    scenario: (id: string) => {
      const scenario = get<QaScenario>('qa_scenarios', id)
      return { ...scenario, visualKey: scenario.visualKey ?? scenario.id }
    },
    saveScenario(input: ScenarioInput, id?: string): QaScenario {
      const parsed = ScenarioInputSchema.parse(input)
      get<QaWorkspace>('qa_workspaces', parsed.workspaceId)
      const previous = id ? get<QaScenario>('qa_scenarios', id) : null
      const scenario = {
        ...parsed,
        visualKey: previous?.visualKey ?? parsed.visualKey ?? randomUUID(),
        id: id ?? randomUUID(),
        createdAt: previous?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      put('qa_scenarios', scenario.id, scenario)
      audit(scenario.workspaceId, previous ? 'scenario.updated' : 'scenario.created', scenario.id)
      return scenario
    },
    deleteScenario(id: string): void {
      const scenario = get<QaScenario>('qa_scenarios', id)
      if (store.suites().some((suite) => suite.scenarioIds.includes(id)))
        throw new AppException('INVALID_INPUT', 'Remove this scenario from its suites before deleting it.')
      db.prepare('DELETE FROM qa_scenarios WHERE id=?').run(id)
      for (const schedule of read<QaSchedule>('qa_schedules'))
        if (schedule.scenarioId === id) db.prepare('DELETE FROM qa_schedules WHERE id=?').run(schedule.id)
      audit(scenario.workspaceId, 'scenario.deleted', id)
    },
    batches: () => read<QaBatch>('qa_batches'),
    batch: (id: string) => get<QaBatch>('qa_batches', id),
    saveBatch: (batch: QaBatch) => put('qa_batches', batch.id, batch),
    deleteBatch: (id: string) => {
      db.prepare('DELETE FROM qa_batches WHERE id=?').run(id)
    },
    policy: (): QaPolicy => {
      const row = db.prepare("SELECT body FROM qa_policy WHERE id='policy'").get()
      return QaPolicySchema.parse(row ? JSON.parse(String(row.body)) : {})
    },
    savePolicy(input: QaPolicy): QaPolicy {
      const policy = QaPolicySchema.parse(input)
      put('qa_policy', 'policy', policy)
      audit('default', 'policy.updated', 'policy')
      return policy
    },
    audit: (): QaAuditEntry[] =>
      db
        .prepare(
          'SELECT id,timestamp,workspace_id AS workspaceId,actor,action,entity_id AS entityId FROM qa_audit ORDER BY id DESC LIMIT 1000',
        )
        .all() as unknown as QaAuditEntry[],
    recordAudit: audit,
    schedules: () => read<QaSchedule>('qa_schedules'),
    saveSchedule(input: ScheduleInput, id?: string): QaSchedule {
      const scenario = store.scenario(input.input.scenarioId)
      if (input.input.suiteId) store.suite(input.input.suiteId)
      if (
        input.input.environmentId &&
        store.environment(input.input.environmentId).workspaceId !== scenario.workspaceId
      )
        throw new AppException('INVALID_INPUT', 'Environment must belong to the scenario workspace.')
      const schedule = {
        id: id ?? randomUUID(),
        scenarioId: scenario.id,
        input: input.input,
        intervalMinutes: input.intervalMinutes,
        enabled: input.enabled,
        nextRunAt: new Date(Date.now() + input.intervalMinutes * 60000).toISOString(),
      }
      put('qa_schedules', schedule.id, schedule)
      audit(scenario.workspaceId, 'schedule.saved', schedule.id)
      return schedule
    },
    advanceSchedule(schedule: QaSchedule, outcome: { lastError: string | null; lastBatchId: string | null }): void {
      put('qa_schedules', schedule.id, {
        ...schedule,
        ...outcome,
        lastRunAt: new Date().toISOString(),
        nextRunAt: new Date(Date.now() + schedule.intervalMinutes * 60000).toISOString(),
      })
    },
    deleteSchedule(id: string): void {
      const schedule = get<QaSchedule>('qa_schedules', id)
      db.prepare('DELETE FROM qa_schedules WHERE id=?').run(id)
      audit('default', 'schedule.deleted', schedule.id)
    },
    snapshot(): QaSnapshot {
      return {
        workspaces: store.workspaces(),
        scenarios: store.scenarios(),
        batches: store.batches().slice(0, 100),
        schedules: store.schedules(),
        audit: store.audit(),
        policy: store.policy(),
        gateways: store.gateways(),
        environments: store.environments(),
        suites: store.suites(),
      }
    },
  }
  if (!db.prepare("SELECT id FROM qa_workspaces WHERE id='default'").get())
    put('qa_workspaces', 'default', { id: 'default', name: 'My workspace', createdAt: new Date().toISOString() })
  return store
}
export type QaStore = ReturnType<typeof createQaStore>

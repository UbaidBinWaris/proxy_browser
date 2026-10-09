import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import type { MatrixInput, QaBatch, QaCase, QaExecution, QaScenario, ScenarioInput } from '@shared/qa'
import { MatrixInputSchema, ScenarioInputSchema, countHealedSteps } from '@shared/qa'
import { summarizeChecks } from '@shared/qa-checks'
import type { Profile } from '@shared/types'
import type { ProfileManager } from '../contracts'
import { AppException } from '../contracts'
import { DEVICE_PRESETS } from '../browser/device-presets'
import { redactEvidence } from '../security/data-privacy'
import type { QaStore } from './store'
import { resolveScenario } from './variables'
import { visualKey } from './visual'

export interface QaServiceOptions {
  store: QaStore
  profiles: ProfileManager
  artifactRoot: string
  execute: (
    profile: Profile,
    scenario: ScenarioInput,
    dir: string,
    signal: AbortSignal,
  ) => Promise<QaExecution & { exitIp?: string; targetMatch?: string | null }>
  canStart?: () => boolean
  onUpdate?: (batch: QaBatch) => void
}
export function planMatrix(
  profile: Profile,
  input: MatrixInput,
  max: number,
): Array<{ engine: Profile['engine']; device: string; target: Profile['target'] }> {
  const engines = [...new Set(input.engines.length ? input.engines : [profile.engine])]
  const devices = [...new Set(input.devices.length ? input.devices : [profile.devicePreset])]
  const targets = input.targets.length ? input.targets : [profile.target]
  if (engines.length * devices.length * targets.length > max)
    throw new AppException('INVALID_INPUT', `Matrix exceeds the ${max}-case limit.`)
  const cases = []
  for (const engine of engines)
    for (const device of devices) {
      const preset = DEVICE_PRESETS.find((item) => item.id === device)
      if (!preset || !preset.supportedEngines.includes(engine))
        throw new AppException('INVALID_INPUT', `Device ${device} is incompatible with ${engine}.`)
      for (const target of targets) {
        if (profile.proxyMode === 'none' && target)
          throw new AppException('INVALID_INPUT', 'Location matrices require a proxy profile.')
        cases.push({ engine, device, target })
      }
    }
  return cases
}

export function createQaService(options: QaServiceOptions) {
  const { store, profiles, artifactRoot } = options
  let active: { id: string; controller: AbortController; done: Promise<void> } | null = null
  let disposed = false
  let lastPrune = Date.now()
  const emit = (batch: QaBatch): void => {
    store.saveBatch(batch)
    options.onUpdate?.(structuredClone(batch))
  }
  for (const batch of store.batches())
    if (batch.status === 'queued' || batch.status === 'running') {
      batch.status = 'interrupted'
      batch.endedAt = new Date().toISOString()
      store.saveBatch(batch)
      store.recordAudit(batch.workspaceId, 'batch.interrupted', batch.id)
    }
  const service = {
    saveScenario(input: ScenarioInput, id?: string): QaScenario {
      const parsed = ScenarioInputSchema.parse(input)
      profiles.get(parsed.profileId)
      if (parsed.gatewayId) store.gateway(parsed.gatewayId)
      if (parsed.captureTrace && !store.policy().allowTraces)
        throw new AppException(
          'INVALID_INPUT',
          'Enable trace capture in data controls first. Traces can contain raw page data.',
        )
      return store.saveScenario(parsed, id)
    },
    deleteScenario(id: string): void {
      if (
        active &&
        (store.batch(active.id).scenarioId === id ||
          (store.batch(active.id).input.suiteId &&
            store.suite(store.batch(active.id).input.suiteId!).scenarioIds.includes(id)))
      )
        throw new AppException('SESSION_LIMIT', 'Cancel the active matrix before deleting this scenario.')
      store.deleteScenario(id)
    },
    start(raw: MatrixInput): QaBatch {
      if (disposed) throw new AppException('INTERNAL', 'QA automation is shutting down.')
      if (options.canStart && !options.canStart())
        throw new AppException('SESSION_LIMIT', 'Stop recording before running tests.')
      if (active)
        throw new AppException('SESSION_LIMIT', 'A matrix is already running. Cancel it or wait for completion.')
      const input = MatrixInputSchema.parse(raw)
      const suite = input.suiteId ? store.suite(input.suiteId) : null
      const sourceScenarios = (suite ? suite.scenarioIds : [input.scenarioId]).map((id) => store.scenario(id))
      const scenario = sourceScenarios[0]!
      const environment = input.environmentId ? store.environment(input.environmentId) : undefined
      if (environment && environment.workspaceId !== scenario.workspaceId)
        throw new AppException('INVALID_INPUT', 'Choose an environment in the same workspace.')
      if (suite && input.scenarioId !== scenario.id)
        throw new AppException('INVALID_INPUT', 'Suite runs must reference their first scenario.')
      const policy = store.policy()
      const plans = sourceScenarios.flatMap((source) => {
        if (source.workspaceId !== scenario.workspaceId)
          throw new AppException('INVALID_INPUT', 'Suite scenarios must belong to one workspace.')
        const base = profiles.get(source.profileId)
        if (source.gatewayId) store.gateway(source.gatewayId)
        const profile = source.gatewayId ? { ...base, proxyMode: 'none' as const, target: null } : base
        if (source.captureTrace && !policy.allowTraces)
          throw new AppException('INVALID_INPUT', 'Trace capture is disabled by the current policy.')
        const rows = source.datasets ?? []
        const selected = input.datasetIds?.length ? rows.filter((row) => input.datasetIds!.includes(row.id)) : rows
        if (input.datasetIds?.length && input.datasetIds.some((id) => !rows.some((row) => row.id === id)))
          throw new AppException('INVALID_INPUT', 'A selected dataset no longer exists. Use all datasets for suites.')
        return (selected.length ? selected : [undefined]).flatMap((row) => {
          const resolved = resolveScenario(source, environment, row)
          resolved.visualKey = visualKey([source.visualKey ?? source.id, row?.id ?? null])
          return planMatrix(profile, input, policy.maxCombinations).map((plan) => ({
            ...plan,
            profile,
            scenario: resolved,
            scenarioId: source.id,
            datasetId: row?.id,
            datasetName: row?.name,
          }))
        })
      })
      if (plans.length > policy.maxCombinations)
        throw new AppException(
          'INVALID_INPUT',
          `Run exceeds the ${policy.maxCombinations}-case limit, including datasets and suite scenarios.`,
        )
      const profile = plans[0]!.profile
      const today = new Date().toISOString().slice(0, 10)
      const reserved = store
        .batches()
        .filter((batch) => batch.startedAt.startsWith(today))
        .reduce((count, batch) => count + batch.total * (batch.input.retries + 1), 0)
      if (reserved + plans.length * (input.retries + 1) > policy.maxDailyCases)
        throw new AppException('INVALID_INPUT', 'This matrix exceeds the daily execution budget, including retries.')
      const batch: QaBatch = {
        id: randomUUID(),
        workspaceId: scenario.workspaceId,
        scenarioId: input.scenarioId,
        scenarioName: suite?.name ?? scenario.name,
        suiteId: suite?.id,
        environmentName: environment?.name,
        status: 'queued',
        startedAt: new Date().toISOString(),
        endedAt: null,
        total: plans.length,
        completed: 0,
        healedSteps: 0,
        cases: [],
        input,
      }
      const controller = new AbortController()
      emit(batch)
      store.recordAudit(batch.workspaceId, 'batch.started', batch.id)
      const run = async (): Promise<void> => {
        batch.status = 'running'
        emit(batch)
        let next = 0
        const worker = async (): Promise<void> => {
          while (!controller.signal.aborted && next < plans.length) {
            const index = next++
            const { profile: caseProfile, scenario: caseScenario, ...plan } = plans[index]!
            const id = `${index + 1}`
            let final: QaCase | undefined
            const history: Array<QaExecution & { attempt: number }> = []
            for (let attempt = 1; attempt <= input.retries + 1 && !controller.signal.aborted; attempt++) {
              const preset = DEVICE_PRESETS.find((item) => item.id === plan.device)!
              let temporary: Profile | undefined
              const began = Date.now()
              try {
                temporary = profiles.create({
                  ...caseProfile,
                  name: `QA ${index + 1}`,
                  engine: plan.engine,
                  devicePreset: plan.device,
                  deviceType: preset.deviceType,
                  viewportWidth: preset.viewportWidth,
                  viewportHeight: preset.viewportHeight,
                  userAgent: null,
                  formUrlOverride: caseScenario.startUrl,
                  target: plan.target,
                  stickySessionId: caseProfile.proxyMode === 'sticky' ? randomUUID() : null,
                  ephemeral: true,
                })
                const outcome = await options.execute(
                  temporary,
                  caseScenario,
                  join(artifactRoot, batch.id, `${id}-${attempt}`),
                  controller.signal,
                )
                const checks = summarizeChecks(outcome.steps)
                final = {
                  ...outcome,
                  id,
                  ...plan,
                  scenarioName: caseScenario.name,
                  environmentName: environment?.name,
                  attempt,
                  ...(checks.length ? { checks } : {}),
                }
              } catch (err) {
                final = {
                  id,
                  ...plan,
                  attempt,
                  status: controller.signal.aborted ? 'cancelled' : 'failed',
                  steps: [],
                  errors: [redactEvidence(err instanceof Error ? err.message : 'Execution failed.').slice(0, 1000)],
                  failedRequests: [],
                  finalUrl: '',
                  durationMs: Date.now() - began,
                }
              } finally {
                if (temporary) profiles.delete(temporary.id)
              }
              history.push({
                status: final.status,
                steps: final.steps,
                errors: final.errors,
                failedRequests: final.failedRequests,
                trace: final.trace,
                finalUrl: final.finalUrl,
                durationMs: final.durationMs,
                attempt,
              })
              if (final.status !== 'failed') break
            }
            if (final) {
              final.attempts = history
              batch.cases.push(final)
              batch.cases.sort((a, b) => Number(a.id) - Number(b.id))
              batch.completed = batch.cases.length
              batch.healedSteps = countHealedSteps(batch.cases)
              emit(batch)
            }
          }
        }
        try {
          await Promise.all(
            Array.from({ length: Math.min(input.concurrency, policy.maxConcurrentBrowsers, plans.length) }, worker),
          )
          batch.status = controller.signal.aborted
            ? 'cancelled'
            : batch.cases.some((item) => item.status !== 'passed')
              ? 'failed'
              : 'passed'
        } catch (err) {
          controller.abort()
          batch.status = 'failed'
          store.recordAudit(batch.workspaceId, 'batch.internal-error', batch.id)
          // The worker failure is observable even if a repository or cleanup failed.
          batch.cases.push({
            id: 'internal',
            engine: profile.engine,
            device: profile.devicePreset,
            target: null,
            attempt: 1,
            status: 'failed',
            steps: [],
            errors: [redactEvidence(err instanceof Error ? err.message : 'Internal failure.')],
            failedRequests: [],
            finalUrl: '',
            durationMs: 0,
          })
        } finally {
          batch.endedAt = new Date().toISOString()
          emit(batch)
          store.recordAudit(batch.workspaceId, `batch.${batch.status}`, batch.id)
          active = null
        }
      }
      const done = Promise.resolve().then(run)
      active = { id: batch.id, controller, done }
      return structuredClone(batch)
    },
    cancel(id: string): void {
      if (active?.id !== id) throw new AppException('NOT_FOUND', 'That matrix is no longer running.')
      active.controller.abort()
      store.recordAudit(store.batch(id).workspaceId, 'batch.cancel-requested', id)
    },
    async prune(): Promise<number> {
      const cutoff = Date.now() - store.policy().retentionDays * 86400000
      await mkdir(artifactRoot, { recursive: true, mode: 0o700 })
      const root = await realpath(artifactRoot)
      let removed = 0
      for (const batch of store.batches()) {
        if (!batch.endedAt || new Date(batch.endedAt).getTime() >= cutoff || active?.id === batch.id) continue
        if (!/^[a-f0-9-]{36}$/i.test(batch.id)) continue
        const dir = join(root, batch.id)
        try {
          const resolved = await realpath(dir)
          const rel = relative(root, resolved)
          if (rel.startsWith('..') || isAbsolute(rel) || !rel) continue
          await rm(dir, { recursive: true, force: true })
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        }
        store.deleteBatch(batch.id)
        store.recordAudit(batch.workspaceId, 'batch.retention-deleted', batch.id)
        removed++
      }
      return removed
    },
    async tick(): Promise<void> {
      if (!disposed && Date.now() - lastPrune >= 3600000) {
        lastPrune = Date.now()
        await service.prune()
      }
      if (active || disposed) return
      for (const schedule of store.schedules()) {
        if (!schedule.enabled || new Date(schedule.nextRunAt).getTime() > Date.now()) continue
        let lastError: string | null = null,
          lastBatchId: string | null = null
        try {
          lastBatchId = service.start(schedule.input).id
        } catch (err) {
          lastError = redactEvidence(err instanceof Error ? err.message : 'Could not start scheduled matrix.')
          store.recordAudit('default', 'schedule.failed-to-start', schedule.id)
        }
        store.advanceSchedule(schedule, { lastError, lastBatchId })
        break
      }
    },
    async dispose(): Promise<void> {
      disposed = true
      if (active) {
        active.controller.abort()
        await active.done
      }
    },
    async idle(): Promise<void> {
      await active?.done
    },
  }
  return service
}
export type QaService = ReturnType<typeof createQaService>

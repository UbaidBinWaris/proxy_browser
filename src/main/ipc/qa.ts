import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { IPC } from '@shared/ipc'
import {
  GatewayInputSchema,
  EnvironmentInputSchema,
  SuiteInputSchema,
  MatrixInputSchema,
  QaPolicySchema,
  ScenarioInputSchema,
  ScheduleInputSchema,
} from '@shared/qa'
import { AppException } from '../contracts'
import { backupConfiguration, decryptBackup, encryptBackup, restoreConfiguration } from '../qa/backup'
import { exportBatch } from '../qa/reports'
import { writeFileAtomicSync } from '../util/atomic-file'
import { redactEvidence } from '../security/data-privacy'
import { approveBatchBaseline, batchVisualEvidence } from '../qa/visual'
import { applyHealedSelector } from '../qa/healing'
import type { IpcDeps } from './deps'
import { IdArg, IdSchema, NoArgs, spec } from './handle'
import type { HandlerSpec } from './handle'

export function qaHandlers(deps: IpcDeps): HandlerSpec[] {
  const store = () => {
    if (!deps.db.qa) throw new AppException('INTERNAL', 'QA storage is unavailable.')
    return deps.db.qa
  }
  const service = () => {
    if (!deps.qa) throw new AppException('INTERNAL', 'QA automation is unavailable.')
    return deps.qa
  }
  const gateways = () => {
    if (!deps.gateways) throw new AppException('INTERNAL', 'Gateway manager is unavailable.')
    return deps.gateways
  }
  const updates = () => {
    if (!deps.updates) throw new AppException('INTERNAL', 'Update manager is unavailable.')
    return deps.updates
  }
  const passphrase = z.string().min(12).max(1024)
  return [
    spec(
      IPC.qa.visualImages,
      z.tuple([IdSchema, z.string().regex(/^\d+$/), z.int().min(0).max(99)]),
      async ([batch, caseId, index]) => {
        if (!deps.visuals) throw new AppException('INTERNAL', 'Visual comparisons are unavailable.')
        const visual = await batchVisualEvidence(store(), join(deps.paths.data, 'qa-artifacts'), batch, caseId, index)
        return deps.visuals.images(visual.actual, visual.expected, visual.diff)
      },
    ),
    spec(IPC.qa.saveEnvironment, z.tuple([EnvironmentInputSchema, IdSchema.optional()]), ([input, id]) =>
      store().saveEnvironment(input, id),
    ),
    spec(IPC.qa.deleteEnvironment, IdArg, ([id]) => store().deleteEnvironment(id)),
    spec(IPC.qa.saveSuite, z.tuple([SuiteInputSchema, IdSchema.optional()]), ([input, id]) =>
      store().saveSuite(input, id),
    ),
    spec(IPC.qa.deleteSuite, IdArg, ([id]) => store().deleteSuite(id)),
    spec(IPC.qa.startRecording, z.tuple([ScenarioInputSchema]), ([input]) => {
      if (!deps.recorder) throw new AppException('INTERNAL', 'Recorder is unavailable.')
      if (
        store()
          .batches()
          .some((batch) => !batch.endedAt)
      )
        throw new AppException('SESSION_LIMIT', 'Wait for the current run before recording.')
      return deps.recorder.start(input)
    }),
    spec(IPC.qa.recording, NoArgs, () => deps.recorder?.snapshot() ?? null),
    spec(IPC.qa.stopRecording, NoArgs, () => deps.recorder?.stop() ?? null),
    spec(
      IPC.qa.approveBaseline,
      z.tuple([IdSchema, z.string().regex(/^\d+$/), z.int().min(0).max(99)]),
      ([batch, caseId, index]) => {
        if (!deps.visuals) throw new AppException('INTERNAL', 'Visual comparisons are unavailable.')
        return approveBatchBaseline(store(), deps.visuals, join(deps.paths.data, 'qa-artifacts'), batch, caseId, index)
      },
    ),
    // Identifiers only: the new selector comes from the saved scenario's own fallback list.
    spec(
      IPC.qa.updateHealedSelector,
      z.tuple([IdSchema, z.string().regex(/^\d+$/), z.int().min(0).max(99)]),
      ([batch, caseId, index]) => applyHealedSelector(store(), batch, caseId, index),
    ),
    spec(IPC.qa.exportBaselines, IdArg, async ([id]) => {
      if (!deps.visuals) throw new AppException('INTERNAL', 'Visual comparisons are unavailable.')
      const batch = store().batch(id)
      const pack = await deps.visuals.export(
        batch.cases.flatMap((item) => item.steps.flatMap((step) => (step.visual ? [step.visual.key] : []))),
      )
      const dir = join(deps.paths.data, 'reports')
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const file = join(dir, `baselines-${id}.qavb`)
      writeFileAtomicSync(file, JSON.stringify(pack))
      return file
    }),
    spec(IPC.qa.exportSuite, IdArg, async ([id]) => {
      const suite = store().suite(id)
      const scenarios = suite.scenarioIds.map((scenarioId) => store().scenario(scenarioId))
      const profiles = [...new Set(scenarios.map((scenario) => scenario.profileId))].map((profileId) =>
        deps.profiles.get(profileId),
      )
      const dir = join(deps.paths.data, 'reports')
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const file = join(dir, `suite-${id}.json`)
      writeFileAtomicSync(
        file,
        JSON.stringify(
          {
            suite,
            scenarios,
            profiles,
            environments: store()
              .environments()
              .filter((env) => env.workspaceId === suite.workspaceId),
          },
          null,
          2,
        ),
      )
      store().recordAudit(suite.workspaceId, 'suite.exported', id)
      return file
    }),
    spec(IPC.qa.checkUpdates, NoArgs, () => updates().check()),
    spec(IPC.qa.downloadUpdate, NoArgs, () => updates().download()),
    spec(IPC.qa.saveGateway, z.tuple([GatewayInputSchema, IdSchema.optional()]), ([input, id]) =>
      gateways().save(input, id),
    ),
    spec(IPC.qa.testGateway, IdArg, ([id]) => gateways().test(id)),
    spec(IPC.qa.deleteGateway, IdArg, ([id]) => store().deleteGateway(id)),
    spec(IPC.qa.exportScenario, IdArg, async ([id]) => {
      const scenario = store().scenario(id)
      const profile = deps.profiles.get(scenario.profileId)
      const dir = join(deps.paths.data, 'reports')
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const file = join(dir, `scenario-${id}.json`)
      writeFileAtomicSync(
        file,
        JSON.stringify(
          {
            scenario,
            profile,
            environments: store()
              .environments()
              .filter((env) => env.workspaceId === scenario.workspaceId),
          },
          null,
          2,
        ),
      )
      store().recordAudit(scenario.workspaceId, 'scenario.exported', id)
      return file
    }),
    spec(IPC.qa.snapshot, NoArgs, () => store().snapshot()),
    spec(IPC.qa.createWorkspace, z.tuple([z.string().trim().min(1).max(120)]), ([name]) =>
      store().createWorkspace(name),
    ),
    spec(IPC.qa.saveScenario, z.tuple([ScenarioInputSchema, IdSchema.optional()]), ([input, id]) =>
      service().saveScenario(input, id),
    ),
    spec(IPC.qa.deleteScenario, IdArg, ([id]) => service().deleteScenario(id)),
    spec(IPC.qa.start, z.tuple([MatrixInputSchema]), ([input]) => {
      if (deps.recorder?.snapshot()?.status === 'recording')
        throw new AppException('SESSION_LIMIT', 'Stop recording before running tests.')
      return service().start(input)
    }),
    spec(IPC.qa.cancel, IdArg, ([id]) => service().cancel(id)),
    spec(IPC.qa.exportBatch, z.tuple([IdSchema, z.enum(['json', 'junit', 'html'])]), async ([id, format]) => {
      const report = exportBatch(store().batch(id), format)
      const dir = join(deps.paths.data, 'reports')
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const file = join(dir, report.fileName)
      writeFileAtomicSync(file, report.content)
      store().recordAudit(store().batch(id).workspaceId, 'batch.exported', id)
      return file
    }),
    spec(IPC.qa.savePolicy, z.tuple([QaPolicySchema]), ([input]) => store().savePolicy(input)),
    spec(IPC.qa.prune, NoArgs, () => service().prune()),
    spec(IPC.qa.backup, z.tuple([passphrase]), async ([password]) => {
      const body = await encryptBackup(backupConfiguration(store(), deps.profiles.list()), password)
      const dir = join(deps.paths.data, 'backups')
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const file = join(dir, `configuration-${randomUUID()}.pqab`)
      writeFileAtomicSync(file, body)
      store().recordAudit('default', 'configuration.backed-up', file.split(/[\\/]/).pop()!)
      return file
    }),
    spec(IPC.qa.restore, z.tuple([passphrase]), async ([password]) => {
      if (
        store()
          .batches()
          .some((batch) => batch.status === 'running' || batch.status === 'queued')
      )
        throw new AppException('SESSION_LIMIT', 'Wait for the active matrix before restoring configuration.')
      const file = await deps.files?.chooseBackup()
      if (!file) return null
      if ((await stat(file)).size > 10 * 1024 * 1024 + 100)
        throw new AppException('INVALID_INPUT', 'Backup exceeds the size limit.')
      return restoreConfiguration(store(), deps.profiles, await decryptBackup(await readFile(file), password))
    }),
    spec(IPC.qa.saveSchedule, z.tuple([ScheduleInputSchema, IdSchema.optional()]), ([input, id]) =>
      store().saveSchedule(input, id),
    ),
    spec(IPC.qa.deleteSchedule, IdArg, ([id]) => store().deleteSchedule(id)),
    spec(IPC.qa.diagnostics, NoArgs, async () => {
      const diagnostic = {
        version: deps.app.getVersion(),
        platform: deps.app.platform,
        capturedAt: new Date().toISOString(),
        browsers: (await deps.provisioner.engines()).map(({ id, available, version }) => ({ id, available, version })),
        recentBatches: store()
          .batches()
          .slice(0, 20)
          .map(({ id, status, completed, total }) => ({ id, status, completed, total })),
        logs: deps.logger.query({ limit: 100 }).map(({ timestamp, level, scope, message }) => ({
          timestamp,
          level,
          scope,
          message: redactEvidence(deps.sanitize(message)),
        })),
      }
      const dir = join(deps.paths.data, 'reports')
      await mkdir(dir, { recursive: true })
      const file = join(dir, `diagnostics-${randomUUID()}.json`)
      writeFileAtomicSync(file, JSON.stringify(diagnostic, null, 2))
      return file
    }),
  ]
}

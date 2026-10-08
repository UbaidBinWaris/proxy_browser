import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GatewayInputSchema,
  MatrixInputSchema,
  ScenarioInputSchema,
  EnvironmentInputSchema,
  SuiteInputSchema,
} from '../src/shared/qa'
import { parseDatasetCsv } from '../src/shared/qa-csv'
import { resolveScenario } from '../src/main/qa/variables'
import { createVisualStore, visualKey, approveBatchBaseline } from '../src/main/qa/visual'
import { PNG } from 'pngjs'
import { createQaStore } from '../src/main/qa/store'
import type { QaBatch, QaExecution } from '../src/shared/qa'
import { ProfileInputSchema } from '../src/shared/types'
import { openDatabase } from '../src/main/database'
import { createProfileManager } from '../src/main/browser/profile-manager'
import { createLogger } from '../src/main/logging/logger'
import { redactUrl } from '../src/main/security/data-privacy'
import { createQaService, planMatrix } from '../src/main/qa/service'
import { backupConfiguration, decryptBackup, encryptBackup, restoreConfiguration } from '../src/main/qa/backup'
import { createGatewayManager } from '../src/main/qa/gateways'
import { exportBatch } from '../src/main/qa/reports'
import { createUpdateManager, newerVersion, verifyUpdateEnvelope } from '../src/main/releases/updates'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, runMigrations } from '../src/main/database/schema'

const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
})
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'qa-unit-'))
  const db = openDatabase(':memory:', { defaultScreenshotDir: join(dir, 'screenshots'), env: {} })
  const logger = createLogger({ repo: db.logs, fileDir: join(dir, 'logs') })
  const profiles = createProfileManager({ repo: db.profiles, logger })
  const profile = profiles.create(
    ProfileInputSchema.parse({
      name: 'Base',
      engine: 'chromium',
      deviceType: 'desktop',
      devicePreset: 'linux-desktop',
      viewportWidth: 1280,
      viewportHeight: 800,
      userAgent: null,
      locale: 'en-US',
      timezone: 'UTC',
      proxyMode: 'none',
      stickySessionId: null,
      formUrlOverride: null,
      notes: '',
    }),
  )
  const input = ScenarioInputSchema.parse({
    name: 'Form test',
    profileId: profile.id,
    startUrl: 'https://qa.example.test/',
    allowedOrigins: ['https://qa.example.test'],
    steps: [{ action: 'assertStatus', value: 200 }],
  })
  const store = db.qa!
  const scenario = store.saveScenario(input)
  const passed: QaExecution = {
    status: 'passed',
    steps: [],
    errors: [],
    failedRequests: [],
    finalUrl: input.startUrl,
    durationMs: 5,
  }
  disposers.push(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { db, logger, profiles, profile, input, store, scenario, passed, dir }
}
describe('Datasets, suites and environments', () => {
  it('gives legacy scenarios a stable visual identity for desktop and CI exports', () => {
    const h = harness(),
      raw = new DatabaseSync(':memory:')
    try {
      runMigrations(raw)
      const store = createQaStore(raw),
        saved = store.saveScenario(h.input)
      const { visualKey: _visualKey, ...legacy } = saved
      raw.prepare('UPDATE qa_scenarios SET body=? WHERE id=?').run(JSON.stringify(legacy), legacy.id)
      expect(store.scenario(legacy.id).visualKey).toBe(legacy.id)
      expect(store.snapshot().scenarios[0]?.visualKey).toBe(legacy.id)
    } finally {
      raw.close()
    }
  })
  it('reads quoted CSV, preserves empty inputs, and rejects malformed rows or duplicate headers', () => {
    expect(
      parseDatasetCsv('_name,email,expected\r\nValid,"test,a@example.test","Submitted"\r\nEmpty,,"Line 1\nLine ""2"""'),
    ).toEqual([
      { id: 'row-1', name: 'Valid', variables: { email: 'test,a@example.test', expected: 'Submitted' } },
      { id: 'row-2', name: 'Empty', variables: { email: '', expected: 'Line 1\nLine "2"' } },
    ])
    for (const invalid of ['email,email\na,b', 'email,expected\na', 'email\n"unclosed', 'email\n"x"oops'])
      expect(() => parseDatasetCsv(invalid)).toThrow()
  })
  it('resolves defaults, environment and dataset overrides without changing the stored scenario', () => {
    const h = harness()
    const input = ScenarioInputSchema.parse({
      ...h.input,
      startUrl: 'https://qa.example.test/form?view=1',
      variables: { email: 'default', expected: 'OK' },
      steps: [
        { action: 'fill', selector: '#email', value: '{{email}}' },
        { action: 'assertText', selector: '#result', value: '{{expected}}' },
      ],
    })
    const env = h.store.saveEnvironment(
      EnvironmentInputSchema.parse({
        name: 'Staging',
        baseUrl: 'https://staging.example.test/path',
        variables: { email: 'environment' },
      }),
    )
    const resolved = resolveScenario(input, env, { id: 'valid', name: 'Valid', variables: { email: 'dataset' } })
    expect(resolved.startUrl).toBe('https://staging.example.test/form?view=1')
    expect(resolved.allowedOrigins).toEqual(['https://staging.example.test'])
    expect(resolved.steps[0]).toMatchObject({ value: 'dataset' })
    expect(input.steps[0]).toMatchObject({ value: '{{email}}' })
    expect(() => resolveScenario({ ...input, startUrl: 'https://user:password@qa.example.test/' })).toThrow(
      /credentials/,
    )
    expect(
      EnvironmentInputSchema.safeParse({ name: 'Unsafe', baseUrl: 'https://user:password@staging.test' }).success,
    ).toBe(false)
    expect(() => resolveScenario({ ...input, variables: {} })).toThrow(/Missing test variable/)
    expect(() =>
      resolveScenario(
        ScenarioInputSchema.parse({
          ...h.input,
          steps: [{ action: 'goto', value: '{{destination}}' }],
          variables: { destination: 'https://foreign.example.test/' },
        }),
      ),
    ).toThrow(/approved origin/)
    expect(() =>
      resolveScenario(
        ScenarioInputSchema.parse({
          ...h.input,
          startUrl: '{{destination}}',
          variables: { destination: 'file:///tmp/private' },
        }),
      ),
    ).toThrow(/HTTP/)
  })
  it('expands every suite scenario and dataset, preserves labels, and enforces the combined budget', async () => {
    const h = harness()
    const first = h.store.saveScenario({
      ...h.input,
      name: 'Dataset scenario',
      variables: { email: 'default' },
      datasets: [
        { id: 'a', name: 'First', variables: { email: 'alpha-secret-test' } },
        { id: 'b', name: 'Second', variables: { email: 'beta-secret-test' } },
      ],
      steps: [{ action: 'fill', selector: '#email', value: '{{email}}' }],
    })
    const env = h.store.saveEnvironment(
      EnvironmentInputSchema.parse({ name: 'Staging', baseUrl: 'https://staging.example.test' }),
    )
    const suite = h.store.saveSuite(SuiteInputSchema.parse({ name: 'Smoke', scenarioIds: [first.id, h.scenario.id] }))
    const calls: string[] = []
    const service = createQaService({
      store: h.store,
      profiles: h.profiles,
      artifactRoot: h.dir,
      execute: async (_profile, scenario) => {
        calls.push(scenario.startUrl)
        return h.passed
      },
    })
    h.store.savePolicy({ ...h.store.policy(), maxCombinations: 2 })
    expect(() =>
      service.start(MatrixInputSchema.parse({ scenarioId: first.id, suiteId: suite.id, environmentId: env.id })),
    ).toThrow(/including datasets/)
    expect(h.store.batches()).toHaveLength(0)
    h.store.savePolicy({ ...h.store.policy(), maxCombinations: 10 })
    const batch = service.start(
      MatrixInputSchema.parse({ scenarioId: first.id, suiteId: suite.id, environmentId: env.id, concurrency: 2 }),
    )
    await service.idle()
    expect(h.store.batch(batch.id)).toMatchObject({ total: 3, completed: 3, status: 'passed', suiteId: suite.id })
    expect(h.store.batch(batch.id).cases.map((item) => item.datasetName)).toEqual(['First', 'Second', undefined])
    expect(calls.every((url) => url.startsWith(env.baseUrl))).toBe(true)
    expect(JSON.stringify(h.store.batch(batch.id))).not.toMatch(/alpha-secret-test|beta-secret-test/)
    expect(() => h.store.deleteScenario(first.id)).toThrow(/suites/)
    await service.dispose()
  })
  it('selects individual datasets, rejects stale IDs, and preflights missing variables before execution', async () => {
    const h = harness()
    const scenario = h.store.saveScenario({
      ...h.input,
      datasets: [
        { id: 'a', name: 'A', variables: {} },
        { id: 'b', name: 'B', variables: {} },
      ],
    })
    const execute = vi.fn(async () => h.passed)
    const service = createQaService({ store: h.store, profiles: h.profiles, artifactRoot: h.dir, execute })
    expect(() => service.start(MatrixInputSchema.parse({ scenarioId: scenario.id, datasetIds: ['deleted'] }))).toThrow(
      /no longer exists/,
    )
    const batch = service.start(MatrixInputSchema.parse({ scenarioId: scenario.id, datasetIds: ['b'] }))
    await service.idle()
    expect(h.store.batch(batch.id).cases[0]?.datasetId).toBe('b')
    expect(execute).toHaveBeenCalledTimes(1)
    const missing = h.store.saveScenario({
      ...h.input,
      steps: [{ action: 'fill', selector: '#email', value: '{{missing}}' }],
    })
    expect(() => service.start(MatrixInputSchema.parse({ scenarioId: missing.id }))).toThrow(/Missing test variable/)
    await service.dispose()
  })
  it('refuses environments and suite members from another workspace, and protects schedule references', () => {
    const h = harness()
    const workspace = h.store.createWorkspace('Other')
    const other = h.store.saveScenario({ ...h.input, workspaceId: workspace.id })
    expect(() =>
      h.store.saveSuite(SuiteInputSchema.parse({ name: 'Mixed', scenarioIds: [h.scenario.id, other.id] })),
    ).toThrow(/same workspace/)
    const env = h.store.saveEnvironment(
      EnvironmentInputSchema.parse({ workspaceId: workspace.id, name: 'Other', baseUrl: 'https://other.test' }),
    )
    const service = createQaService({
      store: h.store,
      profiles: h.profiles,
      artifactRoot: h.dir,
      execute: async () => h.passed,
    })
    expect(() => service.start(MatrixInputSchema.parse({ scenarioId: h.scenario.id, environmentId: env.id }))).toThrow(
      /same workspace/,
    )
    expect(() =>
      h.store.saveSchedule({
        input: MatrixInputSchema.parse({ scenarioId: h.scenario.id, environmentId: env.id }),
        enabled: true,
        intervalMinutes: 5,
      }),
    ).toThrow(/workspace/)
    const suite = h.store.saveSuite(
      SuiteInputSchema.parse({ workspaceId: workspace.id, name: 'Single', scenarioIds: [other.id] }),
    )
    h.store.saveSchedule({
      input: MatrixInputSchema.parse({ scenarioId: other.id, suiteId: suite.id, environmentId: env.id }),
      enabled: true,
      intervalMinutes: 5,
    })
    expect(() => h.store.deleteEnvironment(env.id)).toThrow(/schedules/)
    expect(() => h.store.deleteSuite(suite.id)).toThrow(/schedules/)
  })
  it('restores suite references, environments and stable visual identities from encrypted backups', async () => {
    const h = harness()
    h.store.saveEnvironment(
      EnvironmentInputSchema.parse({ name: 'Staging', baseUrl: 'https://staging.test', variables: { expected: 'OK' } }),
    )
    h.store.saveSuite(SuiteInputSchema.parse({ name: 'Smoke', scenarioIds: [h.scenario.id] }))
    const configuration = await decryptBackup(
      await encryptBackup(backupConfiguration(h.store, h.profiles.list()), 'a-long-test-passphrase'),
      'a-long-test-passphrase',
    )
    restoreConfiguration(h.store, h.profiles, configuration)
    const restoredSuite = h.store.suites().find((suite) => suite.id !== h.store.suites().at(-1)?.id)!
    expect(h.store.suites()).toHaveLength(2)
    expect(h.store.environments()).toHaveLength(2)
    expect(h.store.scenario(restoredSuite.scenarioIds[0]!).visualKey).toBe(h.scenario.visualKey)
    expect(h.store.scenario(restoredSuite.scenarioIds[0]!).workspaceId).toBe(restoredSuite.workspaceId)
  })
})
describe('Visual baselines', () => {
  const png = (color: number) => {
    const img = new PNG({ width: 20, height: 20 })
    img.data.fill(color)
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255
    return PNG.sync.write(img)
  }
  it('requires explicit approval, matches identical pixels and generates differences for changes', async () => {
    const h = harness(),
      key = visualKey(['test']),
      actual = join(h.dir, 'actual.png')
    const visuals = createVisualStore(join(h.dir, 'baselines'))
    writeFileSync(actual, png(255))
    expect((await visuals.compare(key, 'page', actual, 0.01)).status).toBe('missing')
    await visuals.approve(key, actual)
    expect((await visuals.compare(key, 'page', actual, 0.01)).status).toBe('matched')
    writeFileSync(actual, png(0))
    const changed = await visuals.compare(key, 'page', actual, 0.01)
    expect(changed).toMatchObject({ status: 'changed', diffRatio: 1 })
    expect(existsSync(changed.diff!)).toBe(true)
    await visuals.approve(key, actual)
    expect(readFileSync(changed.expected!)).toEqual(png(255))
    expect((await visuals.images(changed.actual, changed.expected, changed.diff)).expected).toContain(
      png(255).toString('base64'),
    )
    const other = createVisualStore(join(h.dir, 'imported'))
    await other.import(await visuals.export([key]))
    expect((await other.compare(key, 'page', actual, 0.01)).status).toBe('matched')
  })
  it('rejects invalid images, path keys, oversized PNG headers and duplicate screenshot names', async () => {
    const h = harness(),
      visuals = createVisualStore(join(h.dir, 'baselines'))
    const path = join(h.dir, 'invalid.png')
    writeFileSync(path, 'not a png')
    await expect(visuals.approve(visualKey(['x']), path)).rejects.toThrow(/PNG/)
    const bomb = png(0)
    bomb.writeUInt32BE(1000000, 16)
    writeFileSync(path, bomb)
    await expect(visuals.approve(visualKey(['x']), path)).rejects.toThrow(/pixel limit/)
    await expect(
      visuals.import({ version: 1, images: [{ key: '../outside', png: png(0).toString('base64') }] }),
    ).rejects.toThrow()
    expect(
      ScenarioInputSchema.safeParse({
        ...h.input,
        steps: [
          { action: 'assertScreenshot', name: 'page' },
          { action: 'assertScreenshot', name: 'page' },
        ],
      }).success,
    ).toBe(false)
  })
  it('prevents approving evidence outside a completed run', async () => {
    const h = harness(),
      visuals = createVisualStore(join(h.dir, 'baselines'))
    const service = createQaService({
      store: h.store,
      profiles: h.profiles,
      artifactRoot: join(h.dir, 'artifacts'),
      execute: async () => h.passed,
    })
    const batch = service.start(MatrixInputSchema.parse({ scenarioId: h.scenario.id }))
    await service.idle()
    mkdirSync(join(h.dir, 'artifacts', batch.id), { recursive: true })
    const path = join(h.dir, 'outside.png')
    writeFileSync(path, png(0))
    const saved = h.store.batch(batch.id)
    saved.cases[0]!.steps = [
      {
        index: 0,
        action: 'assertScreenshot',
        status: 'failed',
        durationMs: 0,
        visual: { key: visualKey(['x']), name: 'page', status: 'missing', actual: path },
      },
    ]
    h.store.saveBatch(saved)
    await expect(approveBatchBaseline(h.store, visuals, join(h.dir, 'artifacts'), batch.id, '1', 0)).rejects.toThrow(
      /outside/,
    )
    await service.dispose()
  })
})
describe('QA input validation and evidence privacy', () => {
  it('rejects navigation outside the approved origins and arbitrary script actions', () => {
    const h = harness()
    expect(
      ScenarioInputSchema.safeParse({ ...h.input, steps: [{ action: 'goto', value: 'https://unapproved.test/' }] })
        .success,
    ).toBe(false)
    expect(
      ScenarioInputSchema.safeParse({ ...h.input, steps: [{ action: 'evaluate', value: 'fetch("secret")' }] }).success,
    ).toBe(false)
  })
  it('redacts duplicated sensitive parameters, URL credentials and fragments while keeping ordinary filters', () => {
    const url = redactUrl(
      'https://user:pass@qa.test/form?email=alice&email=bob&token=secret&country=US#access_token=raw',
    )
    expect(url).not.toMatch(/alice|bob|secret|user:pass|access_token/)
    expect(new URL(url).searchParams.get('country')).toBe('US')
    expect(new URL(url).searchParams.get('email')).toBe('[REDACTED]')
  })
  it('redacts network URLs at the repository boundary', () => {
    const h = harness()
    // FK enforcement means use a real run row from the legacy test-run fixture shape.
    const run = h.db.testRuns.create({
      profileId: h.profile.id,
      profileName: h.profile.name,
      engine: h.profile.engine,
      devicePreset: h.profile.devicePreset,
      proxyPool: null,
      target: null,
      targetingString: null,
      targetMatch: null,
      publicIp: null,
      country: null,
      region: null,
      city: null,
      postalCode: null,
      locationAttempts: 1,
      locationMaxAttempts: 1,
      locationWarning: null,
      proxySessionId: null,
      formUrl: h.input.startUrl,
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: 'running',
      notes: '',
      httpStatus: null,
      finalUrl: null,
      screenshotPath: null,
      leadId: null,
      certificateId: null,
      errorMessage: null,
    })
    h.db.network.insert({
      runId: run.id,
      method: 'GET',
      url: 'https://qa.test/?api_key=never-save',
      status: 200,
      resourceType: 'document',
      requestTime: new Date().toISOString(),
      responseTime: null,
      durationMs: null,
      extractedIds: {},
    })
    expect(h.db.network.listByRun(run.id)[0]!.url).not.toContain('never-save')
  })
  it('upgrades existing captured URL records without retaining secret query values', () => {
    const raw = new DatabaseSync(':memory:')
    try {
      runMigrations(
        raw,
        MIGRATIONS.filter((migration) => migration.version < 6),
      )
      raw
        .prepare(
          'INSERT INTO test_runs(id,profile_name,engine,device_preset,form_url,started_at,status) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          'run',
          'Legacy',
          'chromium',
          'linux-desktop',
          'https://qa.test/?email=legacy-email',
          new Date().toISOString(),
          'success',
        )
      raw
        .prepare('INSERT INTO network_entries(id,run_id,method,url,resource_type,request_time) VALUES(?,?,?,?,?,?)')
        .run(
          'network',
          'run',
          'GET',
          'https://qa.test/?token=legacy-secret#private',
          'document',
          new Date().toISOString(),
        )
      runMigrations(raw)
      expect(String(raw.prepare('SELECT url FROM network_entries').get()!.url)).not.toContain('legacy-secret')
      expect(String(raw.prepare('SELECT form_url FROM test_runs').get()!.form_url)).not.toContain('legacy-email')
      expect(runMigrations(raw)).toEqual([])
    } finally {
      raw.close()
    }
  })
  it('rejects incompatible devices, excessive matrices, and location tests without proxies', () => {
    const h = harness()
    expect(() =>
      planMatrix(
        h.profile,
        MatrixInputSchema.parse({ scenarioId: h.scenario.id, engines: ['firefox'], devices: ['iphone-15'] }),
        100,
      ),
    ).toThrow(/incompatible/)
    expect(() =>
      planMatrix(
        h.profile,
        MatrixInputSchema.parse({ scenarioId: h.scenario.id, engines: ['chromium', 'firefox'] }),
        1,
      ),
    ).toThrow(/limit/)
    expect(() =>
      planMatrix(
        {
          ...h.profile,
          target: { mode: 'state', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: null, zip: null },
        },
        MatrixInputSchema.parse({ scenarioId: h.scenario.id }),
        100,
      ),
    ).toThrow(/proxy/)
  })
})
describe('QA matrix lifecycle', () => {
  it('runs a matrix with bounded concurrency and cleans up every temporary profile', async () => {
    const h = harness()
    let running = 0,
      peak = 0
    const execute = vi.fn(async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 10))
      running--
      return h.passed
    })
    const service = createQaService({ store: h.store, profiles: h.profiles, artifactRoot: h.dir, execute })
    const batch = service.start(
      MatrixInputSchema.parse({
        scenarioId: h.scenario.id,
        engines: ['chromium', 'firefox'],
        devices: ['linux-desktop', 'windows-desktop'],
        concurrency: 4,
      }),
    )
    await service.idle()
    expect(h.store.batch(batch.id)).toMatchObject({ status: 'passed', completed: 4, total: 4 })
    expect(peak).toBe(2)
    expect(h.db.profiles.list({ includeEphemeral: true })).toHaveLength(1)
    expect(h.profiles.get(h.profile.id)).toEqual(h.profile)
    await service.dispose()
  })
  it('retries only failed cases within the requested retry limit', async () => {
    const h = harness()
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ ...h.passed, status: 'failed' })
      .mockResolvedValue(h.passed)
    const service = createQaService({ store: h.store, profiles: h.profiles, artifactRoot: h.dir, execute })
    const batch = service.start(MatrixInputSchema.parse({ scenarioId: h.scenario.id, retries: 1 }))
    await service.idle()
    expect(execute).toHaveBeenCalledTimes(2)
    expect(h.store.batch(batch.id).cases[0]).toMatchObject({ status: 'passed', attempt: 2 })
    await service.dispose()
  })
  it('cancels running work, refuses a competing matrix and stops queued cases', async () => {
    const h = harness()
    const execute = vi.fn(async (_profile, _scenario, _dir, signal: AbortSignal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      return { ...h.passed, status: 'cancelled' as const }
    })
    const service = createQaService({ store: h.store, profiles: h.profiles, artifactRoot: h.dir, execute })
    const batch = service.start(
      MatrixInputSchema.parse({ scenarioId: h.scenario.id, devices: ['linux-desktop', 'windows-desktop'] }),
    )
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    expect(() => service.start(MatrixInputSchema.parse({ scenarioId: h.scenario.id }))).toThrow(/already running/)
    service.cancel(batch.id)
    await service.idle()
    expect(h.store.batch(batch.id)).toMatchObject({ status: 'cancelled', completed: 1, total: 2 })
    expect(h.db.profiles.list({ includeEphemeral: true })).toHaveLength(1)
    await service.dispose()
  })
  it('reserves retry attempts against the daily execution budget', async () => {
    const h = harness()
    h.store.savePolicy({ ...h.store.policy(), maxDailyCases: 1 })
    const execute = vi.fn(async () => h.passed)
    const service = createQaService({ store: h.store, profiles: h.profiles, artifactRoot: h.dir, execute })
    expect(() => service.start(MatrixInputSchema.parse({ scenarioId: h.scenario.id, retries: 1 }))).toThrow(/daily/)
    const batch = service.start(MatrixInputSchema.parse({ scenarioId: h.scenario.id }))
    await service.idle()
    expect(h.store.batch(batch.id).status).toBe('passed')
    expect(() => service.start(MatrixInputSchema.parse({ scenarioId: h.scenario.id }))).toThrow(/daily/)
    await service.dispose()
  })
  it('marks in-flight batches interrupted after a restart', async () => {
    const h = harness()
    h.store.saveBatch({
      id: 'interrupted',
      workspaceId: 'default',
      scenarioId: h.scenario.id,
      scenarioName: h.scenario.name,
      status: 'running',
      startedAt: new Date().toISOString(),
      endedAt: null,
      total: 1,
      completed: 0,
      cases: [],
      input: MatrixInputSchema.parse({ scenarioId: h.scenario.id }),
    })
    const service = createQaService({
      store: h.store,
      profiles: h.profiles,
      artifactRoot: h.dir,
      execute: async () => h.passed,
    })
    expect(h.store.batch('interrupted').status).toBe('interrupted')
    await service.dispose()
  })
  it('prunes expired evidence and records while preserving recent batches', async () => {
    const h = harness()
    const root = join(h.dir, 'artifacts')
    const service = createQaService({
      store: h.store,
      profiles: h.profiles,
      artifactRoot: root,
      execute: async () => h.passed,
    })
    const batch = service.start(MatrixInputSchema.parse({ scenarioId: h.scenario.id }))
    await service.idle()
    mkdirSync(join(root, batch.id), { recursive: true })
    writeFileSync(join(root, batch.id, 'evidence.png'), 'old evidence')
    const saved = h.store.batch(batch.id)
    saved.endedAt = '2020-01-01T00:00:00Z'
    h.store.saveBatch(saved)
    const recent = service.start(MatrixInputSchema.parse({ scenarioId: h.scenario.id }))
    await service.idle()
    expect(await service.prune()).toBe(1)
    expect(existsSync(join(root, batch.id))).toBe(false)
    expect(h.store.batch(recent.id).status).toBe('passed')
    expect(h.store.audit().some((entry) => entry.action === 'batch.retention-deleted')).toBe(true)
    await service.dispose()
  })
  it.skipIf(process.platform === 'win32')(
    'refuses to follow retention symlinks outside the artifact root',
    async () => {
      const h = harness(),
        root = join(h.dir, 'artifacts'),
        outside = join(h.dir, 'keep')
      mkdirSync(outside)
      writeFileSync(join(outside, 'evidence'), 'keep')
      const service = createQaService({
        store: h.store,
        profiles: h.profiles,
        artifactRoot: root,
        execute: async () => h.passed,
      })
      const batch = service.start(MatrixInputSchema.parse({ scenarioId: h.scenario.id }))
      await service.idle()
      mkdirSync(root)
      symlinkSync(outside, join(root, batch.id))
      h.store.saveBatch({ ...h.store.batch(batch.id), endedAt: '2020-01-01T00:00:00Z' })
      expect(await service.prune()).toBe(0)
      expect(readFileSync(join(outside, 'evidence'), 'utf8')).toBe('keep')
      await service.dispose()
    },
  )
  it('runs due schedules once and advances the next run', async () => {
    const h = harness(),
      execute = vi.fn(async () => h.passed)
    const schedule = h.store.saveSchedule({
      input: MatrixInputSchema.parse({ scenarioId: h.scenario.id }),
      intervalMinutes: 5,
      enabled: true,
    })
    vi.spyOn(h.store, 'schedules').mockReturnValue([{ ...schedule, nextRunAt: '2020-01-01T00:00:00Z' }])
    const service = createQaService({ store: h.store, profiles: h.profiles, artifactRoot: h.dir, execute })
    await service.tick()
    await service.idle()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(h.store.batches()).toHaveLength(1)
    await service.dispose()
  })
  it('rejects raw traces unless the local policy explicitly permits them', async () => {
    const h = harness()
    const service = createQaService({
      store: h.store,
      profiles: h.profiles,
      artifactRoot: h.dir,
      execute: async () => h.passed,
    })
    expect(() => service.saveScenario({ ...h.input, captureTrace: true })).toThrow(/trace/)
    h.store.savePolicy({ ...h.store.policy(), allowTraces: true })
    expect(service.saveScenario({ ...h.input, captureTrace: true }).captureTrace).toBe(true)
    await service.dispose()
  })
})
describe('Encrypted backup and local audit', () => {
  it('round-trips encrypted configuration and imports independent copies', async () => {
    const h = harness()
    const encrypted = await encryptBackup(backupConfiguration(h.store, h.profiles.list()), 'a strong test passphrase')
    expect(encrypted.toString()).not.toContain('Form test')
    const config = await decryptBackup(encrypted, 'a strong test passphrase')
    expect(restoreConfiguration(h.store, h.profiles, config)).toBe(1)
    expect(h.store.scenarios()).toHaveLength(2)
    const restored = h.store.scenarios().find((scenario) => scenario.id !== h.scenario.id)!
    expect(restored.profileId).not.toBe(h.profile.id)
    expect(restored.workspaceId).not.toBe('default')
    expect(h.store.audit().some((entry) => entry.action === 'configuration.restored')).toBe(true)
  })
  it('rejects wrong passwords, tampering and unsupported backup versions', async () => {
    const h = harness()
    const bytes = await encryptBackup(backupConfiguration(h.store, h.profiles.list()), 'correct backup password')
    await expect(decryptBackup(bytes, 'incorrect password')).rejects.toThrow(/passphrase/)
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1
    await expect(decryptBackup(bytes, 'correct backup password')).rejects.toThrow(/integrity/)
    await expect(
      encryptBackup({ ...backupConfiguration(h.store, h.profiles.list()), version: 2 }, 'correct backup password'),
    ).rejects.toThrow()
  })
  it('validates all references before modifying existing data', () => {
    const h = harness()
    const config = backupConfiguration(h.store, h.profiles.list())
    config.scenarios[0]!.profileId = 'missing'
    expect(() => restoreConfiguration(h.store, h.profiles, config as never)).toThrow(/references/)
    expect(h.profiles.list()).toHaveLength(1)
    expect(h.store.workspaces()).toHaveLength(1)
  })
  it('rolls back imported workspaces and profiles when profile validation fails', () => {
    const h = harness(),
      config = backupConfiguration(h.store, h.profiles.list())
    config.profiles[0]!.timezone = 'Invalid/Zone'
    expect(() => restoreConfiguration(h.store, h.profiles, config as never)).toThrow()
    expect(h.store.workspaces()).toHaveLength(1)
    expect(h.profiles.list()).toHaveLength(1)
    expect(h.store.scenarios()).toHaveLength(1)
  })
  it('isolates workspace scenario lists and preserves audit history after deletion', () => {
    const h = harness(),
      workspace = h.store.createWorkspace('Second project')
    const scenario = h.store.saveScenario({ ...h.input, workspaceId: workspace.id })
    h.store.deleteScenario(scenario.id)
    expect(h.store.scenarios().filter((item) => item.workspaceId === workspace.id)).toHaveLength(0)
    expect(h.store.audit().some((entry) => entry.entityId === scenario.id && entry.action === 'scenario.deleted')).toBe(
      true,
    )
  })
})
describe('Generic gateway security', () => {
  it('rejects unsafe gateway URLs and missing secure keychains', () => {
    const h = harness()
    expect(
      GatewayInputSchema.safeParse({ name: 'Bad', server: 'file:///etc/passwd', username: '', password: '' }).success,
    ).toBe(false)
    expect(
      GatewayInputSchema.safeParse({ name: 'Bad', server: 'http://user:pass@proxy.test', username: '', password: '' })
        .success,
    ).toBe(false)
    const manager = createGatewayManager(h.store, null, { lookup: vi.fn() }, h.logger)
    expect(() =>
      manager.save({ name: 'Proxy', server: 'http://proxy.test:8000', username: 'u', password: 'p' }),
    ).toThrow(/keychain/)
  })
  it('never returns ciphertext or credentials in snapshots and records gateway health', async () => {
    const h = harness()
    const manager = createGatewayManager(
      h.store,
      { encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() },
      { lookup: vi.fn().mockResolvedValue({ ip: '203.0.113.1' }) },
      h.logger,
    )
    const gateway = manager.save({
      name: 'Other provider',
      server: 'http://proxy.test:8000',
      username: 'private-user',
      password: 'private-password',
    })
    expect(manager.resolve(gateway.id).password).toBe('private-password')
    expect(JSON.stringify(h.store.snapshot())).not.toMatch(/private-password|private-user|encrypted/)
    expect(await manager.test(gateway.id)).toMatchObject({ exitIp: '203.0.113.1', lastError: null })
  })
})
describe('Portable reports and verified updates', () => {
  function batch(): QaBatch {
    return {
      id: 'report',
      workspaceId: 'default',
      scenarioId: 's',
      scenarioName: '<script>alert(1)</script>',
      status: 'failed',
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:00:01Z',
      total: 2,
      completed: 1,
      input: MatrixInputSchema.parse({ scenarioId: 's' }),
      cases: [
        {
          id: '1',
          engine: 'chromium',
          device: 'linux-desktop',
          target: null,
          attempt: 1,
          status: 'failed',
          steps: [],
          errors: ['Expected "done" & got <failed>'],
          failedRequests: [],
          finalUrl: '',
          durationMs: 1000,
        },
      ],
    }
  }
  it('escapes HTML and XML content and reports unexecuted cases as skipped', () => {
    expect(exportBatch(batch(), 'html').content).not.toContain('<script>')
    expect(exportBatch(batch(), 'junit').content).toContain('skipped="1"')
    expect(exportBatch(batch(), 'junit').content).toContain('&amp;')
    expect(JSON.parse(exportBatch(batch(), 'json').content).completed).toBe(1)
  })
  it('compares semantic versions without lexicographic ordering or downgrade acceptance', () => {
    expect(newerVersion('1.10.0', '1.9.0')).toBe(true)
    expect(newerVersion('1.0.0', '2.0.0')).toBe(false)
    expect(newerVersion('bad', '1.0.0')).toBe(false)
  })
  it('verifies signatures and SHA-256 before revealing an update file', async () => {
    const h = harness()
    const keys = generateKeyPairSync('ed25519')
    const bytes = Buffer.from('verified release')
    const payload = JSON.stringify({
      version: '1.1.0',
      assets: [
        {
          platform: 'linux',
          arch: 'x64',
          url: 'https://releases.test/app.AppImage',
          fileName: 'app.AppImage',
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    })
    const envelope = { payload, signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64') }
    const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString()
    expect(() => verifyUpdateEnvelope({ ...envelope, payload: payload.replace('1.1.0', '9.9.9') }, publicKey)).toThrow(
      /signature/,
    )
    const manager = createUpdateManager({
      config: { feedUrl: 'https://releases.test/feed.json', publicKey },
      currentVersion: '1.0.0',
      platform: 'linux',
      arch: 'x64',
      directory: h.dir,
      fetchImpl: async (url, init) => { expect(init?.redirect).toBe('error'); return url.endsWith('feed.json') ? Response.json(envelope) : new Response(bytes) },
    })
    expect(await manager.check()).toMatchObject({ available: true, version: '1.1.0' })
    expect(readFileSync(await manager.download())).toEqual(bytes)
    const corrupt = createUpdateManager({
      config: { feedUrl: 'https://releases.test/feed.json', publicKey },
      currentVersion: '1.0.0',
      platform: 'linux',
      arch: 'x64',
      directory: join(h.dir, 'corrupt'),
      fetchImpl: async (url) =>
        url.endsWith('feed.json') ? Response.json(envelope) : new Response(Buffer.from('corrupt release!')),
    })
    await corrupt.check()
    await expect(corrupt.download()).rejects.toThrow()
    expect(
      existsSync(
        join(h.dir, 'corrupt', `${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}-app.AppImage.part`),
      ),
    ).toBe(false)
  })
  it('rejects a signed update download from another origin', async () => {
    const keys = generateKeyPairSync('ed25519')
    const payload = JSON.stringify({ version: '1.2.0', assets: [{ platform: 'linux', arch: 'x64', url: 'https://another.test/app.AppImage', fileName: 'app.AppImage', size: 10, sha256: '0'.repeat(64) }] })
    const manager = createUpdateManager({ config: { feedUrl: 'https://releases.test/feed', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }, currentVersion: '1.0.0', platform: 'linux', arch: 'x64', directory: harness().dir, fetchImpl: async () => Response.json({ payload, signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64') }) })
    await manager.check()
    await expect(manager.download()).rejects.toThrow('publisher')
  })
  it('returns an explicit unconfigured state when no publisher feed is installed', async () => {
    const manager = createUpdateManager({
      config: null,
      currentVersion: '1.0.0',
      platform: 'linux',
      arch: 'x64',
      directory: '/tmp',
    })
    expect(await manager.check()).toMatchObject({ configured: false, available: false })
    await expect(manager.download()).rejects.toThrow(/first/)
  })
})

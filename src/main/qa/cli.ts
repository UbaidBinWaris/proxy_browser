import { readFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { ProfileInputSchema } from '@shared/types'
import {
  GatewayInputSchema,
  MatrixInputSchema,
  ScenarioInputSchema,
  EnvironmentInputSchema,
  SuiteInputSchema,
} from '@shared/qa'
import { createProfileManager } from '../browser/profile-manager'
import { createBrowserProvisioner } from '../browser/browser-provisioner'
import { openDatabase } from '../database'
import { createLogger } from '../logging/logger'
import { compileSecrets, redactString } from '../logging/redact'
import { readProxyEnv, PROXY_ENV_KEYS } from '../config/env'
import { DataImpulseProvider } from '../proxy/providers/dataimpulse'
import { createProxyManager } from '../proxy/proxy-manager'
import { createIpChecker } from '../proxy/ip-checker'
import { createQaExecutor } from './runtime'
import { createQaService } from './service'
import { exportBatch } from './reports'
import { createVisualStore, visualKey } from './visual'
import { writeFileAtomicSync } from '../util/atomic-file'
import type { AppPaths } from '../contracts'

const EnvironmentsSchema = z
  .array(EnvironmentInputSchema.extend({ id: z.string().min(1) }))
  .max(1000)
  .default([])
const ManifestSchema = z.union([
  z.object({
    scenario: ScenarioInputSchema.safeExtend({ id: z.string().min(1).optional() }),
    profile: ProfileInputSchema,
    matrix: MatrixInputSchema.optional(),
    environments: EnvironmentsSchema,
  }),
  z.object({
    suite: SuiteInputSchema,
    scenarios: z
      .array(ScenarioInputSchema.safeExtend({ id: z.string().min(1) }))
      .min(1)
      .max(100),
    profiles: z
      .array(ProfileInputSchema.extend({ id: z.string().min(1) }))
      .min(1)
      .max(100),
    matrix: MatrixInputSchema.optional(),
    environments: EnvironmentsSchema,
  }),
])
export async function runQaCli(args: string[]): Promise<number> {
  if (args.includes('--help') || args.length === 0) {
    process.stdout.write(
      'Usage: npm run qa -- --config scenario.json [--output qa-results] [--environment name] [--baselines approved.qavb]\nExports JSON, JUnit XML and HTML. Exit: 0 passed, 1 failed, 2 configuration error, 130 cancelled.\nProxy credentials use DATAIMPULSE_PROXY_* environment variables. No .env file is loaded.\n',
    )
    return args.length ? 0 : 2
  }
  const flags = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index],
      value = args[index + 1]
    if (
      !flag ||
      !['--config', '--output', '--environment', '--baselines'].includes(flag) ||
      !value ||
      value.startsWith('--') ||
      flags.has(flag)
    )
      throw new Error(
        'Use --config <file> with optional --output <directory>, --environment <name>, and --baselines <pack>.',
      )
    flags.set(flag, value)
  }
  const file = flags.get('--config')
  if (!file) throw new Error('--config is required.')
  if ((await stat(file)).size > 10 * 1024 * 1024) throw new Error('Scenario manifest exceeds 10 MB.')
  const manifest = ManifestSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  const environmentName = flags.get('--environment')
  const candidates = manifest.environments.filter((env) => env.name === environmentName)
  if (environmentName && candidates.length !== 1)
    throw new Error('Choose one unique environment name from the exported manifest.')
  const chosenEnvironment = candidates[0]
  const baselineFile = flags.get('--baselines')
  if (baselineFile && (await stat(baselineFile)).size > 50 * 1024 * 1024)
    throw new Error('Baseline pack exceeds 50 MB.')
  const baselinePack = baselineFile ? JSON.parse(await readFile(baselineFile, 'utf8')) : undefined
  const customInput = process.env.QA_PROXY_SERVER
    ? GatewayInputSchema.parse({
        name: 'CI gateway',
        server: process.env.QA_PROXY_SERVER,
        username: process.env.QA_PROXY_USERNAME ?? '',
        password: process.env.QA_PROXY_PASSWORD ?? '',
      })
    : null
  if (
    ('scenario' in manifest ? [manifest.scenario] : manifest.scenarios).some((scenario) => scenario.gatewayId) &&
    !customInput
  )
    throw new Error(
      'This manifest uses custom gateways. Supply QA_PROXY_SERVER and gateway credentials through environment variables.',
    )
  if ('suite' in manifest) {
    if (
      new Set(manifest.profiles.map((profile) => profile.id)).size !== manifest.profiles.length ||
      new Set(manifest.scenarios.map((scenario) => scenario.id)).size !== manifest.scenarios.length
    )
      throw new Error('Suite manifest contains duplicate identifiers.')
    for (const id of manifest.suite.scenarioIds)
      if (!manifest.scenarios.some((scenario) => scenario.id === id))
        throw new Error('Suite manifest has a missing scenario.')
    for (const scenario of manifest.scenarios)
      if (!manifest.profiles.some((profile) => profile.id === scenario.profileId))
        throw new Error('Suite manifest has a missing profile.')
  }
  const output = resolve(flags.get('--output') ?? 'qa-results')
  await mkdir(output, { recursive: true, mode: 0o700 })
  const state = await mkdtemp(join(output, '.qa-state-'))
  const paths: AppPaths = {
    userData: state,
    data: state,
    screenshots: join(state, 'screenshots'),
    database: join(state, 'qa.sqlite'),
    logs: join(state, 'logs'),
    browsers: join(state, 'browsers'),
    vault: join(state, 'vault'),
    keys: join(state, 'keys'),
  }
  const db = openDatabase(':memory:', { defaultScreenshotDir: paths.screenshots, env: {} })
  const logger = createLogger({ repo: db.logs, fileDir: paths.logs })
  const secrets: string[] = []
  const env = readProxyEnv()
  if (customInput) secrets.push(customInput.username, customInput.password)
  if (env.config) secrets.push(env.config.password, env.config.username)
  const pool = 'profile' in manifest ? manifest.profile.proxyPool : manifest.profiles[0]!.proxyPool
  const sanitize = (text: string): string => redactString(text, compileSecrets(secrets))
  delete process.env[PROXY_ENV_KEYS.password]
  delete process.env[PROXY_ENV_KEYS.username]
  delete process.env.QA_PROXY_PASSWORD
  delete process.env.QA_PROXY_USERNAME
  const profiles = createProfileManager({ repo: db.profiles, logger })
  const provisioner = createBrowserProvisioner({
    paths,
    logger,
    isPackaged: false,
    execPath: process.execPath,
    resourcesPath: '',
    versionCacheFile: null,
  })
  const provider = new DataImpulseProvider({
    ipChecker: createIpChecker({ getSettings: db.settings.get, logger }),
    logger,
    credentials: env.config ? [{ ...env.config, pool, sessionTemplate: null }] : [],
    source: 'env',
  })
  const proxy = createProxyManager({ provider, sessions: db.proxySessions, profiles: db.profiles, logger })
  const checker = createIpChecker({ getSettings: db.settings.get, logger })
  if (customInput)
    db.qa!.saveGateway({
      id: 'cli-custom',
      name: customInput.name,
      server: customInput.server,
      encrypted: 'environment-only',
      exitIp: null,
      latencyMs: null,
      lastError: null,
      lastCheckedAt: null,
    })
  const custom = customInput
    ? {
        checker,
        resolve: () => ({
          server: customInput.server,
          username: customInput.username,
          password: customInput.password,
          pool: 'residential' as const,
          sessionId: null,
          target: null,
          targetingString: '',
        }),
      }
    : undefined
  const visuals = createVisualStore(join(state, 'baselines'))
  const service = createQaService({
    store: db.qa!,
    profiles,
    artifactRoot: join(output, 'artifacts'),
    execute: createQaExecutor(provisioner, proxy, sanitize, logger, custom, visuals),
  })
  const abort = (): void => {
    for (const batch of db.qa!.batches())
      if (batch.status === 'running' || batch.status === 'queued') service.cancel(batch.id)
  }
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  try {
    if (baselinePack) await visuals.import(baselinePack)
    const environment = chosenEnvironment
      ? db.qa!.saveEnvironment({ ...chosenEnvironment, workspaceId: 'default' })
      : undefined
    let firstId: string
    let suiteId: string | undefined
    if ('scenario' in manifest) {
      const profile = profiles.create(manifest.profile)
      firstId = service.saveScenario({
        ...manifest.scenario,
        visualKey:
          manifest.scenario.visualKey ??
          visualKey([manifest.scenario.id ?? manifest.scenario.name, manifest.scenario.startUrl]),
        workspaceId: 'default',
        profileId: profile.id,
        captureTrace: false,
        gatewayId: customInput ? 'cli-custom' : null,
      }).id
    } else {
      const profileIds = new Map(manifest.profiles.map((profile) => [profile.id, profiles.create(profile).id]))
      const scenarioIds = new Map(
        manifest.scenarios.map((scenario) => [
          scenario.id,
          service.saveScenario({
            ...scenario,
            workspaceId: 'default',
            profileId: profileIds.get(scenario.profileId)!,
            captureTrace: false,
            gatewayId: customInput ? 'cli-custom' : null,
          }).id,
        ]),
      )
      const suite = db.qa!.saveSuite({
        ...manifest.suite,
        workspaceId: 'default',
        scenarioIds: manifest.suite.scenarioIds.map((id) => scenarioIds.get(id)!),
      })
      firstId = suite.scenarioIds[0]!
      suiteId = suite.id
    }
    const batch = service.start(
      MatrixInputSchema.parse({
        ...manifest.matrix,
        scenarioId: firstId,
        suiteId,
        environmentId: environment?.id ?? null,
      }),
    )
    await service.idle()
    const result = db.qa!.batch(batch.id)
    for (const format of ['json', 'junit', 'html'] as const) {
      const report = exportBatch(result, format)
      writeFileAtomicSync(join(output, `results.${format === 'junit' ? 'xml' : format}`), report.content)
    }
    process.stdout.write(`${result.status}: ${result.completed}/${result.total} cases. Reports: ${output}\n`)
    return result.status === 'passed' ? 0 : result.status === 'cancelled' ? 130 : 1
  } finally {
    process.off('SIGINT', abort)
    process.off('SIGTERM', abort)
    await service.dispose()
    provisioner.dispose()
    db.close()
    await rm(state, { recursive: true, force: true })
  }
}

void runQaCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((err: unknown) => {
    process.stderr.write(
      `QA configuration error: ${err instanceof z.ZodError ? err.issues.map((issue) => issue.message).join('; ') : err instanceof Error ? err.message : 'Unknown error'}\n`,
    )
    process.exitCode = 2
  })

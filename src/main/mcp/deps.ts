/**
 * Adapter from the MCP tools onto the headless QA runtime the CLI (`qa/cli.ts`) uses: the browser
 * provisioner, the provider registry with environment credentials, the proxy manager, the QA
 * service/executor and the visual store. No Electron imports, anywhere in this graph.
 *
 * Differences from one CLI run:
 * - One runtime lives for the whole server process; each tool call imports its scenario (or
 *   suite) and profiles, runs them, and removes them again. Runs are serialised.
 * - State (in-memory database, logs, screenshots) lives in a private temporary directory that is
 *   deleted on shutdown; screenshots of a run are deleted once its result was returned.
 * - Proxy credentials are read from the environment once and the variables are removed from it
 *   before any browser can launch.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import type { z } from 'zod'

import { GatewayInputSchema, MatrixInputSchema } from '@shared/qa'
import type { QaBatch } from '@shared/qa'
import type { BrowserEngine } from '@shared/types'

import { AppException } from '../contracts'
import type { AppPaths } from '../contracts'
import { DEVICE_PRESETS } from '../browser/device-presets'
import { createBrowserProvisioner } from '../browser/browser-provisioner'
import { createProfileManager } from '../browser/profile-manager'
import { scrubProxySecretEnv } from '../config/env'
import { openDatabase } from '../database'
import { US_DATASET_FILE } from '../locations/geonames-loader'
import { createLocationsService } from '../locations/locations-service'
import { createLogger } from '../logging/logger'
import { compileSecrets, redactString } from '../logging/redact'
import { createIpChecker } from '../proxy/ip-checker'
import { BUILT_IN_DIALECTS, ProviderRegistry } from '../proxy/providers/registry'
import { createProxyManager } from '../proxy/proxy-manager'
import { firstIssueText } from '../qa/cli-manifest'
import { lookupFromDialects, resolveCliProxy } from '../qa/cli-proxy'
import { createQaExecutor } from '../qa/runtime'
import { createQaService } from '../qa/service'
import { createVisualStore, visualKey } from '../qa/visual'
import { writeFileAtomicSync } from '../util/atomic-file'
import { McpConfigError, createBudgetTracker, memoryBudgetStore, parseBudgetState, resolveInWorkspace } from './policy'
import type { BudgetStore, McpPolicy } from './policy'
import { createResultStore } from './tools/summary'
import type { McpDeps, RunRequest, ScreenshotImage } from './tools/types'

export interface McpRuntime extends McpDeps {
  /** Cancel the active run, close the database and delete the temporary state directory. */
  dispose(): Promise<void>
}

export interface McpRuntimeOptions {
  /** Directory holding US.txt (default: resources/geonames next to the build or the source tree). */
  geonamesDir?: string
  /** Parent of the temporary state directory (default: the OS temp directory). */
  stateRoot?: string
  /** Configuration warnings (never values); default: stderr. */
  warn?: (message: string) => void
}

const CUSTOM_GATEWAY_ID = 'mcp-custom'
/** Screenshots handed to the assistant are downscaled to at most this width. */
export const SCREENSHOT_MAX_WIDTH = 800
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024

/** resources/geonames from the build (out/main) or the source tree (src/main/mcp), else from the working directory. */
export function defaultGeoNamesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [resolve(here, '../../resources/geonames'), resolve(here, '../../../resources/geonames'), resolve(process.cwd(), 'resources/geonames')]
  return candidates.find((dir) => existsSync(join(dir, US_DATASET_FILE))) ?? candidates[0]!
}

/** Box-filter downscale of an RGBA PNG to at most `maxWidth` pixels wide (whole-number factor). */
export function downscalePng(bytes: Buffer, maxWidth = SCREENSHOT_MAX_WIDTH): Buffer {
  const source = PNG.sync.read(bytes)
  if (source.width <= maxWidth) return bytes
  const factor = Math.ceil(source.width / maxWidth)
  const width = Math.max(1, Math.floor(source.width / factor))
  const height = Math.max(1, Math.floor(source.height / factor))
  const target = new PNG({ width, height })
  const area = factor * factor
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const sums = [0, 0, 0, 0]
      for (let dy = 0; dy < factor; dy++)
        for (let dx = 0; dx < factor; dx++) {
          const offset = ((y * factor + dy) * source.width + (x * factor + dx)) * 4
          for (let channel = 0; channel < 4; channel++) sums[channel]! += source.data[offset + channel]!
        }
      const out = (y * width + x) * 4
      for (let channel = 0; channel < 4; channel++) target.data[out + channel] = Math.round(sums[channel]! / area)
    }
  return PNG.sync.write(target)
}

/** Budget state as `<workspace>/.qa-mcp/budget.json` (owner-only), so the daily budget survives restarts. */
export function fileBudgetStore(file: string): BudgetStore {
  return {
    load() {
      try {
        return parseBudgetState(JSON.parse(readFileSync(file, 'utf8')))
      } catch {
        return null
      }
    },
    save(state) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      writeFileAtomicSync(file, `${JSON.stringify(state)}\n`)
    },
  }
}

function checkWorkspace(workspace: string | null): void {
  if (!workspace) return
  let real: string
  try {
    real = realpathSync(workspace)
  } catch {
    throw new McpConfigError('QA_MCP_WORKSPACE does not exist.')
  }
  if (!statSync(real).isDirectory()) throw new McpConfigError('QA_MCP_WORKSPACE must be a directory.')
}

/**
 * Build the runtime. Reads proxy settings from `env` (QA_PROVIDER*, DATAIMPULSE_PROXY_*,
 * QA_PROXY_SERVER/_USERNAME/_PASSWORD) and removes the secret ones from it. Throws
 * McpConfigError for invalid settings before anything is created.
 */
export async function createMcpRuntime(env: NodeJS.ProcessEnv, policy: McpPolicy, options: McpRuntimeOptions = {}): Promise<McpRuntime> {
  const warn = options.warn ?? ((message: string) => process.stderr.write(`qa-mcp configuration warning: ${message}\n`))
  checkWorkspace(policy.workspace)
  let customInput: z.infer<typeof GatewayInputSchema> | null = null
  if (env.QA_PROXY_SERVER) {
    const parsed = GatewayInputSchema.safeParse({
      name: 'MCP gateway',
      server: env.QA_PROXY_SERVER,
      username: env.QA_PROXY_USERNAME ?? '',
      password: env.QA_PROXY_PASSWORD ?? '',
    })
    if (!parsed.success) throw new McpConfigError(`QA_PROXY_SERVER: ${firstIssueText(parsed.error)}`)
    customInput = parsed.data
  }
  let proxySetup: ReturnType<typeof resolveCliProxy>
  try {
    proxySetup = resolveCliProxy(env, lookupFromDialects(BUILT_IN_DIALECTS), [])
  } catch (err) {
    throw new McpConfigError(err instanceof Error ? err.message : 'Invalid proxy configuration.')
  }

  const state = await mkdtemp(join(options.stateRoot ?? tmpdir(), 'qa-mcp-'))
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
  const artifactRoot = join(state, 'artifacts')
  const db = openDatabase(':memory:', { defaultScreenshotDir: paths.screenshots, env: {} })
  const logger = createLogger({ repo: db.logs, fileDir: paths.logs })
  const secrets: string[] = []
  if (customInput) secrets.push(customInput.username, customInput.password, `${customInput.username}:${customInput.password}`)
  secrets.push(...proxySetup.secrets)
  for (const secret of secrets) logger.registerSecret(secret)
  for (const warning of proxySetup.warnings) warn(warning)
  const secretPattern = compileSecrets(secrets)
  const sanitize = (text: string): string => redactString(text, secretPattern)
  // Nothing launched from here on (browsers, installers) may inherit a proxy secret.
  scrubProxySecretEnv(env)
  delete env.QA_PROXY_PASSWORD
  delete env.QA_PROXY_USERNAME

  const ipChecker = createIpChecker({ getSettings: db.settings.get, logger })
  const registry = new ProviderRegistry({ ipChecker, logger })
  for (const dialect of BUILT_IN_DIALECTS) registry.register(dialect)
  if (proxySetup.credentials) registry.get(proxySetup.providerId).setCredentials([proxySetup.credentials], 'env')
  const locations = createLocationsService({ dataDir: options.geonamesDir ?? defaultGeoNamesDir(), logger })
  const profiles = createProfileManager({ repo: db.profiles, logger, providers: registry })
  const provisioner = createBrowserProvisioner({
    paths,
    logger,
    isPackaged: false,
    execPath: process.execPath,
    resourcesPath: '',
    versionCacheFile: null,
  })
  const proxy = createProxyManager({
    providers: registry,
    defaultProviderId: () => proxySetup.providerId,
    sessions: db.proxySessions,
    profiles: db.profiles,
    logger,
    locations,
  })
  const store = db.qa!
  store.savePolicy({
    retentionDays: 30,
    maxCombinations: policy.maxCases,
    maxConcurrentBrowsers: policy.concurrency,
    // The MCP daily budget (policy.ts) is the limit; the store's own counter must never be stricter.
    maxDailyCases: 10000,
    allowTraces: false,
  })
  if (customInput)
    store.saveGateway({
      id: CUSTOM_GATEWAY_ID,
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
        checker: ipChecker,
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
    store,
    profiles,
    artifactRoot,
    execute: createQaExecutor(provisioner, proxy, sanitize, logger, custom, visuals),
  })
  const budget = createBudgetTracker(policy.dailyBudget, policy.workspace ? fileBudgetStore(join(realpathSync(policy.workspace), '.qa-mcp', 'budget.json')) : memoryBudgetStore())
  const routing = {
    proxy: proxySetup.credentials ? { providerId: proxySetup.providerId, product: proxySetup.credentials.pool } : null,
    customGateway: customInput !== null,
  }

  let queue: Promise<unknown> = Promise.resolve()
  let disposed = false
  const serialised = <T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> => {
    const next = queue.then(() => {
      if (disposed) throw new AppException('SESSION_CLOSED', 'The server is shutting down.')
      if (signal.aborted) throw new AppException('SESSION_CLOSED', 'The request was cancelled.')
      return task()
    })
    queue = next.catch(() => undefined)
    return next
  }

  const executeRun = async (request: RunRequest, signal: AbortSignal): Promise<QaBatch> => {
    const { manifest } = request
    const gatewayId = customInput ? CUSTOM_GATEWAY_ID : null
    const createdProfiles: string[] = []
    const createdScenarios: string[] = []
    let suiteId: string | undefined
    let environmentId: string | undefined
    try {
      if (request.baselinePack !== undefined) await visuals.import(request.baselinePack)
      const chosen = request.environmentName ? manifest.environments.find((env) => env.name === request.environmentName) : undefined
      if (chosen) environmentId = store.saveEnvironment({ ...chosen, workspaceId: 'default' }).id
      let firstId: string
      if ('scenario' in manifest) {
        const profile = profiles.create(manifest.profile)
        createdProfiles.push(profile.id)
        firstId = service.saveScenario({
          ...manifest.scenario,
          visualKey: manifest.scenario.visualKey ?? visualKey([manifest.scenario.id ?? manifest.scenario.name, manifest.scenario.startUrl]),
          workspaceId: 'default',
          profileId: profile.id,
          captureTrace: false,
          gatewayId,
          healing: request.healing ?? manifest.scenario.healing,
        }).id
        createdScenarios.push(firstId)
      } else {
        const profileIds = new Map<string, string>()
        for (const input of manifest.profiles) {
          const profile = profiles.create(input)
          createdProfiles.push(profile.id)
          profileIds.set(input.id, profile.id)
        }
        const scenarioIds = new Map<string, string>()
        for (const scenario of manifest.scenarios) {
          const saved = service.saveScenario({
            ...scenario,
            workspaceId: 'default',
            profileId: profileIds.get(scenario.profileId)!,
            captureTrace: false,
            gatewayId,
            healing: request.healing ?? scenario.healing,
          })
          createdScenarios.push(saved.id)
          scenarioIds.set(scenario.id, saved.id)
        }
        const suite = store.saveSuite({ ...manifest.suite, workspaceId: 'default', scenarioIds: manifest.suite.scenarioIds.map((id) => scenarioIds.get(id)!) })
        suiteId = suite.id
        firstId = suite.scenarioIds[0]!
      }
      signal.throwIfAborted()
      const batch = service.start(MatrixInputSchema.parse({ ...manifest.matrix, scenarioId: firstId, suiteId, environmentId: environmentId ?? null }))
      const cancel = (): void => {
        try {
          service.cancel(batch.id)
        } catch {
          // Already finished.
        }
      }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        await service.idle()
      } finally {
        signal.removeEventListener('abort', cancel)
      }
      const result = store.batch(batch.id)
      store.deleteBatch(batch.id)
      return result
    } finally {
      const quietly = (action: () => void): void => {
        try {
          action()
        } catch (err) {
          logger.warn('mcp', 'Could not remove a run record', { error: err instanceof Error ? err.message : String(err) })
        }
      }
      if (suiteId) quietly(() => store.deleteSuite(suiteId!))
      for (const id of createdScenarios) quietly(() => store.deleteScenario(id))
      if (environmentId) quietly(() => store.deleteEnvironment(environmentId!))
      for (const id of createdProfiles) quietly(() => profiles.delete(id))
    }
  }

  const insideArtifacts = (path: string): boolean => {
    const rel = relative(artifactRoot, resolve(path))
    return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
  }

  return {
    policy,
    budget,
    results: createResultStore(),
    sanitize,
    routing: () => routing,
    locations: { query: (input) => locations.query(input), toTarget: (entry) => locations.toTarget(entry) },
    async capabilities() {
      const engines = await provisioner.engines()
      return {
        engines: engines.filter((engine) => engine.available).map((engine) => ({ id: engine.id, label: engine.label, version: engine.version, kind: engine.kind })),
        unavailableEngines: engines.filter((engine) => !engine.available).map((engine) => ({ id: engine.id, note: sanitize(engine.note) })),
        providers: registry.all().map((provider) => ({
          id: provider.name,
          displayName: provider.displayName,
          products: provider.capabilities.products.map((product) => product.key),
          configuredProducts: provider.capabilities.products.map((product) => product.key).filter((key) => provider.isPoolConfigured(key)),
          targetModes: [...provider.capabilities.targetModes],
          stickySessions: provider.capabilities.sticky.supported,
        })),
      }
    },
    async assertEngines(engines: readonly BrowserEngine[]) {
      for (const engine of new Set(engines)) await provisioner.resolveEngine(engine)
    },
    checkExitIp: (request, signal) =>
      serialised(signal, async () => {
        const preset = DEVICE_PRESETS.find((item) => item.id === 'desktop-chrome') ?? DEVICE_PRESETS.find((item) => item.deviceType === 'desktop' && item.supportedEngines.includes('chromium'))!
        const profile = profiles.create({
          name: 'MCP exit IP check',
          engine: 'chromium',
          deviceType: preset.deviceType,
          devicePreset: preset.id,
          viewportWidth: preset.viewportWidth,
          viewportHeight: preset.viewportHeight,
          userAgent: null,
          locale: 'en-US',
          timezone: 'America/New_York',
          proxyMode: 'sticky',
          stickySessionId: randomUUID(),
          formUrlOverride: null,
          notes: '',
          proxyPool: request.product,
          providerId: request.providerId,
          target: request.target,
          stickyTtlMinutes: null,
          ephemeral: true,
        })
        try {
          const verified = await proxy.verifyForLaunch(profile, { policy: 'exact', attempts: 3, shouldContinue: () => !signal.aborted })
          if (verified.result.status !== 'working' || !verified.result.ip)
            throw new AppException(verified.result.error?.code ?? 'PROXY_DEAD', sanitize(verified.result.error?.message ?? 'Proxy verification failed.'))
          return { ip: verified.result.ip, targetMatch: verified.targetMatch, attempts: verified.attempts, warning: verified.warning }
        } finally {
          profiles.delete(profile.id)
        }
      }),
    run: (request, signal) => serialised(signal, () => executeRun(request, signal)),
    async readWorkspaceFile(path, maxBytes) {
      const real = await resolveInWorkspace(policy.workspace, path)
      const info = await stat(real)
      if (!info.isFile()) throw new AppException('INVALID_INPUT', 'The workspace path is not a file.')
      if (info.size > maxBytes) throw new AppException('INVALID_INPUT', `The file exceeds ${Math.round(maxBytes / 1024 / 1024)} MB.`)
      return readFile(real, 'utf8')
    },
    async readScreenshot(path): Promise<ScreenshotImage | null> {
      if (!insideArtifacts(path)) return null
      try {
        if ((await stat(path)).size > MAX_SCREENSHOT_BYTES) return null
        return { data: downscalePng(await readFile(path)).toString('base64'), mimeType: 'image/png' }
      } catch {
        return null
      }
    },
    async discardArtifacts(runId) {
      if (!/^[a-f0-9-]{36}$/i.test(runId)) return
      await rm(join(artifactRoot, runId), { recursive: true, force: true })
    },
    async dispose() {
      if (disposed) return
      disposed = true
      await service.dispose()
      await queue
      provisioner.dispose()
      db.close()
      await rm(state, { recursive: true, force: true })
    },
  }
}

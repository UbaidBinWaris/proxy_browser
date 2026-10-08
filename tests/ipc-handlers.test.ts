/**
 * End-to-end tests for the IPC layer against a fake ipcMain, a real in-memory
 * database, a real credential vault on temp directories (fake keychain
 * wrapper) and fake proxy/browser managers.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EVENTS, IPC } from '../src/shared/ipc'
import type {
  AppSettings,
  BrowserEngine,
  BrowserEngineInfo,
  BrowserSession,
  BrowserWatchUpdate,
  BrowsersSource,
  BrowsersStatus,
  DashboardStats,
  GeoTarget,
  InstalledBrowserEngine,
  IpInfo,
  LocationEntry,
  Profile,
  ProviderInfo,
  ProfileInput,
  ProxyCredentialsInput,
  ProxySession,
  QuickLaunchInput,
  SecurityStatus,
  SetupStatus,
  TargetingPreview,
  Task,
  TestRun,
} from '../src/shared/types'
import { BROWSER_ENGINES, BROWSER_ENGINE_FAMILY, BROWSER_ENGINE_KIND, BROWSER_ENGINE_LABELS } from '../src/shared/types'
import { AppException } from '../src/main/contracts'
import type { BrowserManager, BrowserProvisioner, CredentialVault, Database, Logger, ProfileManager, ProxyManager } from '../src/main/contracts'
import { DEVICE_PRESETS } from '../src/main/browser/device-presets'
import { DOWNLOAD_URLS, downloadUrlFor } from '../src/main/browser/install-support'
import { openDatabase } from '../src/main/database/index'
import { currentIpFromSessions } from '../src/main/ipc/dashboard'
import { createLauncher } from '../src/main/launcher/launcher'
import { createLocationsService } from '../src/main/locations/locations-service'
import { buildTargetingString, dataImpulseDialect } from '../src/main/proxy/providers/dataimpulse'
import { allIpcChannels, createBroadcaster, registerIpcHandlers } from '../src/main/ipc/index'
import type { IpcDeps } from '../src/main/ipc/index'
import type { InvokeHandler, IpcRegistrar } from '../src/main/ipc/handle'
import { createLogger } from '../src/main/logging/logger'
import { createCredentialVault } from '../src/main/security/credential-vault'
import { createInstallStateStore } from '../src/main/security/install-state'
import type { InstallStateStore } from '../src/main/security/install-state'
import type { KeyWrapperBackend } from '../src/main/security/key-wrapper'
import { createInstallExecutor } from '../src/main/tasks/install-executor'
import { createTaskManager } from '../src/main/tasks/task-manager'

type Listener<T> = (value: T) => void

function emitter<T>(): { listeners: Set<Listener<T>>; on: (l: Listener<T>) => () => void; emit: (v: T) => void } {
  const listeners = new Set<Listener<T>>()
  return {
    listeners,
    on: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    emit: (v) => listeners.forEach((l) => l(v)),
  }
}

const profileInput: ProfileInput = {
  name: 'QA Desktop',
  engine: 'chromium',
  deviceType: 'desktop',
  devicePreset: 'windows-desktop',
  viewportWidth: 1366,
  viewportHeight: 768,
  userAgent: null,
  locale: 'en-US',
  timezone: 'America/New_York',
  proxyMode: 'none',
  stickySessionId: null,
  formUrlOverride: null,
  notes: '',
  proxyPool: 'residential',
  providerId: 'dataimpulse',
  target: null,
  stickyTtlMinutes: null,
  ephemeral: false,
}

const NJ: GeoTarget = { mode: 'state', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: null, zip: null }

const quickLaunchInput: QuickLaunchInput = {
  startUrl: 'https://example.com/',
  engine: 'chromium',
  devicePreset: 'iphone-15',
  proxyPool: 'residential',
  providerId: 'dataimpulse',
  target: NJ,
  sticky: true,
  stickyTtlMinutes: null,
  locale: null,
  timezone: null,
  saveAsProfile: false,
  profileName: null,
  replaceActiveSession: false,
}

const ipInfo: IpInfo = {
  ip: '203.0.113.9',
  country: 'United States',
  countryCode: 'US',
  region: 'TX',
  city: 'Austin',
  postalCode: '78701',
  isp: 'Example ISP',
  asn: 'AS64500',
  latencyMs: 120,
  provider: 'ip-api',
  checkedAt: '2026-10-03T10:00:00.000Z',
}

const PASSWORD = 'Ipc-Vault-P@ss-99'
const credentials: ProxyCredentialsInput = { pool: 'residential', host: 'gw.dataimpulse.com', port: 823, username: 'ipc_login__cr.us', password: PASSWORD, sessionTemplate: null }

function fakeKeychain(): KeyWrapperBackend {
  const marker = Buffer.from('KC:')
  return {
    backend: 'os-keychain',
    label: 'Fake Keychain',
    wrap: async (key) => Buffer.concat([marker, key]),
    unwrap: async (data) => data.subarray(marker.length),
  }
}

function fakeRegistrar(): IpcRegistrar & { handlers: Map<string, InvokeHandler>; invoke: (channel: string, ...args: unknown[]) => Promise<unknown> } {
  const handlers = new Map<string, InvokeHandler>()
  return {
    handlers,
    handle: (channel, listener) => {
      handlers.set(channel, listener)
    },
    removeHandler: (channel) => {
      handlers.delete(channel)
    },
    invoke: (channel, ...args) => {
      const h = handlers.get(channel)
      if (!h) throw new Error(`no handler for ${channel}`)
      return h({}, ...args)
    },
  }
}

interface Harness {
  deps: IpcDeps
  registrar: ReturnType<typeof fakeRegistrar>
  sent: Array<{ channel: string; payload: unknown }>
  proxySessions: ReturnType<typeof emitter<ProxySession>>
  browserSessions: ReturnType<typeof emitter<BrowserSession>>
  runUpdates: ReturnType<typeof emitter<TestRun>>
  active: BrowserSession[]
  db: Database
  logger: Logger
  vault: CredentialVault
  install: InstallStateStore
  /** Mutable knobs read by the fakes. */
  proxyConfigured: { current: boolean }
  chromiumInstalled: { current: boolean }
  browsersSource: { current: BrowsersSource }
  /** Installed-kind engines the fake provisioner reports as available (engine → executable). */
  executables: Map<BrowserEngine, string>
  /** How many times the fake detector was asked to re-scan. */
  redetects: { current: number }
  /** Pools the fake proxy reports as configured. */
  configuredPools: Set<string>
  dispose: () => void
  tmp: string
}

function engineInfo(engine: BrowserEngine, executablePath: string | null): BrowserEngineInfo {
  const kind = BROWSER_ENGINE_KIND[engine]
  const available = kind === 'bundled' || executablePath !== null
  return {
    id: engine,
    label: BROWSER_ENGINE_LABELS[engine],
    family: BROWSER_ENGINE_FAMILY[engine],
    kind,
    available,
    executablePath: kind === 'bundled' ? null : executablePath,
    version: available ? '153.0.8010.52' : null,
    source: kind === 'bundled' ? 'bundled' : executablePath ? 'detected' : 'not-found',
    note: available ? 'Detected automatically on this machine.' : 'Not installed on this machine. Install it or set its path in Settings → Browsers.',
    installMethod: kind === 'bundled' ? 'bundled' : engine === 'chrome' ? 'vendor-package' : 'download-page',
    installNote: '',
    downloadUrl: downloadUrlFor(engine),
    // The fake "installs" Chrome into the app data folder.
    managedInstall: executablePath === '/opt/google/chrome/chrome',
  }
}

async function buildHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'proxyqa-ipc-'))
  const screenshots = join(tmp, 'data', 'screenshots')
  const paths = {
    userData: tmp,
    data: join(tmp, 'data'),
    screenshots,
    browsers: join(tmp, 'browsers'),
    database: join(tmp, 'data', 'proxy-qa.sqlite'),
    logs: join(tmp, 'logs'),
    vault: join(tmp, 'vault'),
    keys: join(tmp, 'keys-elsewhere', 'keys'),
  }
  mkdirSync(paths.vault, { recursive: true, mode: 0o700 })
  mkdirSync(paths.keys, { recursive: true, mode: 0o700 })

  const db = openDatabase(':memory:', { defaultScreenshotDir: screenshots, env: {} })
  const logger = createLogger({ repo: db.logs, fileDir: paths.logs })
  logger.registerSecret('topsecret')

  const proxySessions = emitter<ProxySession>()
  const browserSessions = emitter<BrowserSession>()
  const runUpdates = emitter<TestRun>()
  const active: BrowserSession[] = []
  const proxyConfigured = { current: true }
  const chromiumInstalled = { current: true }

  const profiles: ProfileManager = {
    list: () => db.profiles.list(),
    get: (id) => {
      const p = db.profiles.get(id)
      if (!p) throw new AppException('NOT_FOUND', `Profile ${id} was not found.`)
      return p
    },
    create: (input) => db.profiles.create(input as ProfileInput),
    update: (id, input) => db.profiles.update(id, input as ProfileInput),
    duplicate: (id) => {
      const p = db.profiles.get(id)
      if (!p) throw new AppException('NOT_FOUND', 'nope')
      return db.profiles.create({ ...profileInput, name: `${p.name} (copy)` })
    },
    delete: (id) => db.profiles.delete(id),
    presets: () => [...DEVICE_PRESETS],
    validateForLaunch: () => {},
  }

  const configuredPools = new Set<string>(['residential'])
  const poolStatus = (pool: 'residential' | 'mobile') => {
    const on = proxyConfigured.current && configuredPools.has(pool)
    return { pool, configured: on, host: on ? 'gw' : null, port: on ? 823 : null, usernameMasked: on ? 'ab****yz' : null, source: on ? ('vault' as const) : ('none' as const) }
  }
  const configStatus = (): ReturnType<ProxyManager['getConfigStatus']> =>
    proxyConfigured.current
      ? { configured: true, pools: [poolStatus('residential'), poolStatus('mobile')], provider: 'dataimpulse', host: 'gw', port: 823, usernameMasked: 'ab****yz', missing: [], source: 'vault' }
      : { configured: false, pools: [poolStatus('residential'), poolStatus('mobile')], provider: 'dataimpulse', host: null, port: null, usernameMasked: null, missing: ['host', 'port', 'username', 'password'], source: 'none' }
  const proxy: ProxyManager = {
    providers: () => [
      {
        id: 'dataimpulse',
        displayName: dataImpulseDialect.displayName,
        docsUrl: dataImpulseDialect.docsUrl,
        capabilities: structuredClone(dataImpulseDialect.capabilities),
        sessionTemplate: '{username}{sep}sessid.{session}',
        status: configStatus(),
      },
    ],
    getConfigStatus: () =>
      proxyConfigured.current
        ? { configured: true, pools: [poolStatus('residential'), poolStatus('mobile')], provider: 'dataimpulse', host: 'gw', port: 823, usernameMasked: 'ab****yz', missing: [], source: 'vault' }
        : { configured: false, pools: [poolStatus('residential'), poolStatus('mobile')], provider: 'dataimpulse', host: null, port: null, usernameMasked: null, missing: ['host', 'port', 'username', 'password'], source: 'none' },
    testCredentials: vi.fn(async (_input: ProxyCredentialsInput) => ({ status: 'working' as const, sessionId: null, ip: ipInfo, error: null })),
    resolveForProfile: () => null,
    compareTarget: () => 'unknown',
    testConnection: vi.fn(async (profile: Profile | null) => ({
      status: 'working' as const,
      sessionId: profile ? `profile-${profile.id}` : null,
      ip: ipInfo,
      error: null,
    })),
    verifyForLaunch: vi.fn(async (profile: Profile) => ({
      result: { status: 'working' as const, sessionId: profile.stickySessionId, ip: ipInfo, error: null },
      targetMatch: null,
      attempts: 1,
      maxAttempts: 1,
      sessionId: profile.stickySessionId,
      warning: null,
    })),
    getCurrentIp: vi.fn(async () => ipInfo),
    rotateSession: vi.fn(async (profile: Profile) => db.proxySessions.upsertForProfile(profile.id, 'rotated')),
    listSessions: () => db.proxySessions.list(),
    onSessionUpdate: proxySessions.on,
  }

  const browser: BrowserManager = {
    // Mirrors the real manager: launch() returns at once with a 'starting' session and progresses via events.
    launch: vi.fn(async (profile: Profile): Promise<BrowserSession> => {
      const session: BrowserSession = {
        id: 'sess-1',
        runId: 'run-1',
        profileId: profile.id,
        profileName: profile.name,
        engine: profile.engine,
        devicePreset: profile.devicePreset,
        proxyPool: profile.proxyMode === 'none' ? null : profile.proxyPool,
        provider: 'dataimpulse',
        target: profile.proxyMode === 'none' ? null : profile.target,
        targetingString: null,
        targetMatch: null,
        status: 'starting',
        statusDetail: 'Validating profile…',
        ip: null,
        locationAttempts: 1,
        locationMaxAttempts: 1,
        locationWarning: null,
        proxySessionId: null,
        currentUrl: null,
        startedAt: new Date().toISOString(),
        error: null,
        browserPid: null,
        lastHeartbeatAt: null,
      }
      active.push(session)
      queueMicrotask(() => {
        session.status = 'open'
        session.statusDetail = 'Browser open'
        session.currentUrl = 'https://example.com/'
        browserSessions.emit({ ...session })
      })
      return { ...session }
    }),
    close: vi.fn(async (sessionId: string) => {
      const index = active.findIndex((s) => s.id === sessionId)
      if (index === -1) throw new AppException('NOT_FOUND', 'No such session.')
      active.splice(index, 1)
    }),
    closeAll: vi.fn(async () => {
      active.length = 0
    }),
    screenshot: vi.fn(async () => join(screenshots, 'shot.png')),
    focus: vi.fn(async (sessionId: string) => {
      if (!active.some((s) => s.id === sessionId)) throw new AppException('NOT_FOUND', 'No such session.')
    }),
    sessionPids: () => [],
    listActive: () => active,
    get: (id) => active.find((s) => s.id === id) ?? null,
    onSessionUpdate: browserSessions.on,
    onRunUpdate: runUpdates.on,
    onNetworkEntry: () => () => {},
  }

  const browsersSource = { current: 'provisioned' as BrowsersSource }
  const executables = new Map<BrowserEngine, string>([['system-chromium', '/usr/bin/chromium']])
  const redetects = { current: 0 }
  const engines = async (): Promise<BrowserEngineInfo[]> => BROWSER_ENGINES.map((engine) => engineInfo(engine, executables.get(engine) ?? null))
  const browsersStatus = async (overrides: Partial<BrowsersStatus> = {}): Promise<BrowsersStatus> => ({
    browsersPath: join(tmp, 'browsers'),
    chromium: chromiumInstalled.current,
    firefox: false,
    webkit: false,
    playwrightVersion: '1.63.0',
    source: browsersSource.current,
    installable: browsersSource.current !== 'bundled',
    engines: await engines(),
    ...overrides,
  })
  const resolveEngine = async (engine: BrowserEngine): Promise<BrowserEngineInfo> => {
    const info = engineInfo(engine, executables.get(engine) ?? null)
    if (!info.available) throw new AppException('BROWSER_MISSING', `${info.label}: ${info.note}`)
    return info
  }
  const watchListeners = new Set<(update: BrowserWatchUpdate) => void>()
  const provisioner: BrowserProvisioner = {
    status: () => browsersStatus(),
    install: vi.fn(async (engine, onProgress) => {
      onProgress({ engine, phase: 'starting', message: 'Starting', percent: null })
      onProgress({ engine, phase: 'done', message: 'Done', percent: 100 })
      return browsersStatus({ chromium: true, firefox: true, webkit: true })
    }),
    installEngine: vi.fn(async (engine, onProgress) => {
      if (engine !== 'chrome') throw new AppException('INVALID_INPUT', `${engine} cannot be installed by the app on linux.`)
      onProgress({ engine, phase: 'starting', message: 'Installing chrome…', percent: null })
      onProgress({ engine, phase: 'done', message: 'Installed chrome', percent: 100 })
      executables.set('chrome', '/opt/google/chrome/chrome')
      return browsersStatus()
    }),
    uninstallEngine: vi.fn(async (engine) => {
      if (executables.get(engine) !== '/opt/google/chrome/chrome') throw new AppException('INVALID_INPUT', `${engine} was not installed by this app.`)
      executables.delete(engine)
      return browsersStatus()
    }),
    installAllMissing: vi.fn(async (onProgress) => {
      onProgress({ engine: 'chrome', phase: 'downloading', message: 'Downloading', percent: 50, batch: { index: 1, total: 2 } })
      executables.set('chrome', '/opt/google/chrome/chrome')
      return { status: await browsersStatus(), installed: ['chrome' as const], failed: [{ engine: 'opera' as const, message: 'offline' }] }
    }),
    watchForInstall: vi.fn((engine) => {
      for (const listener of watchListeners) listener({ engine: engine as InstalledBrowserEngine, state: 'watching', info: null })
    }),
    onWatchUpdate: (listener) => {
      watchListeners.add(listener)
      return () => watchListeners.delete(listener)
    },
    dispose: vi.fn(),
    downloadUrl: (engine) => downloadUrlFor(engine),
    browsersPath: () => join(tmp, 'browsers'),
    engines,
    redetect: async () => {
      redetects.current += 1
      return engines()
    },
    resolveEngine,
    assertInstalled: async (engine) => {
      await resolveEngine(engine)
    },
  }

  const install = createInstallStateStore({ userData: tmp, appVersion: '1.2.3' })
  const vault = await createCredentialVault({
    paths,
    logger,
    wrapper: fakeKeychain(),
    machine: { machineId: 'ipc-machine', username: 'tester' },
    install,
    activeSource: () => proxy.getConfigStatus().source,
  })

  const sent: Array<{ channel: string; payload: unknown }> = []
  const liveTarget = { isDestroyed: () => false, send: (channel: string, payload: unknown) => sent.push({ channel, payload }) }
  const deadTarget = {
    isDestroyed: () => true,
    send: () => {
      throw new Error('should not send to destroyed webContents')
    },
  }
  const broadcast = createBroadcaster(() => [liveTarget, deadTarget])

  const locations = createLocationsService({ dataDir: join(process.cwd(), 'resources', 'geonames'), logger })
  const launcher = createLauncher({
    profiles,
    browser,
    targeting: {
      get: (id) => {
        if (id !== 'dataimpulse') throw new AppException('INVALID_INPUT', `Unknown proxy provider "${id}".`)
        return {
          name: 'dataimpulse',
          displayName: dataImpulseDialect.displayName,
          capabilities: dataImpulseDialect.capabilities,
          buildTargetingString: (request) => buildTargetingString(request),
          isPoolConfigured: (pool) => proxyConfigured.current && configuredPools.has(pool),
        }
      },
    },
    locations,
    getSettings: () => db.settings.get(),
    logger,
  })

  // The real task manager and executor over the fake provisioner; verification is faked (no Playwright).
  const tasks = createTaskManager({
    executor: createInstallExecutor({
      provisioner,
      logger,
      platform: 'linux',
      verify: async (engine) => ({
        ok: true,
        reason: null,
        code: null,
        info: null,
        verification: { exists: true, version: '1.0', executablePath: executables.get(engine) ?? null, smoke: 'passed', smokeDetail: null, pathSaved: true },
      }),
    }),
    killTree: async () => undefined,
    logger,
    progressThrottleMs: 0,
  })

  const deps: IpcDeps = {
    app: { getVersion: () => '1.2.3', isPackaged: false, platform: 'linux' },
    shell: { showItemInFolder: vi.fn(), openExternal: vi.fn(async () => undefined) },
    paths,
    db,
    logger,
    profiles,
    proxy,
    browser,
    provisioner,
    vault,
    install,
    locations,
    launcher,
    tasks,
    broadcast,
    windows: { openKeysWindow: vi.fn(), closeKeysWindow: vi.fn() },
    sanitize: (text) => text.replaceAll('topsecret', '[REDACTED]'),
  }

  const registrar = fakeRegistrar()
  const dispose = registerIpcHandlers(deps, registrar)
  return { deps, registrar, sent, proxySessions, browserSessions, runUpdates, active, db, logger, vault, install, proxyConfigured, chromiumInstalled, browsersSource, executables, redetects, configuredPools, dispose, tmp }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Wait until the task list (as the manager reports it) satisfies `predicate`. */
async function waitForTasks(h: Harness, predicate: (tasks: Task[]) => boolean, timeoutMs = 5_000): Promise<Task[]> {
  const started = Date.now()
  for (;;) {
    const tasks = h.deps.tasks.list()
    if (predicate(tasks)) return tasks
    if (Date.now() - started > timeoutMs) throw new Error(`tasks did not settle: ${JSON.stringify(tasks.map((task) => [task.engine, task.state, task.error?.message]))}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('registerIpcHandlers', () => {
  let h: Harness

  beforeEach(async () => {
    h = await buildHarness()
  })

  afterEach(() => {
    h.dispose()
    h.db.close()
    rmSync(h.tmp, { recursive: true, force: true })
  })

  it('registers a handler for every channel in the IPC contract', () => {
    const channels = allIpcChannels()
    expect(channels.length).toBeGreaterThan(30)
    for (const channel of channels) expect(h.registrar.handlers.has(channel)).toBe(true)
    expect(h.registrar.handlers.size).toBe(channels.length)
  })

  it('app.getInfo returns version, platform and paths', async () => {
    const res = await h.registrar.invoke(IPC.app.getInfo)
    expect(res).toEqual({
      ok: true,
      data: { version: '1.2.3', platform: 'linux', userDataPath: h.tmp, dataPath: join(h.tmp, 'data'), isPackaged: false },
    })
  })

  it('app.openPath only reveals files under the data folder', async () => {
    mkdirSync(join(h.tmp, 'data'), { recursive: true })
    const inside = join(h.tmp, 'data', 'note.txt')
    writeFileSync(inside, 'x')
    expect(await h.registrar.invoke(IPC.app.openPath, inside)).toEqual({ ok: true, data: undefined })
    expect(h.deps.shell.showItemInFolder).toHaveBeenCalledWith(inside)

    const outside = await h.registrar.invoke(IPC.app.openPath, join(h.tmp, 'elsewhere.txt'))
    expect(outside).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })

    const missing = await h.registrar.invoke(IPC.app.openPath, join(h.tmp, 'data', 'missing.txt'))
    expect(missing).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('profiles CRUD round-trips and validates input', async () => {
    const created = await h.registrar.invoke(IPC.profiles.create, profileInput)
    expect(created).toMatchObject({ ok: true, data: { name: 'QA Desktop' } })
    const id = (created as { data: Profile }).data.id

    expect(await h.registrar.invoke(IPC.profiles.get, id)).toMatchObject({ ok: true, data: { id } })
    expect(await h.registrar.invoke(IPC.profiles.update, id, { ...profileInput, name: 'Renamed' })).toMatchObject({
      ok: true,
      data: { name: 'Renamed' },
    })
    expect(await h.registrar.invoke(IPC.profiles.duplicate, id)).toMatchObject({ ok: true, data: { name: 'Renamed (copy)' } })
    expect(((await h.registrar.invoke(IPC.profiles.list)) as { data: Profile[] }).data).toHaveLength(2)

    const invalid = await h.registrar.invoke(IPC.profiles.create, { ...profileInput, name: '' })
    expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })

    expect(await h.registrar.invoke(IPC.profiles.delete, id)).toEqual({ ok: true, data: undefined })
    expect(await h.registrar.invoke(IPC.profiles.get, id)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('proxy.testConnection resolves the profile (or null for the gateway)', async () => {
    const created = (await h.registrar.invoke(IPC.profiles.create, profileInput)) as { data: Profile }
    expect(await h.registrar.invoke(IPC.proxy.testConnection, created.data.id)).toMatchObject({
      ok: true,
      data: { status: 'working', sessionId: `profile-${created.data.id}` },
    })
    expect(await h.registrar.invoke(IPC.proxy.testConnection, null)).toMatchObject({ ok: true, data: { sessionId: null } })
    expect(h.deps.proxy.testConnection).toHaveBeenLastCalledWith(null)
    // A raw gateway test may name its pool; a profile test ignores it.
    expect(await h.registrar.invoke(IPC.proxy.testConnection, null, 'mobile')).toMatchObject({ ok: true, data: { sessionId: null } })
    expect(h.deps.proxy.testConnection).toHaveBeenLastCalledWith(null, 'mobile', undefined)
    // …and its provider.
    await h.registrar.invoke(IPC.proxy.testConnection, null, 'mobile', 'dataimpulse')
    expect(h.deps.proxy.testConnection).toHaveBeenLastCalledWith(null, 'mobile', 'dataimpulse')
    expect(await h.registrar.invoke(IPC.proxy.testConnection, null, 'mobile', 'Not A Provider')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    await h.registrar.invoke(IPC.proxy.testConnection, created.data.id, 'mobile')
    expect(h.deps.proxy.testConnection).toHaveBeenLastCalledWith(expect.objectContaining({ id: created.data.id }))
    expect(await h.registrar.invoke(IPC.proxy.testConnection, null, 'Data Center')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(await h.registrar.invoke(IPC.proxy.testConnection, 'does-not-exist')).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    })
    expect(await h.registrar.invoke(IPC.proxy.getCurrentIp, null)).toMatchObject({ ok: true, data: { ip: ipInfo.ip } })
  })

  it('proxy.providers lists registered providers with capabilities and status, never credentials', async () => {
    const res = (await h.registrar.invoke(IPC.proxy.providers)) as { ok: true; data: ProviderInfo[] }
    expect(res.ok).toBe(true)
    expect(res.data.map((p) => p.id)).toEqual(['dataimpulse'])
    expect(res.data[0]).toMatchObject({ displayName: 'DataImpulse', capabilities: { defaults: { host: 'gw.dataimpulse.com', port: 823 } }, status: { provider: 'dataimpulse' } })
    expect(await h.registrar.invoke(IPC.proxy.providers, 'extra')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(await h.registrar.invoke(IPC.proxy.getConfigStatus, 'dataimpulse')).toMatchObject({ ok: true, data: { provider: 'dataimpulse' } })
  })

  it('browser.launch resolves the profile and returns the starting session; progress arrives as events', async () => {
    const created = (await h.registrar.invoke(IPC.profiles.create, profileInput)) as { data: Profile }
    h.sent.length = 0
    const launched = await h.registrar.invoke(IPC.browser.launch, created.data.id)
    expect(launched).toMatchObject({ ok: true, data: { id: 'sess-1', status: 'starting', ip: null } })
    await flush()
    const updates = h.sent.filter((e) => e.channel === EVENTS.sessionUpdate).map((e) => (e.payload as BrowserSession).status)
    expect(updates).toEqual(['open'])
    expect(await h.registrar.invoke(IPC.browser.listActive)).toMatchObject({ ok: true, data: [{ id: 'sess-1', status: 'open' }] })
    expect(await h.registrar.invoke(IPC.browser.screenshot, 'sess-1')).toMatchObject({ ok: true })
    expect(await h.registrar.invoke(IPC.browser.close, 'ghost')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await h.registrar.invoke(IPC.browser.launch, 'missing-profile')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('browsers.install queues one background task per missing bundled engine and validates the engine', async () => {
    const res = (await h.registrar.invoke(IPC.browsers.install, 'all')) as { ok: true; data: Task[] }
    expect(res.ok).toBe(true)
    // Chromium is already there: only Firefox and WebKit are queued, one task each.
    expect(res.data.map((task) => [task.kind, task.engine])).toEqual([
      ['install-bundled', 'firefox'],
      ['install-bundled', 'webkit'],
    ])
    await waitForTasks(h, (tasks) => tasks.length === 2 && tasks.every((task) => task.state === 'done'))
    expect(h.deps.provisioner.install).toHaveBeenCalledTimes(2)
    const updates = h.sent.filter((e) => e.channel === EVENTS.tasksUpdate).map((e) => e.payload as Task[])
    expect(updates.length).toBeGreaterThan(3)
    expect(updates.at(-1)?.map((task) => task.note)).toEqual(['Verified · 1.0', 'Verified · 1.0'])

    expect(await h.registrar.invoke(IPC.browsers.install, 'safari')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    // Installed browsers are real browsers from their vendors, never a Playwright download.
    expect(await h.registrar.invoke(IPC.browsers.install, 'opera')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(h.deps.provisioner.install).toHaveBeenCalledTimes(2)
  })

  it('tasks.list / cancel / retry / clearFinished drive the queue', async () => {
    // Hold the first download so the second one is still queued when it is cancelled.
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const realInstall = vi.mocked(h.deps.provisioner.install).getMockImplementation()
    if (!realInstall) throw new Error('fake install missing')
    vi.mocked(h.deps.provisioner.install).mockImplementationOnce(async (engine, onProgress, options) => {
      await gate
      return realInstall(engine, onProgress, options)
    })
    const [firefox, webkit] = ((await h.registrar.invoke(IPC.browsers.install, 'all')) as { data: Task[] }).data
    // The second task is still queued behind the first: cancelling it never starts it.
    const cancelled = (await h.registrar.invoke(IPC.tasks.cancel, webkit?.id)) as { ok: true; data: Task }
    expect(cancelled.data).toMatchObject({ engine: 'webkit', state: 'cancelled' })
    release()
    await waitForTasks(h, (tasks) => tasks.find((task) => task.id === firefox?.id)?.state === 'done')
    expect(h.deps.provisioner.install).toHaveBeenCalledTimes(1)
    expect(await h.registrar.invoke(IPC.tasks.cancel, webkit?.id)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(await h.registrar.invoke(IPC.tasks.cancel, 'nope')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })

    const retried = (await h.registrar.invoke(IPC.tasks.retry, webkit?.id)) as { ok: true; data: Task }
    expect(retried.data).toMatchObject({ engine: 'webkit', kind: 'install-bundled' })
    expect(retried.data.id).not.toBe(webkit?.id)
    await waitForTasks(h, (tasks) => tasks.find((task) => task.id === retried.data.id)?.state === 'done')

    const listed = (await h.registrar.invoke(IPC.tasks.list)) as { ok: true; data: Task[] }
    expect(listed.data).toHaveLength(3)
    const cleared = (await h.registrar.invoke(IPC.tasks.clearFinished)) as { ok: true; data: Task[] }
    expect(cleared.data).toEqual([])
    expect(await h.registrar.invoke(IPC.tasks.retry)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  })

  it('browser.focus reaches the browser manager with a validated session id', async () => {
    const created = (await h.registrar.invoke(IPC.profiles.create, profileInput)) as { data: Profile }
    await h.registrar.invoke(IPC.browser.launch, created.data.id)
    expect(await h.registrar.invoke(IPC.browser.focus, 'sess-1')).toEqual({ ok: true, data: undefined })
    expect(await h.registrar.invoke(IPC.browser.focus, 'ghost')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await h.registrar.invoke(IPC.browser.focus)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  })

  it('browsers.status carries one BrowserEngineInfo per engine; browsers.engines and browsers.redetect expose detection', async () => {
    const status = (await h.registrar.invoke(IPC.browsers.status)) as { ok: true; data: BrowsersStatus }
    expect(status.ok).toBe(true)
    expect(status.data.engines.map((e) => e.id)).toEqual([...BROWSER_ENGINES])
    expect(status.data.engines.find((e) => e.id === 'system-chromium')).toMatchObject({ kind: 'installed', available: true, executablePath: '/usr/bin/chromium', source: 'detected' })
    expect(status.data.engines.find((e) => e.id === 'opera')).toMatchObject({ kind: 'installed', available: false, executablePath: null, source: 'not-found' })
    expect(status.data.engines.find((e) => e.id === 'chromium')).toMatchObject({ kind: 'bundled', available: true, executablePath: null, source: 'bundled' })

    const engines = (await h.registrar.invoke(IPC.browsers.engines)) as { ok: true; data: BrowserEngineInfo[] }
    expect(engines.data).toEqual(status.data.engines)
    expect(h.redetects.current).toBe(0)

    h.executables.set('opera', '/usr/bin/chromium')
    const redetected = (await h.registrar.invoke(IPC.browsers.redetect)) as { ok: true; data: BrowserEngineInfo[] }
    expect(h.redetects.current).toBe(1)
    expect(redetected.data.find((e) => e.id === 'opera')).toMatchObject({ available: true, executablePath: '/usr/bin/chromium' })
    expect(await h.registrar.invoke(IPC.browsers.redetect, 'unexpected')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  })

  it('browser.launch surfaces BROWSER_MISSING for an installed browser that is not on this machine', async () => {
    const created = (await h.registrar.invoke(IPC.profiles.create, { ...profileInput, name: 'Opera QA', engine: 'opera' })) as { data: Profile }
    h.deps.browser.launch = vi.fn(async (profile: Profile) => {
      await h.deps.provisioner.resolveEngine(profile.engine)
      throw new Error('unreachable')
    })
    const res = await h.registrar.invoke(IPC.browser.launch, created.data.id)
    expect(res).toMatchObject({ ok: false, error: { code: 'BROWSER_MISSING', message: 'Opera (installed): Not installed on this machine. Install it or set its path in Settings → Browsers.' } })
  })

  it('settings.update stores browserExecutables overrides and settings.get returns them (default {})', async () => {
    const initial = (await h.registrar.invoke(IPC.settings.get)) as { ok: true; data: AppSettings }
    expect(initial.data.browserExecutables).toEqual({})
    const updated = await h.registrar.invoke(IPC.settings.update, { browserExecutables: { opera: '/usr/bin/chromium' } })
    expect(updated).toMatchObject({ ok: true, data: { browserExecutables: { opera: '/usr/bin/chromium' } } })
    expect(await h.registrar.invoke(IPC.settings.update, { browserExecutables: { opera: '' } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(await h.registrar.invoke(IPC.settings.update, { browserExecutables: { safari: '/x' } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(await h.registrar.invoke(IPC.settings.update, { browserExecutables: {} })).toMatchObject({ ok: true, data: { browserExecutables: {} } })
  })

  it('runs handlers list/get/update/delete/network', async () => {
    const run = h.db.testRuns.create({
      profileId: null,
      profileName: 'QA Desktop',
      engine: 'chromium',
      devicePreset: 'windows-desktop',
      proxyPool: null,
      provider: null,
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
      formUrl: 'https://example.com/',
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
      method: 'POST',
      url: 'https://example.com/api/lead',
      status: null,
      resourceType: 'xhr',
      requestTime: new Date().toISOString(),
      responseTime: null,
      durationMs: null,
      extractedIds: {},
    })

    expect(await h.registrar.invoke(IPC.runs.list)).toMatchObject({ ok: true, data: [{ id: run.id }] })
    expect(await h.registrar.invoke(IPC.runs.list, 0)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(await h.registrar.invoke(IPC.runs.get, run.id)).toMatchObject({ ok: true, data: { id: run.id } })
    expect(await h.registrar.invoke(IPC.runs.get, 'nope')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await h.registrar.invoke(IPC.runs.update, run.id, { notes: 'checked', leadId: 'L-1' })).toMatchObject({
      ok: true,
      data: { notes: 'checked', leadId: 'L-1' },
    })
    expect(await h.registrar.invoke(IPC.runs.update, run.id, { status: 'bogus' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    })
    // The renderer may only mark a run success/failed; 'running' and 'aborted' belong to the browser manager.
    expect(await h.registrar.invoke(IPC.runs.update, run.id, { status: 'running' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(await h.registrar.invoke(IPC.runs.update, run.id, { status: 'aborted' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(await h.registrar.invoke(IPC.runs.update, run.id, { status: 'success' })).toMatchObject({ ok: true, data: { status: 'success' } })
    expect(((await h.registrar.invoke(IPC.runs.network, run.id)) as { data: unknown[] }).data).toHaveLength(1)
    expect(await h.registrar.invoke(IPC.runs.delete, run.id)).toEqual({ ok: true, data: undefined })
    expect(await h.registrar.invoke(IPC.runs.get, run.id)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('settings.update validates the patch and creates a new screenshot folder', async () => {
    const newDir = join(h.tmp, 'custom', 'shots')
    const updated = await h.registrar.invoke(IPC.settings.update, { screenshotDir: newDir, ipCheckRetries: 4 })
    expect(updated).toMatchObject({ ok: true, data: { screenshotDir: newDir, ipCheckRetries: 4 } })
    expect(await h.registrar.invoke(IPC.settings.get)).toMatchObject({ ok: true, data: { screenshotDir: newDir } })

    expect(await h.registrar.invoke(IPC.settings.update, { ipCheckRetries: 99 })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    })
    expect(await h.registrar.invoke(IPC.settings.update, { screenshotDir: 'relative/dir' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    })
  })

  it('logs.list / logs.clear go through the logger', async () => {
    h.logger.info('test', 'hello world')
    const listed = (await h.registrar.invoke(IPC.logs.list, { search: 'hello' })) as { data: unknown[] }
    expect(listed.data).toHaveLength(1)
    expect(await h.registrar.invoke(IPC.logs.list, { level: 'VERBOSE' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(await h.registrar.invoke(IPC.logs.clear)).toEqual({ ok: true, data: undefined })
    const after = (await h.registrar.invoke(IPC.logs.list)) as { data: Array<{ message: string }> }
    expect(after.data.some((e) => e.message === 'hello world')).toBe(false)
  })

  it('dashboard.stats aggregates counts, current IP, browsers and the provider-backed proxyConfigured', async () => {
    const created = (await h.registrar.invoke(IPC.profiles.create, profileInput)) as { data: Profile }
    const session = h.db.proxySessions.upsertForProfile(created.data.id, 'sess')
    h.db.proxySessions.updateStatus(session.id, { status: 'working', ip: ipInfo })
    const other = (await h.registrar.invoke(IPC.profiles.create, { ...profileInput, name: 'Other' })) as { data: Profile }
    const failed = h.db.proxySessions.upsertForProfile(other.data.id, 'x')
    h.db.proxySessions.updateStatus(failed.id, { status: 'failed', error: 'dead' })
    await h.registrar.invoke(IPC.browser.launch, created.data.id)

    const res = (await h.registrar.invoke(IPC.dashboard.stats)) as { ok: true; data: DashboardStats }
    expect(res.ok).toBe(true)
    expect(res.data.totalProfiles).toBe(2)
    expect(res.data.activeSessions).toBe(1)
    expect(res.data.workingProxies).toBe(1)
    expect(res.data.failedProxies).toBe(1)
    expect(res.data.currentIp).toMatchObject({ ip: ipInfo.ip, city: 'Austin', latencyMs: 120, countryCode: 'US', country: 'United States' })
    expect(res.data.proxyConfigured).toBe(true)
    expect(res.data.browsers.chromium).toBe(true)
    expect(Array.isArray(res.data.recentRuns)).toBe(true)

    h.proxyConfigured.current = false
    const unconfigured = (await h.registrar.invoke(IPC.dashboard.stats)) as { data: DashboardStats }
    expect(unconfigured.data.proxyConfigured).toBe(false)
  })

  it('currentIpFromSessions prefers the most recently checked working session, gateway or profile', () => {
    const base: ProxySession = {
      id: 'a',
      profileId: 'p1',
      provider: 'dataimpulse',
      pool: 'residential',
      target: null,
      targetingString: 'sessid.s1',
      targetMatch: null,
      sessionId: 's1',
      status: 'working',
      lastIp: '203.0.113.1',
      country: 'United States',
      countryCode: 'US',
      region: 'TX',
      city: 'Austin',
      postalCode: '78701',
      isp: null,
      asn: null,
      latencyMs: 50,
      lastCheckedAt: '2026-10-03T10:00:00.000Z',
      lastError: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-03T12:00:00.000Z',
    }
    const newerGateway: ProxySession = {
      ...base,
      id: 'gw',
      profileId: null,
      sessionId: null,
      lastIp: '198.51.100.2',
      country: 'Germany',
      countryCode: 'DE',
      lastCheckedAt: '2026-10-03T11:00:00.000Z',
      updatedAt: '2026-10-03T11:00:00.000Z',
    }
    const failedNewest: ProxySession = { ...base, id: 'f', status: 'failed', lastCheckedAt: '2026-10-03T13:00:00.000Z' }
    const workingNoIp: ProxySession = { ...base, id: 'n', lastIp: null, lastCheckedAt: '2026-10-03T14:00:00.000Z' }

    // `base` was updated later than the gateway row but *checked* earlier: the gateway wins.
    const picked = currentIpFromSessions([base, newerGateway, failedNewest, workingNoIp], 'ipinfo')
    expect(picked).toMatchObject({ ip: '198.51.100.2', country: 'Germany', countryCode: 'DE', postalCode: '78701', provider: 'ipinfo', checkedAt: '2026-10-03T11:00:00.000Z' })
    expect(currentIpFromSessions([failedNewest, workingNoIp], 'ip-api')).toBeNull()
    expect(currentIpFromSessions([], 'ip-api')).toBeNull()
  })

  it('forwards logger, browser and proxy events to live windows only', () => {
    h.sent.length = 0
    h.logger.info('scope', 'forwarded line')
    h.proxySessions.emit({ id: 'p1' } as ProxySession)
    h.browserSessions.emit({ id: 's1' } as BrowserSession)
    h.runUpdates.emit({ id: 'r1' } as TestRun)

    expect(h.sent.map((e) => e.channel)).toEqual([EVENTS.logEntry, EVENTS.proxySessionUpdate, EVENTS.sessionUpdate, EVENTS.runUpdate])
    expect((h.sent[0]?.payload as { message: string }).message).toBe('forwarded line')
  })

  it('disposer removes handlers and stops event forwarding', () => {
    h.dispose()
    expect(h.registrar.handlers.size).toBe(0)
    h.sent.length = 0
    h.proxySessions.emit({ id: 'p1' } as ProxySession)
    expect(h.sent).toHaveLength(0)
    h.dispose = () => {}
  })

  it('browsers.installEngine queues a verified vendor install; browsers.openDownloadPage opens only allow-listed vendor URLs', async () => {
    h.sent.length = 0
    const res = (await h.registrar.invoke(IPC.browsers.installEngine, 'chrome')) as { ok: true; data: Task }
    expect(res).toMatchObject({ ok: true, data: { kind: 'install-vendor', engine: 'chrome', label: 'Install Google Chrome' } })
    // Asking again while it is queued/running returns the same task instead of a duplicate.
    const again = (await h.registrar.invoke(IPC.browsers.installEngine, 'chrome')) as { ok: true; data: Task }
    expect(again.data.id).toBe(res.data.id)
    const done = await waitForTasks(h, (tasks) => tasks.find((task) => task.id === res.data.id)?.state === 'done')
    expect(done.find((task) => task.id === res.data.id)).toMatchObject({ note: 'Verified · 1.0 · /opt/google/chrome/chrome', verification: { smoke: 'passed' } })
    expect(h.deps.provisioner.installEngine).toHaveBeenCalledTimes(1)
    // Engines without an automatic install method are refused when queued, not later.
    expect(await h.registrar.invoke(IPC.browsers.installEngine, 'opera')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(await h.registrar.invoke(IPC.browsers.installEngine, 'chromium')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(await h.registrar.invoke(IPC.browsers.installEngine, 'safari')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })

    expect(await h.registrar.invoke(IPC.browsers.openDownloadPage, 'opera')).toEqual({ ok: true, data: undefined })
    expect(h.deps.shell.openExternal).toHaveBeenCalledWith(DOWNLOAD_URLS.opera)
    expect(await h.registrar.invoke(IPC.browsers.openDownloadPage, 'brave')).toEqual({ ok: true, data: undefined })
    expect(h.deps.shell.openExternal).toHaveBeenLastCalledWith('https://brave.com/download/')
    // Bundled engines have no vendor page; unknown engines fail validation; nothing else is ever opened.
    expect(await h.registrar.invoke(IPC.browsers.openDownloadPage, 'chromium')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(await h.registrar.invoke(IPC.browsers.openDownloadPage, 'https://evil.example/')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(h.deps.shell.openExternal).toHaveBeenCalledTimes(2)
    // Opening a vendor page starts the install watcher, whose updates reach the renderer.
    expect(h.deps.provisioner.watchForInstall).toHaveBeenCalledWith('brave')
    expect(h.sent.filter((e) => e.channel === EVENTS.browserWatch).map((e) => e.payload)).toContainEqual({ engine: 'brave', state: 'watching', info: null })
  })

  it('browsers.installAllMissing queues every one-click install; browsers.uninstallEngine queues a removal of the app\'s own copy', async () => {
    const all = (await h.registrar.invoke(IPC.browsers.installAllMissing)) as { ok: true; data: Task[] }
    expect(all.data.map((task) => [task.kind, task.engine])).toEqual([['install-vendor', 'chrome']])
    await waitForTasks(h, (tasks) => tasks.every((task) => task.state === 'done'))
    expect(await h.registrar.invoke(IPC.browsers.installAllMissing, 'extra')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(((await h.registrar.invoke(IPC.browsers.installAllMissing)) as { data: Task[] }).data).toEqual([])

    const removal = (await h.registrar.invoke(IPC.browsers.uninstallEngine, 'chrome')) as { ok: true; data: Task }
    expect(removal.data).toMatchObject({ kind: 'uninstall', engine: 'chrome', label: 'Uninstall Google Chrome' })
    await waitForTasks(h, (tasks) => tasks.find((task) => task.id === removal.data.id)?.state === 'done')
    expect(h.executables.has('chrome')).toBe(false)
    // Not installed by the app (any more): refused when queued.
    expect(await h.registrar.invoke(IPC.browsers.uninstallEngine, 'chrome')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(await h.registrar.invoke(IPC.browsers.uninstallEngine, '../etc')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  })

  it('settings.update marks browser paths typed in Settings as the user\'s and keeps untouched origins', async () => {
    h.db.settings.update({ browserExecutables: { brave: '/auto/brave' }, browserExecutableOrigins: { brave: 'auto' } })
    const saved = (await h.registrar.invoke(IPC.settings.update, { browserExecutables: { brave: '/auto/brave', opera: '/home/qa/opera' } })) as { ok: true; data: AppSettings }
    expect(saved.data.browserExecutableOrigins).toEqual({ brave: 'auto', opera: 'user' })
    const changed = (await h.registrar.invoke(IPC.settings.update, { browserExecutables: { brave: '/home/qa/brave' } })) as { ok: true; data: AppSettings }
    expect(changed.data.browserExecutables).toEqual({ brave: '/home/qa/brave' })
    expect(changed.data.browserExecutableOrigins).toEqual({ brave: 'user' })
    // An explicit origins map (the provisioner's own writes) is stored as given.
    const explicit = (await h.registrar.invoke(IPC.settings.update, { browserExecutables: { brave: '/x/brave' }, browserExecutableOrigins: { brave: 'auto' } })) as { ok: true; data: AppSettings }
    expect(explicit.data.browserExecutableOrigins).toEqual({ brave: 'auto' })
  })

  it('profiles.list hides ephemeral profiles; dashboard counts only saved ones; profiles.update can save an ephemeral one', async () => {
    const saved = (await h.registrar.invoke(IPC.profiles.create, profileInput)) as { data: Profile }
    const quick = (await h.registrar.invoke(IPC.profiles.create, { ...profileInput, name: 'Quick', ephemeral: true, target: NJ, proxyMode: 'sticky', stickySessionId: 'ql-1' })) as { data: Profile }
    expect(quick.data).toMatchObject({ ephemeral: true, target: NJ, proxyPool: 'residential' })
    expect(((await h.registrar.invoke(IPC.profiles.list)) as { data: Profile[] }).data.map((p) => p.id)).toEqual([saved.data.id])
    expect(((await h.registrar.invoke(IPC.dashboard.stats)) as { data: DashboardStats }).data.totalProfiles).toBe(1)
    expect(await h.registrar.invoke(IPC.profiles.get, quick.data.id)).toMatchObject({ ok: true, data: { id: quick.data.id } })

    const promoted = await h.registrar.invoke(IPC.profiles.update, quick.data.id, { ...profileInput, name: 'Quick', ephemeral: false, target: NJ, proxyMode: 'sticky', stickySessionId: 'ql-1' })
    expect(promoted).toMatchObject({ ok: true, data: { ephemeral: false } })
    expect(((await h.registrar.invoke(IPC.profiles.list)) as { data: Profile[] }).data).toHaveLength(2)
    expect(((await h.registrar.invoke(IPC.dashboard.stats)) as { data: DashboardStats }).data.totalProfiles).toBe(2)
  })

  // --- locations & launcher ---------------------------------------------------

  it('locations.search/random/states serve the bundled dataset and validate their input', async () => {
    const states = (await h.registrar.invoke(IPC.locations.states)) as { ok: true; data: LocationEntry[] }
    expect(states.ok).toBe(true)
    expect(states.data).toHaveLength(51)
    expect(states.data[0]?.label).toBe('Alabama (AL)')

    const search = (await h.registrar.invoke(IPC.locations.search, { mode: 'state', query: 'new j' })) as { ok: true; data: LocationEntry[] }
    expect(search.data[0]).toMatchObject({ kind: 'state', state: 'New Jersey', stateCode: 'NJ' })
    const zips = (await h.registrar.invoke(IPC.locations.search, { mode: 'zip', query: '0710', limit: 5 })) as { ok: true; data: LocationEntry[] }
    expect(zips.data).toHaveLength(5)
    expect(zips.data.every((z) => z.zip?.startsWith('0710'))).toBe(true)
    expect(await h.registrar.invoke(IPC.locations.search, { mode: 'galaxy', query: '' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(await h.registrar.invoke(IPC.locations.search, { mode: 'zip', query: '1', limit: 0 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })

    const random = (await h.registrar.invoke(IPC.locations.random, 'zip')) as { ok: true; data: LocationEntry }
    expect(random.data).toMatchObject({ kind: 'zip', zip: expect.stringMatching(/^\d{5}$/) })
    expect(await h.registrar.invoke(IPC.locations.random, 'continent')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })

    const inNj = (await h.registrar.invoke(IPC.locations.random, 'zip', 'nj')) as { ok: true; data: LocationEntry }
    expect(inNj.data).toMatchObject({ kind: 'zip', stateCode: 'NJ' })
    expect(await h.registrar.invoke(IPC.locations.random, 'zip', 'N1')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    const page = (await h.registrar.invoke(IPC.locations.query, { mode: 'city', query: 'new', limit: 5, stateCode: 'NJ' })) as { ok: true; data: { entries: LocationEntry[]; total: number } }
    expect(page.data.entries).toHaveLength(5)
    expect(page.data.entries.every((e) => e.stateCode === 'NJ')).toBe(true)
    expect(page.data.total).toBeGreaterThan(5)
    const stats = (await h.registrar.invoke(IPC.locations.stats)) as { ok: true; data: { states: number; cities: number; zips: number } }
    expect(stats.data.states).toBe(51)
    expect(stats.data.zips).toBeGreaterThan(stats.data.cities)
  })

  it('launcher.preview shows the targeting string; quickLaunch creates an ephemeral profile and launches; closeAll terminates everything', async () => {
    const preview = (await h.registrar.invoke(IPC.launcher.preview, quickLaunchInput)) as { ok: true; data: TargetingPreview }
    expect(preview.ok).toBe(true)
    expect(preview.data.pool).toBe('residential')
    expect(preview.data.targetingString).toMatch(/^cr\.us;state\.newjersey;sessid\.ql-\d{8}-[a-z0-9]{4}$/)
    expect(preview.data.poolConfigured).toBe(true)
    expect(preview.data.warnings).toEqual(['State/city/ZIP targeting is billed at 2× by DataImpulse.'])
    const mobile = (await h.registrar.invoke(IPC.launcher.preview, { ...quickLaunchInput, proxyPool: 'mobile' })) as { ok: true; data: TargetingPreview }
    expect(mobile.data).toMatchObject({ pool: 'mobile', poolConfigured: false })
    expect(mobile.data.warnings[0]).toBe('DataImpulse Mobile credentials are not configured. Add them under Settings → Advanced → Proxy keys.')
    expect(await h.registrar.invoke(IPC.launcher.preview, { ...quickLaunchInput, engine: 'safari' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })

    h.sent.length = 0
    const launched = (await h.registrar.invoke(IPC.launcher.quickLaunch, quickLaunchInput)) as { ok: true; data: BrowserSession }
    expect(launched.ok).toBe(true)
    expect(launched.data).toMatchObject({ status: 'starting', engine: 'chromium', devicePreset: 'iphone-15', proxyPool: 'residential', target: NJ })
    expect(h.deps.browser.launch).toHaveBeenCalledTimes(1)
    const profile = h.db.profiles.get(launched.data.profileId)
    expect(profile).toMatchObject({ ephemeral: true, proxyMode: 'sticky', target: NJ, timezone: 'America/New_York', locale: 'en-US', formUrlOverride: 'https://example.com/' })
    expect(profile?.stickySessionId).toMatch(/^ql-\d{8}-[a-z0-9]{4}$/)
    expect(((await h.registrar.invoke(IPC.profiles.list)) as { data: Profile[] }).data).toEqual([])

    // singleSessionMode (default on): a second quick launch is refused unless it replaces the first.
    expect(await h.registrar.invoke(IPC.launcher.quickLaunch, quickLaunchInput)).toMatchObject({ ok: false, error: { code: 'SESSION_LIMIT' } })
    const replaced = (await h.registrar.invoke(IPC.launcher.quickLaunch, { ...quickLaunchInput, replaceActiveSession: true, saveAsProfile: true, profileName: 'Kept' })) as { ok: true; data: BrowserSession }
    expect(replaced.ok).toBe(true)
    expect(h.deps.browser.close).toHaveBeenCalledWith(launched.data.id)
    expect(h.db.profiles.get(replaced.data.profileId)).toMatchObject({ ephemeral: false, name: 'Kept' })

    expect(await h.registrar.invoke(IPC.launcher.quickLaunch, { ...quickLaunchInput, proxyPool: 'mobile', replaceActiveSession: true })).toMatchObject({
      ok: false,
      error: { code: 'PROXY_NOT_CONFIGURED', message: 'DataImpulse Mobile credentials are not configured. Add them under Settings → Advanced → Proxy keys.' },
    })

    expect(await h.registrar.invoke(IPC.launcher.closeAll)).toEqual({ ok: true, data: undefined })
    expect(h.deps.browser.closeAll).toHaveBeenCalledTimes(1)
    expect(await h.registrar.invoke(IPC.browser.listActive)).toEqual({ ok: true, data: [] })
  })

  // --- security --------------------------------------------------------------

  it('security.status returns the local vault health (fresh install: key present, no vault)', async () => {
    const res = (await h.registrar.invoke(IPC.security.status)) as { ok: true; data: SecurityStatus }
    expect(res.ok).toBe(true)
    expect(res.data).toMatchObject({
      source: 'vault',
      keyBackend: 'os-keychain',
      keyBackendLabel: 'Fake Keychain',
      keyPresent: true,
      vaultPresent: false,
      decryptOk: true,
      permissionsOk: true,
      warnings: [],
    })
    expect(res.data.keyPath.startsWith(h.deps.paths.keys)).toBe(true)
    expect(res.data.vaultPath.startsWith(h.deps.paths.vault)).toBe(true)
    expect(res.data.installId).toBe(h.install.get().installId)
  })

  it('security.testCredentials validates the input, delegates to the proxy manager and returns a credential-free result', async () => {
    const res = await h.registrar.invoke(IPC.security.testCredentials, credentials)
    expect(res).toEqual({ ok: true, data: { status: 'working', sessionId: null, ip: ipInfo, error: null } })
    expect(h.deps.proxy.testCredentials).toHaveBeenCalledWith({ ...credentials, providerId: 'dataimpulse', extras: {} })
    expect(JSON.stringify(res)).not.toContain(PASSWORD)

    expect(await h.registrar.invoke(IPC.security.testCredentials, { ...credentials, password: '' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(await h.registrar.invoke(IPC.security.testCredentials, { ...credentials, port: 'abc' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(await h.registrar.invoke(IPC.security.testCredentials, { ...credentials, sessionTemplate: 'nope' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(await h.registrar.invoke(IPC.security.testCredentials)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    // Nothing was persisted by a test.
    expect(existsSync(h.vault.vaultPath)).toBe(false)
    expect(h.db.proxySessions.list()).toHaveLength(0)
  })

  it('security.saveCredentials encrypts, verifies, broadcasts securityUpdate and never leaks the password', async () => {
    h.sent.length = 0
    const res = (await h.registrar.invoke(IPC.security.saveCredentials, credentials)) as { ok: true; data: SecurityStatus }
    expect(res.ok).toBe(true)
    expect(res.data).toMatchObject({ vaultPresent: true, decryptOk: true, permissionsOk: true, warnings: [], configuredProducts: { dataimpulse: ['residential'] } })
    expect(res.data.vaultUpdatedAt).not.toBeNull()
    expect(h.vault.get('dataimpulse', 'residential')).toEqual({ ...credentials, providerId: 'dataimpulse', extras: {}, sessionTemplate: null })
    expect(h.vault.get('dataimpulse', 'mobile')).toBeNull()

    await flush()
    const updates = h.sent.filter((e) => e.channel === EVENTS.securityUpdate)
    expect(updates).toHaveLength(1)
    expect((updates[0]?.payload as SecurityStatus).vaultPresent).toBe(true)

    // Password: not in the vault file, not in the IPC payloads, not in the logs (db rows or files).
    expect(readFileSync(h.vault.vaultPath, 'utf8')).not.toContain(PASSWORD)
    expect(JSON.stringify(h.sent)).not.toContain(PASSWORD)
    expect(JSON.stringify(h.logger.query())).not.toContain(PASSWORD)
    expect(JSON.stringify(h.logger.query())).not.toContain(credentials.username)
    h.logger.info('probe', `leaked ${PASSWORD} and ${credentials.username}:${PASSWORD}@gw`)
    expect(JSON.stringify(h.logger.query({ search: 'leaked' }))).not.toContain(PASSWORD)

    expect(await h.registrar.invoke(IPC.security.saveCredentials, { ...credentials, host: '' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  })

  it('security.clearCredentials(provider, product) removes one product, the vault file once empty, and broadcasts', async () => {
    await h.registrar.invoke(IPC.security.saveCredentials, credentials)
    await h.registrar.invoke(IPC.security.saveCredentials, { ...credentials, pool: 'mobile', username: 'ipc_mobile' })
    expect(h.vault.getAll().map((c) => c.pool)).toEqual(['residential', 'mobile'])
    h.sent.length = 0
    const partial = (await h.registrar.invoke(IPC.security.clearCredentials, 'dataimpulse', 'residential')) as { ok: true; data: SecurityStatus }
    expect(partial.data).toMatchObject({ vaultPresent: true, configuredProducts: { dataimpulse: ['mobile'] } })
    expect(h.vault.get('dataimpulse', 'residential')).toBeNull()
    expect(h.vault.get('dataimpulse', 'mobile')?.username).toBe('ipc_mobile')

    const res = (await h.registrar.invoke(IPC.security.clearCredentials, 'dataimpulse', 'mobile')) as { ok: true; data: SecurityStatus }
    expect(res.data).toMatchObject({ vaultPresent: false, keyPresent: true, decryptOk: true, configuredProducts: {} })
    expect(existsSync(h.vault.vaultPath)).toBe(false)
    expect(h.vault.getAll()).toEqual([])
    await flush()
    expect(h.sent.filter((e) => e.channel === EVENTS.securityUpdate)).toHaveLength(2)
    expect(await h.registrar.invoke(IPC.security.clearCredentials, 'dataimpulse', 'Data Center')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    // Both the provider and the product must be named.
    expect(await h.registrar.invoke(IPC.security.clearCredentials, 'residential')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(await h.registrar.invoke(IPC.security.clearCredentials)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  })

  it('security.updateCredentials merges a partial update with the stored entry (password rotation keeps the username)', async () => {
    await h.registrar.invoke(IPC.security.saveCredentials, credentials)
    h.sent.length = 0
    const res = (await h.registrar.invoke(IPC.security.updateCredentials, { pool: 'residential', password: 'rotated-Pass-42' })) as { ok: true; data: SecurityStatus }
    expect(res.ok).toBe(true)
    expect(res.data.configuredProducts).toEqual({ dataimpulse: ['residential'] })
    expect(h.vault.get('dataimpulse', 'residential')).toEqual({ ...credentials, providerId: 'dataimpulse', extras: {}, password: 'rotated-Pass-42', sessionTemplate: null })
    expect(JSON.stringify(res)).not.toContain('rotated-Pass-42')
    await flush()
    expect(h.sent.filter((e) => e.channel === EVENTS.securityUpdate)).toHaveLength(1)
    expect(JSON.stringify(h.sent)).not.toContain('rotated-Pass-42')

    // Nothing stored for mobile: the update must be complete.
    expect(await h.registrar.invoke(IPC.security.updateCredentials, { pool: 'mobile', password: 'x' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(h.vault.get('dataimpulse', 'mobile')).toBeNull()
    // A provider this build does not know, or a product the provider does not offer, never reaches the vault.
    expect(await h.registrar.invoke(IPC.security.updateCredentials, { providerId: 'brightdata', pool: 'residential', password: 'x' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: 'Unknown proxy provider "brightdata".' } })
    expect(await h.registrar.invoke(IPC.security.saveCredentials, { ...credentials, pool: 'datacenter' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: 'DataImpulse does not offer a "datacenter" product.' } })
    expect(await h.registrar.invoke(IPC.security.updateCredentials, { pool: 'residential', port: 'abc' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(await h.registrar.invoke(IPC.security.updateCredentials)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  })

  it('security.testCredentialsPartial tests the merged credentials without persisting anything', async () => {
    await h.registrar.invoke(IPC.security.saveCredentials, credentials)
    const vaultBefore = readFileSync(h.vault.vaultPath, 'utf8')
    const res = await h.registrar.invoke(IPC.security.testCredentialsPartial, { pool: 'residential', password: 'candidate-pass' })
    expect(res).toEqual({ ok: true, data: { status: 'working', sessionId: null, ip: ipInfo, error: null } })
    expect(h.deps.proxy.testCredentials).toHaveBeenLastCalledWith({ ...credentials, providerId: 'dataimpulse', extras: {}, password: 'candidate-pass', sessionTemplate: null })
    expect(readFileSync(h.vault.vaultPath, 'utf8')).toBe(vaultBefore)
    expect(h.vault.get('dataimpulse', 'residential')?.password).toBe(credentials.password)
    expect(await h.registrar.invoke(IPC.security.testCredentialsPartial, { pool: 'mobile' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  })

  it('security.openKeysWindow / closeKeysWindow delegate to the window controller', async () => {
    expect(await h.registrar.invoke(IPC.security.openKeysWindow)).toEqual({ ok: true, data: undefined })
    expect(h.deps.windows.openKeysWindow).toHaveBeenCalledTimes(1)
    expect(await h.registrar.invoke(IPC.security.closeKeysWindow)).toEqual({ ok: true, data: undefined })
    expect(h.deps.windows.closeKeysWindow).toHaveBeenCalledTimes(1)
  })

  it('security.rotateKey keeps the credentials and replaces the key file', async () => {
    await h.registrar.invoke(IPC.security.saveCredentials, credentials)
    const keyBefore = readFileSync(h.vault.keyPath, 'utf8')
    const res = (await h.registrar.invoke(IPC.security.rotateKey)) as { ok: true; data: SecurityStatus }
    expect(res.ok).toBe(true)
    expect(res.data).toMatchObject({ decryptOk: true, vaultPresent: true, keyBackend: 'os-keychain' })
    expect(readFileSync(h.vault.keyPath, 'utf8')).not.toBe(keyBefore)
    expect(h.vault.get('dataimpulse', 'residential')).toEqual({ ...credentials, providerId: 'dataimpulse', extras: {}, sessionTemplate: null })
  })

  it('security.revealLocations opens only the key or vault directory', async () => {
    expect(await h.registrar.invoke(IPC.security.revealLocations, 'key')).toEqual({ ok: true, data: undefined })
    expect(h.deps.shell.showItemInFolder).toHaveBeenLastCalledWith(dirname(h.vault.keyPath))
    expect(await h.registrar.invoke(IPC.security.revealLocations, 'vault')).toEqual({ ok: true, data: undefined })
    expect(h.deps.shell.showItemInFolder).toHaveBeenLastCalledWith(dirname(h.vault.vaultPath))
    expect(await h.registrar.invoke(IPC.security.revealLocations, '/etc')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(h.deps.shell.showItemInFolder).toHaveBeenCalledTimes(2)
  })

  // --- setup -----------------------------------------------------------------

  it('setup.status reports first run and the pending steps derived from browsers + proxy', async () => {
    const ready = (await h.registrar.invoke(IPC.setup.status)) as { ok: true; data: SetupStatus }
    expect(ready.ok).toBe(true)
    expect(ready.data).toMatchObject({ firstRun: true, completedAt: null, appVersion: '1.2.3', pending: [] })
    expect(ready.data.browsers.chromium).toBe(true)
    expect(ready.data.security.keyPresent).toBe(true)
    expect(ready.data.proxy.configured).toBe(true)

    h.chromiumInstalled.current = false
    h.proxyConfigured.current = false
    const pending = (await h.registrar.invoke(IPC.setup.status)) as { data: SetupStatus }
    expect(pending.data.pending).toEqual(['browsers', 'credentials'])
    expect(pending.data.proxy.configured).toBe(false)
    expect(pending.data.security.source).toBe('none')

    h.chromiumInstalled.current = true
    expect(((await h.registrar.invoke(IPC.setup.status)) as { data: SetupStatus }).data.pending).toEqual(['credentials'])
  })

  it('setup.status never lists browsers as pending when they are bundled with the build', async () => {
    h.browsersSource.current = 'bundled'
    h.chromiumInstalled.current = false
    h.proxyConfigured.current = false
    const status = (await h.registrar.invoke(IPC.setup.status)) as { ok: true; data: SetupStatus }
    expect(status.ok).toBe(true)
    expect(status.data.pending).toEqual(['credentials'])
    expect(status.data.browsers).toMatchObject({ source: 'bundled', installable: false })
    const browsers = (await h.registrar.invoke(IPC.browsers.status)) as { data: BrowsersStatus }
    expect(browsers.data).toMatchObject({ source: 'bundled', installable: false })
  })

  it('setup.complete persists setupCompletedAt in install.json once and is idempotent', async () => {
    const first = (await h.registrar.invoke(IPC.setup.complete)) as { ok: true; data: SetupStatus }
    expect(first.ok).toBe(true)
    expect(first.data.firstRun).toBe(false)
    expect(first.data.completedAt).not.toBeNull()
    expect(JSON.parse(readFileSync(join(h.tmp, 'install.json'), 'utf8'))).toMatchObject({ setupCompletedAt: first.data.completedAt })

    const second = (await h.registrar.invoke(IPC.setup.complete)) as { data: SetupStatus }
    expect(second.data.completedAt).toBe(first.data.completedAt)
    expect(((await h.registrar.invoke(IPC.setup.status)) as { data: SetupStatus }).data.firstRun).toBe(false)
  })
})

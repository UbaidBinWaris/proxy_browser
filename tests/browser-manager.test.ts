/**
 * Browser manager behaviour with fake Playwright browser types, a fake WebKit
 * relay and a real in-memory database for profiles, runs and network entries.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppSettings, BrowserEngine, BrowserEngineInfo, BrowserSession, BrowsersStatus, GeoTarget, IpInfo, LocationEntry, LogEntry, Profile, ProfileInput, ProxyTestResult, TestRun } from '../src/shared/types'
import { BROWSER_ENGINES, BROWSER_ENGINE_FAMILY, BROWSER_ENGINE_KIND, BROWSER_ENGINE_LABELS, DEFAULT_SETTINGS } from '../src/shared/types'
import { AppException } from '../src/main/contracts'
import type {
  BrowserManager,
  BrowserProvisioner,
  Database,
  IpChecker,
  Logger,
  ProfileManager,
  ProxyConnection,
  ProxyManager,
} from '../src/main/contracts'
import { openDatabase } from '../src/main/database/index'
import type { BrowserManagerOptions } from '../src/main/browser/browser-manager'
import { memoryLiveSessionsStore } from '../src/main/sessions/live-sessions-store'
import { DataImpulseProvider } from '../src/main/proxy/providers/dataimpulse'
import { createProxyManager } from '../src/main/proxy/proxy-manager'

// --- Fake Playwright -----------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

interface FakeWorld {
  launches: Array<{ engine: string; options: Record<string, unknown> }>
  browsers: FakeBrowser[]
  /** When set, `launch()` waits for this promise before returning the browser. */
  launchGate: Promise<void> | null
  launchError: Error | null
  gotoStatus: number
  gotoError: Error | null
  /** When true, `goto` never resolves until the page's context is closed. */
  gotoHangs: boolean
  /** When true, `browser.close()` never resolves. */
  closeHangs: boolean
  /** When true, `context.newPage()` never resolves (Vivaldi under automation). */
  newPageHangs: boolean
  relays: Array<{ upstream: ProxyConnection; close: ReturnType<typeof vi.fn>; port: number }>
  /** CDP commands sent through context.newCDPSession (bring-to-front). */
  cdp: Array<{ method: string; params?: unknown }>
  /** Window state reported by Browser.getWindowBounds. */
  windowState: string
  /** Options of every browser.newContext call. */
  contextOptions: Array<Record<string, unknown>>
  /** page.setViewportSize calls (full-screen sizing of Firefox and WebKit windows). */
  viewportSizes: Array<{ width: number; height: number }>
}

const world = vi.hoisted<FakeWorld>(() => ({
  launches: [],
  browsers: [],
  launchGate: null,
  launchError: null,
  gotoStatus: 200,
  gotoError: null,
  gotoHangs: false,
  closeHangs: false,
  newPageHangs: false,
  relays: [],
  cdp: [],
  windowState: 'normal',
  contextOptions: [],
  viewportSizes: [],
}))

class FakePage extends EventEmitter {
  closed = false
  broughtToFront = 0
  currentUrl = 'about:blank'
  readonly frame = { url: (): string => this.currentUrl }
  constructor(private readonly context: FakeContext) {
    super()
  }
  mainFrame(): unknown {
    return this.frame
  }
  url(): string {
    return this.currentUrl
  }
  isClosed(): boolean {
    return this.closed || this.context.closed
  }
  async goto(url: string): Promise<{ status: () => number; statusText: () => string } | null> {
    if (world.gotoError) throw world.gotoError
    if (world.gotoHangs) {
      await new Promise<void>((resolve) => this.context.once('close', () => resolve()))
      throw new Error('page.goto: Target page, context or browser has been closed')
    }
    this.currentUrl = url
    this.emit('framenavigated', this.frame)
    return { status: () => world.gotoStatus, statusText: () => '' }
  }
  locator(selector: string): unknown { return { selector } }
  /** Only used to measure the window frame (outer minus inner size) for full-screen windows. */
  async evaluate(): Promise<{ width: number; height: number }> {
    return { width: 52, height: 137 }
  }
  async setViewportSize(size: { width: number; height: number }): Promise<void> {
    world.viewportSizes.push(size)
  }
  async screenshot(): Promise<void> {
    return undefined
  }
  async bringToFront(): Promise<void> {
    if (this.isClosed()) throw new Error('Target page, context or browser has been closed')
    this.broughtToFront += 1
  }
  /** The user closes this tab/window. */
  userClose(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close', this)
  }
}

class FakeContext extends EventEmitter {
  closed = false
  created: FakePage[] = []
  /** URL patterns routed with context.route (the IP watch blocks every URL on a change). */
  routes: string[] = []
  async route(url: string, _handler: unknown): Promise<void> {
    this.routes.push(url)
  }
  pages(): FakePage[] {
    return this.created.filter((page) => !page.closed)
  }
  async newPage(): Promise<FakePage> {
    if (world.newPageHangs) await new Promise<void>(() => undefined)
    const page = new FakePage(this)
    this.created.push(page)
    return page
  }
  /** A tab the user (or the site) opened. */
  userOpenTab(): FakePage {
    const page = new FakePage(this)
    this.created.push(page)
    this.emit('page', page)
    return page
  }
  async newCDPSession(): Promise<{ send: (method: string, params?: unknown) => Promise<unknown>; detach: () => Promise<void> }> {
    return {
      send: async (method, params) => {
        world.cdp.push({ method, ...(params === undefined ? {} : { params }) })
        if (method === 'Browser.getWindowForTarget') return { windowId: 7 }
        if (method === 'Browser.getWindowBounds') return { bounds: { windowState: world.windowState } }
        return {}
      },
      detach: async () => undefined,
    }
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
}

class FakeBrowser extends EventEmitter {
  contexts: FakeContext[] = []
  closeCalls = 0
  disconnected = false
  readonly engine: string
  constructor(engine: string) {
    super()
    this.engine = engine
  }
  version(): string {
    return `${this.engine}-fake-1.0`
  }
  isConnected(): boolean {
    return !this.disconnected
  }
  async newContext(options: Record<string, unknown> = {}): Promise<FakeContext> {
    world.contextOptions.push(options)
    const context = new FakeContext()
    this.contexts.push(context)
    return context
  }
  async close(): Promise<void> {
    this.closeCalls += 1
    if (world.closeHangs) await new Promise<void>(() => undefined)
    if (this.disconnected) return
    this.disconnected = true
    for (const context of this.contexts) await context.close()
    this.emit('disconnected')
  }
}

function fakeBrowserType(engine: string): { name: () => string; launch: (options: Record<string, unknown>) => Promise<FakeBrowser> } {
  return {
    name: () => engine,
    launch: async (options) => {
      world.launches.push({ engine, options })
      if (world.launchGate) await world.launchGate
      if (world.launchError) throw world.launchError
      const browser = new FakeBrowser(engine)
      world.browsers.push(browser)
      return browser
    },
  }
}

vi.mock('playwright-core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    chromium: fakeBrowserType('chromium'),
    firefox: fakeBrowserType('firefox'),
    webkit: fakeBrowserType('webkit'),
  }
})

vi.mock('../src/main/proxy/local-relay', () => ({
  startProxyRelay: async (upstream: ProxyConnection) => {
    const port = 40_000 + world.relays.length
    const close = vi.fn(async () => undefined)
    world.relays.push({ upstream, close, port })
    return { server: `http://127.0.0.1:${port}`, port, activeConnections: () => 0, close }
  },
}))

// --- Harness --------------------------------------------------------------------

const PASSWORD = 'S3cret!Pass'

const ipInfo: IpInfo = {
  ip: '203.0.113.9',
  country: 'United States',
  countryCode: 'US',
  region: 'Texas',
  city: 'Austin',
  postalCode: '78701',
  isp: 'Example ISP',
  asn: 'AS64500',
  latencyMs: 120,
  provider: 'ip-api',
  checkedAt: '2026-10-03T10:00:00.000Z',
}

const baseInput: ProfileInput = {
  name: 'QA Chromium',
  engine: 'chromium',
  deviceType: 'desktop',
  devicePreset: 'windows-desktop',
  viewportWidth: 1366,
  viewportHeight: 768,
  userAgent: null,
  locale: 'en-US',
  timezone: 'America/New_York',
  proxyMode: 'sticky',
  stickySessionId: 'qa-session-1',
  formUrlOverride: 'https://forms.example.com/qa',
  notes: '',
  proxyPool: 'residential',
  providerId: 'dataimpulse',
  target: null,
  stickyTtlMinutes: null,
  ephemeral: false,
}

const NJ: GeoTarget = { mode: 'state', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: null, zip: null }
const TX: GeoTarget = { mode: 'state', country: 'us', state: 'Texas', stateCode: 'TX', city: null, zip: null }

interface Harness {
  manager: BrowserManager
  db: Database
  logs: Array<{ level: string; message: string; meta?: Record<string, unknown> }>
  sessions: BrowserSession[]
  runs: TestRun[]
  proxyResult: { current: ProxyTestResult }
  installed: { current: boolean }
  settings: AppSettings
  /** Executable paths the fake provisioner reports for installed-kind engines (absent = not installed). */
  executables: Map<BrowserEngine, string>
  /** Insert a real profile row (runs reference profiles by FK). */
  profile: (overrides?: Partial<ProfileInput>) => Profile
  /**
   * Scripted results for the exit-IP watch's lookups (taken in order; when empty the lookup
   * returns the IP verified at launch). An Error entry makes that lookup fail.
   */
  ipLookups: Array<IpInfo | Error>
  /** When set, the fake proxy's launch check reports that the area was widened to this target. */
  widened: { current: GeoTarget | null }
  /** Proxy connections the IP checker was called with (null = direct lookup). */
  lookupCalls: Array<ProxyConnection | null>
}

const SYSTEM_CHROMIUM_PATH = '/usr/bin/chromium'

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
    installMethod: kind === 'bundled' ? 'bundled' : 'download-page',
    installNote: '',
    downloadUrl: kind === 'bundled' ? null : 'https://example.com/download',
    managedInstall: false,
  }
}

interface HarnessOptions {
  /** Replace the fake proxy manager (e.g. with a real one over a scripted IP checker). */
  makeProxy?: (db: Database, logger: Logger) => ProxyManager
  launchTimeoutMs?: number
  manager?: Pick<BrowserManagerOptions, 'engineBusyMessage' | 'liveSessions' | 'findBrowserPid' | 'heartbeatIntervalMs' | 'siteAccess' | 'screenWorkArea' | 'ipWatchIntervalMs' | 'onExitIpChange'>
}

async function buildHarness(closeTimeoutMs: number, webkitLibsDir: string | null = null, options: HarnessOptions = {}): Promise<Harness> {
  const { createBrowserManager } = await import('../src/main/browser/browser-manager')
  const db = openDatabase(':memory:', { defaultScreenshotDir: '/tmp/proxy-qa-test-shots', env: {} })
  const logs: Harness['logs'] = []
  const logger: Logger = {
    info: (_s, message, meta) => void logs.push({ level: 'INFO', message, meta }),
    warn: (_s, message, meta) => void logs.push({ level: 'WARN', message, meta }),
    error: (_s, message, meta) => void logs.push({ level: 'ERROR', message, meta }),
    log: (level, _s, message, meta) => void logs.push({ level, message, meta }),
    onEntry: () => () => undefined,
    query: (): LogEntry[] => [],
    clear: () => undefined,
    registerSecret: () => undefined,
  }
  const proxyResult = { current: { status: 'working', sessionId: 'qa-session-1', ip: ipInfo, error: null } as ProxyTestResult }
  const installed = { current: true }
  const widened: { current: GeoTarget | null } = { current: null }

  const profiles: ProfileManager = {
    list: () => db.profiles.list(),
    get: (id) => {
      const found = db.profiles.get(id)
      if (!found) throw new AppException('NOT_FOUND', 'missing')
      return found
    },
    create: (input) => db.profiles.create(input as ProfileInput),
    update: (id, input) => db.profiles.update(id, input as ProfileInput),
    duplicate: (id) => profiles.get(id),
    delete: (id) => db.profiles.delete(id),
    presets: () => [],
    validateForLaunch: (profile) => {
      if (profile.proxyMode === 'sticky' && !profile.stickySessionId) {
        throw new AppException('INVALID_PROFILE', 'Sticky proxy mode requires a session ID.')
      }
    },
  }
  const fakeProxy: ProxyManager = {
    providers: () => [],
    getConfigStatus: () => ({
      configured: true,
      pools: [
        { pool: 'residential', configured: true, host: 'gw', port: 823, usernameMasked: 'ab****yz', source: 'vault' },
        { pool: 'mobile', configured: false, host: null, port: null, usernameMasked: null, source: 'none' },
      ],
      provider: 'dataimpulse',
      host: 'gw',
      port: 823,
      usernameMasked: 'ab****yz',
      missing: [],
      source: 'vault',
    }),
    testCredentials: async () => proxyResult.current,
    resolveForProfile: (profile) => {
      if (profile.proxyMode === 'none') return null
      const params = [...(profile.target?.state ? ['cr.us', `state.${profile.target.state.toLowerCase().replace(/\s+/g, '')}`] : []), `sessid.${profile.stickySessionId ?? 'rotating'}`]
      return {
        server: 'http://gw.example.com:823',
        username: `login__${params.join(';')}`,
        password: PASSWORD,
        pool: profile.proxyPool,
        sessionId: profile.stickySessionId,
        target: profile.target,
        targetingString: params.join(';'),
      }
    },
    compareTarget: (target, ip) => (!target || !ip ? 'unknown' : target.state === ip.region ? 'match' : 'mismatch'),
    testConnection: async () => proxyResult.current,
    verifyForLaunch: async (profile) => {
      const result = proxyResult.current
      const targetMatch = profile.target && result.ip ? fakeProxy.compareTarget(profile.target, result.ip) : null
      const sessionId = profile.proxyMode === 'sticky' ? profile.stickySessionId : null
      if (widened.current) {
        const wider = widened.current
        return { result, targetMatch: 'match', attempts: 3, maxAttempts: 3, sessionId: `${sessionId}-r3`, warning: `No exit IPs available in the ZIP right now; connected via ${wider.state} instead.`, widenedTarget: wider }
      }
      return { result, targetMatch, attempts: 1, maxAttempts: 1, sessionId, warning: null }
    },
    getCurrentIp: async () => ipInfo,
    rotateSession: async () => {
      throw new Error('not used')
    },
    listSessions: () => [],
    onSessionUpdate: () => () => undefined,
  }
  const proxy = options.makeProxy ? options.makeProxy(db, logger) : fakeProxy
  const ipLookups: Array<IpInfo | Error> = []
  const lookupCalls: Array<ProxyConnection | null> = []
  const ipChecker: IpChecker = {
    lookup: async (connection) => {
      lookupCalls.push(connection)
      // Direct (no proxy) lookups keep their historical fixture IP.
      if (!connection) return { ...ipInfo, ip: '198.51.100.4' }
      const next = ipLookups.shift()
      if (next instanceof Error) throw next
      return next ?? proxyResult.current.ip ?? ipInfo
    },
  }
  const executables = new Map<BrowserEngine, string>([['system-chromium', SYSTEM_CHROMIUM_PATH]])
  const engines = async (): Promise<BrowserEngineInfo[]> => BROWSER_ENGINES.map((engine) => engineInfo(engine, executables.get(engine) ?? null))
  const status = async (): Promise<BrowsersStatus> => ({
    browsersPath: '/tmp/browsers',
    chromium: true,
    firefox: true,
    webkit: true,
    playwrightVersion: '1.63.0',
    source: 'provisioned',
    installable: true,
    engines: await engines(),
  })
  const resolveEngine = async (engine: BrowserEngine): Promise<BrowserEngineInfo> => {
    const info = engineInfo(engine, executables.get(engine) ?? null)
    if (!installed.current || !info.available) throw new AppException('BROWSER_MISSING', `${info.label}: ${info.note}`)
    return info
  }
  const provisioner: BrowserProvisioner = {
    status,
    install: status,
    installEngine: status,
    uninstallEngine: status,
    installAllMissing: async () => ({ status: await status(), installed: [], failed: [] }),
    watchForInstall: () => undefined,
    onWatchUpdate: () => () => undefined,
    dispose: () => undefined,
    downloadUrl: () => null,
    browsersPath: () => '/tmp/browsers',
    engines,
    redetect: engines,
    resolveEngine,
    assertInstalled: async (engine) => {
      await resolveEngine(engine)
    },
  }
  // Most cases open several sessions at once; the single-session rule has its own case.
  const settings: AppSettings = { ...DEFAULT_SETTINGS, screenshotDir: '/tmp/proxy-qa-test-shots', networkInspectorEnabled: true, singleSessionMode: false }

  const manager = createBrowserManager({
    profiles,
    proxy,
    ipChecker,
    provisioner,
    runs: db.testRuns,
    network: db.network,
    getSettings: () => settings,
    logger,
    closeTimeoutMs,
    webkitLibsDir,
    // The exit-IP watch has its own cases; elsewhere it would only add background lookups.
    ipWatchIntervalMs: 0,
    ...(options.launchTimeoutMs !== undefined ? { launchTimeoutMs: options.launchTimeoutMs } : {}),
    ...options.manager,
  })
  const sessions: BrowserSession[] = []
  const runs: TestRun[] = []
  manager.onSessionUpdate((s) => sessions.push(s))
  manager.onRunUpdate((r) => runs.push(r))
  return {
    manager,
    db,
    logs,
    sessions,
    runs,
    proxyResult,
    installed,
    settings,
    executables,
    profile: (overrides = {}) => db.profiles.create({ ...baseInput, ...overrides }),
    ipLookups,
    lookupCalls,
    widened,
  }
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Status sequence for one session with consecutive repeats collapsed (currentUrl/ip updates re-emit the same status). */
const statusesOf = (sessions: BrowserSession[], id: string): string[] =>
  sessions
    .filter((s) => s.id === id)
    .map((s) => s.status)
    .filter((status, index, all) => index === 0 || all[index - 1] !== status)

describe('createBrowserManager', () => {
  let h: Harness

  beforeEach(async () => {
    world.launches.length = 0
    world.browsers.length = 0
    world.relays.length = 0
    world.launchGate = null
    world.launchError = null
    world.gotoStatus = 200
    world.gotoError = null
    world.gotoHangs = false
    world.closeHangs = false
    world.newPageHangs = false
    world.cdp.length = 0
    world.windowState = 'normal'
    world.contextOptions.length = 0
    world.viewportSizes.length = 0
    h = await buildHarness(200)
  })

  afterEach(() => {
    h.db.close()
  })

  it('returns a starting session immediately, then verifies the proxy, launches and opens in the background', async () => {
    const profile = h.profile()
    const session = await h.manager.launch(profile)
    expect(session.status).toBe('starting')
    expect(session.profileId).toBe(profile.id)
    expect(session.proxySessionId).toBe('qa-session-1')
    expect(session.ip).toBeNull()
    expect(session).toMatchObject({ devicePreset: 'windows-desktop', proxyPool: 'residential', target: null, targetingString: 'sessid.qa-session-1', targetMatch: null })

    const runAtLaunch = h.db.testRuns.get(session.runId)
    expect(runAtLaunch).toMatchObject({
      status: 'running',
      profileId: profile.id,
      proxySessionId: 'qa-session-1',
      publicIp: null,
      formUrl: 'https://forms.example.com/qa',
      proxyPool: 'residential',
      target: null,
      targetingString: 'sessid.qa-session-1',
      targetMatch: null,
    })
    // Nothing beyond the synchronous part has happened yet.
    expect(world.launches).toHaveLength(0)

    await waitFor(() => h.manager.get(session.id)?.status === 'open', 'session to open')
    expect(statusesOf(h.sessions, session.id)).toEqual(['starting', 'verifying-proxy', 'launching', 'open'])

    const open = h.manager.get(session.id)
    expect(open?.ip).toEqual(ipInfo)
    expect(open?.currentUrl).toBe('https://forms.example.com/qa')
    const run = h.db.testRuns.get(session.runId)
    expect(run).toMatchObject({
      status: 'running',
      publicIp: '203.0.113.9',
      country: 'United States',
      region: 'Texas',
      city: 'Austin',
      httpStatus: 200,
      finalUrl: 'https://forms.example.com/qa',
      endedAt: null,
    })
    // The IP reached the session and the run before the browser was launched.
    const launchingIndex = h.sessions.findIndex((s) => s.id === session.id && s.status === 'launching')
    const ipSessionIndex = h.sessions.findIndex((s) => s.id === session.id && s.ip !== null)
    expect(ipSessionIndex).toBeGreaterThan(-1)
    expect(ipSessionIndex).toBeLessThan(launchingIndex)
    expect(h.runs.some((r) => r.publicIp === '203.0.113.9')).toBe(true)

    expect(world.launches[0]?.options).toMatchObject({
      headless: false,
      proxy: { server: 'http://gw.example.com:823', username: 'login__sessid.qa-session-1', password: PASSWORD },
    })

    await h.manager.close(session.id)
    expect(h.db.testRuns.get(session.runId)).toMatchObject({ status: 'success', errorMessage: null })
    expect(h.db.testRuns.get(session.runId)?.endedAt).not.toBeNull()
    expect(h.manager.get(session.id)).toBeNull()
    expect(h.manager.listActive()).toEqual([])
  })

  it('records pool, target, targeting string and the verified-vs-requested match on session and run', async () => {
    const texas = await h.manager.launch(h.profile({ name: 'Texas', stickySessionId: 'tx-1', target: TX }))
    expect(texas).toMatchObject({ proxyPool: 'residential', target: TX, targetingString: 'cr.us;state.texas;sessid.tx-1', targetMatch: null })
    await waitFor(() => h.manager.get(texas.id)?.status === 'open', 'texas open')
    expect(h.manager.get(texas.id)?.targetMatch).toBe('match')
    expect(h.db.testRuns.get(texas.runId)).toMatchObject({ proxyPool: 'residential', target: TX, targetingString: 'cr.us;state.texas;sessid.tx-1', targetMatch: 'match', region: 'Texas' })
    expect(world.launches[0]?.options).toMatchObject({ proxy: { username: 'login__cr.us;state.texas;sessid.tx-1' } })
    await h.manager.close(texas.id)

    const jersey = await h.manager.launch(h.profile({ name: 'Jersey', stickySessionId: 'nj-1', target: NJ, proxyPool: 'mobile' }))
    await waitFor(() => h.manager.get(jersey.id)?.status === 'open', 'jersey open')
    expect(h.manager.get(jersey.id)).toMatchObject({ proxyPool: 'mobile', targetMatch: 'mismatch' })
    expect(h.db.testRuns.get(jersey.runId)).toMatchObject({ proxyPool: 'mobile', targetMatch: 'mismatch' })
    expect(h.logs.some((l) => l.level === 'WARN' && l.message.includes('is a mismatch for the requested target'))).toBe(true)
    await h.manager.close(jersey.id)

    // Without a target nothing is compared; a direct session has no pool at all.
    const direct = await h.manager.launch(h.profile({ name: 'Direct', proxyMode: 'none', stickySessionId: null, target: NJ }))
    await waitFor(() => h.manager.get(direct.id)?.status === 'open', 'direct open')
    expect(h.manager.get(direct.id)).toMatchObject({ proxyPool: null, target: null, targetingString: null, targetMatch: null })
    expect(h.db.testRuns.get(direct.runId)).toMatchObject({ proxyPool: null, targetMatch: null })
    await h.manager.close(direct.id)
    expect(JSON.stringify(h.logs)).not.toContain(PASSWORD)
  })

  describe('exit-IP watch', () => {
    const OKLAHOMA_A: IpInfo = { ...ipInfo, ip: '203.0.113.74', region: 'Oklahoma', city: 'Shawnee', postalCode: '74801' }
    const OKLAHOMA_B: IpInfo = { ...ipInfo, ip: '198.51.100.57', region: 'Oklahoma', city: 'Duncan', postalCode: '73533' }
    const OK: GeoTarget = { mode: 'state', country: 'us', state: 'Oklahoma', stateCode: 'OK', city: null, zip: null }

    async function watched(interval = 15, onExitIpChange?: BrowserManagerOptions['onExitIpChange']): Promise<Harness> {
      const w = await buildHarness(200, null, { manager: { ipWatchIntervalMs: interval, ...(onExitIpChange ? { onExitIpChange } : {}) } })
      w.proxyResult.current = { status: 'working', sessionId: 'ok-1', ip: OKLAHOMA_A, error: null }
      return w
    }

    it('on an IP switch blocks the page, fails the run, alerts and closes the browser (the TrustedForm case)', async () => {
      const changes: Array<{ to: string; detail: string }> = []
      const w = await watched(15, (session, change) => changes.push({ to: change.toIp, detail: session.statusDetail }))
      try {
        // First re-check (right after the page opens): unchanged. Second: the provider swapped the IP.
        w.ipLookups.push(OKLAHOMA_A, OKLAHOMA_B)
        const session = await w.manager.launch(w.profile({ name: 'OK sticky', stickySessionId: 'ok-1', target: OK }))
        await waitFor(() => w.sessions.some((s) => s.id === session.id && s.status === 'closed'), 'stopped and closed', 3_000)
        const changed = w.sessions.find((s) => s.id === session.id && s.exitIpWatch === 'changed')!
        expect(changed.ip?.ip).toBe('203.0.113.74')
        expect(changed.currentExitIp?.ip).toBe('198.51.100.57')
        expect(changed.ipChanges).toEqual([expect.objectContaining({ fromIp: '203.0.113.74', toIp: '198.51.100.57', city: 'Duncan', region: 'Oklahoma', postalCode: '73533' })])
        expect(changed.error).toMatchObject({ code: 'IP_CHANGED' })
        expect(changed.statusDetail).toContain('Stopped: the IP changed from 203.0.113.74 (Shawnee')
        expect(changed.statusDetail).toContain('198.51.100.57 (Duncan')
        // Traffic was cut before the browser closed, and the browser is gone.
        const browser = world.browsers[0]!
        expect(browser.contexts[0]?.routes).toContain('**/*')
        expect(browser.disconnected).toBe(true)
        expect(w.manager.get(session.id)).toBeNull()
        const run = w.db.testRuns.get(session.runId)!
        expect(run.status).toBe('failed')
        expect(run.errorMessage).toContain('Stopped: the IP changed')
        expect(run.ipChanges).toEqual(changed.ipChanges)
        expect(changes).toEqual([expect.objectContaining({ to: '198.51.100.57' })])
        // The checks used exactly the browser's proxy credentials (same sticky session ⇒ same exit).
        const launchUsername = (world.launches[0]?.options.proxy as { username?: string } | undefined)?.username
        const watchCalls = w.lookupCalls.filter((c): c is ProxyConnection => c !== null)
        expect(watchCalls.length).toBe(2)
        for (const call of watchCalls) expect(call.username).toBe(launchUsername)
        // No more checks after the stop.
        await new Promise((resolve) => setTimeout(resolve, 60))
        expect(w.lookupCalls.filter((c) => c !== null).length).toBe(2)
        expect(w.logs.some((l) => l.level === 'WARN' && l.message.includes('exit IP changed 203.0.113.74 → 198.51.100.57'))).toBe(true)
        expect(JSON.stringify(w.logs)).not.toContain(PASSWORD)
      } finally {
        w.db.close()
      }
    })

    it('stays "watching" while the IP holds, and stops checking once the session closes', async () => {
      const w = await watched(10)
      try {
        const session = await w.manager.launch(w.profile({ name: 'Stable', stickySessionId: 'ok-1', target: OK }))
        await waitFor(() => (w.manager.get(session.id)?.lastIpCheckAt ?? null) !== null, 'first re-check')
        await waitFor(() => w.lookupCalls.filter(Boolean).length >= 3, 'several re-checks')
        expect(w.manager.get(session.id)).toMatchObject({ exitIpWatch: 'watching', ipChanges: [] })
        await w.manager.close(session.id)
        const after = w.lookupCalls.length
        await new Promise((resolve) => setTimeout(resolve, 60))
        expect(w.lookupCalls.length).toBe(after)
        expect(w.db.testRuns.get(session.runId)?.ipChanges).toEqual([])
      } finally {
        w.db.close()
      }
    })

    it('marks the IP unverified after three failed checks and recovers on the next success', async () => {
      const w = await watched(10)
      try {
        w.ipLookups.push(OKLAHOMA_A, new Error('timeout'), new Error('timeout'), new Error('timeout'), OKLAHOMA_A)
        const session = await w.manager.launch(w.profile({ name: 'Flaky', stickySessionId: 'ok-1', target: OK }))
        await waitFor(() => w.sessions.some((s) => s.id === session.id && s.exitIpWatch === 'unverified'), 'unverified')
        await waitFor(() => w.manager.get(session.id)?.exitIpWatch === 'watching', 'recovered')
        expect(w.manager.get(session.id)?.ipChanges).toEqual([])
        await w.manager.close(session.id)
      } finally {
        w.db.close()
      }
    })

    it('does not watch rotating, direct or disabled sessions', async () => {
      const w = await watched(10)
      try {
        const rotating = await w.manager.launch(w.profile({ name: 'Rotating', proxyMode: 'rotating', stickySessionId: null, target: OK }))
        await waitFor(() => w.manager.get(rotating.id)?.exitIpWatch === 'rotating', 'rotating marked')
        await w.manager.close(rotating.id)

        const direct = await w.manager.launch(w.profile({ name: 'Direct', proxyMode: 'none', stickySessionId: null }))
        await waitFor(() => w.manager.get(direct.id)?.status === 'open', 'direct open')
        expect(w.manager.get(direct.id)?.exitIpWatch).toBe('off')
        await w.manager.close(direct.id)

        w.settings.watchExitIp = false
        const off = await w.manager.launch(w.profile({ name: 'Off', stickySessionId: 'ok-1', target: OK }))
        await waitFor(() => w.manager.get(off.id)?.status === 'open', 'off open')
        await new Promise((resolve) => setTimeout(resolve, 40))
        expect(w.manager.get(off.id)?.exitIpWatch).toBe('off')
        await w.manager.close(off.id)
        // Only direct launches looked up an IP; nothing re-checked a proxied session.
        expect(w.lookupCalls.filter((c) => c !== null)).toEqual([])
      } finally {
        w.db.close()
      }
    })
  })

  it('singleSessionMode: a second session for another profile is refused with SESSION_LIMIT until the first closes', async () => {
    h.settings.singleSessionMode = true
    const first = await h.manager.launch(h.profile())
    await expect(h.manager.launch(h.profile({ name: 'Two', stickySessionId: 'two' }))).rejects.toMatchObject({
      code: 'SESSION_LIMIT',
      message: 'Another browser session is already open. Close it first or enable "replace active session".',
    })
    expect(h.db.testRuns.list()).toHaveLength(1)
    await waitFor(() => h.manager.get(first.id)?.status === 'open', 'open')
    await expect(h.manager.launch(h.profile({ name: 'Three', stickySessionId: 'three' }))).rejects.toMatchObject({ code: 'SESSION_LIMIT' })
    await h.manager.close(first.id)

    // A failed attempt without a window never blocks the next launch.
    h.proxyResult.current = { status: 'failed', sessionId: 'x', ip: null, error: { code: 'PROXY_DEAD', message: 'dead' } }
    const failed = await h.manager.launch(h.profile({ name: 'Failing', stickySessionId: 'fail' }))
    await waitFor(() => h.manager.get(failed.id)?.status === 'error', 'error')
    h.proxyResult.current = { status: 'working', sessionId: 'qa-session-1', ip: ipInfo, error: null }
    const next = await h.manager.launch(h.profile({ name: 'Next', stickySessionId: 'next' }))
    await waitFor(() => h.manager.get(next.id)?.status === 'open', 'next open')
    await h.manager.close(next.id)
    await h.manager.close(failed.id)

    h.settings.singleSessionMode = false
    const a = await h.manager.launch(h.profile({ name: 'A', stickySessionId: 'a' }))
    const b = await h.manager.launch(h.profile({ name: 'B', stickySessionId: 'b' }))
    await waitFor(() => h.manager.get(a.id)?.status === 'open' && h.manager.get(b.id)?.status === 'open', 'both open')
    await h.manager.closeAll()
  })

  it('opens desktop presets maximized at the screen size when the simple device picker is on', async () => {
    h.db.close()
    h = await buildHarness(200, null, { manager: { screenWorkArea: () => ({ width: 1920, height: 1048 }) } })
    h.settings.simpleDevices = true
    const chromium = await h.manager.launch(h.profile({ name: 'Full screen', proxyMode: 'none', stickySessionId: null }))
    await waitFor(() => h.manager.get(chromium.id)?.status === 'open', 'open')
    expect(world.launches[0]?.options.args).toEqual([`--proxy-qa-session=${chromium.id}`, '--start-maximized'])
    expect(world.contextOptions[0]).toMatchObject({ viewport: null, locale: 'en-US', timezoneId: 'America/New_York' })
    expect(world.contextOptions[0]).not.toHaveProperty('deviceScaleFactor')
    expect(world.contextOptions[0]).not.toHaveProperty('isMobile')
    // Chromium maximizes itself: its window is never resized from the page.
    expect(world.viewportSizes).toEqual([])
    await h.manager.close(chromium.id)

    // Firefox ignores window flags: the content area is the work area minus the measured frame (52 × 137 here).
    const firefox = await h.manager.launch(h.profile({ name: 'FF full screen', engine: 'firefox', proxyMode: 'none', stickySessionId: null }))
    await waitFor(() => h.manager.get(firefox.id)?.status === 'open' && world.viewportSizes.length > 0, 'ff sized')
    expect(world.launches.at(-1)?.options.args).toBeUndefined()
    expect(world.contextOptions.at(-1)).toMatchObject({ viewport: null })
    expect(world.viewportSizes).toEqual([{ width: 1868, height: 911 }])
    await h.manager.close(firefox.id)
  })

  it('keeps the preset viewport for phones, and for every preset when the simple device picker is off', async () => {
    h.settings.simpleDevices = true
    const phone = await h.manager.launch(h.profile({ name: 'Phone', deviceType: 'mobile', devicePreset: 'iphone-15', viewportWidth: 393, viewportHeight: 659, proxyMode: 'none', stickySessionId: null }))
    await waitFor(() => h.manager.get(phone.id)?.status === 'open', 'phone open')
    expect(world.launches[0]?.options.args).toEqual([`--proxy-qa-session=${phone.id}`])
    expect(world.contextOptions[0]).toMatchObject({ viewport: { width: 393, height: 659 }, isMobile: true })
    await h.manager.close(phone.id)

    h.settings.simpleDevices = false
    const desktop = await h.manager.launch(h.profile({ name: 'Fixed desktop', proxyMode: 'none', stickySessionId: null }))
    await waitFor(() => h.manager.get(desktop.id)?.status === 'open', 'desktop open')
    expect(world.launches.at(-1)?.options.args).toEqual([`--proxy-qa-session=${desktop.id}`])
    expect(world.contextOptions.at(-1)).toMatchObject({ viewport: { width: 1366, height: 768 } })
    await h.manager.close(desktop.id)
  })

  it('appends settings.extraChromiumArgs to every Chromium-family launch and logs them', async () => {
    h.settings.extraChromiumArgs = ['--disable-gpu', '--lang=en-US']
    const chromium = await h.manager.launch(h.profile({ name: 'Flags', proxyMode: 'none', stickySessionId: null }))
    await waitFor(() => h.manager.get(chromium.id)?.status === 'open', 'open')
    // The user's flags, then the session marker that identifies this browser process.
    expect(world.launches[0]?.options.args).toEqual(['--disable-gpu', '--lang=en-US', `--proxy-qa-session=${chromium.id}`])
    expect(h.logs.some((l) => l.message.includes('extra Chromium args --disable-gpu --lang=en-US'))).toBe(true)
    await h.manager.close(chromium.id)

    // Installed Chromium-family browsers get the same flags.
    h.executables.set('brave', '/opt/brave.com/brave/brave')
    const brave = await h.manager.launch(h.profile({ name: 'Brave flags', engine: 'brave', proxyMode: 'none', stickySessionId: null }))
    await waitFor(() => h.manager.get(brave.id)?.status === 'open', 'brave open')
    expect(world.launches[1]?.options).toMatchObject({ executablePath: '/opt/brave.com/brave/brave', args: ['--disable-gpu', '--lang=en-US', `--proxy-qa-session=${brave.id}`] })
    await h.manager.close(brave.id)

    const firefox = await h.manager.launch(h.profile({ name: 'FF flags', engine: 'firefox', proxyMode: 'none', stickySessionId: null }))
    await waitFor(() => h.manager.get(firefox.id)?.status === 'open', 'ff open')
    expect(world.launches.at(-1)?.engine).toBe('firefox')
    expect(world.launches.at(-1)?.options.args).toBeUndefined()
    await h.manager.close(firefox.id)
  })

  it('fails fast with BROWSER_LAUNCH_FAILED when the browser hangs at page creation, and closes it', async () => {
    vi.useFakeTimers()
    try {
      world.newPageHangs = true
      const timed = await buildHarness(200, null, { launchTimeoutMs: 45_000 })
      try {
        timed.executables.set('vivaldi', '/opt/vivaldi/vivaldi-bin')
        const session = await timed.manager.launch(timed.profile({ name: 'Vivaldi', engine: 'vivaldi', proxyMode: 'none', stickySessionId: null }))
        // Let the pipeline reach the hung newPage(), then confirm nothing failed early.
        await vi.advanceTimersByTimeAsync(44_000)
        expect(timed.manager.get(session.id)?.status).toBe('launching')
        expect(world.browsers).toHaveLength(1)

        await vi.advanceTimersByTimeAsync(1_000)
        for (let i = 0; i < 50 && timed.manager.get(session.id)?.status !== 'error'; i += 1) await vi.advanceTimersByTimeAsync(1)

        const failed = timed.manager.get(session.id)
        expect(failed?.status).toBe('error')
        expect(failed?.error).toMatchObject({
          code: 'BROWSER_LAUNCH_FAILED',
          message: 'Vivaldi did not finish starting within 45 s. This browser may not support automation; choose another engine.',
        })
        // The hung browser was closed, the run is final and Playwright's own launch timeout sits after ours.
        expect(world.browsers[0]?.closeCalls).toBe(1)
        expect(timed.db.testRuns.get(session.runId)).toMatchObject({ status: 'failed' })
        expect(timed.db.testRuns.get(session.runId)?.endedAt).not.toBeNull()
        expect(world.launches[0]?.options.timeout).toBeGreaterThan(45_000)
        expect(timed.logs.some((l) => l.level === 'WARN' && l.message.includes('stuck at page creation'))).toBe(true)

        // A failed attempt without a window is dismissable and does not block the next launch.
        await timed.manager.close(session.id)
        expect(timed.manager.get(session.id)).toBeNull()
      } finally {
        timed.db.close()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('launchTimeoutMessage names the browser without its "(installed)" suffix', async () => {
    const { launchTimeoutMessage } = await import('../src/main/browser/browser-manager')
    expect(launchTimeoutMessage('Vivaldi (installed)', 45_000)).toBe('Vivaldi did not finish starting within 45 s. This browser may not support automation; choose another engine.')
    expect(launchTimeoutMessage('Chromium', 30_000)).toMatch(/^Chromium did not finish starting within 30 s./)
  })

  it('rejects a second launch while the profile has a live session', async () => {
    const profile = h.profile()
    const first = await h.manager.launch(profile)
    await expect(h.manager.launch(profile)).rejects.toMatchObject({
      code: 'INVALID_PROFILE',
      message: 'This profile already has an open browser session. Close it first.',
    })
    await waitFor(() => h.manager.get(first.id)?.status === 'open', 'open')
    await expect(h.manager.launch(profile)).rejects.toMatchObject({ code: 'INVALID_PROFILE' })
    expect(h.db.testRuns.list()).toHaveLength(1)

    await h.manager.close(first.id)
    const again = await h.manager.launch(profile)
    expect(again.id).not.toBe(first.id)
    await waitFor(() => h.manager.get(again.id)?.status === 'open', 'open again')
    await h.manager.close(again.id)
  })

  it('routes site access tokens into every manual context (bundled, installed and WebKit relay) and records only the evidence line', async () => {
    const contexts: unknown[] = []
    const siteAccess = {
      attach: vi.fn(async (context: unknown, onNote?: (note: string) => void) => {
        contexts.push(context)
        onNote?.('site access token "Staging" applied to https://forms.example.com')
      }),
    }
    h.db.close()
    h = await buildHarness(200, null, { manager: { siteAccess } })
    for (const [name, engine] of [['QA Chromium', 'chromium'], ['QA System Chromium', 'system-chromium'], ['QA WebKit', 'webkit']] as const) {
      const session = await h.manager.launch(h.profile({ name, engine, stickySessionId: `sa-${engine}` }))
      await waitFor(() => h.manager.get(session.id)?.status === 'open', `${engine} open`)
      const line = h.logs.find((l) => l.message.includes(`${name} `) && l.message.includes('site access token "Staging" applied to https://forms.example.com'))
      expect(line?.level).toBe('INFO')
      expect(line?.meta).toMatchObject({ sessionId: session.id, runId: session.runId })
      await h.manager.close(session.id)
    }
    expect(siteAccess.attach).toHaveBeenCalledTimes(3)
    expect(new Set(contexts).size).toBe(3)
  })

  it('launches WebKit through the local auth relay and closes the relay with the session', async () => {
    const profile = h.profile({ name: 'QA WebKit', engine: 'webkit', stickySessionId: 'wk-1' })
    const session = await h.manager.launch(profile)
    await waitFor(() => h.manager.get(session.id)?.status === 'open', 'webkit open')

    expect(world.relays).toHaveLength(1)
    expect(world.relays[0]?.upstream).toMatchObject({ server: 'http://gw.example.com:823', username: 'login__sessid.wk-1', password: PASSWORD })
    const launch = world.launches[0]
    expect(launch?.engine).toBe('webkit')
    expect(launch?.options.proxy).toEqual({ server: 'http://127.0.0.1:40000' })
    expect(h.logs.some((l) => l.level === 'INFO' && l.message.includes('WebKit session using local auth relay'))).toBe(true)
    expect(JSON.stringify(h.logs)).not.toContain(PASSWORD)

    await h.manager.close(session.id)
    expect(world.relays[0]?.close).toHaveBeenCalledTimes(1)
    expect(h.db.testRuns.get(session.runId)?.status).toBe('success')
  })

  it('prepends the bundled host libraries to LD_LIBRARY_PATH for WebKit launches only', async () => {
    const libsDir = '/opt/app/resources/webkit-libs'
    const bundled = await buildHarness(200, libsDir)
    try {
      const wk = await bundled.manager.launch(bundled.profile({ name: 'QA WebKit libs', engine: 'webkit', proxyMode: 'none', stickySessionId: null }))
      await waitFor(() => bundled.manager.get(wk.id)?.status === 'open', 'webkit open')
      const env = world.launches[0]?.options.env as Record<string, string> | undefined
      expect(env).toBeDefined()
      expect(env?.LD_LIBRARY_PATH?.split(':')[0]).toBe(libsDir)
      // The parent environment is carried over, not replaced.
      expect(env?.PATH).toBe(process.env.PATH)
      expect(bundled.logs.some((l) => l.level === 'INFO' && l.message.includes(`WebKit using bundled host libraries from ${libsDir}`))).toBe(true)
      await bundled.manager.close(wk.id)

      const cr = await bundled.manager.launch(bundled.profile({ name: 'QA Chromium libs', engine: 'chromium', proxyMode: 'none', stickySessionId: null }))
      await waitFor(() => bundled.manager.get(cr.id)?.status === 'open', 'chromium open')
      expect(world.launches[1]?.engine).toBe('chromium')
      expect(world.launches[1]?.options.env).toBeUndefined()
      await bundled.manager.close(cr.id)
    } finally {
      bundled.db.close()
    }

    // Default harness (no libs dir): WebKit is launched with Playwright's default environment.
    world.launches.length = 0
    const wk = await h.manager.launch(h.profile({ name: 'QA WebKit plain', engine: 'webkit', proxyMode: 'none', stickySessionId: null }))
    await waitFor(() => h.manager.get(wk.id)?.status === 'open', 'webkit plain open')
    expect(world.launches[0]?.options.env).toBeUndefined()
    await h.manager.close(wk.id)
  })

  it('does not use the relay for Chromium or Firefox', async () => {
    const ff = await h.manager.launch(h.profile({ name: 'QA Firefox', engine: 'firefox', stickySessionId: 'ff-1' }))
    await waitFor(() => h.manager.get(ff.id)?.status === 'open', 'firefox open')
    expect(world.relays).toHaveLength(0)
    expect(world.launches[0]?.options.proxy).toMatchObject({ username: 'login__sessid.ff-1', password: PASSWORD })
    await h.manager.close(ff.id)
  })

  it('fails the run when proxy verification fails and leaves a dismissable error session that does not block a relaunch', async () => {
    h.proxyResult.current = {
      status: 'failed',
      sessionId: 'qa-session-1',
      ip: null,
      error: { code: 'PROXY_AUTH_FAILED', message: 'Proxy rejected the credentials (HTTP 407).', detail: 'HTTP 407' },
    }
    const profile = h.profile()
    const session = await h.manager.launch(profile)
    await waitFor(() => h.manager.get(session.id)?.status === 'error', 'error')

    const errored = h.manager.get(session.id)
    expect(errored?.error).toMatchObject({ code: 'PROXY_AUTH_FAILED' })
    expect(errored?.statusDetail).toBe('Proxy rejected the credentials (HTTP 407).')
    const run = h.db.testRuns.get(session.runId)
    expect(run?.status).toBe('failed')
    expect(run?.errorMessage).toBe('Proxy rejected the credentials (HTTP 407).')
    expect(run?.endedAt).not.toBeNull()
    expect(world.launches).toHaveLength(0)
    expect(h.manager.listActive().map((s) => s.id)).toEqual([session.id])

    // A failed attempt must not block retrying the same profile.
    h.proxyResult.current = { status: 'working', sessionId: 'qa-session-1', ip: ipInfo, error: null }
    const retry = await h.manager.launch(profile)
    await waitFor(() => h.manager.get(retry.id)?.status === 'open', 'retry open')
    await h.manager.close(retry.id)

    // Dismissing the failed one closes it without touching the already-final run.
    await h.manager.close(session.id)
    expect(h.manager.get(session.id)).toBeNull()
    expect(h.db.testRuns.get(session.runId)?.status).toBe('failed')
    await expect(h.manager.close(session.id)).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
  })

  it('marks HTTP >= 400 as SITE_HTTP_ERROR while keeping the window open for inspection', async () => {
    world.gotoStatus = 503
    const profile = h.profile()
    const session = await h.manager.launch(profile)
    await waitFor(() => h.manager.get(session.id)?.status === 'error', 'error')

    const errored = h.manager.get(session.id)
    expect(errored?.error).toEqual({
      code: 'SITE_HTTP_ERROR',
      message: 'The form URL responded with HTTP 503.',
      detail: 'https://forms.example.com/qa → HTTP 503',
    })
    const run = h.db.testRuns.get(session.runId)
    expect(run).toMatchObject({ status: 'failed', errorMessage: 'The form URL responded with HTTP 503.', httpStatus: 503, endedAt: null })
    // Browser still open: screenshots remain possible and the session blocks a relaunch.
    expect(world.browsers[0]?.disconnected).toBe(false)
    await expect(h.manager.launch(profile)).rejects.toMatchObject({ code: 'INVALID_PROFILE' })

    await h.manager.close(session.id)
    expect(world.browsers[0]?.disconnected).toBe(true)
    expect(h.db.testRuns.get(session.runId)).toMatchObject({ status: 'failed', errorMessage: 'The form URL responded with HTTP 503.' })
    expect(h.db.testRuns.get(session.runId)?.endedAt).not.toBeNull()
  })

  it('keeps the window open after a navigation failure and finalises the run when it closes', async () => {
    world.gotoError = new Error('page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://forms.example.com/qa')
    // The re-check through the same proxy session fails too: the proxy really is the problem.
    h.ipLookups.push(new Error('tunnel failed'))
    const session = await h.manager.launch(h.profile())
    await waitFor(() => h.manager.get(session.id)?.status === 'error', 'error')
    expect(h.manager.get(session.id)?.error?.code).toBe('PROXY_DEAD')
    expect(h.db.testRuns.get(session.runId)).toMatchObject({ status: 'failed', endedAt: null })

    // The user closes the browser window themselves.
    await world.browsers[0]?.close()
    await waitFor(() => h.manager.get(session.id) === null, 'eviction')
    const run = h.db.testRuns.get(session.runId)
    expect(run?.status).toBe('failed')
    expect(run?.endedAt).not.toBeNull()
    expect(h.sessions.filter((s) => s.id === session.id).at(-1)?.status).toBe('closed')
  })

  it('connects the browser through the widened area when the requested ZIP had no exit IP', async () => {
    const zip: GeoTarget = { mode: 'zip', country: 'us', state: 'Texas', stateCode: 'TX', city: 'Lankin', zip: '79999' }
    h.widened.current = TX
    const session = await h.manager.launch(h.profile({ name: 'Thin ZIP', stickySessionId: 'zip-1', target: zip }))
    await waitFor(() => h.manager.get(session.id)?.status === 'open', 'open')
    // The browser connected with the widened target and the sticky id that worked — not the requested ZIP.
    expect(world.launches[0]?.options).toMatchObject({ proxy: { username: 'login__cr.us;state.texas;sessid.zip-1-r3' } })
    const live = h.manager.get(session.id)!
    expect(live.target).toEqual(TX)
    expect(live.locationWarning).toContain('connected via Texas instead')
    expect(h.db.testRuns.get(session.runId)).toMatchObject({ target: TX, locationWarning: expect.stringContaining('connected via Texas') })
    // The saved profile still targets the ZIP.
    expect(h.db.profiles.get(session.profileId)?.target).toEqual(zip)
    await h.manager.close(session.id)
  })

  it('blames the website, not the proxy, when the page fails but the proxy session still answers', async () => {
    world.gotoError = new Error('page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://forms.example.com/qa')
    const session = await h.manager.launch(h.profile({ formUrlOverride: 'https://confinality.com/' }))
    await waitFor(() => h.manager.get(session.id)?.status === 'error', 'error')
    const error = h.manager.get(session.id)?.error
    expect(error?.code).toBe('SITE_UNREACHABLE')
    expect(error?.message).toBe('confinality.com did not respond. The proxy exit 203.0.113.9 (Austin, Texas) is working, so the website may be down or blocking this IP. Try again later, or check the site without a proxy.')
    expect(error?.detail).toContain('ERR_TUNNEL_CONNECTION_FAILED')
    expect(h.db.testRuns.get(session.runId)?.errorMessage).toContain('confinality.com did not respond')
    // The re-check used the session's own proxy connection.
    expect(h.lookupCalls.filter((c) => c !== null)).toHaveLength(1)
    await h.manager.close(session.id)
  })

  it('does not re-check direct sessions or non-ambiguous failures', async () => {
    world.gotoError = new Error('page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://forms.example.com/qa')
    const proxied = await h.manager.launch(h.profile({ name: 'TLS' }))
    await waitFor(() => h.manager.get(proxied.id)?.status === 'error', 'tls error')
    expect(h.manager.get(proxied.id)?.error?.code).toBe('SSL_ERROR')
    await h.manager.close(proxied.id)
    world.gotoError = new Error('page.goto: net::ERR_CONNECTION_REFUSED at https://forms.example.com/qa')
    const direct = await h.manager.launch(h.profile({ name: 'Direct', proxyMode: 'none', stickySessionId: null }))
    await waitFor(() => h.manager.get(direct.id)?.status === 'error', 'direct error')
    expect(h.manager.get(direct.id)?.error?.code).not.toBe('SITE_UNREACHABLE')
    expect(h.lookupCalls.filter((c) => c !== null)).toHaveLength(0)
    await h.manager.close(direct.id)
  })

  it('close() during an in-flight launch cancels it, disposes the browser and finalises the run as aborted', async () => {
    const gate = deferred<void>()
    world.launchGate = gate.promise
    const session = await h.manager.launch(h.profile())
    await waitFor(() => h.manager.get(session.id)?.status === 'launching', 'launching')
    expect(world.launches).toHaveLength(1)

    const closing = h.manager.close(session.id)
    await waitFor(() => h.manager.get(session.id)?.status === 'closing', 'closing')
    gate.resolve()
    await closing

    expect(world.browsers).toHaveLength(1)
    expect(world.browsers[0]?.closeCalls).toBeGreaterThanOrEqual(1)
    expect(world.browsers[0]?.disconnected).toBe(true)
    const run = h.db.testRuns.get(session.runId)
    expect(run?.status).toBe('aborted')
    expect(run?.endedAt).not.toBeNull()
    expect(run?.errorMessage).toContain('cancelled')
    expect(h.manager.get(session.id)).toBeNull()
    expect(h.manager.listActive()).toEqual([])
  })

  it('close() while navigation is pending disposes the browser and aborts the run', async () => {
    world.gotoHangs = true
    const session = await h.manager.launch(h.profile())
    await waitFor(() => world.browsers[0]?.contexts[0]?.created.length === 1, 'page created')
    await h.manager.close(session.id)
    expect(world.browsers[0]?.disconnected).toBe(true)
    expect(h.db.testRuns.get(session.runId)?.status).toBe('aborted')
    expect(h.manager.get(session.id)).toBeNull()
  })

  it('closeAll() finalises every run even when a browser refuses to close within the timeout', async () => {
    const a = await h.manager.launch(h.profile())
    const b = await h.manager.launch(h.profile({ name: 'Two', stickySessionId: 'two' }))
    await waitFor(() => h.manager.get(a.id)?.status === 'open' && h.manager.get(b.id)?.status === 'open', 'both open')

    world.closeHangs = true
    const started = Date.now()
    await h.manager.closeAll()
    expect(Date.now() - started).toBeLessThan(1_500)
    expect(h.manager.listActive()).toEqual([])
    for (const session of [a, b]) {
      const run = h.db.testRuns.get(session.runId)
      expect(run?.status).toBe('success')
      expect(run?.endedAt).not.toBeNull()
    }
    expect(h.logs.some((l) => l.level === 'WARN' && l.message.includes('finalising the run anyway'))).toBe(true)
  })

  it('throws BROWSER_MISSING before creating a run when the engine is not installed', async () => {
    h.installed.current = false
    await expect(h.manager.launch(h.profile())).rejects.toMatchObject({ code: 'BROWSER_MISSING' })
    expect(h.db.testRuns.list()).toEqual([])
    expect(h.manager.listActive()).toEqual([])
  })

  it('launches an installed browser through the chromium BrowserType with its own executable path, and logs label + path', async () => {
    const profile = h.profile({ name: 'QA System Chromium', engine: 'system-chromium', devicePreset: 'pixel-9', deviceType: 'mobile', viewportWidth: 360, viewportHeight: 732, proxyMode: 'none', stickySessionId: null })
    const session = await h.manager.launch(profile)
    expect(session.engine).toBe('system-chromium')
    await waitFor(() => h.manager.get(session.id)?.status === 'open', 'system chromium open')

    expect(world.launches).toHaveLength(1)
    expect(world.launches[0]?.engine).toBe('chromium')
    expect(world.launches[0]?.options).toMatchObject({ headless: false, executablePath: SYSTEM_CHROMIUM_PATH })
    expect(world.launches[0]?.options.proxy).toBeUndefined()
    expect(world.relays).toHaveLength(0)
    const launchLine = h.logs.find((l) => l.message.includes(`launching Chromium (system install) from ${SYSTEM_CHROMIUM_PATH}`))
    expect(launchLine?.meta).toMatchObject({ engine: 'system-chromium', executablePath: SYSTEM_CHROMIUM_PATH, executableSource: 'detected' })
    expect(h.logs.some((l) => l.message.includes('browser launched (Chromium (system install) chromium-fake-1.0)'))).toBe(true)

    await h.manager.close(session.id)
    expect(h.db.testRuns.get(session.runId)).toMatchObject({ status: 'success', engine: 'system-chromium', devicePreset: 'pixel-9' })
  })

  it('installed browsers with a proxy authenticate directly (no relay) and bundled engines never get an executablePath', async () => {
    h.executables.set('brave', '/opt/brave.com/brave/brave')
    const brave = await h.manager.launch(h.profile({ name: 'QA Brave', engine: 'brave', stickySessionId: 'brave-1' }))
    await waitFor(() => h.manager.get(brave.id)?.status === 'open', 'brave open')
    expect(world.launches[0]?.engine).toBe('chromium')
    expect(world.launches[0]?.options).toMatchObject({
      executablePath: '/opt/brave.com/brave/brave',
      proxy: { server: 'http://gw.example.com:823', username: 'login__sessid.brave-1', password: PASSWORD },
    })
    expect(world.relays).toHaveLength(0)
    await h.manager.close(brave.id)

    const chromium = await h.manager.launch(h.profile({ name: 'QA Bundled', engine: 'chromium', proxyMode: 'none', stickySessionId: null }))
    await waitFor(() => h.manager.get(chromium.id)?.status === 'open', 'chromium open')
    expect(world.launches[1]?.options.executablePath).toBeUndefined()
    await h.manager.close(chromium.id)
  })

  it('refuses to launch an installed browser that is not on this machine, with the detection note, before any run exists', async () => {
    await expect(h.manager.launch(h.profile({ name: 'QA Opera', engine: 'opera', proxyMode: 'none', stickySessionId: null }))).rejects.toMatchObject({
      code: 'BROWSER_MISSING',
      message: 'Opera (installed): Not installed on this machine. Install it or set its path in Settings → Browsers.',
    })
    expect(h.db.testRuns.list()).toEqual([])
    expect(world.launches).toHaveLength(0)
  })

  it('throws INVALID_PROFILE synchronously for an unlaunchable profile', async () => {
    await expect(h.manager.launch(h.profile({ stickySessionId: null }))).rejects.toMatchObject({ code: 'INVALID_PROFILE' })
    expect(h.db.testRuns.list()).toEqual([])
  })

  it('records the direct exit IP for proxy-less profiles', async () => {
    const session = await h.manager.launch(h.profile({ name: 'Direct', proxyMode: 'none', stickySessionId: null }))
    expect(session.proxySessionId).toBeNull()
    await waitFor(() => h.manager.get(session.id)?.status === 'open', 'open')
    expect(h.manager.get(session.id)?.ip?.ip).toBe('198.51.100.4')
    expect(h.db.testRuns.get(session.runId)).toMatchObject({ publicIp: '198.51.100.4', proxySessionId: null })
    expect(world.launches[0]?.options.proxy).toBeUndefined()
    expect(h.sessions.some((s) => s.statusDetail === 'Direct connection (no proxy)')).toBe(true)
    await h.manager.close(session.id)
  })

  it('never leaks the proxy password through launch errors, runs or logs', async () => {
    world.launchError = new Error(`browserType.launch: spawn failed with --proxy-server=http://login:${PASSWORD}@gw.example.com:823`)
    const session = await h.manager.launch(h.profile())
    await waitFor(() => h.manager.get(session.id)?.status === 'error', 'error')
    const errored = h.manager.get(session.id)
    expect(errored?.error?.code).toBe('BROWSER_LAUNCH_FAILED')
    const everything = JSON.stringify({ sessions: h.sessions, runs: h.runs, logs: h.logs, stored: h.db.testRuns.list(), errored })
    expect(everything).not.toContain(PASSWORD)
    expect(h.db.testRuns.get(session.runId)).toMatchObject({ status: 'failed' })
    expect(h.db.testRuns.get(session.runId)?.endedAt).not.toBeNull()
  })

  it('get() returns null and close() reports SESSION_CLOSED for closed sessions; unknown ids are NOT_FOUND', async () => {
    const session = await h.manager.launch(h.profile())
    await waitFor(() => h.manager.get(session.id)?.status === 'open', 'open')
    await h.manager.close(session.id)
    expect(h.manager.get(session.id)).toBeNull()
    await expect(h.manager.close(session.id)).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(h.manager.screenshot(session.id)).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(h.manager.close('never-existed')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('createBrowserManager location re-roll (real proxy manager, scripted IP checker)', () => {
  const ZIP_07102: GeoTarget = { mode: 'zip', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: 'Newark', zip: '07102' }
  const NY_CARRIER: Partial<IpInfo> = { ip: '107.77.76.91', region: 'New York', city: 'New York', postalCode: '10118' }
  const ELIZABETH_07201: Partial<IpInfo> = { ip: '198.51.100.20', region: 'New Jersey', city: 'Elizabeth', postalCode: '07201' }
  const NEWARK_07103: Partial<IpInfo> = { ip: '198.51.100.22', region: 'New Jersey', city: 'Newark', postalCode: '07103' }
  const NEWARK_07102: Partial<IpInfo> = { ip: '198.51.100.21', region: 'New Jersey', city: 'Newark', postalCode: '07102' }
  const locations = {
    states: (): LocationEntry[] =>
      [
        ['New Jersey', 'NJ'],
        ['New York', 'NY'],
      ].map(([state = '', stateCode = '']) => ({ kind: 'state' as const, label: state, country: 'us', state, stateCode, city: null, zip: null, timezone: null })),
  }

  let script: Array<Partial<IpInfo>>
  let seen: ProxyConnection[]
  let h: Harness

  beforeEach(async () => {
    world.launches.length = 0
    world.browsers.length = 0
    world.relays.length = 0
    world.launchGate = null
    world.launchError = null
    world.gotoStatus = 200
    world.gotoError = null
    world.gotoHangs = false
    world.closeHangs = false
    script = []
    seen = []
    const checker: IpChecker = {
      lookup: async (connection) => {
        if (connection) seen.push(connection)
        const next = script.shift()
        if (!next) throw new Error('IP check script exhausted')
        return { ...ipInfo, ...next }
      },
    }
    h = await buildHarness(200, null, {
      makeProxy: (db, logger) =>
        createProxyManager({
          provider: new DataImpulseProvider({
            ipChecker: checker,
            logger,
            credentials: [{ pool: 'residential', host: 'gw.dataimpulse.com', port: 823, username: 'acme_login', password: PASSWORD, sessionTemplate: null }],
          }),
          sessions: db.proxySessions,
          profiles: db.profiles,
          logger,
          locations,
          stickyConfirmDelayMs: 0,
        }),
    })
  })

  afterEach(() => {
    h.db.close()
  })

  const detailsOf = (id: string): string[] => h.sessions.filter((s) => s.id === id).map((s) => s.statusDetail)

  it('re-rolls until the exact ZIP matches, then launches the browser with the final sticky id', async () => {
    h.settings.locationMatchPolicy = 'exact'
    h.settings.locationMatchAttempts = 3
    // The last entry is the stickiness check of the accepted session (same IP: it holds).
    script = [NY_CARRIER, ELIZABETH_07201, NEWARK_07102, NEWARK_07102]
    const profile = h.profile({ name: 'ZIP 07102', stickySessionId: 'zip-1', target: ZIP_07102 })
    const session = await h.manager.launch(profile)
    expect(session).toMatchObject({ locationAttempts: 1, locationMaxAttempts: 3, locationWarning: null })
    expect(h.db.testRuns.get(session.runId)).toMatchObject({ locationAttempts: 1, locationMaxAttempts: 3 })
    await waitFor(() => h.manager.get(session.id)?.status === 'open', 'session to open')

    expect(detailsOf(session.id)).toEqual(
      expect.arrayContaining([
        'Exit IP 107.77.76.91 is in New York, NY 10118 — re-rolling session (2/3)…',
        'Exit IP 198.51.100.20 is in Elizabeth, NJ 07201 — re-rolling session (3/3)…',
      ]),
    )
    expect(statusesOf(h.sessions, session.id)).toEqual(['starting', 'verifying-proxy', 'launching', 'open'])
    const finalTargeting = 'cr.us;state.newjersey;city.newark;zip.07102;sessid.zip-1-r3'
    expect(h.manager.get(session.id)).toMatchObject({
      targetMatch: 'match',
      proxySessionId: 'zip-1-r3',
      targetingString: finalTargeting,
      locationAttempts: 3,
      locationMaxAttempts: 3,
      locationWarning: null,
      ip: { ip: '198.51.100.21', postalCode: '07102' },
    })
    expect(h.db.testRuns.get(session.runId)).toMatchObject({
      targetMatch: 'match',
      publicIp: '198.51.100.21',
      postalCode: '07102',
      proxySessionId: 'zip-1-r3',
      targetingString: finalTargeting,
      locationAttempts: 3,
      locationMaxAttempts: 3,
      locationWarning: null,
    })
    expect(seen.map((c) => c.sessionId)).toEqual(['zip-1', 'zip-1-r2', 'zip-1-r3', 'zip-1-r3'])
    expect(world.launches[0]?.options.proxy).toEqual({ server: 'http://gw.dataimpulse.com:823', username: `acme_login__${finalTargeting}`, password: PASSWORD })
    expect(h.db.profiles.get(profile.id)?.stickySessionId).toBe('zip-1-r3')
    expect(JSON.stringify({ logs: h.logs, sessions: h.sessions, runs: h.runs })).not.toContain(PASSWORD)
    await h.manager.close(session.id)
  })

  it('falls back to the best attempt with a warning when no exit IP meets the policy', async () => {
    h.settings.locationMatchPolicy = 'exact'
    h.settings.locationMatchAttempts = 3
    script = [ELIZABETH_07201, NY_CARRIER, NY_CARRIER]
    const profile = h.profile({ name: 'ZIP fallback', stickySessionId: 'zip-2', target: ZIP_07102 })
    const session = await h.manager.launch(profile)
    await waitFor(() => h.manager.get(session.id)?.status === 'open', 'session to open')

    const warning = 'Could not get an exit IP in ZIP 07102 (Newark, NJ) after 3 attempts; using Elizabeth, NJ 07201 (same state)'
    expect(detailsOf(session.id)).toContain(warning)
    expect(h.manager.get(session.id)).toMatchObject({ targetMatch: 'partial', proxySessionId: 'zip-2', locationAttempts: 3, locationWarning: warning, ip: { postalCode: '07201' } })
    expect(h.db.testRuns.get(session.runId)).toMatchObject({ targetMatch: 'partial', proxySessionId: 'zip-2', postalCode: '07201', locationAttempts: 3, locationWarning: warning })
    // The browser uses the first session id again: it still holds the best exit IP.
    expect(world.launches[0]?.options.proxy).toMatchObject({ username: 'acme_login__cr.us;state.newjersey;city.newark;zip.07102;sessid.zip-2' })
    expect(h.db.profiles.get(profile.id)?.stickySessionId).toBe('zip-2')
    await h.manager.close(session.id)
  })

  it("policy 'off' launches after a single check, whatever the location", async () => {
    h.settings.locationMatchPolicy = 'off'
    script = [NY_CARRIER, NY_CARRIER, NEWARK_07102]
    const session = await h.manager.launch(h.profile({ name: 'ZIP off', stickySessionId: 'zip-3', target: ZIP_07102 }))
    expect(session.locationMaxAttempts).toBe(1)
    await waitFor(() => h.manager.get(session.id)?.status === 'open', 'session to open')
    // One location check plus the stickiness check of the same session.
    expect(seen.map((c) => c.sessionId)).toEqual(['zip-3', 'zip-3'])
    expect(h.manager.get(session.id)).toMatchObject({ targetMatch: 'mismatch', proxySessionId: 'zip-3', locationAttempts: 1, locationMaxAttempts: 1, locationWarning: null })
    expect(detailsOf(session.id).some((detail) => detail.includes('re-rolling'))).toBe(false)
    await h.manager.close(session.id)
  })

  it('counts a ZIP in the requested city as a match: lookups disagree on ZIPs for the same IP', async () => {
    h.settings.locationMatchPolicy = 'exact'
    h.settings.locationMatchAttempts = 3
    script = [NEWARK_07103, NEWARK_07103]
    const session = await h.manager.launch(h.profile({ name: 'ZIP same city', stickySessionId: 'zip-4', target: ZIP_07102 }))
    await waitFor(() => h.manager.get(session.id)?.status === 'open', 'session to open')
    expect(h.manager.get(session.id)).toMatchObject({ targetMatch: 'match', proxySessionId: 'zip-4', locationAttempts: 1, locationWarning: null })
    await h.manager.close(session.id)
  })

  it('switches to a fresh session when the exit IP changes between two quick checks, without using a location attempt', async () => {
    h.settings.locationMatchPolicy = 'exact'
    h.settings.locationMatchAttempts = 3
    // Session zip-5 answers with a different IP on the second look (the provider ignored stickiness); zip-5-r2 holds.
    script = [NEWARK_07102, NEWARK_07103, NEWARK_07102, NEWARK_07102]
    const profile = h.profile({ name: 'Unstable', stickySessionId: 'zip-5', target: ZIP_07102 })
    const session = await h.manager.launch(profile)
    await waitFor(() => h.manager.get(session.id)?.status === 'open', 'session to open')
    expect(seen.map((c) => c.sessionId)).toEqual(['zip-5', 'zip-5', 'zip-5-r2', 'zip-5-r2'])
    expect(detailsOf(session.id)).toContain('Exit IP 198.51.100.21 changed to 198.51.100.22 within seconds — trying another session…')
    expect(h.manager.get(session.id)).toMatchObject({ targetMatch: 'match', proxySessionId: 'zip-5-r2', locationAttempts: 1, ip: { ip: '198.51.100.21' } })
    expect(world.launches[0]?.options.proxy).toMatchObject({ username: 'acme_login__cr.us;state.newjersey;city.newark;zip.07102;sessid.zip-5-r2' })
    expect(h.db.profiles.get(profile.id)?.stickySessionId).toBe('zip-5-r2')
    expect(h.logs.some((l) => l.message === 'Sticky session did not keep its exit IP (198.51.100.21 then 198.51.100.22)')).toBe(true)
    await h.manager.close(session.id)
  })

  it('fails with IP_UNSTABLE, without opening a browser, when no session keeps one IP', async () => {
    h.settings.locationMatchPolicy = 'off'
    script = [NEWARK_07102, NEWARK_07103, NEWARK_07102, NEWARK_07103, NEWARK_07102, NEWARK_07103]
    const session = await h.manager.launch(h.profile({ name: 'Never sticky', stickySessionId: 'zip-6', target: ZIP_07102 }))
    await waitFor(() => h.manager.get(session.id)?.status === 'error', 'error')
    expect(world.launches).toHaveLength(0)
    expect(h.manager.get(session.id)?.error).toMatchObject({
      code: 'IP_UNSTABLE',
      message:
        'The proxy could not keep one IP in ZIP 07102 (Newark, NJ): the IP changed within seconds in 3 sessions in a row. Try again in a minute or choose another location.',
    })
    expect(seen.map((c) => c.sessionId)).toEqual(['zip-6', 'zip-6', 'zip-6-r2', 'zip-6-r2', 'zip-6-r3', 'zip-6-r3'])
    expect(h.db.testRuns.get(session.runId)?.status).toBe('failed')
    await h.manager.close(session.id)
  })
})

describe('createBrowserManager session maintenance', () => {
  beforeEach(() => {
    world.launches.length = 0
    world.browsers.length = 0
    world.relays.length = 0
    world.launchGate = null
    world.launchError = null
    world.gotoStatus = 200
    world.gotoError = null
    world.gotoHangs = false
    world.closeHangs = false
    world.newPageHangs = false
    world.cdp.length = 0
    world.windowState = 'normal'
  })

  const direct = { proxyMode: 'none' as const, stickySessionId: null }

  it('ends the session as closed when the user closes the last tab, and keeps it while another tab is open', async () => {
    const store = memoryLiveSessionsStore()
    const h = await buildHarness(200, null, { manager: { liveSessions: store, heartbeatIntervalMs: 0 } })
    try {
      const session = await h.manager.launch(h.profile({ name: 'Tabs', ...direct }))
      expect(store.list()).toMatchObject([{ sessionId: session.id, runId: session.runId, engine: 'chromium', pid: null }])
      await waitFor(() => h.manager.get(session.id)?.status === 'open', 'open')
      const context = world.browsers[0]?.contexts[0]
      const first = context?.created[0]
      const popup = context?.userOpenTab()
      first?.userClose()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(h.manager.get(session.id)?.status).toBe('open')
      popup?.userClose()
      await waitFor(() => h.manager.get(session.id) === null, 'session finalised')
      expect(statusesOf(h.sessions, session.id).at(-1)).toBe('closed')
      expect(world.browsers[0]?.closeCalls).toBeGreaterThan(0)
      expect(h.db.testRuns.get(session.runId)).toMatchObject({ status: 'success' })
      expect(h.logs.some((l) => l.message.includes('the last browser window was closed'))).toBe(true)
      expect(store.list()).toEqual([])
    } finally {
      h.db.close()
    }
  })

  it('the heartbeat stamps lastHeartbeatAt and finalises sessions whose pages vanished or whose browser disconnected', async () => {
    const h = await buildHarness(200, null, { manager: { heartbeatIntervalMs: 15 } })
    try {
      const a = await h.manager.launch(h.profile({ name: 'A', ...direct }))
      const b = await h.manager.launch(h.profile({ name: 'B', ...direct }))
      await waitFor(() => h.manager.get(a.id)?.status === 'open' && h.manager.get(b.id)?.status === 'open', 'both open')
      await waitFor(() => (h.manager.get(a.id)?.lastHeartbeatAt ?? null) !== null, 'heartbeat')
      // A: the window went away without a close event reaching us.
      const pageA = world.browsers[0]?.contexts[0]?.created[0]
      if (pageA) pageA.closed = true
      // B: the browser process died without a 'disconnected' event.
      const browserB = world.browsers[1]
      if (browserB) browserB.disconnected = true
      await waitFor(() => h.manager.get(a.id) === null && h.manager.get(b.id) === null, 'both finalised by the heartbeat')
      expect(h.manager.listActive()).toEqual([])
    } finally {
      h.db.close()
    }
  })

  it('a crashed tab marks the session failed with a clear message and keeps the window for inspection', async () => {
    const h = await buildHarness(200)
    try {
      const session = await h.manager.launch(h.profile({ name: 'Crash', ...direct }))
      await waitFor(() => h.manager.get(session.id)?.status === 'open', 'open')
      world.browsers[0]?.contexts[0]?.created[0]?.emit('crash')
      expect(h.manager.get(session.id)).toMatchObject({ status: 'error', error: { code: 'INTERNAL', message: 'The browser tab crashed' } })
      expect(h.db.testRuns.get(session.runId)).toMatchObject({ status: 'failed', errorMessage: 'The browser tab crashed', endedAt: null })
      expect(world.browsers[0]?.closeCalls).toBe(0)
      await h.manager.close(session.id)
      expect(h.db.testRuns.get(session.runId)?.endedAt).not.toBeNull()
    } finally {
      h.db.close()
    }
  })

  it('refuses to launch an engine that is being installed (ENGINE_BUSY) before any run exists', async () => {
    const busy = 'Google Chrome is being installed — launch will be available when the install finishes.'
    const h = await buildHarness(200, null, { manager: { engineBusyMessage: (engine) => (engine === 'chrome' ? busy : null) } })
    try {
      h.executables.set('chrome', '/opt/google/chrome/chrome')
      await expect(h.manager.launch(h.profile({ name: 'Chrome', engine: 'chrome', ...direct }))).rejects.toMatchObject({ code: 'ENGINE_BUSY', message: busy })
      expect(h.db.testRuns.list()).toEqual([])
      expect(world.launches).toHaveLength(0)
      const ok = await h.manager.launch(h.profile({ name: 'Other', ...direct }))
      await waitFor(() => h.manager.get(ok.id)?.status === 'open', 'open')
      await h.manager.close(ok.id)
    } finally {
      h.db.close()
    }
  })

  it('finds the Chromium-family browser pid by its marker, records it, and forgets it when the session ends', async () => {
    const store = memoryLiveSessionsStore()
    const lookups: string[] = []
    const h = await buildHarness(200, null, {
      manager: {
        liveSessions: store,
        findBrowserPid: async (sessionId) => {
          lookups.push(sessionId)
          return lookups.length >= 2 ? 4242 : null
        },
      },
    })
    try {
      const session = await h.manager.launch(h.profile({ name: 'Pid', ...direct }))
      await waitFor(() => h.manager.get(session.id)?.browserPid === 4242, 'pid found')
      expect(lookups.every((id) => id === session.id)).toBe(true)
      expect(store.list()).toMatchObject([{ sessionId: session.id, pid: 4242 }])
      expect(h.manager.sessionPids()).toEqual([4242])
      await h.manager.close(session.id)
      expect(store.list()).toEqual([])
      expect(h.manager.sessionPids()).toEqual([])

      // Firefox carries no marker: its pid is never looked up.
      lookups.length = 0
      const firefox = await h.manager.launch(h.profile({ name: 'FF', engine: 'firefox', ...direct }))
      await waitFor(() => h.manager.get(firefox.id)?.status === 'open', 'ff open')
      expect(world.launches.at(-1)?.options.args).toBeUndefined()
      expect(lookups).toEqual([])
      await h.manager.close(firefox.id)
    } finally {
      h.db.close()
    }
  })

  it('focus() restores a minimised Chromium window through CDP and brings the page to the front', async () => {
    const h = await buildHarness(200)
    try {
      const session = await h.manager.launch(h.profile({ name: 'Focus', ...direct }))
      await waitFor(() => h.manager.get(session.id)?.status === 'open', 'open')
      await h.manager.focus(session.id)
      expect(world.cdp.map((c) => c.method)).toEqual(['Browser.getWindowForTarget', 'Browser.getWindowBounds'])
      world.cdp.length = 0
      world.windowState = 'minimized'
      await h.manager.focus(session.id)
      expect(world.cdp).toEqual([{ method: 'Browser.getWindowForTarget' }, { method: 'Browser.getWindowBounds', params: { windowId: 7 } }, { method: 'Browser.setWindowBounds', params: { windowId: 7, bounds: { windowState: 'normal' } } }])
      expect(world.browsers[0]?.contexts[0]?.created[0]?.broughtToFront).toBe(2)
      await h.manager.close(session.id)
      await expect(h.manager.focus(session.id)).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      await expect(h.manager.focus('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })

      world.cdp.length = 0
      const firefox = await h.manager.launch(h.profile({ name: 'FF focus', engine: 'firefox', ...direct }))
      await waitFor(() => h.manager.get(firefox.id)?.status === 'open', 'ff open')
      await h.manager.focus(firefox.id)
      expect(world.cdp).toEqual([])
      await h.manager.close(firefox.id)
    } finally {
      h.db.close()
    }
  })
})

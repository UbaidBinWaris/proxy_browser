/**
 * Internal module contracts for the Electron main process.
 *
 * Each subsystem (database, logging, proxy, browser) implements one of these
 * interfaces. `main/ipc` wires them together. Implementations must not import
 * each other directly except through these interfaces, so modules can be
 * developed and unit-tested independently.
 */
import type { QaStore } from './qa/store'
import type {
  AppError,
  AppSettings,
  AppSettingsPatch,
  BrowserEngine,
  BrowserEngineInfo,
  BrowserInstallProgress,
  BrowserInstallTarget,
  BrowserSession,
  BrowserWatchUpdate,
  BrowsersStatus,
  DevicePresetInfo,
  InstallAllResult,
  IpInfo,
  LogEntry,
  LogLevel,
  LogQuery,
  NetworkEntry,
  Profile,
  ProfileInput,
  CredentialSource,
  GeoTarget,
  LocationEntry,
  LocationQueryResult,
  LocationStats,
  LocationMatchPolicy,
  LocationSearch,
  ProxyConfigStatus,
  ProxyCredentialsInput,
  ProxyPool,
  TargetingPreview,
  ProxySession,
  ProxyStatus,
  ProxyTestResult,
  SecurityStatus,
  TargetMatch,
  Task,
  TaskKind,
  TestRun,
  TestRunPatch,
} from '../shared/types'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown by any module; converted to an `IpcResult` failure at the IPC boundary. */
export class AppException extends Error {
  readonly code: AppError['code']
  readonly detail?: string
  constructor(code: AppError['code'], message: string, detail?: string) {
    super(message)
    this.name = 'AppException'
    this.code = code
    this.detail = detail
  }
  toAppError(): AppError {
    return { code: this.code, message: this.message, ...(this.detail ? { detail: this.detail } : {}) }
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export interface Logger {
  info(scope: string, message: string, meta?: Record<string, unknown>): void
  warn(scope: string, message: string, meta?: Record<string, unknown>): void
  error(scope: string, message: string, meta?: Record<string, unknown>): void
  log(level: LogLevel, scope: string, message: string, meta?: Record<string, unknown>): void
  /** Subscribe to new entries (used to push to renderer). */
  onEntry(listener: (entry: LogEntry) => void): () => void
  query(query?: LogQuery): LogEntry[]
  clear(): void
  /** Register a secret value that must be redacted from every message/meta. */
  registerSecret(value: string): void
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export interface ProfileListOptions {
  /** Include Quick Launch profiles (`ephemeral: true`); hidden by default. */
  includeEphemeral?: boolean
}

export interface ProfileRepository {
  list(options?: ProfileListOptions): Profile[]
  get(id: string): Profile | null
  create(input: ProfileInput): Profile
  update(id: string, input: ProfileInput): Profile
  delete(id: string): void
  /** Number of profiles, ephemeral ones excluded unless requested. */
  count(options?: ProfileListOptions): number
}

/** Pool/target context recorded on a proxy session row alongside the sticky id. */
export interface ProxySessionContext {
  pool: ProxyPool
  target: GeoTarget | null
  targetingString: string | null
}

export interface ProxySessionRepository {
  list(): ProxySession[]
  get(id: string): ProxySession | null
  /** `null` addresses the raw-gateway row (a test not tied to any profile). */
  getByProfile(profileId: string | null): ProxySession | null
  /** Context defaults to the residential pool without a target when omitted. */
  upsertForProfile(profileId: string | null, sessionId: string | null, context?: ProxySessionContext): ProxySession
  updateStatus(
    id: string,
    patch: {
      status: ProxyStatus
      ip?: IpInfo | null
      error?: string | null
      targetMatch?: TargetMatch | null
    },
  ): ProxySession
  countByStatus(status: ProxyStatus): number
  delete(id: string): void
}

export interface TestRunRepository {
  list(limit?: number): TestRun[]
  get(id: string): TestRun | null
  create(run: Omit<TestRun, 'id'>): TestRun
  update(id: string, patch: Partial<Omit<TestRun, 'id'>>): TestRun
  patch(id: string, patch: TestRunPatch): TestRun
  delete(id: string): void
}

export interface NetworkRepository {
  listByRun(runId: string): NetworkEntry[]
  insert(entry: Omit<NetworkEntry, 'id'>): NetworkEntry
  /** Update status/response fields when the response arrives. */
  complete(id: string, patch: Pick<NetworkEntry, 'status' | 'responseTime' | 'durationMs' | 'extractedIds'>): void
  deleteByRun(runId: string): void
}

export interface SettingsRepository {
  get(): AppSettings
  update(patch: AppSettingsPatch): AppSettings
}

export interface LogRepository {
  insert(entry: Omit<LogEntry, 'id'>): LogEntry
  query(query?: LogQuery): LogEntry[]
  clear(): void
  /** Keep at most `max` rows (oldest removed). */
  prune(max: number): void
}

export interface Database {
  qa?: QaStore
  profiles: ProfileRepository
  proxySessions: ProxySessionRepository
  testRuns: TestRunRepository
  network: NetworkRepository
  settings: SettingsRepository
  logs: LogRepository
  /** Path to the sqlite file. */
  readonly path: string
  close(): void
}

// ---------------------------------------------------------------------------
// Credential vault
// ---------------------------------------------------------------------------

/** Decrypted proxy credentials. Main process memory only. */
export interface ProxyCredentials {
  pool: ProxyPool
  host: string
  port: number
  username: string
  password: string
  sessionTemplate: string | null
}

/** Everything the provider needs to build one connection. */
export interface ProxyRequest {
  pool: ProxyPool
  /** Sticky session id, or null for a rotating connection. */
  sessionId: string | null
  target: GeoTarget | null
  ttlMinutes: number | null
}

/**
 * Encrypted, per-machine credential store.
 * - Vault file: AES-256-GCM, lives under <userData>/vault/.
 * - Key file: random 256-bit key wrapped by the OS keychain (Electron safeStorage:
 *   DPAPI / libsecret / kwallet) or, when no keychain is available, by a
 *   machine-derived scrypt key (reported as reduced protection). Lives in a
 *   DIFFERENT directory than the vault, owner-only permissions.
 * - All methods are network-free except none; proxy tests live in ProxyManager.
 */
export interface CredentialVault {
  /** Current decrypted credentials for a pool (null when none/undecryptable). */
  get(pool: ProxyPool): ProxyCredentials | null
  /** Every configured pool. */
  getAll(): ProxyCredentials[]
  /** Local health check: key readable, vault decrypts, integrity ok, permissions ok. */
  status(): Promise<SecurityStatus>
  /** Encrypt, write, read back and verify. Emits onChange. */
  save(input: ProxyCredentialsInput): Promise<SecurityStatus>
  /** Remove one pool's credentials (key is kept). Emits onChange. */
  clear(pool: ProxyPool): Promise<SecurityStatus>
  /** Generate a fresh key and re-encrypt the vault with it. */
  rotateKey(): Promise<SecurityStatus>
  /** Record the latest on-demand proxy test so health can show it without re-testing. */
  recordProxyTest(status: ProxyStatus, at: string): void
  onChange(listener: (credentials: ProxyCredentials[]) => void): () => void
  readonly keyPath: string
  readonly vaultPath: string
}

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

/** Playwright-compatible proxy settings. Contains the password — main process only. */
export interface ProxyConnection {
  server: string
  username: string
  password: string
  pool: ProxyPool
  /** Sticky session id embedded in the username, if any. */
  sessionId: string | null
  target: GeoTarget | null
  /** Provider parameters only (no login/password), safe to log and show: "cr.us;state.newjersey;sessid.x". */
  targetingString: string
}

export interface ProxyProvider {
  readonly name: 'dataimpulse'
  isConfigured(): boolean
  /** Swap the active credentials at runtime (vault saved/cleared). Replaces the whole pool set. */
  setCredentials(credentials: ProxyCredentials[], source: CredentialSource): void
  isPoolConfigured(pool: ProxyPool): boolean
  /** Test arbitrary credentials through the gateway WITHOUT changing the active ones. */
  testCredentials(input: ProxyCredentialsInput): Promise<ProxyTestResult>
  /** Public, password-free description of the configuration (per pool). */
  getConfigStatus(): ProxyConfigStatus
  /** Compose the provider parameter string for a request (no secrets). */
  buildTargetingString(request: ProxyRequest): string
  /** Build connection settings for a request (pool + session + geo target). */
  buildProxyConfig(request: ProxyRequest): ProxyConnection
  /** Verify connectivity through the proxy and return the exit IP info. */
  testConnection(request: ProxyRequest): Promise<ProxyTestResult>
  getCurrentIp(request: ProxyRequest): Promise<IpInfo>
  /** Derive a deterministic sticky session id for a profile. */
  createSession(profileName: string): string
  /** Produce a new, different session id (e.g. suffix increment / random). */
  rotateSession(currentSessionId: string | null, profileName: string): string
}

/** A re-roll is about to start (reported before its IP check). */
export interface LocationRerollProgress {
  /** The attempt about to start (2…attempts). */
  attempt: number
  attempts: number
  /** Sticky session id the attempt uses. */
  sessionId: string
  /** e.g. "Exit IP 107.77.76.91 is in New York, NY 10118 — re-rolling session (2/3)…" (no secrets). */
  message: string
}

export interface LaunchVerifyOptions {
  policy: LocationMatchPolicy
  /** Total attempts allowed, first check included (clamped to 1–8). Only sticky sessions with a target re-roll. */
  attempts: number
  onProgress?: (progress: LocationRerollProgress) => void
  /** Checked before every re-roll; returning false stops re-rolling (e.g. the launch was cancelled). */
  shouldContinue?: () => boolean
}

/** Outcome of the pre-launch proxy check, including the location re-roll. */
export interface LaunchVerification {
  /**
   * The result the browser should use: the first attempt that met the policy, otherwise the best
   * working attempt (match > partial > mismatch, ties → the later one). A failure only when the
   * first check failed (nothing usable exists).
   */
  result: ProxyTestResult
  /** Verified-vs-requested comparison of the chosen result; null without a target or on failure. */
  targetMatch: TargetMatch | null
  /** IP checks made (≥ 1). */
  attempts: number
  /** Budget that applied: `options.attempts` for a sticky session with a target and policy ≠ 'off', else 1. */
  maxAttempts: number
  /** Sticky session id of the chosen result (written back to the profile when it changed); null when rotating. */
  sessionId: string | null
  /** Set when no attempt met the policy: which result was used instead, and why. */
  warning: string | null
}

export interface ProxyManager {
  getConfigStatus(): ProxyConfigStatus
  /** Live test of candidate credentials through the gateway; active credentials and ProxySession rows are untouched. */
  testCredentials(input: ProxyCredentialsInput): Promise<ProxyTestResult>
  /** Resolve the proxy connection for a profile according to its proxyMode/pool/target. Null when proxyMode is 'none'. */
  resolveForProfile(profile: Profile): ProxyConnection | null
  /** Compare the verified IP location with the requested target. */
  compareTarget(target: GeoTarget | null, ip: IpInfo | null): TargetMatch | null
  /**
   * Test the proxy for a profile (or raw gateway when profile is null), persisting the ProxySession row.
   * `pool` overrides the default pool of a raw gateway test; it is ignored for a profile.
   */
  testConnection(profile: Profile | null, pool?: ProxyPool): Promise<ProxyTestResult>
  /**
   * Pre-launch check of a proxied profile: test the exit IP and, for a sticky session with a target,
   * re-roll the sticky session id while the verified location falls short of `options.policy`.
   * The chosen session id is written back to the profile and its ProxySession row shows the chosen result.
   */
  verifyForLaunch(profile: Profile, options: LaunchVerifyOptions): Promise<LaunchVerification>
  getCurrentIp(profile: Profile | null): Promise<IpInfo>
  rotateSession(profile: Profile): Promise<ProxySession>
  listSessions(): ProxySession[]
  onSessionUpdate(listener: (session: ProxySession) => void): () => void
}

export interface IpChecker {
  /** Look up the exit IP as seen by an external service, optionally through a proxy. */
  lookup(proxy: ProxyConnection | null): Promise<IpInfo>
}

// ---------------------------------------------------------------------------
// Locations (bundled GeoNames US postal dataset, CC BY 4.0)
// ---------------------------------------------------------------------------

export interface LocationsService {
  search(input: LocationSearch): LocationEntry[]
  /** Like `search`, plus the uncapped number of matches. */
  query(input: LocationSearch): LocationQueryResult
  /** Dataset size (states / cities / ZIP codes). */
  stats(): LocationStats
  /** A random targetable entry; `stateCode` keeps cities / ZIP codes inside one state. */
  random(mode: LocationSearch['mode'], stateCode?: string | null): LocationEntry
  states(): LocationEntry[]
  /** IANA timezone typical for a US state code (e.g. "NJ" → "America/New_York"). */
  timezoneForState(stateCode: string): string | null
  /** Build a GeoTarget from a selected entry. */
  toTarget(entry: LocationEntry): GeoTarget
}

/** Quick Launch orchestration (ephemeral profile + launch). */
export interface Launcher {
  preview(input: unknown): TargetingPreview
  quickLaunch(input: unknown): Promise<BrowserSession>
  /** Terminate every open browser session. */
  closeAll(): Promise<void>
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

export interface BrowserManager {
  launch(profile: Profile): Promise<BrowserSession>
  close(sessionId: string): Promise<void>
  closeAll(): Promise<void>
  /** Bring a session's browser window to the front (restore a minimised Chromium-family window first). */
  focus(sessionId: string): Promise<void>
  /** Browser process ids of the live sessions that have one (Chromium family). */
  sessionPids(): number[]
  screenshot(sessionId: string): Promise<string>
  listActive(): BrowserSession[]
  get(sessionId: string): BrowserSession | null
  onSessionUpdate(listener: (session: BrowserSession) => void): () => void
  onRunUpdate(listener: (run: TestRun) => void): () => void
  onNetworkEntry(listener: (entry: NetworkEntry) => void): () => void
}

/** Cancellation and child-process tracking for one install (used by the task manager). */
export interface InstallRunOptions {
  /** Aborting kills the installer child and fails the install with "The installation was cancelled." */
  signal?: AbortSignal
  /** Pid of each installer child process as it starts (so a cancel can terminate the whole tree). */
  onChildProcess?: (pid: number) => void
}

export interface BrowserProvisioner {
  status(): Promise<BrowsersStatus>
  /** Download a bundled engine (or all of them) with `playwright-core install`; installed browsers are refused. */
  install(engine: BrowserInstallTarget, onProgress: (p: BrowserInstallProgress) => void, options?: InstallRunOptions): Promise<BrowsersStatus>
  /** Directory passed as PLAYWRIGHT_BROWSERS_PATH. */
  browsersPath(): string
  /**
   * Install an installed-kind engine with its automatic `installMethod` (winget, vendor package or
   * portable archive into the app data folder, Playwright's vendor installer), save its executable
   * path as 'auto' and return the refreshed status. INVALID_INPUT for engines without an automatic
   * method; one install at a time (a concurrent request is refused).
   */
  installEngine(engine: BrowserEngine, onProgress: (p: BrowserInstallProgress) => void, options?: InstallRunOptions): Promise<BrowsersStatus>
  /** Delete the app's own user-space copy of an engine and forget a saved path pointing into it. */
  uninstallEngine(engine: BrowserEngine): Promise<BrowsersStatus>
  /** Install every unavailable engine with an automatic method, one after another (failures are collected, not fatal). */
  installAllMissing(onProgress: (p: BrowserInstallProgress) => void): Promise<InstallAllResult>
  /** Poll for an engine the user installs by hand (after the vendor page opened); results via onWatchUpdate. */
  watchForInstall(engine: BrowserEngine): void
  onWatchUpdate(listener: (update: BrowserWatchUpdate) => void): () => void
  /** Cancel watchers and abort a running download (app quit). */
  dispose(): void
  /** Vendor download page for an installed-kind engine. */
  downloadUrl(engine: BrowserEngine): string | null
  /** Availability of every engine in `BROWSER_ENGINES` order (bundled markers + installed-browser detection, cached). */
  engines(): Promise<BrowserEngineInfo[]>
  /** Clear the detection cache and scan again. */
  redetect(): Promise<BrowserEngineInfo[]>
  /** The engine's availability; throws AppException('BROWSER_MISSING') with the engine's note when it is unavailable. */
  resolveEngine(engine: BrowserEngine): Promise<BrowserEngineInfo>
  /** Throws AppException('BROWSER_MISSING') when the engine is not installed. */
  assertInstalled(engine: BrowserEngine): Promise<void>
}

/**
 * Serial background queue for browser installs/uninstalls (src/main/tasks/task-manager.ts). One task runs
 * at a time; every install is verified before it counts as done.
 */
export interface TaskManager {
  /** Queue work; an identical queued/running task (same kind + engine) is returned instead of a duplicate. Validation errors throw. */
  enqueue(kind: TaskKind, engine: BrowserEngine): Promise<Task>
  cancel(taskId: string): Promise<Task>
  retry(taskId: string): Promise<Task>
  clearFinished(): Task[]
  list(): Task[]
  /** A queued/running/verifying task targets this engine (launches are refused with ENGINE_BUSY). */
  isEngineBusy(engine: BrowserEngine): boolean
  /** The engine's task is running right now (its files are in flux; detection leaves it alone). */
  isEngineInstalling(engine: BrowserEngine): boolean
  onUpdate(listener: (tasks: Task[]) => void): () => void
  /** Cancel everything (app quit). */
  dispose(): Promise<void>
}

export interface ProfileManager {
  list(): Profile[]
  get(id: string): Profile
  create(input: unknown): Profile
  update(id: string, input: unknown): Profile
  duplicate(id: string): Profile
  delete(id: string): void
  presets(): DevicePresetInfo[]
  /** Validate a stored profile is launchable; throws AppException('INVALID_PROFILE'). */
  validateForLaunch(profile: Profile): void
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface AppPaths {
  /** Electron userData directory. */
  userData: string
  /** <userData>/data */
  data: string
  /** <userData>/data/screenshots */
  screenshots: string
  /** <userData>/data/browsers (PLAYWRIGHT_BROWSERS_PATH) */
  browsers: string
  /** <userData>/data/proxy-qa.sqlite */
  database: string
  /** <userData>/data/logs */
  logs: string
  /** <userData>/vault — encrypted credential vault. */
  vault: string
  /**
   * Wrapped vault key — deliberately OUTSIDE userData:
   *   Windows: %LOCALAPPDATA%/ProxyQABrowser/keys
   *   Linux:   $XDG_DATA_HOME/proxy-qa-browser/keys (default ~/.local/share/proxy-qa-browser/keys)
   *   macOS:   ~/Library/Application Support/ProxyQABrowser-keys
   */
  keys: string
}

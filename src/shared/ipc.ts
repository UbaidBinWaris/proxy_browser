import type { DesktopSetupOptions, DesktopStatus, UpdateAvailability, UsbUpdatePreview } from './desktop'
import type { SiteAccessStatus, SiteAccessTokenInput, SiteAccessTokenSummary } from './site-access'
/**
 * IPC contract between renderer and main.
 *
 * - `IPC` lists every invoke channel (renderer → main, request/response).
 * - `EVENTS` lists every push channel (main → renderer).
 * - `ProxyQaApi` is the exact shape exposed on `window.api` by the preload bridge.
 *
 * Every invoke handler returns an `IpcResult<T>` envelope; it never throws across IPC.
 */
import type {
  AppInfo,
  AppSettings,
  AppSettingsPatch,
  BrowserEngine,
  BrowserEngineInfo,
  BrowserInstallTarget,
  BrowserSession,
  BrowserWatchUpdate,
  BrowsersStatus,
  DashboardStats,
  DevicePresetInfo,
  IpInfo,
  IpcResult,
  LocationEntry,
  LocationQueryResult,
  LocationStats,
  LocationSearch,
  ProductKey,
  ProviderId,
  ProviderInfo,
  QuickLaunchInput,
  TargetingPreview,
  LogEntry,
  LogQuery,
  NetworkEntry,
  Profile,
  ProfileInput,
  ProxyConfigStatus,
  ProxyCredentialsInput,
  ProxyCredentialsUpdate,
  ProxySession,
  ProxyTestResult,
  SecurityStatus,
  SetupStatus,
  Task,
  TestRun,
  TestRunPatch,
} from './types'
import type {
  EnvironmentInput,
  SuiteInput,
  QaEnvironment,
  QaSuite,
  QaRecording,
  GatewayInput,
  MatrixInput,
  QaBatch,
  QaGateway,
  QaPolicy,
  QaScenario,
  QaSchedule,
  QaSnapshot,
  ScenarioInput,
  ScheduleInput,
  UpdateStatus,
} from './qa'
import type { QaFixture } from './qa-fixtures'

export const IPC = {
  desktop: {
    status: 'desktop:status',
    setup: 'desktop:setup',
    showPinning: 'desktop:show-pinning',
    launchInstalled: 'desktop:launch-installed',
    chooseUsb: 'desktop:choose-usb',
    applyUsb: 'desktop:apply-usb',
    applyOnline: 'desktop:apply-online',
    retryPendingUpdate: 'desktop:retry-pending-update',
    dismissUpdateNotice: 'desktop:dismiss-update-notice',
    updateAvailability: 'desktop:update-availability',
    openDownloadPage: 'desktop:open-download-page',
  },
  qa: {
    visualImages: 'qa:visual-images',
    saveEnvironment: 'qa:save-environment',
    deleteEnvironment: 'qa:delete-environment',
    saveSuite: 'qa:save-suite',
    deleteSuite: 'qa:delete-suite',
    exportSuite: 'qa:export-suite',
    approveBaseline: 'qa:approve-baseline',
    updateHealedSelector: 'qa:update-healed-selector',
    exportBaselines: 'qa:export-baselines',
    startRecording: 'qa:start-recording',
    recording: 'qa:recording',
    stopRecording: 'qa:stop-recording',
    chooseFixture: 'qa:choose-fixture',
    saveGateway: 'qa:save-gateway',
    testGateway: 'qa:test-gateway',
    deleteGateway: 'qa:delete-gateway',
    checkUpdates: 'qa:check-updates',
    downloadUpdate: 'qa:download-update',
    exportScenario: 'qa:export-scenario',
    snapshot: 'qa:snapshot',
    createWorkspace: 'qa:create-workspace',
    saveScenario: 'qa:save-scenario',
    deleteScenario: 'qa:delete-scenario',
    start: 'qa:start',
    cancel: 'qa:cancel',
    exportBatch: 'qa:export-batch',
    savePolicy: 'qa:save-policy',
    prune: 'qa:prune',
    backup: 'qa:backup',
    restore: 'qa:restore',
    saveSchedule: 'qa:save-schedule',
    deleteSchedule: 'qa:delete-schedule',
    diagnostics: 'qa:diagnostics',
  },
  app: {
    getInfo: 'app:get-info',
    openPath: 'app:open-path',
  },
  profiles: {
    list: 'profiles:list',
    get: 'profiles:get',
    create: 'profiles:create',
    update: 'profiles:update',
    duplicate: 'profiles:duplicate',
    delete: 'profiles:delete',
    presets: 'profiles:presets',
  },
  proxy: {
    providers: 'proxy:providers',
    getConfigStatus: 'proxy:get-config-status',
    testConnection: 'proxy:test-connection',
    getCurrentIp: 'proxy:get-current-ip',
    listSessions: 'proxy:list-sessions',
    rotateSession: 'proxy:rotate-session',
  },
  browser: {
    launch: 'browser:launch',
    close: 'browser:close',
    screenshot: 'browser:screenshot',
    listActive: 'browser:list-active',
    focus: 'browser:focus',
  },
  browsers: {
    status: 'browsers:status',
    install: 'browsers:install',
    installEngine: 'browsers:install-engine',
    uninstallEngine: 'browsers:uninstall-engine',
    installAllMissing: 'browsers:install-all-missing',
    openDownloadPage: 'browsers:open-download-page',
    engines: 'browsers:engines',
    redetect: 'browsers:redetect',
  },
  runs: {
    list: 'runs:list',
    get: 'runs:get',
    update: 'runs:update',
    delete: 'runs:delete',
    network: 'runs:network',
  },
  settings: {
    get: 'settings:get',
    update: 'settings:update',
  },
  logs: {
    list: 'logs:list',
    clear: 'logs:clear',
  },
  dashboard: {
    stats: 'dashboard:stats',
  },
  security: {
    status: 'security:status',
    saveCredentials: 'security:save-credentials',
    testCredentials: 'security:test-credentials',
    clearCredentials: 'security:clear-credentials',
    rotateKey: 'security:rotate-key',
    revealLocations: 'security:reveal-locations',
    updateCredentials: 'security:update-credentials',
    testCredentialsPartial: 'security:test-credentials-partial',
    openKeysWindow: 'security:open-keys-window',
    closeKeysWindow: 'security:close-keys-window',
  },
  setup: {
    status: 'setup:status',
    complete: 'setup:complete',
  },
  locations: {
    search: 'locations:search',
    query: 'locations:query',
    stats: 'locations:stats',
    random: 'locations:random',
    states: 'locations:states',
  },
  tasks: {
    list: 'tasks:list',
    cancel: 'tasks:cancel',
    retry: 'tasks:retry',
    clearFinished: 'tasks:clear-finished',
  },
  launcher: {
    preview: 'launcher:preview',
    quickLaunch: 'launcher:quick-launch',
    closeAll: 'launcher:close-all',
  },
  siteAccess: {
    status: 'site-access:status',
    save: 'site-access:save',
    setEnabled: 'site-access:set-enabled',
    delete: 'site-access:delete',
  },
} as const

export const EVENTS = {
  qaUpdate: 'event:qa-update',
  sessionUpdate: 'event:session-update',
  runUpdate: 'event:run-update',
  logEntry: 'event:log-entry',
  networkEntry: 'event:network-entry',
  proxySessionUpdate: 'event:proxy-session-update',
  tasksUpdate: 'event:tasks-update',
  browserWatch: 'event:browser-watch',
  securityUpdate: 'event:security-update',
  updateAvailable: 'event:update-available',
} as const

export type EventChannel = (typeof EVENTS)[keyof typeof EVENTS]

export interface EventPayloads {
  [EVENTS.qaUpdate]: QaBatch
  [EVENTS.sessionUpdate]: BrowserSession
  [EVENTS.runUpdate]: TestRun
  [EVENTS.logEntry]: LogEntry
  [EVENTS.networkEntry]: NetworkEntry
  [EVENTS.proxySessionUpdate]: ProxySession
  [EVENTS.tasksUpdate]: Task[]
  [EVENTS.browserWatch]: BrowserWatchUpdate
  [EVENTS.securityUpdate]: SecurityStatus
  /** Result of the single startup update check (or a remembered one that is still newer). */
  [EVENTS.updateAvailable]: UpdateAvailability
}

export type Unsubscribe = () => void

/** The complete bridge exposed to the renderer as `window.api`. */
export interface ProxyQaApi {
  desktop: {
    status(): Promise<IpcResult<DesktopStatus>>
    setup(options: DesktopSetupOptions): Promise<IpcResult<DesktopStatus>>
    showPinning(): Promise<IpcResult<void>>
    launchInstalled(): Promise<IpcResult<void>>
    chooseUsb(): Promise<IpcResult<UsbUpdatePreview | null>>
    applyUsb(): Promise<IpcResult<void>>
    applyOnline(): Promise<IpcResult<void>>
    /** Finish a pending update again after it failed on start (the update notice's Retry). */
    retryPendingUpdate(): Promise<IpcResult<DesktopStatus>>
    /** Hide the last update result (status.lastUpdate becomes null). */
    dismissUpdateNotice(): Promise<IpcResult<void>>
    /** The startup check's result in this run (null before it finished, when disabled or unconfigured). */
    updateAvailability(): Promise<IpcResult<UpdateAvailability | null>>
    /** Open the publisher's download page (macOS updates: status.updateDelivery === 'download-page'). Takes no URL. */
    openDownloadPage(): Promise<IpcResult<void>>
  }
  qa: {
    visualImages(
      batchId: string,
      caseId: string,
      stepIndex: number,
    ): Promise<IpcResult<{ actual: string; expected: string | null; diff: string | null }>>
    saveEnvironment(input: EnvironmentInput, id?: string): Promise<IpcResult<QaEnvironment>>
    deleteEnvironment(id: string): Promise<IpcResult<void>>
    saveSuite(input: SuiteInput, id?: string): Promise<IpcResult<QaSuite>>
    deleteSuite(id: string): Promise<IpcResult<void>>
    exportSuite(id: string): Promise<IpcResult<string>>
    approveBaseline(batchId: string, caseId: string, stepIndex: number): Promise<IpcResult<void>>
    /** Promotes the fallback a finished run healed with to that step's primary selector in the saved scenario. */
    updateHealedSelector(batchId: string, caseId: string, stepIndex: number): Promise<IpcResult<QaScenario>>
    exportBaselines(batchId: string): Promise<IpcResult<string>>
    startRecording(input: ScenarioInput): Promise<IpcResult<QaRecording>>
    recording(): Promise<IpcResult<QaRecording | null>>
    stopRecording(): Promise<IpcResult<QaRecording | null>>
    /** Pick a file in a main-process dialog; main reads it once and returns it as an upload fixture (null = cancelled). */
    chooseFixture(): Promise<IpcResult<QaFixture | null>>
    saveGateway(input: GatewayInput, id?: string): Promise<IpcResult<QaGateway>>
    testGateway(id: string): Promise<IpcResult<QaGateway>>
    deleteGateway(id: string): Promise<IpcResult<void>>
    checkUpdates(): Promise<IpcResult<UpdateStatus>>
    downloadUpdate(): Promise<IpcResult<string>>
    exportScenario(id: string): Promise<IpcResult<string>>
    snapshot(): Promise<IpcResult<QaSnapshot>>
    createWorkspace(name: string): Promise<IpcResult<QaSnapshot['workspaces'][number]>>
    saveScenario(input: ScenarioInput, id?: string): Promise<IpcResult<QaScenario>>
    deleteScenario(id: string): Promise<IpcResult<void>>
    start(input: MatrixInput): Promise<IpcResult<QaBatch>>
    cancel(id: string): Promise<IpcResult<void>>
    exportBatch(id: string, format: 'json' | 'junit' | 'html'): Promise<IpcResult<string>>
    savePolicy(input: QaPolicy): Promise<IpcResult<QaPolicy>>
    prune(): Promise<IpcResult<number>>
    backup(passphrase: string): Promise<IpcResult<string>>
    restore(passphrase: string): Promise<IpcResult<number | null>>
    saveSchedule(input: ScheduleInput, id?: string): Promise<IpcResult<QaSchedule>>
    deleteSchedule(id: string): Promise<IpcResult<void>>
    diagnostics(): Promise<IpcResult<string>>
  }
  app: {
    getInfo(): Promise<IpcResult<AppInfo>>
    /** Reveal a file (e.g. screenshot) in the OS file manager. */
    openPath(path: string): Promise<IpcResult<void>>
  }
  profiles: {
    list(): Promise<IpcResult<Profile[]>>
    get(id: string): Promise<IpcResult<Profile>>
    create(input: ProfileInput): Promise<IpcResult<Profile>>
    update(id: string, input: ProfileInput): Promise<IpcResult<Profile>>
    duplicate(id: string): Promise<IpcResult<Profile>>
    delete(id: string): Promise<IpcResult<void>>
    presets(): Promise<IpcResult<DevicePresetInfo[]>>
  }
  proxy: {
    /** Registered proxy providers with their capabilities and password-free configuration status, in picker order. */
    providers(): Promise<IpcResult<ProviderInfo[]>>
    /** Password-free configuration of one provider (default: settings.defaultProviderId). */
    getConfigStatus(providerId?: ProviderId): Promise<IpcResult<ProxyConfigStatus>>
    /**
     * Test proxy for a profile (uses its provider and sticky session) or the raw gateway when profileId is null.
     * `pool` / `providerId` pick the product and provider of a raw gateway test (default: settings.defaultProxyPool /
     * settings.defaultProviderId); both are ignored for profiles.
     */
    testConnection(profileId: string | null, pool?: ProductKey, providerId?: ProviderId): Promise<IpcResult<ProxyTestResult>>
    getCurrentIp(profileId: string | null): Promise<IpcResult<IpInfo>>
    listSessions(): Promise<IpcResult<ProxySession[]>>
    /** Assigns a fresh sticky session id to the profile and re-tests. */
    rotateSession(profileId: string): Promise<IpcResult<ProxySession>>
  }
  browser: {
    launch(profileId: string): Promise<IpcResult<BrowserSession>>
    close(sessionId: string): Promise<IpcResult<void>>
    /** Captures a screenshot; returns the absolute file path and updates the run. */
    screenshot(sessionId: string): Promise<IpcResult<string>>
    listActive(): Promise<IpcResult<BrowserSession[]>>
    /** Bring the session's browser window to the front (restoring it when minimised, Chromium family). */
    focus(sessionId: string): Promise<IpcResult<void>>
  }
  browsers: {
    /**
     * Queue a background install of an installed-kind engine with its automatic method (winget, vendor
     * package / portable archive extracted into the app data folder, or Playwright's vendor installer).
     * Returns the task at once (an identical queued/running task is returned instead of a duplicate);
     * progress, verification and the outcome arrive on event:tasks-update.
     */
    installEngine(engine: BrowserEngine): Promise<IpcResult<Task>>
    /** Queue the removal of the copy the app installed into its data folder (and its auto-saved path). */
    uninstallEngine(engine: BrowserEngine): Promise<IpcResult<Task>>
    /** Queue an install for every missing engine that has an automatic method (vendor browsers only). */
    installAllMissing(): Promise<IpcResult<Task[]>>
    /** Open the vendor download page in the system browser and watch for the install to appear (event:browser-watch). */
    openDownloadPage(engine: BrowserEngine): Promise<IpcResult<void>>
    status(): Promise<IpcResult<BrowsersStatus>>
    /**
     * Queue the download of a bundled Playwright engine, or of every missing bundled engine for 'all'
     * (one task per engine). Installed browsers are never downloaded here.
     */
    install(engine: BrowserInstallTarget): Promise<IpcResult<Task[]>>
    /** Availability of every engine (bundled + installed), served from a short-lived cache. */
    engines(): Promise<IpcResult<BrowserEngineInfo[]>>
    /** Drop the detection cache and scan the machine again (after installing a browser or changing an override). */
    redetect(): Promise<IpcResult<BrowserEngineInfo[]>>
  }
  runs: {
    list(limit?: number): Promise<IpcResult<TestRun[]>>
    get(id: string): Promise<IpcResult<TestRun>>
    update(id: string, patch: TestRunPatch): Promise<IpcResult<TestRun>>
    delete(id: string): Promise<IpcResult<void>>
    network(runId: string): Promise<IpcResult<NetworkEntry[]>>
  }
  settings: {
    get(): Promise<IpcResult<AppSettings>>
    update(patch: AppSettingsPatch): Promise<IpcResult<AppSettings>>
  }
  logs: {
    list(query?: LogQuery): Promise<IpcResult<LogEntry[]>>
    clear(): Promise<IpcResult<void>>
  }
  dashboard: {
    stats(): Promise<IpcResult<DashboardStats>>
  }
  security: {
    /** Local, network-free health check of key + vault. */
    status(): Promise<IpcResult<SecurityStatus>>
    /** Live test of the given credentials (`providerId` + product `pool`) through that provider's gateway WITHOUT persisting them. */
    testCredentials(input: ProxyCredentialsInput): Promise<IpcResult<ProxyTestResult>>
    /** Encrypt + persist credentials of one provider product, verify by reading them back, and activate them immediately. */
    saveCredentials(input: ProxyCredentialsInput): Promise<IpcResult<SecurityStatus>>
    /** Remove one provider product's credentials from the vault. */
    clearCredentials(providerId: ProviderId, product: ProductKey): Promise<IpcResult<SecurityStatus>>
    /** Generate a new per-machine key and re-wrap the vault with it. */
    rotateKey(): Promise<IpcResult<SecurityStatus>>
    /** Reveal the key or vault directory in the OS file manager. */
    revealLocations(which: 'key' | 'vault'): Promise<IpcResult<void>>
    /**
     * Merge a partial update with the provider product's stored vault entry inside the main process (empty
     * fields keep the stored value), validate the merged credentials, encrypt + persist + verify.
     */
    updateCredentials(input: ProxyCredentialsUpdate): Promise<IpcResult<SecurityStatus>>
    /** Live test of the merged (stored + partial update) credentials WITHOUT persisting anything. */
    testCredentialsPartial(input: ProxyCredentialsUpdate): Promise<IpcResult<ProxyTestResult>>
    /** Open (or focus) the single "Manage proxy keys" window. */
    openKeysWindow(): Promise<IpcResult<void>>
    /** Close the "Manage proxy keys" window (Close button, inactivity timeout). */
    closeKeysWindow(): Promise<IpcResult<void>>
  }
  locations: {
    /** Type-to-search over the bundled US dataset (states / cities / ZIPs). */
    search(input: LocationSearch): Promise<IpcResult<LocationEntry[]>>
    /** Search plus the uncapped match count ("50 of 2,341"). */
    query(input: LocationSearch): Promise<IpcResult<LocationQueryResult>>
    /** Size of the bundled dataset (states / cities / ZIP codes). */
    stats(): Promise<IpcResult<LocationStats>>
    /** A random entry of the given kind; `stateCode` keeps cities / ZIP codes inside one state. */
    random(mode: LocationSearch['mode'], stateCode?: string | null): Promise<IpcResult<LocationEntry>>
    /** All states (for a compact dropdown). */
    states(): Promise<IpcResult<LocationEntry[]>>
  }
  tasks: {
    /** Active tasks in queue order, then the most recent finished ones. */
    list(): Promise<IpcResult<Task[]>>
    /** Cancel a queued or running task (a running installer's process tree is terminated). */
    cancel(taskId: string): Promise<IpcResult<Task>>
    /** Queue the same work again after a failure or cancellation. */
    retry(taskId: string): Promise<IpcResult<Task>>
    /** Forget finished tasks; returns the remaining list. */
    clearFinished(): Promise<IpcResult<Task[]>>
  }
  launcher: {
    /** The exact provider targeting string (no secrets) that quickLaunch would send. */
    preview(input: QuickLaunchInput): Promise<IpcResult<TargetingPreview>>
    /** Create the (ephemeral or saved) profile and launch it; returns the BrowserSession like browser.launch. */
    quickLaunch(input: QuickLaunchInput): Promise<IpcResult<BrowserSession>>
    /** Terminate every open browser session. */
    closeAll(): Promise<IpcResult<void>>
  }
  setup: {
    status(): Promise<IpcResult<SetupStatus>>
    /** Mark first-run setup as completed for this installation. */
    complete(): Promise<IpcResult<SetupStatus>>
  }
  /** Site access tokens (Settings → Advanced). Responses never contain a header value, only a masked preview. */
  siteAccess: {
    status(): Promise<IpcResult<SiteAccessStatus>>
    /** Create (no id) or update a token; on update an empty/omitted headerValue keeps the stored secret. */
    save(input: SiteAccessTokenInput, id?: string): Promise<IpcResult<SiteAccessTokenSummary>>
    setEnabled(id: string, enabled: boolean): Promise<IpcResult<SiteAccessTokenSummary>>
    delete(id: string): Promise<IpcResult<void>>
  }
  events: {
    on<C extends EventChannel>(channel: C, listener: (payload: EventPayloads[C]) => void): Unsubscribe
  }
}

declare global {
  interface Window {
    api: ProxyQaApi
  }
}

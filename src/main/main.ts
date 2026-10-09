/**
 * Electron main module. Loaded by `index.ts` (the process entry) only after
 * PLAYWRIGHT_BROWSERS_PATH has been exported, so playwright-core picks up the
 * provisioned browsers directory.
 *
 * Bootstrap order matters:
 *   1. privileged scheme registration and the single-instance lock (before `ready`)
 *   2. paths → .env (development only) → database → logger (secrets registered
 *      before anything logs, proxy credentials removed from process.env so child
 *      processes never inherit them)
 *   3. process toolkit → provisioner → ip checker → provider → managers → background
 *      task manager (installs) → clean-up of browsers left open by a crashed run
 *   4. after `ready`: credential vault (safeStorage needs `ready`), screenshot
 *      protocol, CSP header, IPC handlers, main window
 *
 * Credential precedence: vault (decrypted and holding credentials) → `.env`
 * (never in packaged builds) → none. Every registered provider is re-pointed
 * whenever the vault changes.
 *
 * Any failure during bootstrap is shown in a native error box and the app exits;
 * it never dies silently.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { BrowserWindow, app, dialog, ipcMain, net, protocol, safeStorage, session, shell } from 'electron'
import originalFs from 'original-fs'

import { EVENTS } from '@shared/ipc'
import { DESKTOP_APP_ID, DESKTOP_APP_NAME, USB_MANIFEST_NAME } from '@shared/desktop'
import { createDesktopIntegration, newerInstalledCopy } from './desktop/integration'
import type { DesktopIntegration } from './desktop/integration'
import { restoreRelaunchEnvironment } from './desktop/relaunch-env'
import { pidToAwait, restartPlan, waitForExit } from './desktop/restart'
import { updateDirectories } from './desktop/update-paths'

import { createBrowserManager } from './browser/browser-manager'
import { createBrowserProvisioner } from './browser/browser-provisioner'
import type { ExecutablePathStore } from './browser/executable-paths'
import { webkitLibsDirFromEnv } from './browser/browsers-path'
import { nodeDetectFs } from './browser/engine-detect'
import { sweepPostInstall } from './browser/installers/post-install-sweep'
import { createProfileManager } from './browser/profile-manager'
import { defaultEnvCandidates, loadDotEnv, readProviderEnv, scrubProxySecretEnv } from './config/env'
import { resolveAppPaths } from './config/paths'
import { AppException } from './contracts'
import type {
  BrowserManager,
  BrowserProvisioner,
  CredentialVault,
  Database,
  Logger,
  StoredProxyCredentials,
  TaskManager,
} from './contracts'
import { openDatabase } from './database/index'
import { createBroadcaster, registerIpcHandlers } from './ipc/index'
import { SCREENSHOT_SCHEME, resolveScreenshotRequest } from './ipc/screenshot-protocol'
import { createLauncher } from './launcher/launcher'
import { resolveGeoNamesDir } from './locations/geonames-loader'
import { createLocationsService } from './locations/locations-service'
import { createLogger } from './logging/logger'
import { compileSecrets, redactString } from './logging/redact'
import { createIpChecker } from './proxy/ip-checker'
import { dataImpulseDialect } from './proxy/providers/dataimpulse'
import { BUILT_IN_DIALECTS, ProviderRegistry } from './proxy/providers/registry'
import { createProxyManager } from './proxy/proxy-manager'
import { createCredentialVault } from './security/credential-vault'
import { createInstallStateStore } from './security/install-state'
import { selectKeyWrapper } from './security/key-wrapper'
import { readMachineIdentity } from './security/machine-identity'
import { LIVE_SESSIONS_FILE_NAME, fileLiveSessionsStore } from './sessions/live-sessions-store'
import type { LiveSessionsStore } from './sessions/live-sessions-store'
import { cleanupOrphanedSessions } from './sessions/orphan-cleanup'
import { createProcessToolkit, sessionRootPids } from './system/processes'
import { createInstallExecutor, engineBusyMessage, engineName, verifyEngine } from './tasks/install-executor'
import { createSmokeLauncher } from './tasks/smoke-launch'
import { TASK_HISTORY_FILE_NAME, createTaskManager } from './tasks/task-manager'
import { withTimeout } from './util/timeout'
import { createQaService } from './qa/service'
import { createQaExecutor, createQaSessionFactory } from './qa/runtime'
import { createRecorderManager } from './qa/recorder'
import type { RecorderManager } from './qa/recorder'
import { createVisualStore } from './qa/visual'
import type { QaService } from './qa/service'
import { createGatewayManager } from './qa/gateways'
import { SITE_ACCESS_FILE_NAME, createSiteAccess } from './site-access'
import { createUpdateManager } from './releases/updates'
import type { UpdateConfig } from './releases/updates'
import { resolveAppIconPath } from './windows/app-icon'
import { KEYS_WINDOW_ROUTE, createKeysWindowController, keysWindowOptions } from './windows/keys-window'

const WINDOW_BACKGROUND = '#0b0f19'
const SCOPE = 'app'
/** Upper bound for closing every browser session on quit; the app quits regardless afterwards. */
const SHUTDOWN_TIMEOUT_MS = 8_000
/** Upper bound for cancelling a running install on quit. */
const TASKS_SHUTDOWN_TIMEOUT_MS = 10_000
/** Upper bound for terminating browsers a crashed run left open. */
const ORPHAN_CLEANUP_TIMEOUT_MS = 20_000
/** Chromium reports a cancelled load as ERR_ABORTED (-3); that is not a failure. */
const ERR_ABORTED = -3

/** Mirrors the <meta http-equiv="Content-Security-Policy"> in src/renderer/index.html. */
const CSP_PRODUCTION =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: file: proxyqa:; font-src 'self'; connect-src 'self'"
/** Development adds what Vite's dev server and HMR need. */
const CSP_DEVELOPMENT =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: file: proxyqa:; font-src 'self'; connect-src 'self' ws: http://localhost:* http://127.0.0.1:*"

const rendererDevUrl = process.env.ELECTRON_RENDERER_URL
const isDev = !app.isPackaged && Boolean(rendererDevUrl)

/**
 * The electron-vite output directory holding main/, preload/ and renderer/.
 * This module is a Rollup chunk, so its location is a build detail; the stable
 * anchor is `app.getAppPath()` (project root in dev, app.asar when packaged).
 * When Electron is pointed straight at out/main/index.js, getAppPath() is that
 * folder instead, so fall back to this chunk's own parent directory.
 */
function resolveOutDir(): string {
  const candidates = [join(app.getAppPath(), 'out'), resolve(__dirname, '..')]
  return candidates.find((dir) => existsSync(join(dir, 'preload', 'index.cjs'))) ?? candidates[0]!
}

const OUT_DIR = resolveOutDir()
const PRELOAD_PATH = join(OUT_DIR, 'preload', 'index.cjs')
const RENDERER_INDEX = join(OUT_DIR, 'renderer', 'index.html')

app.setAppUserModelId(DESKTOP_APP_ID)
if (process.platform === 'linux') app.setDesktopName(`${DESKTOP_APP_ID}.desktop`)

// --- Before `ready` -----------------------------------------------------------

// Development smoke tests use an explicit isolated directory before the instance lock.
if (!app.isPackaged && process.env.PROXY_QA_TEST_DATA_DIR)
  app.setPath('userData', resolve(process.env.PROXY_QA_TEST_DATA_DIR))

protocol.registerSchemesAsPrivileged([
  { scheme: SCREENSHOT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

// Started by a previous release that is restarting into this one (Linux, see desktop/restart.ts):
// let it exit first so the single-instance lock is free.
const previousRelease = pidToAwait(process.argv)
if (previousRelease !== null) waitForExit(previousRelease)

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

// --- Bootstrap ----------------------------------------------------------------

interface Runtime {
  recorder: RecorderManager
  qa: QaService
  qaTimer: ReturnType<typeof setInterval>
  db: Database
  logger: Logger
  browser: BrowserManager
  provisioner: BrowserProvisioner
  tasks: TaskManager
  liveSessions: LiveSessionsStore
  disposeIpc: () => void
}

let runtime: Runtime | null = null
let mainWindow: BrowserWindow | null = null
let quitting = false

function stripHash(url: string): string {
  const index = url.indexOf('#')
  return index === -1 ? url : url.slice(0, index)
}

/**
 * Shared renderer hardening for every app window: a failed load is reported instead of
 * leaving a blank window, window.open is denied, and only the app's own document may load.
 */
function hardenWindow(window: BrowserWindow, appUrl: string, logger: Logger): void {
  // A renderer that fails to load must never leave the user staring at nothing.
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === ERR_ABORTED) return
    logger.error(SCOPE, 'Renderer failed to load', { errorCode, errorDescription, url: validatedURL })
    if (!window.isDestroyed()) {
      window.show()
      dialog.showErrorBox(
        'Proxy QA Browser could not load its interface',
        `${errorDescription} (code ${errorCode})\n\nURL: ${validatedURL}\n\nCheck the application log and reinstall if the problem persists.`,
      )
    }
  })

  // No popups: everything the renderer needs is in-app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    logger.warn(SCOPE, 'Blocked window.open from renderer', { url })
    return { action: 'deny' }
  })

  // Only the app's own document may be (re)loaded; no external navigation.
  const allowed = stripHash(appUrl)
  window.webContents.on('will-navigate', (event, url) => {
    if (stripHash(url) !== allowed) {
      event.preventDefault()
      logger.warn(SCOPE, 'Blocked navigation from renderer', { url })
    }
  })
}

/** Load the renderer, optionally at a hash route (e.g. '/keys'). */
function loadRenderer(window: BrowserWindow, route?: string): void {
  if (isDev && rendererDevUrl) void window.loadURL(route ? `${stripHash(rendererDevUrl)}#${route}` : rendererDevUrl)
  else void window.loadFile(RENDERER_INDEX, route ? { hash: route } : undefined)
}

/** The "Manage proxy keys" window (see windows/keys-window.ts for its security properties). */
function createKeysWindow(appUrl: string, logger: Logger): BrowserWindow {
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  const window = new BrowserWindow(
    keysWindowOptions({
      parent,
      preload: PRELOAD_PATH,
      backgroundColor: WINDOW_BACKGROUND,
      isPackaged: app.isPackaged,
      platform: process.platform,
      icon: appIconPath(),
    }),
  )
  // Blocks screen capture on Windows and macOS; a no-op on Linux.
  window.setContentProtection(true)
  // Keep the fixed title instead of the document's <title>.
  window.on('page-title-updated', (event) => event.preventDefault())
  window.once('ready-to-show', () => window.show())
  hardenWindow(window, appUrl, logger)
  loadRenderer(window, KEYS_WINDOW_ROUTE)
  logger.info(SCOPE, 'Opened the Manage proxy keys window')
  return window
}

/** Linux window icon (null elsewhere: Windows/macOS use the executable / bundle icon). */
function appIconPath(): string | null {
  return resolveAppIconPath({
    platform: process.platform,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  })
}

function createWindow(appUrl: string, logger: Logger): BrowserWindow {
  const icon = appIconPath()
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: WINDOW_BACKGROUND,
    show: false,
    autoHideMenuBar: true,
    title: 'Proxy QA Browser',
    ...(icon ? { icon } : {}),
    webPreferences: {
      // electron-vite emits the CommonJS preload as index.cjs (package.json is "type": "module").
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  })

  window.once('ready-to-show', () => window.show())
  hardenWindow(window, appUrl, logger)

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  loadRenderer(window)
  if (isDev && rendererDevUrl) window.webContents.openDevTools({ mode: 'detach' })
  return window
}

/** Offer the newer computer copy when an older copy was opened; choosing it restarts into that copy. */
async function offerNewerCopy(
  window: BrowserWindow,
  desktop: DesktopIntegration,
  current: string,
  newer: string,
  logger: Logger,
): Promise<void> {
  try {
    const { response } = await dialog.showMessageBox(window, {
      type: 'info',
      title: DESKTOP_APP_NAME,
      message: `Version ${newer} is set up on this computer`,
      detail: `You opened an older copy (version ${current}). Open the installed version to use your latest update.`,
      buttons: [`Open version ${newer}`, `Keep using ${current}`],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (response === 0) await desktop.openInstalled()
  } catch (err) {
    logger.warn(SCOPE, 'Could not open the newer computer copy', { error: err })
  }
}

function installCspHeader(csp: string): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    })
  })
}

function installScreenshotProtocol(db: Database, logger: Logger): void {
  protocol.handle(SCREENSHOT_SCHEME, async (request) => {
    const decision = resolveScreenshotRequest(request.url, db.settings.get().screenshotDir)
    if (decision.kind === 'bad-request') {
      return new Response('Bad request', { status: 400, headers: { 'content-type': 'text/plain' } })
    }
    if (decision.kind === 'forbidden') {
      logger.warn(SCOPE, 'Refused screenshot request outside the screenshot folder', { reason: decision.reason })
      return new Response('Forbidden', { status: 403, headers: { 'content-type': 'text/plain' } })
    }
    try {
      return await net.fetch(pathToFileURL(decision.path).toString())
    } catch {
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })
    }
  })
}

async function bootstrap(): Promise<Runtime> {
  const paths = resolveAppPaths(app.getPath('userData'))

  // `.env` is a development convenience only. Packaged builds never read it: the
  // encrypted vault is the single source of proxy credentials once installed.
  const envFile =
    app.isPackaged || Boolean(process.env.PROXY_QA_TEST_DATA_DIR)
      ? { loadedFrom: null }
      : loadDotEnv(
          defaultEnvCandidates({
            cwd: process.cwd(),
            execDir: dirname(process.execPath),
            userData: paths.userData,
            isPackaged: app.isPackaged,
            portableDir: process.env.PORTABLE_EXECUTABLE_DIR ?? null,
            appImagePath: process.env.APPIMAGE ?? null,
          }),
        )

  const db = openDatabase(paths.database, { defaultScreenshotDir: paths.screenshots })
  const baseLogger = createLogger({ repo: db.logs, fileDir: paths.logs, console: !app.isPackaged })

  // One secret registry feeds both the logger and the IPC sanitiser: whatever any module
  // registers through the logger (vault, provider, candidate credentials under test) is
  // redacted from log lines and from every error message crossing IPC.
  const secrets: string[] = []
  const logger: Logger = {
    ...baseLogger,
    registerSecret: (value) => {
      if (typeof value === 'string' && value.length > 0 && !secrets.includes(value)) secrets.push(value)
      baseLogger.registerSecret(value)
    },
  }
  const sanitize = (text: string): string => redactString(text, compileSecrets(secrets))

  // Development .env: QA_PROVIDER* variables, or the DATAIMPULSE_PROXY_* alias (one login → the residential product).
  const dialectInfo = (id: string): { defaults: { host: string; port: number }; extraFieldKeys: string[]; productKeys: string[] } | null => {
    const dialect = BUILT_IN_DIALECTS.find((candidate) => candidate.id === id)
    return dialect
      ? {
          defaults: dialect.capabilities.defaults,
          extraFieldKeys: dialect.capabilities.extraCredentialFields.map((field) => field.key),
          productKeys: dialect.capabilities.products.map((product) => product.key),
        }
      : null
  }
  const proxyEnv = app.isPackaged ? { config: null, missing: [] as string[], warnings: [] as string[] } : readProviderEnv(process.env, dialectInfo)
  // The providers keep the credentials in memory; nothing else may read them. Removing them from
  // process.env keeps Playwright's browser processes and the installer child from inheriting them.
  scrubProxySecretEnv(process.env)
  const envCredentials: StoredProxyCredentials | null = proxyEnv.config
    ? {
        providerId: proxyEnv.config.providerId,
        pool: proxyEnv.config.product ?? dialectInfo(proxyEnv.config.providerId)?.productKeys[0] ?? 'residential',
        host: proxyEnv.config.host,
        port: proxyEnv.config.port,
        username: proxyEnv.config.username,
        password: proxyEnv.config.password,
        sessionTemplate: null,
        extras: proxyEnv.config.extras,
      }
    : null
  if (envCredentials) {
    logger.registerSecret(envCredentials.password)
    logger.registerSecret(`${envCredentials.username}:${envCredentials.password}`)
    for (const value of Object.values(envCredentials.extras)) logger.registerSecret(value)
  }

  logger.info(SCOPE, 'app startup', {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    userData: paths.userData,
    database: paths.database,
    logs: paths.logs,
    envFile: envFile.loadedFrom,
    envCredentials: envCredentials ? envCredentials.providerId : null,
    envMissing: proxyEnv.missing,
    envWarnings: proxyEnv.warnings,
  })

  const getSettings = (): ReturnType<Database['settings']['get']> => db.settings.get()
  // Saved executable paths are read on every detection (a path saved in Settings applies at once);
  // the provisioner writes auto-detected / freshly installed paths back with origin 'auto'.
  const executablePaths: ExecutablePathStore = {
    get: () => {
      const settings = getSettings()
      return { executables: settings.browserExecutables, origins: settings.browserExecutableOrigins }
    },
    set: (next) => {
      db.settings.update({ browserExecutables: next.executables, browserExecutableOrigins: next.origins })
    },
  }
  const toolkit = createProcessToolkit()
  // The task manager is created after the provisioner it drives; detection asks it which engine is being installed.
  let tasks: TaskManager | null = null
  const provisioner = createBrowserProvisioner({
    paths,
    logger,
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
    executablePaths,
    isEngineBusy: (engine) => tasks?.isEngineInstalling(engine) ?? false,
  })
  const busyMessage = (engine: Parameters<typeof engineBusyMessage>[1]): string | null =>
    tasks ? engineBusyMessage(tasks.list(), engine) : null
  const liveSessions = fileLiveSessionsStore(join(paths.data, LIVE_SESSIONS_FILE_NAME), (err) =>
    logger.warn(SCOPE, 'Could not save the open-sessions record', { error: err }),
  )
  const webkitLibsDir = webkitLibsDirFromEnv()
  if (webkitLibsDir)
    logger.info(SCOPE, `WebKit host libraries bundled at ${webkitLibsDir} (Playwright host validation skipped)`)
  const ipChecker = createIpChecker({ getSettings, logger })
  // Proxy providers: one GatewayProvider per built-in dialect; profiles pick theirs by id.
  const providers = new ProviderRegistry({ ipChecker, logger })
  for (const dialect of BUILT_IN_DIALECTS) {
    providers.register(dialect, {
      // Read at request time, so a changed setting applies to the next connection.
      getEncoding: () => getSettings().providerOptions[dialect.id]?.encoding ?? dialect.capabilities.encodingOptions?.[0] ?? '',
      ...(dialect.id === dataImpulseDialect.id && process.env.DATAIMPULSE_SESSION_TEMPLATE ? { sessionTemplate: process.env.DATAIMPULSE_SESSION_TEMPLATE } : {}),
    })
  }
  // The development .env applies until the vault (available after `ready`) says otherwise.
  if (envCredentials) {
    if (providers.has(envCredentials.providerId)) providers.get(envCredentials.providerId).setCredentials([envCredentials], 'env')
    else logger.warn(SCOPE, `The development .env names an unknown proxy provider "${envCredentials.providerId}"; ignoring it`)
  }
  /** Where the active credentials come from: the vault when any provider uses it, else the .env, else none. */
  const activeCredentialSource = (): 'vault' | 'env' | 'none' => {
    const sources = providers.all().map((provider) => provider.getConfigStatus().source)
    return sources.includes('vault') ? 'vault' : sources.includes('env') ? 'env' : 'none'
  }
  const locations = createLocationsService({
    dataDir: resolveGeoNamesDir({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    }),
    logger,
  })
  let vault: CredentialVault | null = null
  const proxy = createProxyManager({
    providers,
    defaultProviderId: () => getSettings().defaultProviderId,
    sessions: db.proxySessions,
    profiles: db.profiles,
    logger,
    locations,
    defaultPool: () => getSettings().defaultProxyPool,
    onGatewayTest: (status, at) => vault?.recordProxyTest(status, at),
  })
  const profiles = createProfileManager({ repo: db.profiles, logger, providers })
  // Site access tokens: per device, encrypted with safeStorage once `ready` (unlocked below); never in backups or CI.
  const siteAccess = createSiteAccess({ file: join(paths.data, SITE_ACCESS_FILE_NAME), logger })
  const browser = createBrowserManager({
    profiles,
    proxy,
    ipChecker,
    provisioner,
    runs: db.testRuns,
    network: db.network,
    getSettings,
    logger,
    engineBusyMessage: busyMessage,
    liveSessions,
    findBrowserPid: async (sessionId) => sessionRootPids(await toolkit.listMarked(), sessionId)[0] ?? null,
    siteAccess,
  })
  const launcher = createLauncher({
    profiles,
    browser,
    targeting: providers,
    locations,
    getSettings,
    logger,
    engineBusyMessage: busyMessage,
  })

  // Background installs: one at a time, each verified with a headless launch (no window), never started on its own.
  const smoke = createSmokeLauncher({ logger, webkitLibsDir, toolkit })
  const taskManager = createTaskManager({
    executor: createInstallExecutor({
      provisioner,
      logger,
      verify: (engine, signal) =>
        verifyEngine(engine, { provisioner, isFile: (filePath) => nodeDetectFs.isFile(filePath), smoke }, signal),
      sweep: (engine, executablePath, startedAtMs) =>
        sweepPostInstall({
          executablePath,
          startedAtMs,
          ownPids: () => new Set(browser.sessionPids()),
          toolkit,
          logger,
          label: engineName(engine),
        }),
    }),
    killTree: (pid) => toolkit.killTree(pid),
    logger,
    historyFile: join(paths.data, TASK_HISTORY_FILE_NAME),
  })
  tasks = taskManager

  // Browsers a crashed or killed run left open (recorded in live-sessions.json) are terminated, their runs closed.
  await withTimeout(
    cleanupOrphanedSessions({ store: liveSessions, toolkit, runs: db.testRuns, logger }),
    ORPHAN_CLEANUP_TIMEOUT_MS,
    'Cleaning up sessions from the previous run',
  ).catch((err: unknown) =>
    logger.warn(SCOPE, 'Could not finish cleaning up sessions from the previous run', { error: err }),
  )

  await app.whenReady()

  // Credential vault. safeStorage is only usable after `ready`, hence the position.
  // Startup never runs a proxy test (quota): health is purely local.
  const machine = await readMachineIdentity()
  const keyWrappers = selectKeyWrapper({ safeStorage, platform: process.platform, machine })
  const install = createInstallStateStore({ userData: paths.userData, appVersion: app.getVersion() })
  if (install.recoveredFrom) {
    logger.warn(
      SCOPE,
      'install.json was unreadable and has been recreated; saved proxy credentials must be re-entered',
      { movedTo: install.recoveredFrom },
    )
  }
  const credentialVault = await createCredentialVault({
    paths,
    logger,
    wrapper: keyWrappers.primary,
    machine,
    install,
    activeSource: activeCredentialSource,
    // Extra credential fields a provider declares secret are registered with the logger like passwords.
    secretExtraKeys: (providerId) =>
      providers.has(providerId)
        ? providers.get(providerId).capabilities.extraCredentialFields.filter((field) => field.secret).map((field) => field.key)
        : [],
  })
  vault = credentialVault
  // Precedence per installation: a vault holding any credentials wins outright (each provider gets its own
  // products); otherwise the development .env (its provider only); otherwise nothing.
  const applyCredentialSource = (fromVault: StoredProxyCredentials[]): void => {
    const unknown = [...new Set(fromVault.map((entry) => entry.providerId).filter((id) => !providers.has(id)))]
    if (unknown.length > 0) logger.warn(SCOPE, `The vault holds credentials for proxy providers this version does not support: ${unknown.join(', ')}; they are kept but not used`)
    for (const provider of providers.all()) {
      if (fromVault.length > 0) provider.setCredentials(fromVault.filter((entry) => entry.providerId === provider.name), 'vault')
      else if (envCredentials && envCredentials.providerId === provider.name) provider.setCredentials([envCredentials], 'env')
      else provider.setCredentials([], 'none')
    }
  }
  applyCredentialSource(credentialVault.getAll())
  credentialVault.onChange(applyCredentialSource)

  const health = await credentialVault.status()
  logger.info(
    SCOPE,
    `credential vault: backend=${health.keyBackendLabel} decryptOk=${health.decryptOk} source=${health.source} products=${
      Object.entries(health.configuredProducts)
        .map(([id, products]) => `${id}:${products.join('+')}`)
        .join(',') || 'none'
    }`,
    {
      keyBackend: health.keyBackend,
      configuredProducts: health.configuredProducts,
      keyPresent: health.keyPresent,
      vaultPresent: health.vaultPresent,
      permissionsOk: health.permissionsOk,
      keyPath: health.keyPath,
      vaultPath: health.vaultPath,
      machineIdSource: machine.source,
      safeStorageBackend: keyWrappers.assessment.linuxBackend,
    },
  )
  if (keyWrappers.assessment.reason)
    logger.warn(SCOPE, `OS keychain not used for the vault key: ${keyWrappers.assessment.reason}`)
  for (const warning of health.warnings) logger.warn(SCOPE, warning)

  installScreenshotProtocol(db, logger)
  installCspHeader(isDev ? CSP_DEVELOPMENT : CSP_PRODUCTION)

  const broadcast = createBroadcaster(
    () => BrowserWindow.getAllWindows().map((w) => w.webContents),
    (err) => logger.warn(SCOPE, 'Failed to push event to a window', { error: err }),
  )
  const appUrl = isDev && rendererDevUrl ? rendererDevUrl : pathToFileURL(RENDERER_INDEX).toString()
  if (!db.qa) throw new AppException('INTERNAL', 'QA storage did not initialize.')
  const gateways = createGatewayManager(db.qa, keyWrappers.assessment.usable ? safeStorage : null, ipChecker, logger)
  siteAccess.unlock(keyWrappers.assessment.usable ? safeStorage : null)
  const visuals = createVisualStore(join(paths.data, 'qa-baselines'))
  const recorder = createRecorderManager({
    profiles,
    open: createQaSessionFactory(
      provisioner,
      proxy,
      sanitize,
      logger,
      { resolve: gateways.resolve, checker: ipChecker },
      siteAccess,
    ),
  })
  const qa = createQaService({
    canStart: () => !recorder.isBusy(),
    store: db.qa,
    profiles,
    artifactRoot: join(paths.data, 'qa-artifacts'),
    execute: createQaExecutor(
      provisioner,
      proxy,
      sanitize,
      logger,
      { resolve: gateways.resolve, checker: ipChecker },
      visuals,
      siteAccess,
    ),
    onUpdate: (batch) => broadcast(EVENTS.qaUpdate, batch),
  })
  const metadataFile = join(app.getAppPath(), 'package.json')
  const metadata = (existsSync(metadataFile) ? JSON.parse(readFileSync(metadataFile, 'utf8')) : {}) as {
    qaUpdates?: UpdateConfig
    qaOfflineUpdates?: { publicKey: string }
    qaReleaseNotes?: string[]
  }
  const updateDirs = updateDirectories(paths.data)
  const updates = createUpdateManager({
    config: metadata.qaUpdates ?? null,
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    directory: updateDirs.downloads,
  })
  const desktop = createDesktopIntegration({
    fileSystem: originalFs.promises,
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    version: app.getVersion(),
    executable: process.execPath,
    portableExecutable: process.env.PORTABLE_EXECUTABLE_FILE ?? null,
    appImage: process.env.APPIMAGE ?? null,
    resourcesPath: process.resourcesPath,
    root:
      process.platform === 'win32'
        ? join(process.env.LOCALAPPDATA ?? app.getPath('appData'), 'ProxyQABrowser')
        : join(process.env.XDG_DATA_HOME ?? join(app.getPath('home'), '.local', 'share'), 'proxy-qa-browser'),
    desktopDirectory: app.getPath('desktop'),
    menuDirectory:
      process.platform === 'win32'
        ? join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
        : join(process.env.XDG_DATA_HOME ?? join(app.getPath('home'), '.local', 'share'), 'applications'),
    updatesDirectory: updateDirs.staged,
    onlineDownloadsDirectory: updateDirs.downloads,
    publicKey: metadata.qaOfflineUpdates?.publicKey ?? null,
    releaseNotes: metadata.qaReleaseNotes ?? [],
    writeWindowsShortcut: (path, options) => shell.writeShortcutLink(path, 'create', options),
    reveal: (path) => shell.showItemInFolder(path),
    onInstalled: (executable) => {
      if (process.platform === 'win32')
        mainWindow?.setAppDetails({
          appId: DESKTOP_APP_ID,
          appIconPath: executable,
          appIconIndex: 0,
          relaunchCommand: `"${executable}" --user-data-dir="${paths.userData}"`,
          relaunchDisplayName: DESKTOP_APP_NAME,
        })
    },
    restart: (executable) => {
      restoreRelaunchEnvironment(process.env)
      const plan = restartPlan(process.platform, [`--user-data-dir=${paths.userData}`], process.pid)
      if (plan.kind === 'relaunch') app.relaunch({ execPath: executable, args: plan.args })
      else spawn(executable, plan.args, { detached: true, stdio: 'ignore', env: process.env }).unref()
      setTimeout(() => app.quit(), 250)
    },
  })
  // A restart into a verified portable release replaces the stable application folder
  // after the old process has released its files. Failure leaves that copy usable.
  await desktop
    .finishPendingUpdate()
    .catch((error: unknown) =>
      logger.warn('desktop', 'Local update setup failed; open App & updates to retry', { error }),
    )
  // Local schedules intentionally do not replay missed intervals after downtime.
  const qaTimer = setInterval(() => {
    void qa.tick().catch((err: unknown) => logger.warn('qa', 'Schedule check failed', { error: err }))
  }, 60000)
  qaTimer.unref()
  void qa.prune().catch((err: unknown) => logger.warn('qa', 'Retention cleanup failed', { error: err }))
  const keysWindow = createKeysWindowController({
    create: () => createKeysWindow(appUrl, logger),
    // The only thing sent back when the keys window closes: a fresh, credential-free status for the main window.
    onClosed: () => {
      logger.info(SCOPE, 'Manage proxy keys window closed')
      void credentialVault
        .status()
        .then((status) => broadcast(EVENTS.securityUpdate, status))
        .catch((err: unknown) =>
          logger.warn(SCOPE, 'Could not compute the security status after the keys window closed', { error: err }),
        )
    },
  })
  const disposeIpc = registerIpcHandlers(
    {
      app: { getVersion: () => app.getVersion(), isPackaged: app.isPackaged, platform: process.platform },
      shell: {
        showItemInFolder: (fullPath) => shell.showItemInFolder(fullPath),
        openExternal: (url) => shell.openExternal(url),
      },
      paths,
      db,
      logger,
      profiles,
      proxy,
      browser,
      provisioner,
      vault: credentialVault,
      install,
      locations,
      launcher,
      tasks: taskManager,
      broadcast,
      windows: { openKeysWindow: () => keysWindow.open(), closeKeysWindow: () => keysWindow.close() },
      sanitize,
      qa,
      recorder,
      visuals,
      gateways,
      siteAccess: siteAccess.store,
      updates,
      desktop,
      files: {
        chooseUsb: async () => {
          const result = await dialog.showOpenDialog({
            title: `Select ${USB_MANIFEST_NAME} from your USB release`,
            properties: ['openFile'],
            filters: [{ name: 'Signed USB update', extensions: ['json'] }],
          })
          return result.canceled ? null : (result.filePaths[0] ?? null)
        },
        chooseBackup: async () => {
          const result = await dialog.showOpenDialog({
            title: 'Restore encrypted QA configuration',
            properties: ['openFile'],
            filters: [{ name: 'QA configuration backup', extensions: ['pqab'] }],
          })
          return result.canceled ? null : (result.filePaths[0] ?? null)
        },
      },
    },
    ipcMain,
  )

  mainWindow = createWindow(appUrl, logger)
  const localApp = await desktop.status()
  // An old downloaded EXE/AppImage was opened while a newer computer copy exists (e.g. after an update).
  const newerCopy = newerInstalledCopy(localApp)
  if (newerCopy) void offerNewerCopy(mainWindow, desktop, localApp.currentVersion, newerCopy, logger)
  const relaunchExecutable = localApp.installedPath ?? process.env.PORTABLE_EXECUTABLE_FILE
  if (process.platform === 'win32' && relaunchExecutable)
    mainWindow.setAppDetails({
      appId: DESKTOP_APP_ID,
      appIconPath: relaunchExecutable,
      appIconIndex: 0,
      relaunchCommand: `"${relaunchExecutable}" --user-data-dir="${paths.userData}"`,
      relaunchDisplayName: DESKTOP_APP_NAME,
    })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow(appUrl, logger)
  })

  logger.info(SCOPE, 'app ready', { browsersPath: provisioner.browsersPath(), webkitLibsDir, outDir: OUT_DIR })
  return { db, logger, browser, provisioner, tasks: taskManager, liveSessions, disposeIpc, qa, qaTimer, recorder }
}

/**
 * Close browser sessions (bounded by SHUTDOWN_TIMEOUT_MS, each session also has
 * its own 5s budget inside closeAll), then release IPC and the database. This
 * never hangs: a straggling browser is logged and the quit proceeds.
 */
async function shutdown(): Promise<void> {
  if (!runtime) return
  const current = runtime
  runtime = null
  try {
    current.logger.info(SCOPE, 'app shutting down')
    clearInterval(current.qaTimer)
    await current.recorder.dispose()
    await current.qa.dispose()
    // Stop install watchers, cancel queued/running installs (their process trees included) before anything else.
    current.provisioner.dispose()
    await withTimeout(current.tasks.dispose(), TASKS_SHUTDOWN_TIMEOUT_MS, 'Cancelling background tasks').catch(
      (err: unknown) => {
        current.logger.warn(SCOPE, 'Background tasks did not stop in time; quitting anyway', { error: err })
      },
    )
    await withTimeout(current.browser.closeAll(), SHUTDOWN_TIMEOUT_MS, 'Closing browser sessions')
    // A normal quit leaves nothing for the next start to clean up.
    current.liveSessions.clear()
  } catch (err) {
    current.logger.error(SCOPE, 'Failed to close every browser session during shutdown; quitting anyway', {
      error: err,
    })
  } finally {
    current.disposeIpc()
    current.db.close()
  }
}

function fatal(err: unknown): void {
  const message =
    err instanceof AppException
      ? `${err.message}${err.detail ? `\n\nDetails: ${err.detail}` : ''}`
      : err instanceof Error
        ? err.message
        : String(err)
  console.error('[proxy-qa] Fatal startup error:', err)
  dialog.showErrorBox('Proxy QA Browser could not start', message)
  app.exit(1)
}

// --- App lifecycle --------------------------------------------------------------

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', (event) => {
  if (quitting || !runtime) return
  quitting = true
  event.preventDefault()
  void shutdown().finally(() => app.quit())
})

if (app.hasSingleInstanceLock()) {
  bootstrap()
    .then((rt) => {
      runtime = rt
    })
    .catch(fatal)
}

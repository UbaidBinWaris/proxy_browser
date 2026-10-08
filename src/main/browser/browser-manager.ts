/**
 * Browser manager: launches one dedicated Playwright Browser + isolated
 * BrowserContext per session, verifies the proxy exit IP first, records a
 * TestRun, streams live session/run/network updates and finalises the run when
 * the window is closed.
 *
 * `launch()` is non-blocking: it validates the profile, resolves the proxy,
 * creates the TestRun and BrowserSession and returns at once. The remaining
 * steps (verifying-proxy → launching → navigation → open) run in the
 * background and are reported through session-update / run-update events, so
 * the UI can show live progress and the detected exit IP before the form opens.
 *
 * Location re-roll: during verifying-proxy, a sticky session with a target is
 * re-rolled to a fresh sticky id (ProxyManager.verifyForLaunch) while its exit
 * location falls short of settings.locationMatchPolicy, up to
 * settings.locationMatchAttempts IP checks. Every re-roll is a statusDetail
 * line; the browser then connects with the chosen session id, and the run
 * records the attempts made and, when the policy was not met, a warning.
 *
 * WebKit cannot tunnel HTTPS through an authenticated proxy, so WebKit sessions
 * are launched against a per-session local relay that injects the upstream
 * credentials. Proxy credentials never leave this process: sessions, runs and
 * log lines only carry sanitised text.
 *
 * On Linux builds that bundle WebKit's Ubuntu host libraries (PROXY_QA_WEBKIT_LIBS,
 * exported by the bootstrap), WebKit — and only WebKit — is launched with that
 * directory prepended to LD_LIBRARY_PATH. Chromium and Firefox are unaffected.
 *
 * Installed browsers (Chrome, Edge, Brave, Opera, Opera GX, Vivaldi, system
 * Chromium) are Chromium-family engines: they are driven by Playwright's
 * `chromium` BrowserType with `executablePath` pointing at the real binary the
 * provisioner resolved, so device emulation, proxy and the network inspector
 * work exactly as for the bundled Chromium — and the browser that opens is the
 * one the profile names.
 *
 * Session maintenance:
 * - every Chromium-family launch carries `--proxy-qa-session=<sessionId>` (Chromium ignores
 *   unknown switches) so the browser's pid can be found by command line (`findBrowserPid`)
 *   and an orphaned browser can be terminated after a crash (sessions/orphan-cleanup.ts);
 *   Firefox and WebKit are tracked through Playwright's 'disconnected' event only;
 * - every live session is recorded in `liveSessions` (live-sessions.json) until it ends;
 * - a heartbeat (every 5 s) checks `browser.isConnected()` and the open pages: when the user
 *   closed the last tab/window the session is finalised as closed (Playwright keeps a
 *   windowless browser running otherwise); a crashed tab marks the session as failed;
 * - `focus()` brings a session's window to the front (restoring a minimised Chromium window
 *   through CDP first);
 * - an engine with a queued/running install task cannot be launched (ENGINE_BUSY).
 */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium, firefox, webkit } from 'playwright-core'
import type { Browser, BrowserContext, BrowserType, Frame, Page, Response } from 'playwright-core'
import type {
  AppError,
  AppSettings,
  BrowserEngineFamily,
  BrowserEngineInfo,
  BrowserSession,
  IpInfo,
  NetworkEntry,
  Profile,
  RunStatus,
  SessionStatus,
  TargetMatch,
  TestRun,
} from '@shared/types'
import { BROWSER_ENGINE_LABELS } from '@shared/types'
import { AppException } from '../contracts'
import type {
  BrowserManager,
  BrowserProvisioner,
  IpChecker,
  Logger,
  NetworkRepository,
  ProfileManager,
  ProxyConnection,
  ProxyManager,
  TestRunRepository,
} from '../contracts'
import { startProxyRelay } from '../proxy/local-relay'
import type { ProxyRelay } from '../proxy/local-relay'
import { withTimeout } from '../util/timeout'
import { sessionMarkerArg } from '../system/processes'
import { memoryLiveSessionsStore } from '../sessions/live-sessions-store'
import type { LiveSessionsStore } from '../sessions/live-sessions-store'
import { webkitLaunchEnv, webkitLibsDirFromEnv } from './browsers-path'
import { DEVICE_PRESETS, buildContextOptions } from './device-presets'
import { mapLaunchError, mapNavigationError, sanitizeErrorText, shortErrorText } from './error-mapping'
import { attachNetworkInspector } from './network-inspector'
import { DEFAULT_MASK_SELECTORS, redactUrl } from '../security/data-privacy'
import type { SiteAccessAttacher } from '../site-access'

const SCOPE = 'browser'
/** Per-session budget for `closeAll()` (app shutdown). */
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000
/** How many closed session ids to remember so late calls get SESSION_CLOSED instead of NOT_FOUND. */
const CLOSED_IDS_MEMORY = 500
/**
 * Upper bound for browser launch + first context + first page. A browser that hangs under automation
 * (Vivaldi stalls at page creation) fails fast with BROWSER_LAUNCH_FAILED instead of spinning forever.
 */
export const DEFAULT_LAUNCH_TIMEOUT_MS = 45_000
/** Playwright's own launch timeout sits a little later, so a hung launch is still killed by Playwright after ours fired. */
const PLAYWRIGHT_LAUNCH_GRACE_MS = 5_000
/** Session monitor period (browser connected? any page left open?). */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000
/** Attempts (500 ms apart) to find a freshly launched browser's pid by its marker switch. */
const PID_LOOKUP_ATTEMPTS = 6
const PID_LOOKUP_DELAY_MS = 500
export const TAB_CRASHED_MESSAGE = 'The browser tab crashed'

/** "Vivaldi (installed)" → "Vivaldi did not finish starting within 45 s. …" */
export function launchTimeoutMessage(engineLabel: string, timeoutMs: number): string {
  const name = engineLabel.replace(/\s*\([^)]*\)\s*$/, '').trim() || engineLabel
  return `${name} did not finish starting within ${Math.round(timeoutMs / 1000)} s. This browser may not support automation; choose another engine.`
}

export interface BrowserManagerOptions {
  profiles: ProfileManager
  proxy: ProxyManager
  /** Used for the direct (no-proxy) exit-IP lookup when a profile has proxyMode 'none'. */
  ipChecker: IpChecker
  provisioner: BrowserProvisioner
  runs: TestRunRepository
  network: NetworkRepository
  getSettings: () => AppSettings
  logger: Logger
  /** Per-session timeout used by `closeAll()`. Default 5000ms. */
  closeTimeoutMs?: number
  /** Budget for launch + context + first page (see DEFAULT_LAUNCH_TIMEOUT_MS). */
  launchTimeoutMs?: number
  /**
   * Directory of bundled WebKit host libraries to prepend to LD_LIBRARY_PATH for
   * WebKit launches (Linux). Defaults to the PROXY_QA_WEBKIT_LIBS env var; null disables it.
   */
  webkitLibsDir?: string | null
  /** Why an engine cannot be launched right now (an install task is queued or running), or null. */
  engineBusyMessage?: (engine: Profile['engine']) => string | null
  /** Persistent record of open sessions (live-sessions.json in production). */
  liveSessions?: LiveSessionsStore
  /** Find a Chromium-family session's browser pid by its `--proxy-qa-session` marker. */
  findBrowserPid?: (sessionId: string) => Promise<number | null>
  heartbeatIntervalMs?: number
  /** Site access tokens (src/main/site-access): routes enabled tokens into every new context. */
  siteAccess?: SiteAccessAttacher
}

interface LiveSession {
  session: BrowserSession
  runId: string
  profile: Profile
  /** Resolved engine (executable path for installed browsers), fixed at launch time. */
  engineInfo: BrowserEngineInfo
  connection: ProxyConnection | null
  settings: AppSettings
  formUrl: string
  browser: Browser | null
  context: BrowserContext | null
  page: Page | null
  relay: ProxyRelay | null
  detachNetwork: (() => void) | null
  /** Secrets to scrub from any text derived from browser errors. */
  secrets: string[]
  pageLoadedOk: boolean
  finalized: boolean
  /** Set by close()/closeAll() while the launch pipeline is still running. */
  cancelRequested: boolean
  /** Reason recorded by whoever initiated the close, so 'disconnected' does not mislabel it. */
  closeReason: string | null
  /** The background launch pipeline; null once it has settled. */
  launchTask: Promise<void> | null
  /** Launch + context + page missed the startup deadline; anything that finishes later is closed at once. */
  startupTimedOut: boolean
  /** The monitor found no open page and is closing the browser. */
  closingAfterLastWindow: boolean
}

/** What the verify step established before the browser launches. */
interface VerifiedExit {
  ip: IpInfo | null
  proxySessionId: string | null
  targetMatch: TargetMatch | null
  /** IP checks made for the location policy (1 without a re-roll). */
  attempts: number
  maxAttempts: number
  warning: string | null
}

/** Attempt budget for a launch: re-rolls only apply to a sticky session with a target and a policy other than 'off'. */
export function locationAttemptBudget(profile: Profile, settings: Pick<AppSettings, 'locationMatchPolicy' | 'locationMatchAttempts'>): number {
  const eligible = profile.proxyMode === 'sticky' && profile.target !== null && settings.locationMatchPolicy !== 'off'
  return eligible ? Math.max(1, settings.locationMatchAttempts) : 1
}

/** One Playwright BrowserType per engine family; installed browsers reuse `chromium` with their own executable. */
const BROWSER_TYPES: Record<BrowserEngineFamily, BrowserType> = { chromium, firefox, webkit }

const STATUS_DETAIL: Record<SessionStatus, string> = {
  starting: 'Validating profile…',
  'verifying-proxy': 'Verifying proxy exit IP…',
  launching: 'Launching browser…',
  open: 'Browser open',
  closing: 'Closing browser…',
  closed: 'Browser closed',
  error: 'Failed',
}

const ALREADY_OPEN_MESSAGE = 'This profile already has an open browser session. Close it first.'
/** settings.singleSessionMode: only one browser session may be open at a time. */
export const SESSION_LIMIT_MESSAGE = 'Another browser session is already open. Close it first or enable "replace active session".'

function toAppError(err: unknown): AppError {
  if (err instanceof AppException) return err.toAppError()
  return { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) }
}

function timestampForFile(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

export function createBrowserManager(opts: BrowserManagerOptions): BrowserManager {
  const { profiles, proxy, ipChecker, provisioner, runs, network, getSettings, logger } = opts
  const closeTimeoutMs = opts.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS
  const launchTimeoutMs = opts.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS
  const webkitLibsDir = opts.webkitLibsDir === undefined ? webkitLibsDirFromEnv() : opts.webkitLibsDir
  const liveSessions = opts.liveSessions ?? memoryLiveSessionsStore()
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null

  /** Sessions that are not closed yet (closed ones are evicted). */
  const live = new Map<string, LiveSession>()
  const closedIds = new Set<string>()
  const sessionListeners = new Set<(session: BrowserSession) => void>()
  const runListeners = new Set<(run: TestRun) => void>()
  const networkListeners = new Set<(entry: NetworkEntry) => void>()

  const snapshot = (session: BrowserSession): BrowserSession => ({
    ...session,
    ip: session.ip ? { ...session.ip } : null,
    target: session.target ? { ...session.target } : null,
  })

  const emitSession = (session: BrowserSession): void => {
    for (const listener of sessionListeners) listener(snapshot(session))
  }
  const emitRun = (run: TestRun): void => {
    for (const listener of runListeners) listener(run)
  }
  const emitNetwork = (entry: NetworkEntry): void => {
    for (const listener of networkListeners) listener(entry)
  }

  const setStatus = (ls: LiveSession, status: SessionStatus, detail?: string): void => {
    ls.session.status = status
    ls.session.statusDetail = detail ?? STATUS_DETAIL[status]
    emitSession(ls.session)
  }

  const updateRun = (ls: LiveSession, patch: Partial<Omit<TestRun, 'id'>>): TestRun | null => {
    try {
      const run = runs.update(ls.runId, patch)
      emitRun(run)
      return run
    } catch (err) {
      logger.warn(SCOPE, `Could not update test run: ${shortErrorText(err, ls.secrets)}`, { runId: ls.runId })
      return null
    }
  }

  const label = (ls: LiveSession): string => `${ls.session.profileName} [${BROWSER_ENGINE_LABELS[ls.session.engine]}]`

  const forget = (ls: LiveSession): void => {
    try {
      liveSessions.remove(ls.session.id)
    } catch (err) {
      logger.warn(SCOPE, `Could not update the open-sessions record: ${shortErrorText(err, ls.secrets)}`, { sessionId: ls.session.id })
    }
  }

  const remember = (ls: LiveSession): void => {
    try {
      liveSessions.upsert({ sessionId: ls.session.id, runId: ls.runId, engine: ls.session.engine, pid: ls.session.browserPid, startedAt: ls.session.startedAt })
    } catch (err) {
      logger.warn(SCOPE, `Could not update the open-sessions record: ${shortErrorText(err, ls.secrets)}`, { sessionId: ls.session.id })
    }
  }

  const evict = (ls: LiveSession): void => {
    forget(ls)
    live.delete(ls.session.id)
    closedIds.add(ls.session.id)
    while (closedIds.size > CLOSED_IDS_MEMORY) {
      const oldest = closedIds.values().next().value
      if (oldest === undefined) break
      closedIds.delete(oldest)
    }
  }

  /** Release everything that is not the browser itself (inspector, relay, handles). Never throws. */
  const teardownResources = (ls: LiveSession): void => {
    ls.detachNetwork?.()
    ls.detachNetwork = null
    const relay = ls.relay
    ls.relay = null
    if (relay) {
      void relay.close().catch((err: unknown) => {
        logger.warn(SCOPE, `${label(ls)}: local proxy relay did not close cleanly: ${shortErrorText(err, ls.secrets)}`, {
          sessionId: ls.session.id,
        })
      })
    }
    ls.browser = null
    ls.context = null
    ls.page = null
    // No browser process is left for this session: nothing to clean up after a crash.
    forget(ls)
  }

  /** Mark the session failed and persist the run as failed. Never throws. */
  const failSession = (ls: LiveSession, err: unknown): void => {
    const appError = toAppError(err)
    appError.message = sanitizeErrorText(appError.message, ls.secrets)
    if (appError.detail) appError.detail = sanitizeErrorText(appError.detail, ls.secrets)
    ls.session.error = appError
    logger.error(SCOPE, `${label(ls)}: ${appError.message}`, {
      sessionId: ls.session.id,
      runId: ls.runId,
      code: appError.code,
      ...(appError.detail ? { detail: appError.detail } : {}),
    })
    // With a browser still open the run ends when the window closes; otherwise it ends now.
    updateRun(ls, { status: 'failed', errorMessage: appError.message, ...(ls.browser ? {} : { endedAt: new Date().toISOString() }) })
    setStatus(ls, 'error', appError.message)
  }

  /**
   * Failure before any browser window exists (proxy, relay or launch error): the
   * run is final, the session stays visible as 'error' until dismissed with
   * close(), and it does not block a relaunch of the same profile.
   */
  const abandon = (ls: LiveSession, err: unknown): void => {
    ls.finalized = true
    teardownResources(ls)
    failSession(ls, err)
  }

  /** Idempotent end-of-life: close the run, mark the session closed, release handles, evict. */
  const finalize = (ls: LiveSession, reason: string): void => {
    if (ls.finalized) return
    ls.finalized = true

    const current = runs.get(ls.runId)
    let status: RunStatus
    if (current && current.status !== 'running') status = current.status
    else if (ls.pageLoadedOk) status = 'success'
    else if (ls.cancelRequested) status = 'aborted'
    else status = 'failed'
    const errorMessage =
      current?.errorMessage ??
      (status === 'aborted'
        ? 'Launch cancelled before the form finished loading.'
        : status === 'failed'
          ? 'The browser window was closed before the form finished loading.'
          : null)
    const finalUrl = ls.session.currentUrl ?? current?.finalUrl ?? null
    const run = updateRun(ls, { status, endedAt: new Date().toISOString(), finalUrl, errorMessage })

    teardownResources(ls)
    logger.info(SCOPE, `${label(ls)}: test ${run?.status ?? status} (${ls.closeReason ?? reason})`, {
      sessionId: ls.session.id,
      runId: ls.runId,
      finalUrl,
    })
    setStatus(ls, 'closed')
    evict(ls)
  }

  /** Close a session that never got a browser (or already lost it). */
  const markClosed = (ls: LiveSession): void => {
    ls.finalized = true
    teardownResources(ls)
    if (ls.session.status !== 'closed') setStatus(ls, 'closed')
    evict(ls)
  }

  /** `skipContext`: a hung browser may never answer a context close, so go straight to closing the browser. */
  const disposeBrowser = async (ls: LiveSession, skipContext = false): Promise<void> => {
    const { context, browser } = ls
    try {
      if (!skipContext) await context?.close()
    } catch {
      // Context may already be gone when the user closed the window.
    }
    try {
      await browser?.close()
    } catch {
      // Browser may already be disconnected.
    }
  }

  const resolveFormUrl = (profile: Profile, settings: AppSettings): string =>
    profile.formUrlOverride ?? settings.defaultFormUrl

  /**
   * A failed attempt that never got a window (proxy/launch error, pipeline
   * settled) is only a leftover row: it blocks nothing and is dismissed by close().
   */
  const isDismissableFailure = (ls: LiveSession): boolean => ls.session.status === 'error' && ls.browser === null && ls.launchTask === null

  /**
   * Per-profile rule: one live session per profile. Single-session rule
   * (settings.singleSessionMode): one live session in total.
   */
  const assertCanLaunch = (profile: Profile, settings: AppSettings): void => {
    for (const ls of live.values()) {
      if (isDismissableFailure(ls)) continue
      if (ls.session.profileId === profile.id) throw new AppException('INVALID_PROFILE', ALREADY_OPEN_MESSAGE)
      if (settings.singleSessionMode) {
        throw new AppException('SESSION_LIMIT', SESSION_LIMIT_MESSAGE, `open session ${ls.session.id} (${ls.session.profileName}, ${ls.session.status})`)
      }
    }
  }

  /**
   * Verify the exit IP with the real upstream credentials. For a sticky session with a target the
   * proxy manager re-rolls the session id while the location falls short of settings.locationMatchPolicy;
   * each re-roll is reported as a statusDetail line. Returns null (after failing the session) on error.
   */
  const verifyProxy = async (ls: LiveSession): Promise<VerifiedExit | null> => {
    const { profile, connection } = ls
    if (connection) {
      const verification = await proxy.verifyForLaunch(profile, {
        policy: ls.settings.locationMatchPolicy,
        attempts: ls.settings.locationMatchAttempts,
        shouldContinue: () => !ls.cancelRequested,
        onProgress: (progress) => {
          ls.session.locationAttempts = progress.attempt
          ls.session.locationMaxAttempts = progress.attempts
          ls.session.proxySessionId = progress.sessionId
          setStatus(ls, 'verifying-proxy', progress.message)
          updateRun(ls, { locationAttempts: progress.attempt, locationMaxAttempts: progress.attempts })
        },
      })
      const { result } = verification
      if (result.status !== 'working' || !result.ip) {
        abandon(
          ls,
          result.error
            ? new AppException(result.error.code, result.error.message, result.error.detail)
            : new AppException('PROXY_DEAD', 'The proxy exit could not be verified. Re-test the proxy and try again.'),
        )
        return null
      }
      if (verification.sessionId !== null && verification.sessionId !== connection.sessionId) {
        // The location re-roll settled on another sticky id: the browser must connect with that one.
        ls.profile = { ...profile, stickySessionId: verification.sessionId }
        const rerolled = proxy.resolveForProfile(ls.profile)
        if (rerolled) {
          ls.connection = rerolled
          if (!ls.secrets.includes(rerolled.password)) ls.secrets.push(rerolled.password)
        }
      }
      const where = [result.ip.city, result.ip.region, result.ip.postalCode, result.ip.country ?? 'unknown country'].filter((part): part is string => Boolean(part)).join(', ')
      logger.info(SCOPE, `${label(ls)}: proxy exit verified ${result.ip.ip} (${where})`, {
        sessionId: ls.session.id,
        pool: ls.connection?.pool ?? connection.pool,
        targeting: ls.connection?.targetingString || null,
        proxySessionId: verification.sessionId ?? result.sessionId,
        region: result.ip.region,
        city: result.ip.city,
        postalCode: result.ip.postalCode,
        latencyMs: result.ip.latencyMs,
        locationAttempts: verification.attempts,
        locationMaxAttempts: verification.maxAttempts,
      })
      return {
        ip: result.ip,
        proxySessionId: verification.sessionId ?? result.sessionId ?? connection.sessionId,
        targetMatch: profile.target ? verification.targetMatch : null,
        attempts: verification.attempts,
        maxAttempts: verification.maxAttempts,
        warning: verification.warning,
      }
    }
    // No proxy: report the machine's own exit IP so the run record is truthful.
    const direct = { proxySessionId: null, targetMatch: null, attempts: 1, maxAttempts: 1, warning: null }
    try {
      return { ...direct, ip: await ipChecker.lookup(null) }
    } catch (err) {
      logger.warn(SCOPE, `${label(ls)}: IP lookup skipped: ${shortErrorText(err, ls.secrets)}`, {
        sessionId: ls.session.id,
      })
      return { ...direct, ip: null }
    }
  }

  const recordIp = (ls: LiveSession, verified: VerifiedExit): void => {
    // Requested-vs-verified location: only meaningful for a proxied session with a geo target.
    const { targetMatch } = verified
    ls.session.ip = verified.ip
    ls.session.proxySessionId = verified.proxySessionId
    ls.session.targetingString = ls.connection?.targetingString || null
    ls.session.targetMatch = targetMatch
    ls.session.locationAttempts = verified.attempts
    ls.session.locationMaxAttempts = verified.maxAttempts
    ls.session.locationWarning = verified.warning
    // "Could not get an exit IP in … after N attempts; using …" stays on the session as locationWarning.
    if (verified.warning) ls.session.statusDetail = verified.warning
    if (targetMatch && targetMatch !== 'match') {
      logger.warn(SCOPE, `${label(ls)}: exit IP location is a ${targetMatch} for the requested target`, {
        sessionId: ls.session.id,
        targeting: ls.connection?.targetingString ?? null,
        region: verified.ip?.region ?? null,
        city: verified.ip?.city ?? null,
        postalCode: verified.ip?.postalCode ?? null,
        targetMatch,
        locationAttempts: verified.attempts,
      })
    }
    emitSession(ls.session)
    updateRun(ls, {
      publicIp: verified.ip?.ip ?? null,
      country: verified.ip?.country ?? null,
      region: verified.ip?.region ?? null,
      city: verified.ip?.city ?? null,
      postalCode: verified.ip?.postalCode ?? null,
      proxySessionId: verified.proxySessionId,
      targetingString: ls.connection?.targetingString || null,
      targetMatch,
      locationAttempts: verified.attempts,
      locationMaxAttempts: verified.maxAttempts,
      locationWarning: verified.warning,
    })
  }

  /** Browser-level proxy settings: WebKit goes through the local relay, everything else authenticates directly. */
  const prepareLaunchProxy = async (ls: LiveSession): Promise<{ server: string; username?: string; password?: string } | undefined> => {
    const { connection } = ls
    if (!connection) return undefined
    if (ls.engineInfo.family !== 'webkit') {
      return { server: connection.server, username: connection.username, password: connection.password }
    }
    const relay = await startProxyRelay(connection, logger)
    ls.relay = relay
    logger.info(SCOPE, `${label(ls)}: WebKit session using local auth relay`, {
      sessionId: ls.session.id,
      relayPort: relay.port,
      proxySessionId: connection.sessionId,
    })
    return { server: relay.server }
  }

  const launchBrowser = async (ls: LiveSession, launchProxy: { server: string; username?: string; password?: string } | undefined): Promise<void> => {
    const { engineInfo } = ls
    const browserType = BROWSER_TYPES[engineInfo.family]
    const launchOptions: Parameters<BrowserType['launch']>[0] = {
      headless: false,
      timeout: launchTimeoutMs + PLAYWRIGHT_LAUNCH_GRACE_MS,
      ...(launchProxy ? { proxy: launchProxy } : {}),
    }
    if (engineInfo.family === 'chromium') {
      if (ls.settings.extraChromiumArgs.length > 0) {
        // "Flags settings": user-provided command-line switches for every Chromium-family launch (bundled and installed).
        logger.info(SCOPE, `${label(ls)}: extra Chromium args ${ls.settings.extraChromiumArgs.join(' ')}`, { sessionId: ls.session.id, args: ls.settings.extraChromiumArgs })
      }
      // The marker lets the app find (and, after a crash, terminate) exactly this session's browser process.
      launchOptions.args = [...ls.settings.extraChromiumArgs, sessionMarkerArg(ls.session.id)]
    }
    if (engineInfo.kind === 'installed') {
      // A real browser on this machine: same Chromium automation protocol, its own binary.
      if (!engineInfo.executablePath) {
        throw new AppException('BROWSER_MISSING', `${engineInfo.label}: ${engineInfo.note}`)
      }
      launchOptions.executablePath = engineInfo.executablePath
      logger.info(SCOPE, `${label(ls)}: launching ${engineInfo.label} from ${engineInfo.executablePath}`, {
        sessionId: ls.session.id,
        engine: engineInfo.id,
        executablePath: engineInfo.executablePath,
        executableSource: engineInfo.source,
        detectedVersion: engineInfo.version,
      })
    }
    if (engineInfo.family === 'webkit' && webkitLibsDir) {
      // Playwright replaces the browser environment when `env` is given, so the full parent env is copied.
      launchOptions.env = webkitLaunchEnv(webkitLibsDir)
      logger.info(SCOPE, `${label(ls)}: WebKit using bundled host libraries from ${webkitLibsDir}`, { sessionId: ls.session.id })
    }
    const browser = await browserType.launch(launchOptions)
    if (ls.startupTimedOut) {
      // Started after the deadline: the session has already failed, so this browser must not linger.
      void browser.close().catch(() => undefined)
      throw new AppException('BROWSER_LAUNCH_FAILED', launchTimeoutMessage(engineInfo.label, launchTimeoutMs), 'browser started after the launch deadline and was closed')
    }
    // Track the browser immediately so a cancelled launch can never orphan it.
    ls.browser = browser
    browser.on('disconnected', () => finalize(ls, 'browser disconnected'))
    if (engineInfo.family === 'chromium') void trackPid(ls)
    ensureHeartbeat()
    logger.info(SCOPE, `${label(ls)}: browser launched (${engineInfo.label} ${browser.version()})`, {
      sessionId: ls.session.id,
      engine: engineInfo.id,
      executablePath: engineInfo.executablePath,
      viaProxy: ls.connection !== null,
      viaRelay: ls.relay !== null,
    })
  }

  const openContext = async (ls: LiveSession): Promise<Page> => {
    if (!ls.browser) throw new AppException('BROWSER_LAUNCH_FAILED', 'Browser is not running.')
    const preset = DEVICE_PRESETS.find((candidate) => candidate.id === ls.profile.devicePreset)
    if (!preset) {
      throw new AppException('INVALID_PROFILE', `Profile "${ls.profile.name}" uses unknown device preset "${ls.profile.devicePreset}". Edit the profile and pick a preset.`)
    }
    const context = await ls.browser.newContext(buildContextOptions(ls.profile, preset))
    ls.context = context
    await opts.siteAccess?.attach(context, (note) => logger.info(SCOPE, `${label(ls)}: ${note}`, { sessionId: ls.session.id, runId: ls.runId }))
    context.on('close', () => finalize(ls, 'window closed'))
    // Tabs the user opens are watched too: the session ends when the last one closes.
    context.on('page', (opened: Page) => watchPage(ls, opened))
    const page = await context.newPage()
    ls.page = page
    watchPage(ls, page)
    page.on('framenavigated', (frame: Frame) => {
      if (frame !== page.mainFrame()) return
      const url = frame.url()
      ls.session.currentUrl = url
      emitSession(ls.session)
      updateRun(ls, { finalUrl: redactUrl(url) })
    })
    return page
  }

  // -------------------------------------------------------------------------
  // Session monitor
  // -------------------------------------------------------------------------

  const openPages = (ls: LiveSession): Page[] => (ls.context ? ls.context.pages().filter((candidate) => !candidate.isClosed()) : [])

  /** The user closed the last tab/window: close the (now windowless) browser and end the session. */
  const closeAfterLastWindow = (ls: LiveSession): void => {
    if (ls.finalized || ls.closingAfterLastWindow || ls.cancelRequested) return
    ls.closingAfterLastWindow = true
    ls.closeReason ??= 'window closed by user'
    logger.info(SCOPE, `${label(ls)}: the last browser window was closed`, { sessionId: ls.session.id })
    void withTimeout(disposeBrowser(ls), closeTimeoutMs, `Closing ${label(ls)}`)
      .catch((err: unknown) => {
        logger.warn(SCOPE, `${label(ls)}: browser did not close after its last window: ${shortErrorText(err, ls.secrets)}`, { sessionId: ls.session.id })
      })
      .finally(() => finalize(ls, 'window closed by user'))
  }

  const watchPage = (ls: LiveSession, page: Page): void => {
    page.on('crash', () => {
      if (ls.finalized) return
      logger.warn(SCOPE, `${label(ls)}: ${TAB_CRASHED_MESSAGE}`, { sessionId: ls.session.id, url: page.url() })
      failSession(ls, new AppException('INTERNAL', TAB_CRASHED_MESSAGE, page.url()))
    })
    page.on('close', () => {
      if (!ls.finalized && ls.page && openPages(ls).length === 0) closeAfterLastWindow(ls)
    })
  }

  const heartbeat = (ls: LiveSession): void => {
    if (ls.finalized || !ls.browser || !ls.context || !ls.page) return
    if (!ls.browser.isConnected()) {
      finalize(ls, 'browser disconnected')
      return
    }
    if (openPages(ls).length === 0) {
      closeAfterLastWindow(ls)
      return
    }
    ls.session.lastHeartbeatAt = new Date().toISOString()
    emitSession(ls.session)
  }

  const ensureHeartbeat = (): void => {
    if (heartbeatTimer || heartbeatIntervalMs <= 0) return
    heartbeatTimer = setInterval(() => {
      if (live.size === 0) {
        if (heartbeatTimer) clearInterval(heartbeatTimer)
        heartbeatTimer = null
        return
      }
      for (const ls of [...live.values()]) {
        try {
          heartbeat(ls)
        } catch (err) {
          logger.warn(SCOPE, `${label(ls)}: session check failed: ${shortErrorText(err, ls.secrets)}`, { sessionId: ls.session.id })
        }
      }
    }, heartbeatIntervalMs)
    // The monitor must never keep the process alive on its own.
    heartbeatTimer.unref?.()
  }

  /** Find the browser's pid by its marker switch (Chromium family), retrying while it starts up. */
  const trackPid = async (ls: LiveSession): Promise<void> => {
    if (!opts.findBrowserPid) return
    for (let attempt = 0; attempt < PID_LOOKUP_ATTEMPTS && !ls.finalized; attempt += 1) {
      let pid: number | null
      try {
        pid = await opts.findBrowserPid(ls.session.id)
      } catch (err) {
        logger.warn(SCOPE, `${label(ls)}: could not look up the browser process: ${shortErrorText(err, ls.secrets)}`, { sessionId: ls.session.id })
        return
      }
      if (ls.finalized) return
      if (pid !== null) {
        ls.session.browserPid = pid
        remember(ls)
        logger.info(SCOPE, `${label(ls)}: browser process ${pid}`, { sessionId: ls.session.id, pid })
        emitSession(ls.session)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, PID_LOOKUP_DELAY_MS))
    }
  }

  const attachInspector = (ls: LiveSession): void => {
    if (!ls.context) return
    ls.detachNetwork = attachNetworkInspector({
      context: ls.context,
      runId: ls.runId,
      network,
      logger,
      onEntry: emitNetwork,
      onIdsExtracted: (ids) => {
        const current = runs.get(ls.runId)
        if (!current) return
        const patch: Partial<TestRun> = {}
        if (ids.leadId && current.leadId === null) patch.leadId = ids.leadId
        if (ids.certificateId && current.certificateId === null) patch.certificateId = ids.certificateId
        if (Object.keys(patch).length === 0) return
        logger.info(SCOPE, `${label(ls)}: captured ${Object.keys(patch).join(', ')} from network response`, {
          runId: ls.runId,
          ...patch,
        })
        updateRun(ls, patch)
      },
    })
  }

  /**
   * Launch the browser, open its context and first page within `launchTimeoutMs`. Resolves with the page,
   * with null when a close() arrived in between, or rejects with BROWSER_LAUNCH_FAILED once the deadline
   * passes (a startup that finishes later is closed by launchBrowser or simply ignored).
   */
  const startWithDeadline = (ls: LiveSession, launchProxy: { server: string; username?: string; password?: string } | undefined): Promise<Page | null> => {
    const startup = (async (): Promise<Page | null> => {
      await launchBrowser(ls, launchProxy)
      if (ls.cancelRequested || ls.finalized || ls.startupTimedOut) return null
      return openContext(ls)
    })()
    return new Promise<Page | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        ls.startupTimedOut = true
        // Whatever the abandoned startup does from now on is irrelevant and must not surface as an unhandled rejection.
        startup.catch(() => undefined)
        const step = ls.browser ? (ls.context ? 'page creation' : 'context creation') : 'browser launch'
        logger.warn(SCOPE, `${label(ls)}: startup did not finish within ${launchTimeoutMs} ms (stuck at ${step})`, { sessionId: ls.session.id, engine: ls.engineInfo.id, step })
        reject(new AppException('BROWSER_LAUNCH_FAILED', launchTimeoutMessage(ls.engineInfo.label, launchTimeoutMs), `stuck at ${step} after ${launchTimeoutMs} ms`))
      }, launchTimeoutMs)
      startup.then(
        (page) => {
          clearTimeout(timer)
          resolve(page)
        },
        (err: unknown) => {
          clearTimeout(timer)
          reject(err instanceof Error ? err : new Error(String(err)))
        },
      )
    })
  }

  /** close() arrived mid-launch: dispose whatever exists and finalise as aborted. */
  const abortLaunch = async (ls: LiveSession): Promise<void> => {
    if (ls.finalized) return
    ls.closeReason ??= 'cancelled during launch'
    await disposeBrowser(ls)
    finalize(ls, 'cancelled during launch')
  }

  /** The background part of a launch. Every exit path leaves the run in a final state or the window open. */
  const runLaunchPipeline = async (ls: LiveSession): Promise<void> => {
    const { profile, settings, formUrl } = ls

    // --- Proxy verification -------------------------------------------------
    setStatus(ls, 'verifying-proxy', profile.proxyMode === 'none' ? 'Direct connection (no proxy)' : undefined)
    const verified = await verifyProxy(ls)
    if (!verified) return
    if (ls.cancelRequested) {
      await abortLaunch(ls)
      return
    }
    recordIp(ls, verified)

    // --- Browser launch -----------------------------------------------------
    setStatus(ls, 'launching')
    let page: Page
    try {
      const launchProxy = await prepareLaunchProxy(ls)
      if (ls.cancelRequested) {
        await abortLaunch(ls)
        return
      }
      const started = await startWithDeadline(ls, launchProxy)
      if (started === null) {
        await abortLaunch(ls)
        return
      }
      page = started
    } catch (err) {
      if (ls.finalized) return
      if (ls.cancelRequested && !ls.startupTimedOut) {
        await abortLaunch(ls)
        return
      }
      // Mark finalized first so a 'disconnected' event raised by disposeBrowser cannot double-finalise.
      ls.finalized = true
      if (ls.startupTimedOut) {
        // A hung browser may never answer: bound the close and fail the session either way.
        await withTimeout(disposeBrowser(ls, true), closeTimeoutMs, `Closing ${label(ls)} after the launch deadline`).catch((closeErr: unknown) => {
          logger.warn(SCOPE, `${label(ls)}: browser did not close after the launch deadline: ${shortErrorText(closeErr, ls.secrets)}`, { sessionId: ls.session.id })
        })
      } else {
        await disposeBrowser(ls)
      }
      ls.finalized = false
      abandon(ls, mapLaunchError(err, ls.secrets))
      return
    }
    if (ls.cancelRequested) {
      await abortLaunch(ls)
      return
    }
    if (settings.networkInspectorEnabled) attachInspector(ls)

    // --- Navigation ---------------------------------------------------------
    let response: Response | null
    try {
      response = await page.goto(formUrl, { timeout: settings.navigationTimeoutMs, waitUntil: 'domcontentloaded' })
    } catch (err) {
      if (ls.finalized) return
      if (ls.cancelRequested) {
        await abortLaunch(ls)
        return
      }
      // Keep the window open so the tester can inspect the error page; the run stays failed unless re-marked.
      failSession(
        ls,
        mapNavigationError(err, {
          timeoutMs: settings.navigationTimeoutMs,
          viaProxy: ls.connection !== null,
          secrets: ls.secrets,
          ...(ls.connection ? { providerName: proxy.providers().find((candidate) => candidate.id === ls.profile.providerId)?.displayName } : {}),
        }),
      )
      return
    }
    if (ls.finalized) return
    if (ls.cancelRequested) {
      await abortLaunch(ls)
      return
    }

    const httpStatus = response?.status() ?? null
    ls.pageLoadedOk = httpStatus === null || httpStatus < 400
    ls.session.currentUrl = page.url()
    updateRun(ls, { httpStatus, finalUrl: redactUrl(page.url()) })
    logger.info(SCOPE, `${label(ls)}: navigated to ${page.url()} (HTTP ${httpStatus ?? 'n/a'})`, {
      sessionId: ls.session.id,
      runId: ls.runId,
    })
    if (!ls.pageLoadedOk && httpStatus !== null) {
      // The window stays open (the error page is useful evidence); the run is failed with a clear reason.
      failSession(
        ls,
        new AppException('SITE_HTTP_ERROR', `The form URL responded with HTTP ${httpStatus}.`, `${page.url()} → HTTP ${httpStatus}`),
      )
      return
    }
    setStatus(ls, 'open')
  }

  const launch = async (profile: Profile): Promise<BrowserSession> => {
    profiles.validateForLaunch(profile)
    const settings = getSettings()
    assertCanLaunch(profile, settings)
    const busy = opts.engineBusyMessage?.(profile.engine) ?? null
    if (busy) throw new AppException('ENGINE_BUSY', busy)
    // Throws BROWSER_MISSING (with the engine's note) before any run is recorded.
    const engineInfo = await provisioner.resolveEngine(profile.engine)
    // Throws PROXY_NOT_CONFIGURED (naming the product) or INVALID_INPUT (unknown provider) before any run is recorded.
    const connection = proxy.resolveForProfile(profile)
    const formUrl = resolveFormUrl(profile, settings)
    const startedAt = new Date().toISOString()
    const locationMaxAttempts = connection ? locationAttemptBudget(profile, settings) : 1

    const run = runs.create({
      profileId: profile.id,
      profileName: profile.name,
      engine: profile.engine,
      devicePreset: profile.devicePreset,
      provider: connection ? profile.providerId : null,
      proxyPool: connection?.pool ?? null,
      target: connection?.target ?? null,
      targetingString: connection?.targetingString || null,
      targetMatch: null,
      publicIp: null,
      country: null,
      region: null,
      city: null,
      postalCode: null,
      locationAttempts: 1,
      locationMaxAttempts,
      locationWarning: null,
      proxySessionId: connection?.sessionId ?? null,
      formUrl: redactUrl(formUrl),
      startedAt,
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
    emitRun(run)

    const ls: LiveSession = {
      session: {
        id: randomUUID(),
        runId: run.id,
        profileId: profile.id,
        profileName: profile.name,
        engine: profile.engine,
        devicePreset: profile.devicePreset,
        provider: connection ? profile.providerId : null,
        proxyPool: connection?.pool ?? null,
        target: connection?.target ?? null,
        targetingString: connection?.targetingString || null,
        targetMatch: null,
        status: 'starting',
        statusDetail: STATUS_DETAIL.starting,
        ip: null,
        locationAttempts: 1,
        locationMaxAttempts,
        locationWarning: null,
        proxySessionId: connection?.sessionId ?? null,
        currentUrl: null,
        startedAt,
        error: null,
        browserPid: null,
        lastHeartbeatAt: null,
      },
      runId: run.id,
      profile,
      engineInfo,
      connection,
      settings,
      formUrl,
      browser: null,
      context: null,
      page: null,
      relay: null,
      detachNetwork: null,
      secrets: connection ? [connection.password] : [],
      pageLoadedOk: false,
      finalized: false,
      cancelRequested: false,
      closeReason: null,
      launchTask: null,
      startupTimedOut: false,
      closingAfterLastWindow: false,
    }
    live.set(ls.session.id, ls)
    remember(ls)
    logger.info(SCOPE, `Launching profile "${profile.name}" with ${engineInfo.label}`, {
      sessionId: ls.session.id,
      runId: run.id,
      engine: profile.engine,
      executablePath: engineInfo.executablePath,
      devicePreset: profile.devicePreset,
      proxyMode: profile.proxyMode,
      provider: connection ? profile.providerId : null,
      proxyPool: connection?.pool ?? null,
      targeting: connection?.targetingString || null,
      proxySessionId: connection?.sessionId ?? null,
      locationPolicy: connection ? settings.locationMatchPolicy : null,
      locationMaxAttempts,
      formUrl,
      ephemeral: profile.ephemeral,
    })
    setStatus(ls, 'starting')
    const returned = snapshot(ls.session)

    // Fire-and-forget: the pipeline reports through events; nothing here can reject.
    ls.launchTask = Promise.resolve()
      .then(() => runLaunchPipeline(ls))
      .catch(async (err: unknown) => {
        logger.error(SCOPE, `${label(ls)}: unexpected launch failure: ${shortErrorText(err, ls.secrets)}`, {
          sessionId: ls.session.id,
          runId: ls.runId,
        })
        if (ls.finalized) return
        if (ls.browser) {
          await disposeBrowser(ls)
          finalize(ls, 'unexpected launch failure')
          return
        }
        abandon(ls, err)
      })
      .finally(() => {
        ls.launchTask = null
      })
    return returned
  }

  const requireLive = (sessionId: string): LiveSession => {
    const ls = live.get(sessionId)
    if (ls) return ls
    if (closedIds.has(sessionId)) {
      throw new AppException('SESSION_CLOSED', 'This browser session has already been closed.')
    }
    throw new AppException('NOT_FOUND', `Session "${sessionId}" was not found.`)
  }

  const close = async (sessionId: string): Promise<void> => {
    const ls = requireLive(sessionId)
    ls.closeReason ??= 'closed by user'

    if (ls.launchTask) {
      // Cancel the in-flight launch: closing an existing browser makes any pending step reject fast;
      // otherwise the pipeline notices `cancelRequested` at its next checkpoint and disposes what it created.
      ls.cancelRequested = true
      setStatus(ls, 'closing')
      logger.info(SCOPE, `${label(ls)}: close requested during launch`, { sessionId })
      if (ls.browser) await disposeBrowser(ls)
      await ls.launchTask
      if (!ls.finalized) finalize(ls, 'cancelled during launch')
      else if (live.has(sessionId)) markClosed(ls)
      return
    }

    if (ls.finalized || !ls.browser) {
      // Failed before a browser existed (proxy/launch error): the run is already final, just dismiss it.
      markClosed(ls)
      return
    }
    setStatus(ls, 'closing')
    logger.info(SCOPE, `${label(ls)}: closing browser`, { sessionId })
    try {
      await disposeBrowser(ls)
    } finally {
      finalize(ls, 'closed by user')
    }
  }

  return {
    launch,
    close,

    async closeAll(): Promise<void> {
      const open = [...live.values()]
      await Promise.allSettled(
        open.map(async (ls) => {
          ls.closeReason ??= 'app shutdown'
          try {
            await withTimeout(close(ls.session.id), closeTimeoutMs, `Closing ${label(ls)}`)
          } catch (err) {
            logger.warn(SCOPE, `${label(ls)}: ${shortErrorText(err, ls.secrets)}; finalising the run anyway`, {
              sessionId: ls.session.id,
            })
            if (live.has(ls.session.id)) finalize(ls, 'close timed out')
          }
        }),
      )
    },

    async focus(sessionId: string): Promise<void> {
      const ls = requireLive(sessionId)
      const page = ls.page && !ls.page.isClosed() ? ls.page : (openPages(ls).at(-1) ?? null)
      if (!page || ls.finalized || !ls.context) {
        throw new AppException('SESSION_CLOSED', 'The browser window is no longer open.')
      }
      if (ls.engineInfo.family === 'chromium') {
        // A minimised window stays minimised on bringToFront(); restore it through CDP first.
        try {
          const cdp = await ls.context.newCDPSession(page)
          try {
            const { windowId } = (await cdp.send('Browser.getWindowForTarget')) as { windowId: number }
            const { bounds } = (await cdp.send('Browser.getWindowBounds', { windowId })) as { bounds: { windowState?: string } }
            if (bounds.windowState === 'minimized') await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
          } finally {
            await cdp.detach().catch(() => undefined)
          }
        } catch (err) {
          logger.warn(SCOPE, `${label(ls)}: could not restore the window: ${shortErrorText(err, ls.secrets)}`, { sessionId })
        }
      }
      try {
        await page.bringToFront()
      } catch (err) {
        throw new AppException('SESSION_CLOSED', 'The browser window could not be brought to the front.', shortErrorText(err, ls.secrets))
      }
      logger.info(SCOPE, `${label(ls)}: brought to the front`, { sessionId })
    },

    sessionPids(): number[] {
      return [...live.values()].map((ls) => ls.session.browserPid).filter((pid): pid is number => pid !== null)
    },

    async screenshot(sessionId: string): Promise<string> {
      const ls = requireLive(sessionId)
      if (!ls.page || ls.page.isClosed() || ls.finalized) {
        throw new AppException('SESSION_CLOSED', 'The browser page is no longer open, so no screenshot can be taken.')
      }
      const dir = getSettings().screenshotDir
      const filePath = path.join(dir, `${ls.runId}-${timestampForFile(new Date())}.png`)
      try {
        await mkdir(dir, { recursive: true })
        await ls.page.screenshot({ path: filePath, fullPage: false, mask: DEFAULT_MASK_SELECTORS.map((selector) => ls.page!.locator(selector)) })
      } catch (err) {
        throw new AppException(
          'INTERNAL',
          'Screenshot failed. Check that the screenshot directory is writable and the browser window is still open.',
          shortErrorText(err, ls.secrets),
        )
      }
      updateRun(ls, { screenshotPath: filePath })
      logger.info(SCOPE, `${label(ls)}: screenshot saved to ${filePath}`, { sessionId, runId: ls.runId })
      return filePath
    },

    listActive(): BrowserSession[] {
      return [...live.values()].map((ls) => snapshot(ls.session))
    },

    get(sessionId: string): BrowserSession | null {
      const ls = live.get(sessionId)
      return ls ? snapshot(ls.session) : null
    },

    onSessionUpdate(listener): () => void {
      sessionListeners.add(listener)
      return () => sessionListeners.delete(listener)
    },
    onRunUpdate(listener): () => void {
      runListeners.add(listener)
      return () => runListeners.delete(listener)
    },
    onNetworkEntry(listener): () => void {
      networkListeners.add(listener)
      return () => networkListeners.delete(listener)
    },
  }
}

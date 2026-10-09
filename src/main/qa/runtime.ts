import { chromium, firefox, webkit } from 'playwright-core'
import type { Browser } from 'playwright-core'
import type { Profile } from '@shared/types'
import type { QaExecution, ScenarioInput } from '@shared/qa'
import type { BrowserProvisioner, ProxyManager, Logger, ProxyConnection, IpChecker } from '../contracts'
import { AppException } from '../contracts'
import { DEVICE_PRESETS, buildContextOptions } from '../browser/device-presets'
import { webkitLaunchEnv, webkitLibsDirFromEnv } from '../browser/browsers-path'
import { startProxyRelay } from '../proxy/local-relay'
import type { ProxyRelay } from '../proxy/local-relay'
import { executeScenario } from './executor'
import { redactEvidence } from '../security/data-privacy'
import type { VisualStore } from './visual'
import { TRACE_SKIPPED_NOTE, shouldSkipTrace } from '../site-access'
import type { SiteAccessAttacher } from '../site-access'

export function createQaSessionFactory(
  provisioner: BrowserProvisioner,
  proxy: ProxyManager,
  _sanitize: (text: string) => string,
  logger: Logger,
  custom?: { resolve: (id: string) => ProxyConnection; checker: IpChecker },
  siteAccess?: SiteAccessAttacher,
) {
  return async (profile: Profile, scenario: ScenarioInput, signal: AbortSignal, headless = true) => {
    const info = await provisioner.resolveEngine(profile.engine)
    const preset = DEVICE_PRESETS.find((item) => item.id === profile.devicePreset)
    if (!preset || !preset.supportedEngines.includes(profile.engine))
      throw new AppException('INVALID_PROFILE', 'This device does not support the selected engine.')
    let connection =
      scenario.gatewayId && custom ? custom.resolve(scenario.gatewayId) : proxy.resolveForProfile(profile)
    let exitIp: string | undefined
    let targetMatch: string | null = null
    if (scenario.gatewayId) {
      if (!custom) throw new AppException('INVALID_INPUT', 'Custom gateway is not configured for this runner.')
      if (profile.target)
        throw new AppException('INVALID_INPUT', 'Custom gateways do not support provider location targeting; use a registered proxy provider for location matrices.')
      exitIp = (await custom.checker.lookup(connection)).ip
      if (connection?.server.startsWith('socks') && info.family === 'webkit')
        throw new AppException('INVALID_INPUT', 'WebKit custom gateways require an HTTP proxy.')
    } else if (connection) {
      const verified = await proxy.verifyForLaunch(profile, {
        policy: 'exact',
        attempts: 3,
        shouldContinue: () => !signal.aborted,
      })
      if (verified.result.status !== 'working')
        throw new AppException('PROXY_DEAD', verified.result.error?.message ?? 'Proxy verification failed.')
      exitIp = verified.result.ip?.ip
      targetMatch = verified.targetMatch
      if (profile.target && targetMatch !== 'match')
        throw new AppException('INVALID_INPUT', 'Proxy exit did not match the requested test location.')
      // verifyForLaunch may rotate the sticky ID. Use the selected ID, not the stale snapshot.
      connection = proxy.resolveForProfile({
        ...profile,
        stickySessionId: verified.sessionId ?? profile.stickySessionId,
      })
    }
    signal.throwIfAborted()
    let browser: Browser | undefined
    let relay: ProxyRelay | undefined
    const abort = (): void => {
      if (browser) void browser.close().catch(() => undefined)
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      let server = connection?.server
      if (info.family === 'webkit' && connection) {
        relay = await startProxyRelay(connection, logger)
        server = relay.server
      }
      const type = info.family === 'firefox' ? firefox : info.family === 'webkit' ? webkit : chromium
      const libsDir = webkitLibsDirFromEnv()
      browser = await type.launch({
        headless,
        timeout: 45000,
        ...(info.kind === 'installed' && info.executablePath ? { executablePath: info.executablePath } : {}),
        ...(info.family === 'webkit' && libsDir ? { env: webkitLaunchEnv(libsDir) } : {}),
        ...(connection
          ? {
              proxy: {
                server: server!,
                ...(relay ? {} : { username: connection.username, password: connection.password }),
              },
            }
          : {}),
      })
      signal.throwIfAborted()
      const context = await browser.newContext({
        ...buildContextOptions(profile, preset),
        serviceWorkers: 'block',
        acceptDownloads: false,
      })
      const siteAccessNotes: string[] = []
      await siteAccess?.attach(context, (note) => siteAccessNotes.push(note))
      const close = async (): Promise<void> => {
        signal.removeEventListener('abort', abort)
        await browser?.close().catch(() => undefined)
        await relay?.close()
      }
      return { context, exitIp, targetMatch, browserVersion: browser.version(), siteAccessNotes, close }
    } catch (err) {
      signal.removeEventListener('abort', abort)
      await browser?.close().catch(() => undefined)
      await relay?.close()
      throw err
    }
  }
}
export type QaSessionFactory = ReturnType<typeof createQaSessionFactory>
export function createQaExecutor(
  provisioner: BrowserProvisioner,
  proxy: ProxyManager,
  sanitize: (text: string) => string,
  logger: Logger,
  custom?: { resolve: (id: string) => ProxyConnection; checker: IpChecker },
  visuals?: VisualStore,
  siteAccess?: SiteAccessAttacher,
) {
  const open = createQaSessionFactory(provisioner, proxy, sanitize, logger, custom, siteAccess)
  return async (
    profile: Profile,
    scenario: ScenarioInput,
    dir: string,
    signal: AbortSignal,
  ): Promise<QaExecution & { exitIp?: string; targetMatch?: string | null }> => {
    const started = Date.now()
    const traceSkipped = shouldSkipTrace(scenario.captureTrace, siteAccess)
    const session = await open(profile, scenario, signal)
    try {
      const execution = await executeScenario(
        session.context,
        traceSkipped ? { ...scenario, captureTrace: false } : scenario,
        dir,
        signal,
        (text) => redactEvidence(sanitize(text)),
        visuals
          ? {
              store: visuals,
              fingerprint: [
                process.platform,
                process.arch,
                profile.engine,
                session.browserVersion,
                profile.devicePreset,
                profile.viewportWidth,
                profile.viewportHeight,
                profile.locale,
                profile.timezone,
                profile.target,
                new URL(scenario.startUrl).origin,
              ],
            }
          : undefined,
      )
      // Token notes are recorded while the scenario navigates, so collect them only after it ran.
      const notes = [...(traceSkipped ? [TRACE_SKIPPED_NOTE] : []), ...session.siteAccessNotes, ...(execution.notes ?? [])]
      return {
        ...execution,
        exitIp: session.exitIp,
        targetMatch: session.targetMatch,
        ...(notes.length > 0 ? { notes } : {}),
        durationMs: Date.now() - started,
      }
    } finally {
      await session.close()
    }
  }
}

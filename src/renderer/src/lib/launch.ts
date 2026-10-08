import type { BrowserSession, ProductKey, ProxyMode, SessionStatus } from '@shared/types'

// ---------------------------------------------------------------------------
// Connection kind (direct vs. proxied) and the session label shown with an IP
// ---------------------------------------------------------------------------

/**
 * How a run reached the network.
 * - `direct`: profile has proxyMode 'none'; the exit IP is the machine's own.
 * - `sticky`: the provider's sticky session (session id known).
 * - `rotating`: the provider's rotating gateway (no session id).
 * - `unknown`: the profile is gone and no session id was recorded, so rotating vs. direct cannot be told apart.
 */
export type ConnectionKind = 'direct' | 'sticky' | 'rotating' | 'unknown'

export function connectionKindFor(proxyMode: ProxyMode | null | undefined, sessionId: string | null): ConnectionKind {
  switch (proxyMode) {
    case 'none':
      return 'direct'
    case 'sticky':
      return 'sticky'
    case 'rotating':
      return 'rotating'
    default:
      return sessionId ? 'sticky' : 'unknown'
  }
}

/**
 * Connection kind from what a run/session recorded, used when the owning profile is unknown (deleted or
 * ephemeral and not yet fetched): a null pool is a direct connection, a session id means sticky.
 */
export function connectionKindForRecord(record: { proxyPool: ProductKey | null; proxySessionId: string | null }, profileMode?: ProxyMode | null): ConnectionKind {
  if (profileMode !== null && profileMode !== undefined) return connectionKindFor(profileMode, record.proxySessionId)
  if (record.proxyPool === null) return 'direct'
  return record.proxySessionId ? 'sticky' : 'rotating'
}

/** "none" for direct runs, "rotating" only when the mode really is rotating, the sticky id otherwise. */
export function sessionLabelFor(kind: ConnectionKind, sessionId: string | null): string {
  switch (kind) {
    case 'direct':
      return 'none'
    case 'rotating':
      return 'rotating'
    case 'sticky':
    case 'unknown':
      return sessionId ?? '—'
  }
}

// ---------------------------------------------------------------------------
// Launch progress steps
// ---------------------------------------------------------------------------

export type LaunchStepId = 'validating' | 'verifying' | 'launching' | 'open'
export type LaunchStepState = 'done' | 'active' | 'failed' | 'pending'

export interface LaunchStep {
  id: LaunchStepId
  label: string
  state: LaunchStepState
}

export const LAUNCH_STEP_ORDER: readonly LaunchStepId[] = ['validating', 'verifying', 'launching', 'open']

const STEP_FOR_STATUS: Record<Exclude<SessionStatus, 'error'>, LaunchStepId> = {
  starting: 'validating',
  'verifying-proxy': 'verifying',
  launching: 'launching',
  open: 'open',
  closing: 'open',
  closed: 'open',
}

/** Codes raised while the profile is validated (before any network activity). */
const VALIDATION_CODES: ReadonlySet<string> = new Set(['INVALID_PROFILE', 'INVALID_INPUT', 'NOT_FOUND'])
/** Codes the proxy verification step can raise. They can also surface during navigation (through the proxy). */
const PROXY_CODES: ReadonlySet<string> = new Set(['PROXY_NOT_CONFIGURED', 'PROXY_AUTH_FAILED', 'PROXY_TIMEOUT', 'PROXY_DEAD', 'DNS_FAILURE', 'IP_VERIFY_FAILED'])
/** Codes raised while the browser executable starts. */
const LAUNCH_CODES: ReadonlySet<string> = new Set(['BROWSER_MISSING', 'BROWSER_LAUNCH_FAILED'])
/** Codes raised by the navigation to the form (the browser window exists at this point). */
const NAVIGATION_CODES: ReadonlySet<string> = new Set(['SITE_TIMEOUT', 'SITE_HTTP_ERROR', 'SSL_ERROR'])

export function stepLabel(id: LaunchStepId, connection: ConnectionKind = 'unknown'): string {
  switch (id) {
    case 'validating':
      return 'Validating'
    case 'verifying':
      return connection === 'direct' ? 'Checking exit IP' : 'Verifying proxy'
    case 'launching':
      return 'Launching'
    case 'open':
      return 'Open'
  }
}

/**
 * Which step was in progress when a session failed.
 *
 * The main process only reports `status: 'error'`, so the step is reconstructed from the error code first
 * (most reliable, also works after a reload), then from the status observed just before the error
 * (`statusBeforeError`, tracked by the sessions store), then from what the session had achieved so far.
 */
export function failedStepFor(session: BrowserSession, statusBeforeError?: SessionStatus | null): LaunchStepId {
  const code: string = session.error?.code ?? ''
  if (VALIDATION_CODES.has(code)) return 'validating'
  if (LAUNCH_CODES.has(code)) return 'launching'
  if (NAVIGATION_CODES.has(code)) return 'open'
  if (PROXY_CODES.has(code)) {
    // Navigation runs under the 'launching' status, so a proxy/DNS code seen after launching came from the site load.
    if (statusBeforeError === 'launching' || statusBeforeError === 'open') return 'open'
    if (statusBeforeError === 'starting' || statusBeforeError === 'verifying-proxy') return 'verifying'
    return session.ip === null ? 'verifying' : 'open'
  }
  if (statusBeforeError && statusBeforeError !== 'error') {
    const step = STEP_FOR_STATUS[statusBeforeError]
    return step === 'launching' && session.currentUrl ? 'open' : step
  }
  if (session.currentUrl) return 'open'
  if (session.ip) return 'launching'
  return 'verifying'
}

/** Per-step state for the launch progress strip. Earlier steps stay done; later steps stay pending. */
export function deriveLaunchSteps(
  session: BrowserSession,
  options: { statusBeforeError?: SessionStatus | null; connection?: ConnectionKind } = {},
): LaunchStep[] {
  const connection = options.connection ?? 'unknown'
  if (session.status === 'error') {
    const failedIndex = LAUNCH_STEP_ORDER.indexOf(failedStepFor(session, options.statusBeforeError))
    return LAUNCH_STEP_ORDER.map((id, index) => ({
      id,
      label: stepLabel(id, connection),
      state: index < failedIndex ? 'done' : index === failedIndex ? 'failed' : 'pending',
    }))
  }
  const currentIndex = LAUNCH_STEP_ORDER.indexOf(STEP_FOR_STATUS[session.status])
  const settled = session.status === 'open' || session.status === 'closing' || session.status === 'closed'
  return LAUNCH_STEP_ORDER.map((id, index) => ({
    id,
    label: stepLabel(id, connection),
    state: index < currentIndex || (index === currentIndex && settled) ? 'done' : index === currentIndex ? 'active' : 'pending',
  }))
}

/**
 * True while a browser window exists for the session: status 'open', or an error raised after the window was
 * created (navigation failure), in which case the main process keeps the window open for inspection.
 */
export function isBrowserWindowOpen(session: BrowserSession | null | undefined, statusBeforeError?: SessionStatus | null): boolean {
  if (!session) return false
  if (session.status === 'open') return true
  if (session.status === 'error') return failedStepFor(session, statusBeforeError) === 'open'
  return false
}

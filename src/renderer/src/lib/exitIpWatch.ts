/**
 * Plain-language wording for the exit-IP watch (settings.watchExitIp), shared by the run page,
 * the launch panel, history and tests. Users are not technical: every message says what
 * happened and what to do.
 */
import { IP_HOLD_WARNING_MS } from '@shared/types'
import type { BrowserSession, ExitIpChange, ExitIpWatchState, GeoTarget, IpInfo } from '@shared/types'

export type ExitIpTone = 'ok' | 'danger' | 'warning' | 'info'

export interface ExitIpNotice {
  tone: ExitIpTone
  title: string
  detail: string | null
}

function place(city: string | null, region: string | null): string {
  return [city, region].filter((part): part is string => Boolean(part)).join(', ')
}

/** "198.51.100.57 (Duncan, Oklahoma)" or just the IP. */
export function describeChangeTarget(change: Pick<ExitIpChange, 'toIp' | 'city' | 'region'>): string {
  const where = place(change.city, change.region)
  return where ? `${change.toIp} (${where})` : change.toIp
}

/** Why the IP changed, in plain words (empty for records without a known reason). */
export function changeReasonText(change: Pick<ExitIpChange, 'reason' | 'afterMinutes'> | undefined, holdMinutes: number | null | undefined): string {
  if (change?.reason === 'expired') return holdMinutes ? ` The proxy keeps an IP for ${holdMinutes} minutes, and that time ran out.` : ' The time the proxy keeps an IP ran out.'
  if (change?.reason === 'replaced') return ` The proxy replaced the IP early${change.afterMinutes !== undefined ? ` (after ${change.afterMinutes} min)` : ''} because the home connection behind it went offline; a city or state target keeps its IP longer than a small town.`
  return ''
}

/** "2:45 PM" in the user's locale. */
function clockTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
}

/** Where a rotating session's IPs can come from: the target's area, else "the provider's pool". */
export function rotatingArea(target: GeoTarget | null): string {
  if (!target) return "the provider's pool"
  if (target.zip) return `ZIP ${target.zip}`
  if (target.city) return [target.city, target.stateCode ?? target.state].filter(Boolean).join(', ')
  if (target.state) return target.state
  return target.country.toUpperCase()
}

export function exitIpNotice(input: {
  watch: ExitIpWatchState
  ipChanges: readonly ExitIpChange[]
  /** The IP verified before the browser opened (only ip/city/region are used). */
  verifiedIp: Pick<IpInfo, 'ip' | 'city' | 'region'> | null
  target: GeoTarget | null
  lastIpCheckAt: string | null
  /** When the sticky session's lifetime ends (ISO) and its length; absent when unknown. */
  ipHoldUntil?: string | null
  ipHoldMinutes?: number | null
  /** Current time (epoch ms), for the countdown; defaults to now. */
  now?: number
}): ExitIpNotice | null {
  const { watch, ipChanges } = input
  if (ipChanges.length > 0 || watch === 'changed') {
    const last = ipChanges[ipChanges.length - 1]
    const from = input.verifiedIp ? `${input.verifiedIp.ip}${place(input.verifiedIp.city, input.verifiedIp.region) ? ` (${place(input.verifiedIp.city, input.verifiedIp.region)})` : ''}` : (ipChanges[0]?.fromIp ?? 'the verified IP')
    return {
      tone: 'danger',
      title: 'Browser stopped: the IP address changed',
      detail: last
        ? `The proxy switched from ${from} to ${describeChangeTarget(last)}${ipChanges.length > 1 ? ` (${ipChanges.length} changes)` : ''}.${changeReasonText(last, input.ipHoldMinutes)} The browser was closed so the form could not be sent from another IP. Launch again.`
        : 'The proxy switched to another IP. The browser was closed so the form could not be sent from another IP. Launch again.',
    }
  }
  switch (watch) {
    case 'watching': {
      const until = input.ipHoldUntil ? Date.parse(input.ipHoldUntil) : Number.NaN
      const left = until - (input.now ?? Date.now())
      if (left > 0 && left <= IP_HOLD_WARNING_MS) {
        const minutes = Math.max(1, Math.round(left / 60_000))
        return {
          tone: 'warning',
          title: `The IP changes in about ${minutes} minute${minutes === 1 ? '' : 's'}`,
          detail: 'Finish and submit the form now, or close the browser and launch again for a fresh IP. When the IP changes, the browser is stopped.',
        }
      }
      const holding = left > 0 && input.ipHoldUntil ? `Same IP until ${clockTime(input.ipHoldUntil)} (${Math.ceil(left / 60_000)} min left). ` : ''
      return {
        tone: 'ok',
        title: 'IP stable',
        detail: input.lastIpCheckAt ? `${holding}Re-checked every 20 seconds through the same session. If it changes, the browser is stopped before anything more is sent.` : 'Checking the IP through the same session…',
      }
    }
    case 'unverified':
      return {
        tone: 'warning',
        title: 'IP could not be re-checked',
        detail: 'The last checks through the proxy failed, so the current IP is unknown. Wait until it shows "IP stable" again before submitting.',
      }
    case 'rotating':
      return {
        tone: 'info',
        title: 'Rotating IP — the website may see a different IP',
        detail: `Every connection can use another IP in ${rotatingArea(input.target)}, so the IP shown here is only a sample. Turn on "Sticky session" to keep one IP for the whole visit.`,
      }
    default:
      return null
  }
}

/** Convenience for a live session. */
export function sessionExitIpNotice(session: Pick<BrowserSession, 'exitIpWatch' | 'ipChanges' | 'ip' | 'target' | 'lastIpCheckAt' | 'ipHoldUntil' | 'ipHoldMinutes'>, now?: number): ExitIpNotice | null {
  return exitIpNotice({
    watch: session.exitIpWatch,
    ipChanges: session.ipChanges,
    verifiedIp: session.ip,
    target: session.target,
    lastIpCheckAt: session.lastIpCheckAt,
    ipHoldUntil: session.ipHoldUntil,
    ipHoldMinutes: session.ipHoldMinutes,
    ...(now !== undefined ? { now } : {}),
  })
}

/** New changes in `next` compared with `previous` (for the toast). */
export function newIpChanges(previous: readonly ExitIpChange[] | undefined, next: readonly ExitIpChange[]): ExitIpChange[] {
  return next.slice(previous?.length ?? 0)
}

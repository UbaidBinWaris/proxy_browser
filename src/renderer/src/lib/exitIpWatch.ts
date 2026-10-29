/**
 * Plain-language wording for the exit-IP watch (settings.watchExitIp), shared by the run page,
 * the launch panel, history and tests. Users are not technical: every message says what
 * happened and what to do.
 */
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
}): ExitIpNotice | null {
  const { watch, ipChanges } = input
  if (ipChanges.length > 0 || watch === 'changed') {
    const last = ipChanges[ipChanges.length - 1]
    const from = input.verifiedIp ? `${input.verifiedIp.ip}${place(input.verifiedIp.city, input.verifiedIp.region) ? ` (${place(input.verifiedIp.city, input.verifiedIp.region)})` : ''}` : (ipChanges[0]?.fromIp ?? 'the verified IP')
    return {
      tone: 'danger',
      title: 'Browser stopped: the IP address changed',
      detail: last
        ? `The proxy switched from ${from} to ${describeChangeTarget(last)}${ipChanges.length > 1 ? ` (${ipChanges.length} changes)` : ''}. The browser was closed so the form could not be sent from another IP. Launch again.`
        : 'The proxy switched to another IP. The browser was closed so the form could not be sent from another IP. Launch again.',
    }
  }
  switch (watch) {
    case 'watching':
      return {
        tone: 'ok',
        title: 'IP stable',
        detail: input.lastIpCheckAt ? 'Re-checked every 20 seconds through the same session. If it changes, the browser is stopped before anything more is sent.' : 'Checking the IP through the same session…',
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
export function sessionExitIpNotice(session: Pick<BrowserSession, 'exitIpWatch' | 'ipChanges' | 'ip' | 'target' | 'lastIpCheckAt'>): ExitIpNotice | null {
  return exitIpNotice({ watch: session.exitIpWatch, ipChanges: session.ipChanges, verifiedIp: session.ip, target: session.target, lastIpCheckAt: session.lastIpCheckAt })
}

/** New changes in `next` compared with `previous` (for the toast). */
export function newIpChanges(previous: readonly ExitIpChange[] | undefined, next: readonly ExitIpChange[]): ExitIpChange[] {
  return next.slice(previous?.length ?? 0)
}

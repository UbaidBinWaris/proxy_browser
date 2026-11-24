/**
 * Plain-language system notification for an exit-IP change of an open session.
 *
 * While filling a form the user looks at the browser window, not the app, so an in-app
 * banner alone would go unnoticed. By the time it shows, the browser has already been stopped
 * (its traffic blocked, then closed). The text must make sense to a non-technical user:
 * what happened, and the one thing to do about it.
 */
import type { BrowserSession, ExitIpChange } from '@shared/types'

export interface NotificationText {
  title: string
  body: string
}

function place(city: string | null, region: string | null): string {
  return [city, region].filter((part): part is string => Boolean(part)).join(', ') || 'another location'
}

export function ipChangeNotificationText(session: Pick<BrowserSession, 'profileName' | 'ip' | 'ipHoldMinutes'>, change: ExitIpChange): NotificationText {
  const before = session.ip && session.ip.ip === change.fromIp ? place(session.ip.city, session.ip.region) : null
  const from = before ? `${change.fromIp} (${before})` : change.fromIp
  const why =
    change.reason === 'expired'
      ? ` because its ${session.ipHoldMinutes}-minute IP time ran out`
      : change.reason === 'replaced'
        ? ' early, because the home connection behind the IP went offline'
        : ''
  return {
    title: 'Browser stopped: the IP address changed',
    body: `"${session.profileName}": the proxy switched from ${from} to ${change.toIp} (${place(change.city, change.region)})${why}. The browser was closed so the form could not be sent from another IP. Launch again.`,
  }
}

/** Shown IP_HOLD_WARNING_MS before the sticky session's lifetime ends, while the user may still be on the form. */
export function ipHoldEndingNotificationText(session: Pick<BrowserSession, 'profileName'>, minutesLeft: number): NotificationText {
  return {
    title: `The IP changes in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}`,
    body: `"${session.profileName}": finish and submit the form now, or close the browser and launch again for a fresh IP. When the IP changes, the browser is stopped.`,
  }
}

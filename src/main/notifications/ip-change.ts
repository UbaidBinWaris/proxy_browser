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

export function ipChangeNotificationText(session: Pick<BrowserSession, 'profileName' | 'ip'>, change: ExitIpChange): NotificationText {
  const before = session.ip && session.ip.ip === change.fromIp ? place(session.ip.city, session.ip.region) : null
  const from = before ? `${change.fromIp} (${before})` : change.fromIp
  return {
    title: 'Browser stopped: the IP address changed',
    body: `"${session.profileName}": the proxy switched from ${from} to ${change.toIp} (${place(change.city, change.region)}). The browser was closed so the form could not be sent from another IP. Launch again.`,
  }
}

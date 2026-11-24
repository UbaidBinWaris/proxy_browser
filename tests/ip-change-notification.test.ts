import { describe, expect, it } from 'vitest'
import type { IpInfo } from '../src/shared/types'
import { ipChangeNotificationText, ipHoldEndingNotificationText } from '../src/main/notifications/ip-change'

const verified: IpInfo = {
  ip: '203.0.113.74',
  country: 'United States',
  countryCode: 'US',
  region: 'Oklahoma',
  city: 'Shawnee',
  postalCode: '74801',
  isp: 'Optimum',
  asn: 'AS19108',
  latencyMs: 300,
  provider: 'ip-api',
  checkedAt: '2026-10-30T00:00:00.000Z',
}
const change = { at: '2026-10-30T00:05:00.000Z', fromIp: '203.0.113.74', toIp: '198.51.100.57', city: 'Duncan', region: 'Oklahoma', postalCode: '73533' }

describe('ipChangeNotificationText', () => {
  it('names both IPs and places and tells the user what to do', () => {
    const text = ipChangeNotificationText({ profileName: 'OK lead form', ip: verified, ipHoldMinutes: 15 }, change)
    expect(text.title).toBe('Browser stopped: the IP address changed')
    expect(text.body).toContain('"OK lead form"')
    expect(text.body).toContain('203.0.113.74 (Shawnee, Oklahoma)')
    expect(text.body).toContain('198.51.100.57 (Duncan, Oklahoma)')
    expect(text.body).toContain('The browser was closed so the form could not be sent from another IP. Launch again.')
  })

  it('omits the old place after a second change (it is no longer the launch IP)', () => {
    const second = { ...change, fromIp: '198.51.100.57', toIp: '8.8.8.8', city: null, region: null }
    const text = ipChangeNotificationText({ profileName: 'P', ip: verified, ipHoldMinutes: 15 }, second)
    expect(text.body).toContain('from 198.51.100.57 to 8.8.8.8 (another location)')
  })

  it('says why the IP changed when the session lifetime is known', () => {
    const expired = ipChangeNotificationText({ profileName: 'P', ip: verified, ipHoldMinutes: 15 }, { ...change, reason: 'expired', afterMinutes: 15 })
    expect(expired.body).toContain('because its 15-minute IP time ran out')
    const replaced = ipChangeNotificationText({ profileName: 'P', ip: verified, ipHoldMinutes: 60 }, { ...change, reason: 'replaced', afterMinutes: 7 })
    expect(replaced.body).toContain('early, because the home connection behind the IP went offline')
  })

  it('warns before the IP lifetime ends, without blaming anything', () => {
    expect(ipHoldEndingNotificationText({ profileName: 'MO form' }, 2)).toEqual({
      title: 'The IP changes in 2 minutes',
      body: '"MO form": finish and submit the form now, or close the browser and launch again for a fresh IP. When the IP changes, the browser is stopped.',
    })
    expect(ipHoldEndingNotificationText({ profileName: 'P' }, 1).title).toBe('The IP changes in 1 minute')
  })
})

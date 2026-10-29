import { describe, expect, it } from 'vitest'
import type { GeoTarget } from '../src/shared/types'
import { describeChangeTarget, exitIpNotice, newIpChanges, rotatingArea } from '../src/renderer/src/lib/exitIpWatch'

const OK: GeoTarget = { mode: 'state', country: 'us', state: 'Oklahoma', stateCode: 'OK', city: null, zip: null }
const verifiedIp = { ip: '203.0.113.74', city: 'Shawnee', region: 'Oklahoma' }
const change = { at: '2026-10-30T00:05:00.000Z', fromIp: '203.0.113.74', toIp: '198.51.100.57', city: 'Duncan', region: 'Oklahoma', postalCode: '73533' }

describe('exit-IP watch wording', () => {
  it('a change is a red "browser stopped" alert naming both IPs and places', () => {
    const notice = exitIpNotice({ watch: 'changed', ipChanges: [change], verifiedIp, target: OK, lastIpCheckAt: change.at })
    expect(notice?.tone).toBe('danger')
    expect(notice?.title).toBe('Browser stopped: the IP address changed')
    expect(notice?.detail).toContain('203.0.113.74 (Shawnee, Oklahoma)')
    expect(notice?.detail).toContain('198.51.100.57 (Duncan, Oklahoma)')
    expect(notice?.detail).toContain('The browser was closed so the form could not be sent from another IP')
  })

  it('recorded changes win over the watch state (history view after the session ended)', () => {
    expect(exitIpNotice({ watch: 'off', ipChanges: [change, { ...change, fromIp: change.toIp, toIp: '1.2.3.4' }], verifiedIp, target: OK, lastIpCheckAt: null })?.detail).toContain('(2 changes)')
  })

  it('stable, unverified, rotating and off', () => {
    expect(exitIpNotice({ watch: 'watching', ipChanges: [], verifiedIp, target: OK, lastIpCheckAt: change.at })).toMatchObject({ tone: 'ok', title: 'IP stable' })
    expect(exitIpNotice({ watch: 'unverified', ipChanges: [], verifiedIp, target: OK, lastIpCheckAt: null })).toMatchObject({ tone: 'warning' })
    const rotating = exitIpNotice({ watch: 'rotating', ipChanges: [], verifiedIp: null, target: OK, lastIpCheckAt: null })
    expect(rotating).toMatchObject({ tone: 'info', title: 'Rotating IP — the website may see a different IP' })
    expect(rotating?.detail).toContain('Oklahoma')
    expect(rotating?.detail).toContain('Sticky session')
    expect(exitIpNotice({ watch: 'off', ipChanges: [], verifiedIp, target: OK, lastIpCheckAt: null })).toBeNull()
  })

  it('helpers', () => {
    expect(describeChangeTarget(change)).toBe('198.51.100.57 (Duncan, Oklahoma)')
    expect(describeChangeTarget({ toIp: '1.2.3.4', city: null, region: null })).toBe('1.2.3.4')
    expect(rotatingArea({ ...OK, mode: 'zip', zip: '73533', city: 'Duncan' })).toBe('ZIP 73533')
    expect(rotatingArea({ ...OK, mode: 'city', city: 'Duncan' })).toBe('Duncan, OK')
    expect(rotatingArea(null)).toBe("the provider's pool")
    expect(newIpChanges(undefined, [change])).toEqual([change])
    expect(newIpChanges([change], [change])).toEqual([])
  })
})

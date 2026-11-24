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

  it('counts down the sticky session lifetime and warns in its last two minutes', () => {
    const now = Date.parse('2026-11-24T12:00:00.000Z')
    const base = { watch: 'watching' as const, ipChanges: [], verifiedIp, target: OK, lastIpCheckAt: change.at, ipHoldMinutes: 15 }
    const plenty = exitIpNotice({ ...base, ipHoldUntil: new Date(now + 9.5 * 60_000).toISOString(), now })
    expect(plenty).toMatchObject({ tone: 'ok', title: 'IP stable' })
    expect(plenty?.detail).toMatch(/^Same IP until .+ \(10 min left\)\. Re-checked every 20 seconds/)
    const ending = exitIpNotice({ ...base, ipHoldUntil: new Date(now + 90_000).toISOString(), now })
    expect(ending).toMatchObject({ tone: 'warning', title: 'The IP changes in about 2 minutes' })
    expect(ending?.detail).toContain('submit the form now, or close the browser and launch again')
    // Past the end (the change is detected on the next check) and unknown lifetimes keep the plain wording.
    expect(exitIpNotice({ ...base, ipHoldUntil: new Date(now - 1000).toISOString(), now })?.detail).toMatch(/^Re-checked every 20 seconds/)
    expect(exitIpNotice({ ...base, ipHoldUntil: null, now })?.detail).toMatch(/^Re-checked every 20 seconds/)
  })

  it('explains an expired lifetime and an early replacement differently', () => {
    const expired = exitIpNotice({ watch: 'changed', ipChanges: [{ ...change, reason: 'expired', afterMinutes: 15 }], verifiedIp, target: OK, lastIpCheckAt: change.at, ipHoldMinutes: 15 })
    expect(expired?.detail).toContain('The proxy keeps an IP for 15 minutes, and that time ran out.')
    const replaced = exitIpNotice({ watch: 'changed', ipChanges: [{ ...change, reason: 'replaced', afterMinutes: 6 }], verifiedIp, target: OK, lastIpCheckAt: change.at, ipHoldMinutes: 60 })
    expect(replaced?.detail).toContain('The proxy replaced the IP early (after 6 min) because the home connection behind it went offline')
  })
})

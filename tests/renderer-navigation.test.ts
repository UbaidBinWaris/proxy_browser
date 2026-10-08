/**
 * Pure helpers behind the simplified UI: routing (Settings tabs, Advanced sections,
 * legacy redirects, keys-window route), keys-window inactivity, History overview,
 * proxy key presentation, the Launch device summary and partial credential updates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DevicePresetInfo, ProxyPoolStatus, ProxySession, TestRun } from '../src/shared/types'
import { NOTHING_TO_UPDATE_MESSAGE, emptyCredentialsForm, validateCredentialsUpdateForm } from '../src/renderer/src/lib/credentialsForm'
import { formatSuccessRate, historyOverview } from '../src/renderer/src/lib/history'
import { KEYS_INACTIVITY_TIMEOUT_MS, createInactivityTracker, formatCountdown, inactivityNote } from '../src/renderer/src/lib/keysWindow'
import { deviceSummary, incompatibleEngineSuffix, userAgentFamily } from '../src/renderer/src/lib/launcherForm'
import {
  ADVANCED_SECTIONS,
  DEFAULT_OPEN_SECTIONS,
  LEGACY_REDIRECTS,
  PROXY_KEYS_PATH,
  SETTINGS_FIELD_LOCATIONS,
  advancedSectionFromHash,
  firstSettingsError,
  historyRunPath,
  isKeysWindowHash,
  parseSettingsTab,
  settingsPath,
} from '../src/renderer/src/lib/navigation'
import { groupEngineOptions } from '../src/renderer/src/lib/profileForm'
import { lastPoolTest, poolKeyLine, proxyStatusPill, supportsPartialUpdate, unchangedPlaceholder, unconfiguredPools } from '../src/renderer/src/lib/proxyKeys'
import { settingsFormFrom } from '../src/renderer/src/lib/settingsForm'
import { DEFAULT_SETTINGS } from '../src/shared/types'

describe('navigation', () => {
  it('recognises the keys-window hash route only', () => {
    expect(isKeysWindowHash('#/keys')).toBe(true)
    expect(isKeysWindowHash('#/keys/')).toBe(true)
    expect(isKeysWindowHash('#/keys?x=1')).toBe(true)
    expect(isKeysWindowHash('#/keysmith')).toBe(false)
    expect(isKeysWindowHash('#/settings/advanced#proxy-keys')).toBe(false)
    expect(isKeysWindowHash('')).toBe(false)
  })

  it('parses settings tabs and builds deep links into Advanced sections', () => {
    expect(parseSettingsTab('general')).toBe('general')
    expect(parseSettingsTab('about')).toBe('about')
    expect(parseSettingsTab('proxy')).toBeNull()
    expect(parseSettingsTab(undefined)).toBeNull()
    expect(settingsPath('browsers')).toBe('/settings/browsers')
    expect(settingsPath('advanced', 'logs')).toBe('/settings/advanced#logs')
    expect(PROXY_KEYS_PATH).toBe('/settings/advanced#proxy-keys')
    expect(advancedSectionFromHash('#proxy-sessions')).toBe('proxy-sessions')
    expect(advancedSectionFromHash('#nope')).toBeNull()
    expect(advancedSectionFromHash('')).toBeNull()
    expect(DEFAULT_OPEN_SECTIONS).toEqual(['proxy-keys'])
    expect(ADVANCED_SECTIONS[0]).toBe('proxy-keys')
  })

  it('keeps old links working', () => {
    expect(LEGACY_REDIRECTS).toEqual({
      '/dashboard': '/launch',
      '/proxy': '/settings/advanced#proxy-keys',
      '/proxy-sessions': '/settings/advanced#proxy-sessions',
      '/logs': '/settings/advanced#logs',
      '/runs': '/history',
    })
    expect(historyRunPath('run 1/2')).toBe('/history/run%201%2F2')
  })

  it('places every settings field in exactly one location and finds the first error in display order', () => {
    const fields = Object.keys(settingsFormFrom({ ...DEFAULT_SETTINGS, screenshotDir: '/tmp/s' })).sort()
    expect(Object.keys(SETTINGS_FIELD_LOCATIONS).sort()).toEqual(fields)
    expect(SETTINGS_FIELD_LOCATIONS.defaultFormUrl).toEqual({ tab: 'general', section: null })
    expect(SETTINGS_FIELD_LOCATIONS.extraChromiumArgs).toEqual({ tab: 'advanced', section: 'browser-flags' })
    expect(SETTINGS_FIELD_LOCATIONS.navigationTimeoutMs).toEqual({ tab: 'advanced', section: 'network-inspector' })
    expect(firstSettingsError({ ipCheckRetries: 'bad', locationMatchAttempts: 'bad' })).toEqual({ field: 'locationMatchAttempts', tab: 'advanced', section: 'targeting' })
    expect(firstSettingsError({ defaultFormUrl: 'bad', ipCheckRetries: 'bad' })).toEqual({ field: 'defaultFormUrl', tab: 'general', section: null })
    expect(firstSettingsError({ defaultFormUrl: undefined })).toBeNull()
  })
})

describe('keys window inactivity', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('expires after the timeout without input, once', () => {
    const onExpire = vi.fn()
    createInactivityTracker({ timeoutMs: KEYS_INACTIVITY_TIMEOUT_MS, onExpire })
    vi.advanceTimersByTime(KEYS_INACTIVITY_TIMEOUT_MS - 1)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(KEYS_INACTIVITY_TIMEOUT_MS * 2)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('activity pushes the deadline out without creating more timers', () => {
    const onExpire = vi.fn()
    const tracker = createInactivityTracker({ timeoutMs: 300_000, onExpire })
    vi.advanceTimersByTime(200_000)
    tracker.touch()
    tracker.touch()
    expect(vi.getTimerCount()).toBe(1)
    expect(tracker.remainingMs()).toBe(300_000)
    vi.advanceTimersByTime(299_999)
    expect(onExpire).not.toHaveBeenCalled()
    expect(tracker.remainingMs()).toBe(1)
    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
    // Activity after expiry changes nothing.
    tracker.touch()
    expect(tracker.remainingMs()).toBe(0)
  })

  it('dispose stops the timer', () => {
    const onExpire = vi.fn()
    const tracker = createInactivityTracker({ timeoutMs: 1_000, onExpire })
    tracker.dispose()
    vi.advanceTimersByTime(10_000)
    expect(onExpire).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('formats the countdown and the footer note', () => {
    expect(formatCountdown(299_500)).toBe('5:00')
    expect(formatCountdown(45_000)).toBe('0:45')
    expect(formatCountdown(-5)).toBe('0:00')
    expect(inactivityNote(KEYS_INACTIVITY_TIMEOUT_MS)).toBe('Closes automatically after 5 min of inactivity')
    expect(inactivityNote(42_100)).toBe('Closes automatically after 5 min of inactivity · closing in 0:43')
  })
})

describe('history overview', () => {
  const run = (startedAt: string, status: TestRun['status']): Pick<TestRun, 'startedAt' | 'status'> => ({ startedAt, status })

  it('counts runs started today and the success rate of runs with a verdict', () => {
    const now = new Date(2026, 9, 6, 15, 0, 0)
    const today = new Date(2026, 9, 6, 9, 30).toISOString()
    const yesterday = new Date(2026, 9, 5, 23, 59).toISOString()
    const overview = historyOverview([run(today, 'success'), run(today, 'failed'), run(today, 'running'), run(yesterday, 'success'), run(yesterday, 'aborted'), run('not a date', 'success')], now)
    expect(overview).toEqual({ runsToday: 3, successRate: 3 / 4, judged: 4 })
    expect(historyOverview([], now)).toEqual({ runsToday: 0, successRate: null, judged: 0 })
    expect(formatSuccessRate(5 / 6)).toBe('83%')
    expect(formatSuccessRate(null)).toBe('—')
  })
})

describe('proxy key presentation', () => {
  const pool = (overrides: Partial<ProxyPoolStatus>): ProxyPoolStatus => ({
    pool: 'residential',
    configured: true,
    host: 'gw.dataimpulse.com',
    port: 823,
    usernameMasked: 'be****91',
    source: 'vault',
    ...overrides,
  })

  it('sidebar pill', () => {
    expect(proxyStatusPill(null)).toEqual({ label: 'Proxy …', tone: 'muted' })
    expect(proxyStatusPill({ configured: true })).toEqual({ label: 'Proxy ready', tone: 'success' })
    expect(proxyStatusPill({ configured: false })).toEqual({ label: 'Proxy not set', tone: 'warning' })
  })

  it('pool line, partial-update eligibility and placeholders', () => {
    expect(poolKeyLine(pool({}))).toBe('Configured · be****91 · Encrypted vault')
    expect(poolKeyLine(pool({ source: 'env' }))).toBe('Configured · be****91 · Development .env')
    expect(poolKeyLine(pool({ configured: false, usernameMasked: null, source: 'none' }))).toBe('Not set up')
    expect(poolKeyLine(null)).toBe('Not set up')
    expect(supportsPartialUpdate(pool({}))).toBe(true)
    expect(supportsPartialUpdate(pool({ source: 'env' }))).toBe(false)
    expect(supportsPartialUpdate(pool({ configured: false }))).toBe(false)
    expect(supportsPartialUpdate(null)).toBe(false)
    expect(unchangedPlaceholder('be****91')).toBe('unchanged: be****91')
    expect(unchangedPlaceholder(null)).toBe('unchanged')
    expect(unconfiguredPools(null)).toEqual([])
    expect(unconfiguredPools([pool({}), pool({ pool: 'mobile', configured: false })])).toEqual(['mobile'])
  })

  it('last pool test comes from the gateway row of that pool only', () => {
    const base = { provider: 'dataimpulse', target: null, targetingString: null, targetMatch: null, lastIp: '1.2.3.4', country: null, countryCode: null, region: null, city: null, postalCode: null, isp: null, asn: null, latencyMs: 10, lastError: null, createdAt: 'x', updatedAt: 'x' } as const
    const gateway: ProxySession = { ...base, id: 'g', profileId: null, sessionId: null, pool: 'mobile', status: 'working', lastCheckedAt: '2026-10-06T10:00:00.000Z' }
    const profileRow: ProxySession = { ...base, id: 'p', profileId: 'p1', sessionId: 's', pool: 'residential', status: 'failed', lastCheckedAt: '2026-10-06T11:00:00.000Z' }
    expect(lastPoolTest([profileRow, gateway], 'mobile')).toEqual({ status: 'working', at: '2026-10-06T10:00:00.000Z' })
    expect(lastPoolTest([profileRow, gateway], 'residential')).toBeNull()
    expect(lastPoolTest([{ ...gateway, lastCheckedAt: null }], 'mobile')).toBeNull()
  })
})

describe('launch device summary', () => {
  const preset = (userAgent: string, overrides: Partial<DevicePresetInfo> = {}): DevicePresetInfo =>
    ({ id: 'x', label: 'Galaxy S24', deviceType: 'mobile', viewportWidth: 407, viewportHeight: 844, userAgent, supportedEngines: ['chromium'], ...overrides }) as DevicePresetInfo

  it('names the user-agent family', () => {
    expect(userAgentFamily('Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36')).toBe('Android Chrome')
    expect(userAgentFamily('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1')).toBe('iOS Safari')
    expect(userAgentFamily('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1')).toBe('iOS Chrome')
    expect(userAgentFamily('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0')).toBe('Windows Edge')
    expect(userAgentFamily('Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:132.0) Gecko/20100101 Firefox/132.0')).toBe('macOS Firefox')
    expect(userAgentFamily('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')).toBe('Linux Chrome')
    expect(userAgentFamily('Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36')).toBe('Android Samsung Internet')
    expect(userAgentFamily('curl/8.0')).toBe('Custom')
  })

  it('formats one muted line', () => {
    expect(deviceSummary(preset('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'))).toBe('Mobile · 407×844 · Android Chrome UA')
    expect(deviceSummary(preset('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', { deviceType: 'desktop', viewportWidth: 1920, viewportHeight: 1080 }))).toBe(
      'Desktop · 1920×1080 · Windows Chrome UA',
    )
  })

  it('marks engines the device cannot use as "not compatible with <device>"', () => {
    const s24 = preset('ua', { supportedEngines: ['chromium', 'webkit'] })
    expect(incompatibleEngineSuffix(s24)).toBe(' · not compatible with Galaxy S24')
    const groups = groupEngineOptions(null, s24, 'chromium', incompatibleEngineSuffix(s24))
    const firefox = groups[0]?.options.find((option) => option.value === 'firefox')
    expect(firefox).toMatchObject({ label: expect.stringContaining('· not compatible with Galaxy S24'), disabled: true })
    expect(groups[0]?.options.find((option) => option.value === 'chromium')?.label).not.toContain('not compatible')
  })
})

describe('validateCredentialsUpdateForm (partial update of a vault pool)', () => {
  const current = { host: 'gw.dataimpulse.com', port: 823 }
  const form = (overrides: Partial<ReturnType<typeof emptyCredentialsForm>> = {}): ReturnType<typeof emptyCredentialsForm> => ({ ...emptyCredentialsForm(current), ...overrides })

  it('sends only what changed: a password alone keeps the stored username', () => {
    expect(validateCredentialsUpdateForm(form({ password: 'new pass ' }), 'residential', { current, templateTouched: false })).toEqual({
      input: { providerId: 'dataimpulse', pool: 'residential', host: 'gw.dataimpulse.com', port: 823, password: 'new pass ' },
      errors: null,
    })
    expect(validateCredentialsUpdateForm(form({ username: ' login2 ' }), 'mobile', { current, templateTouched: false }).input).toEqual({ providerId: 'dataimpulse', pool: 'mobile', host: 'gw.dataimpulse.com', port: 823, username: 'login2' })
  })

  it('includes the template only when edited (empty edit removes the override)', () => {
    expect(validateCredentialsUpdateForm(form({ sessionTemplate: '' }), 'residential', { current, templateTouched: true }).input).toMatchObject({ sessionTemplate: null })
    expect(validateCredentialsUpdateForm(form({ sessionTemplate: 'bad' }), 'residential', { current, templateTouched: true }).errors).toMatchObject({ sessionTemplate: expect.stringContaining('{username}') })
  })

  it('refuses an update that changes nothing, and invalid host/port', () => {
    expect(validateCredentialsUpdateForm(form(), 'residential', { current, templateTouched: false })).toEqual({ input: null, errors: { password: NOTHING_TO_UPDATE_MESSAGE } })
    expect(validateCredentialsUpdateForm(form({ port: '8080' }), 'residential', { current, templateTouched: false }).input).toMatchObject({ port: 8080 })
    expect(validateCredentialsUpdateForm(form({ host: 'http://gw', password: 'x' }), 'residential', { current, templateTouched: false }).errors?.host).toMatch(/hostname only/)
    expect(validateCredentialsUpdateForm(form({ port: 'abc', password: 'x' }), 'residential', { current, templateTouched: false }).errors?.port).toMatch(/Port must be/)
  })
})

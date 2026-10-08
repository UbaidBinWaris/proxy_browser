import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProxyQaApi } from '../src/shared/ipc'
import type { BrowserEngineInfo, BrowserSession, BrowsersStatus, LogEntry, Profile, ProxyConfigStatus, ProxySession, SecurityStatus, SetupStatus, TestRun } from '../src/shared/types'
import { fail, ok } from '../src/shared/types'
import { MAX_LOG_ENTRIES, appendCapped, collectScopes, filterLogs, useLogsStore } from '../src/renderer/src/stores/logs'
import { sortRunsNewestFirst, upsertRun, useRunsStore, selectRunById } from '../src/renderer/src/stores/runs'
import {
  isSessionActive,
  isSessionLive,
  mergeSessionUpdate,
  selectActiveSessions,
  selectLiveSessions,
  selectSessionForRun,
  useSessionsStore,
} from '../src/renderer/src/stores/sessions'
import { isGatewaySession, selectProxySessionForIp, upsertProxySession, selectProxySessionForProfile, useProxyStore } from '../src/renderer/src/stores/proxy'
import { proxySessionIdLabel, proxySessionName, rotateDisabledReason, testDisabledReason } from '../src/renderer/src/lib/proxySessions'
import { MAX_TOASTS, toast, useToastStore } from '../src/renderer/src/stores/toasts'
import { useProfilesStore, selectProfileById } from '../src/renderer/src/stores/profiles'
import { automaticallyInstallable, missingEngines, selectEngineInfo, useAppStore } from '../src/renderer/src/stores/app'
import { newerSecurityStatus, useSecurityStore } from '../src/renderer/src/stores/security'
import { selectFirstRun, selectSetupPending, useSetupStore } from '../src/renderer/src/stores/setup'

const bridgeHolder = globalThis as unknown as { api?: ProxyQaApi }

function logEntry(id: number, overrides: Partial<LogEntry> = {}): LogEntry {
  return { id, timestamp: new Date(1_700_000_000_000 + id).toISOString(), level: 'INFO', scope: 'proxy', message: `entry ${id}`, meta: null, ...overrides }
}

function run(id: string, startedAt: string, overrides: Partial<TestRun> = {}): TestRun {
  return {
    id,
    profileId: 'p1',
    profileName: 'Profile',
    engine: 'chromium',
    devicePreset: 'windows-desktop',
    proxyPool: 'residential',
    target: null,
    targetingString: null,
    targetMatch: null,
    publicIp: null,
    country: null,
    region: null,
    city: null,
    postalCode: null,
    locationAttempts: 1,
    locationMaxAttempts: 1,
    locationWarning: null,
    proxySessionId: null,
    formUrl: 'https://example.com/',
    startedAt,
    endedAt: null,
    status: 'running',
    notes: '',
    httpStatus: null,
    finalUrl: null,
    screenshotPath: null,
    leadId: null,
    certificateId: null,
    errorMessage: null,
    ...overrides,
  }
}

function session(id: string, overrides: Partial<BrowserSession> = {}): BrowserSession {
  return {
    id,
    runId: `run-${id}`,
    profileId: 'p1',
    profileName: 'Profile',
    engine: 'chromium',
    devicePreset: 'windows-desktop',
    proxyPool: 'residential',
    target: null,
    targetingString: null,
    targetMatch: null,
    status: 'open',
    statusDetail: 'Open',
    ip: null,
    locationAttempts: 1,
    locationMaxAttempts: 1,
    locationWarning: null,
    proxySessionId: null,
    currentUrl: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    error: null,
    browserPid: null,
    lastHeartbeatAt: null,
    ...overrides,
  }
}

function profile(id: string, name: string): Profile {
  return {
    id,
    name,
    engine: 'chromium',
    deviceType: 'desktop',
    devicePreset: 'windows-desktop',
    viewportWidth: 1920,
    viewportHeight: 1080,
    userAgent: null,
    locale: 'en-US',
    timezone: 'UTC',
    proxyMode: 'dataimpulse-sticky',
    stickySessionId: `profile-${id}`,
    formUrlOverride: null,
    notes: '',
    proxyPool: 'residential',
    target: null,
    stickyTtlMinutes: null,
    ephemeral: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

afterEach(() => {
  delete bridgeHolder.api
  useLogsStore.getState().reset()
  useToastStore.getState().clear()
  useRunsStore.setState({ runs: [], status: 'idle', error: null })
  useSessionsStore.setState({ sessions: {}, statusBeforeError: {}, status: 'idle', error: null, busy: {} })
  useProfilesStore.setState({ items: [], status: 'idle', error: null, presets: [], presetsStatus: 'idle', presetsError: null })
  useProxyStore.setState({ config: null, configStatus: 'idle', configError: null })
  useSecurityStore.setState({ status: null, loadStatus: 'idle', error: null, checking: false, busy: null })
  useSetupStore.setState({ status: null, loadStatus: 'idle', error: null, completing: false })
})

describe('logs store ring buffer', () => {
  it('caps the buffer at MAX_LOG_ENTRIES, dropping the oldest', () => {
    let entries: LogEntry[] = []
    for (let i = 1; i <= MAX_LOG_ENTRIES + 25; i++) entries = appendCapped(entries, logEntry(i))
    expect(entries).toHaveLength(MAX_LOG_ENTRIES)
    expect(entries[0]?.id).toBe(26)
    expect(entries[entries.length - 1]?.id).toBe(MAX_LOG_ENTRIES + 25)
  })

  it('ignores duplicate ids', () => {
    const base = appendCapped([], logEntry(1))
    expect(appendCapped(base, logEntry(1))).toBe(base)
  })

  it('append action feeds the store and clear() calls the bridge', async () => {
    const clear = vi.fn(async () => ok(undefined))
    bridgeHolder.api = { logs: { clear, list: vi.fn() } } as unknown as ProxyQaApi
    useLogsStore.getState().append(logEntry(7))
    expect(useLogsStore.getState().entries).toHaveLength(1)
    await useLogsStore.getState().clear()
    expect(clear).toHaveBeenCalledTimes(1)
    expect(useLogsStore.getState().entries).toHaveLength(0)
  })

  it('filters by level, scope and search (message + meta)', () => {
    const entries = [
      logEntry(1, { level: 'INFO', scope: 'proxy', message: 'checking ip' }),
      logEntry(2, { level: 'ERROR', scope: 'browser', message: 'launch failed', meta: { engine: 'webkit' } }),
      logEntry(3, { level: 'WARN', scope: 'proxy', message: 'slow response' }),
    ]
    expect(filterLogs(entries, { level: 'ERROR', scope: '', search: '' }).map((e) => e.id)).toEqual([2])
    expect(filterLogs(entries, { level: 'all', scope: 'proxy', search: '' }).map((e) => e.id)).toEqual([1, 3])
    expect(filterLogs(entries, { level: 'all', scope: '', search: 'WEBKIT' }).map((e) => e.id)).toEqual([2])
    expect(collectScopes(entries)).toEqual(['browser', 'proxy'])
  })
})

describe('runs store', () => {
  it('sorts newest first and upserts by id', () => {
    const a = run('a', '2026-01-01T10:00:00.000Z')
    const b = run('b', '2026-01-01T12:00:00.000Z')
    expect(sortRunsNewestFirst([a, b]).map((r) => r.id)).toEqual(['b', 'a'])
    const updated = upsertRun([b, a], { ...a, status: 'success' })
    expect(updated).toHaveLength(2)
    expect(selectRunById(updated, 'a')?.status).toBe('success')
    expect(upsertRun(updated, run('c', '2026-01-02T00:00:00.000Z'))[0]?.id).toBe('c')
  })

  it('fetch() uses the cache and otherwise asks the bridge, surfacing NOT_FOUND as ApiError', async () => {
    const get = vi.fn(async (id: string) => (id === 'known' ? ok(run('known', '2026-01-01T00:00:00.000Z')) : fail<TestRun>({ code: 'NOT_FOUND', message: 'No such run' })))
    bridgeHolder.api = { runs: { get } } as unknown as ProxyQaApi
    useRunsStore.getState().upsert(run('cached', '2026-01-01T00:00:00.000Z'))
    await expect(useRunsStore.getState().fetch('cached')).resolves.toMatchObject({ id: 'cached' })
    expect(get).not.toHaveBeenCalled()
    await expect(useRunsStore.getState().fetch('known')).resolves.toMatchObject({ id: 'known' })
    expect(useRunsStore.getState().runs.map((r) => r.id)).toContain('known')
    await expect(useRunsStore.getState().fetch('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('sessions store', () => {
  it('keeps error sessions in the live list (only closed leaves) and counts only in-progress/open ones as active', () => {
    const live = session('s1', { runId: 'r1', startedAt: '2026-01-01T00:00:01.000Z' })
    const closed = session('s0', { runId: 'r1', status: 'closed', startedAt: '2026-01-01T00:00:00.000Z' })
    const errored = session('s2', { runId: 'r2', status: 'error', error: { code: 'SITE_TIMEOUT', message: 'slow' } })
    const sessions = { [live.id]: live, [closed.id]: closed, [errored.id]: errored }
    expect(isSessionLive(live)).toBe(true)
    expect(isSessionLive(closed)).toBe(false)
    expect(isSessionLive(errored)).toBe(true)
    expect(isSessionActive(live)).toBe(true)
    expect(isSessionActive(errored)).toBe(false)
    expect(isSessionActive(closed)).toBe(false)
    expect(selectLiveSessions(sessions).map((s) => s.id).sort()).toEqual(['s1', 's2'])
    expect(selectActiveSessions(sessions).map((s) => s.id)).toEqual(['s1'])
    expect(selectSessionForRun(sessions, 'r1')?.id).toBe('s1')
    expect(selectSessionForRun(sessions, 'r2')?.id).toBe('s2')
    expect(selectSessionForRun(sessions, 'r9')).toBeNull()
  })

  it('merges updates by id and records the status seen right before an error', () => {
    let state = mergeSessionUpdate({ sessions: {}, statusBeforeError: {} }, session('s1', { status: 'starting' }))
    state = mergeSessionUpdate(state, session('s1', { status: 'verifying-proxy' }))
    state = mergeSessionUpdate(state, session('s1', { status: 'launching', ip: { ip: '1.2.3.4' } as BrowserSession['ip'] }))
    expect(Object.keys(state.sessions)).toEqual(['s1'])
    expect(state.sessions.s1?.status).toBe('launching')
    expect(state.statusBeforeError.s1).toBeUndefined()
    state = mergeSessionUpdate(state, session('s1', { status: 'error', error: { code: 'SITE_TIMEOUT', message: 'slow' } }))
    expect(state.statusBeforeError.s1).toBe('launching')
    // A later error event (e.g. re-delivered) must not overwrite the recorded pre-error status.
    state = mergeSessionUpdate(state, session('s1', { status: 'error', error: { code: 'SITE_TIMEOUT', message: 'slow' } }))
    expect(state.statusBeforeError.s1).toBe('launching')
    state = mergeSessionUpdate(state, session('s1', { status: 'closed' }))
    expect(state.statusBeforeError.s1).toBeUndefined()
    expect(isSessionLive(state.sessions.s1)).toBe(false)
  })

  it('upsert action goes through the merge and the store exposes statusBeforeError', () => {
    useSessionsStore.getState().upsert(session('s9', { status: 'open' }))
    useSessionsStore.getState().upsert(session('s9', { status: 'error', error: { code: 'INTERNAL', message: 'x' } }))
    expect(useSessionsStore.getState().sessions.s9?.status).toBe('error')
    expect(useSessionsStore.getState().statusBeforeError.s9).toBe('open')
    useSessionsStore.getState().remove('s9')
    expect(useSessionsStore.getState().statusBeforeError.s9).toBeUndefined()
  })

  it('tracks busy flags around close()', async () => {
    let release: () => void = () => undefined
    const close = vi.fn(() => new Promise<ReturnType<typeof ok<void>>>((resolve) => { release = () => resolve(ok(undefined)) }))
    bridgeHolder.api = { browser: { close } } as unknown as ProxyQaApi
    const pending = useSessionsStore.getState().close('s1')
    expect(useSessionsStore.getState().busy.s1).toBe('closing')
    release()
    await pending
    expect(useSessionsStore.getState().busy.s1).toBeUndefined()
  })
})

describe('proxy sessions helpers', () => {
  it('upserts and orders by updatedAt desc, and selects by profile', () => {
    const base: ProxySession = {
      id: 'ps1',
      profileId: 'p1',
      provider: 'dataimpulse',
      pool: 'residential',
      target: null,
      targetingString: null,
      targetMatch: null,
      sessionId: 'profile-p1',
      status: 'untested',
      lastIp: null,
      country: null,
      countryCode: null,
      region: null,
      city: null,
      postalCode: null,
      isp: null,
      asn: null,
      latencyMs: null,
      lastCheckedAt: null,
      lastError: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const other: ProxySession = { ...base, id: 'ps2', profileId: 'p2', updatedAt: '2026-01-02T00:00:00.000Z' }
    const list = upsertProxySession(upsertProxySession([], base), other)
    expect(list.map((s) => s.id)).toEqual(['ps2', 'ps1'])
    const refreshed = upsertProxySession(list, { ...base, status: 'working', updatedAt: '2026-01-03T00:00:00.000Z' })
    expect(refreshed[0]?.id).toBe('ps1')
    expect(refreshed).toHaveLength(2)
    expect(selectProxySessionForProfile(refreshed, 'p2')?.id).toBe('ps2')
    expect(selectProxySessionForProfile(refreshed, 'nope')).toBeNull()
  })

  it('finds the session behind a verified IP and identifies the raw gateway record', () => {
    const base: ProxySession = {
      id: 'ps1',
      profileId: 'p1',
      provider: 'dataimpulse',
      pool: 'residential',
      target: null,
      targetingString: null,
      targetMatch: null,
      sessionId: 'profile-p1',
      status: 'working',
      lastIp: '203.0.113.7',
      country: null,
      countryCode: null,
      region: null,
      city: null,
      postalCode: null,
      isp: null,
      asn: null,
      latencyMs: null,
      lastCheckedAt: null,
      lastError: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const gateway: ProxySession = { ...base, id: 'gw', profileId: null, sessionId: null, lastIp: '198.51.100.2' }
    const rotatingProfile: ProxySession = { ...base, id: 'rot', profileId: 'p2', sessionId: null, lastIp: null }
    expect(selectProxySessionForIp([base, gateway], '198.51.100.2')?.id).toBe('gw')
    expect(selectProxySessionForIp([base, gateway], '203.0.113.7')?.id).toBe('ps1')
    expect(selectProxySessionForIp([base, gateway], null)).toBeNull()
    expect(selectProxySessionForIp([base, gateway], '0.0.0.0')).toBeNull()
    expect(isGatewaySession(gateway)).toBe(true)
    expect(isGatewaySession(rotatingProfile)).toBe(false)
    expect(isGatewaySession(base)).toBe(false)
  })

  it('labels rows and gates Rotate/Test by the owning profile mode', () => {
    const row = (overrides: Partial<ProxySession>): ProxySession => ({
      id: 'x',
      profileId: 'p1',
      provider: 'dataimpulse',
      pool: 'residential',
      target: null,
      targetingString: null,
      targetMatch: null,
      sessionId: 'profile-p1',
      status: 'working',
      lastIp: null,
      country: null,
      countryCode: null,
      region: null,
      city: null,
      postalCode: null,
      isp: null,
      asn: null,
      latencyMs: null,
      lastCheckedAt: null,
      lastError: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    })
    const sticky = profile('p1', 'Sticky one')
    const rotating: Profile = { ...profile('p2', 'Rotating one'), proxyMode: 'dataimpulse-rotating', stickySessionId: null }
    const direct: Profile = { ...profile('p3', 'Direct one'), proxyMode: 'none', stickySessionId: null }
    const gateway = row({ profileId: null, sessionId: null })
    const orphanSticky = row({ profileId: null, sessionId: 'leftover' })
    const deleted = row({ profileId: 'gone' })

    expect(proxySessionName(gateway, null)).toBe('Gateway')
    expect(proxySessionName(orphanSticky, null)).toBe('Unassigned sticky session')
    expect(proxySessionName(deleted, null)).toBe('Deleted profile')
    expect(proxySessionName(row({}), sticky)).toBe('Sticky one')

    expect(rotateDisabledReason(row({}), sticky)).toBeNull()
    expect(rotateDisabledReason(row({ profileId: 'p2', sessionId: null }), rotating)).toMatch(/rotating/i)
    expect(rotateDisabledReason(row({ profileId: 'p3', sessionId: null }), direct)).toMatch(/directly/i)
    expect(rotateDisabledReason(gateway, null)).toMatch(/gateway/i)
    expect(rotateDisabledReason(deleted, null)).toMatch(/deleted/i)

    expect(testDisabledReason(row({}), sticky)).toBeNull()
    expect(testDisabledReason(gateway, null)).toMatch(/Settings → Advanced/)
    expect(testDisabledReason(row({ profileId: 'p3', sessionId: null }), direct)).toMatch(/directly/i)

    expect(proxySessionIdLabel(row({}), sticky)).toBe('profile-p1')
    expect(proxySessionIdLabel(gateway, null)).toBe('rotating')
    expect(proxySessionIdLabel(row({ profileId: 'p2', sessionId: null }), rotating)).toBe('rotating')
    expect(proxySessionIdLabel(row({ profileId: 'p3', sessionId: null }), direct)).toBe('none')
    expect(proxySessionIdLabel(row({ profileId: 'gone', sessionId: null }), null)).toBe('—')
  })
})

describe('toast store', () => {
  it('caps the visible stack and formats errors with their code', () => {
    for (let i = 0; i < MAX_TOASTS + 3; i++) toast.info(`t${i}`)
    expect(useToastStore.getState().toasts).toHaveLength(MAX_TOASTS)
    useToastStore.getState().clear()
    const error = toast.fromError({ code: 'PROXY_AUTH_FAILED', message: 'Check DATAIMPULSE_PROXY_USERNAME' })
    expect(error.code).toBe('PROXY_AUTH_FAILED')
    const shown = useToastStore.getState().toasts[0]
    expect(shown?.kind).toBe('error')
    expect(shown?.title).toBe('Proxy authentication failed')
    expect(shown?.description).toBe('PROXY_AUTH_FAILED: Check DATAIMPULSE_PROXY_USERNAME')
    useToastStore.getState().dismiss(shown?.id ?? -1)
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })
})

describe('profiles store', () => {
  beforeEach(() => {
    bridgeHolder.api = {
      profiles: {
        list: vi.fn(async () => ok([profile('b', 'Zulu'), profile('a', 'alpha')])),
        delete: vi.fn(async () => ok(undefined)),
        duplicate: vi.fn(async (id: string) => ok(profile(`${id}-copy`, 'alpha (copy)'))),
        presets: vi.fn(async () => fail({ code: 'INTERNAL', message: 'presets unavailable' })),
      },
    } as unknown as ProxyQaApi
  })

  it('loads and sorts profiles by name, removes and duplicates', async () => {
    await useProfilesStore.getState().load()
    expect(useProfilesStore.getState().status).toBe('ready')
    expect(useProfilesStore.getState().items.map((p) => p.name)).toEqual(['alpha', 'Zulu'])
    expect(selectProfileById(useProfilesStore.getState().items, 'a')?.name).toBe('alpha')
    await useProfilesStore.getState().duplicate('a')
    expect(useProfilesStore.getState().items).toHaveLength(3)
    await useProfilesStore.getState().remove('b')
    expect(useProfilesStore.getState().items.map((p) => p.id)).toEqual(['a', 'a-copy'])
  })

  it('records preset load failures as AppError without throwing', async () => {
    await useProfilesStore.getState().loadPresets()
    expect(useProfilesStore.getState().presetsStatus).toBe('error')
    expect(useProfilesStore.getState().presetsError).toEqual({ code: 'INTERNAL', message: 'presets unavailable' })
  })
})

const operaInfo: BrowserEngineInfo = {
  id: 'opera',
  label: 'Opera (installed)',
  family: 'chromium',
  kind: 'installed',
  available: false,
  executablePath: null,
  version: null,
  source: 'not-found',
  note: 'Not installed on this machine. Install it or set its path in Settings → Browsers.',
  installMethod: 'download-page',
  installNote: '',
  downloadUrl: 'https://www.opera.com/download',
  managedInstall: false,
}

const browsersFixture: BrowsersStatus = {
  browsersPath: '/x',
  chromium: true,
  firefox: false,
  webkit: false,
  playwrightVersion: '1.63.0',
  source: 'provisioned',
  installable: true,
  engines: [operaInfo],
}

describe('missingEngines / selectEngineInfo', () => {
  it('lists only bundled engines that are not installed (installed browsers are never "missing")', () => {
    expect(missingEngines(null)).toEqual([])
    expect(missingEngines(browsersFixture)).toEqual(['firefox', 'webkit'])
    expect(missingEngines({ ...browsersFixture, firefox: true, webkit: true })).toEqual([])
  })

  it('selectEngineInfo finds the availability record for an engine', () => {
    expect(selectEngineInfo(null, 'opera')).toBeNull()
    expect(selectEngineInfo(browsersFixture, 'opera')).toEqual(operaInfo)
    expect(selectEngineInfo(browsersFixture, 'brave')).toBeNull()
  })
})

describe('app store — redetect', () => {
  it('replaces browsers.engines with the re-detected list and clears the busy flag', async () => {
    const detected: BrowserEngineInfo = { ...operaInfo, available: true, executablePath: '/usr/bin/chromium', version: '153.0.8010.52', source: 'settings', note: 'Using the executable path set in Settings → Browsers.' }
    const status = vi.fn(async () => ok(browsersFixture))
    const redetect = vi.fn(async () => ok([detected]))
    bridgeHolder.api = { browsers: { status, redetect } } as unknown as ProxyQaApi
    await useAppStore.getState().loadBrowsers()
    expect(useAppStore.getState().browsers?.engines).toEqual([operaInfo])

    const pending = useAppStore.getState().redetect()
    expect(useAppStore.getState().redetecting).toBe(true)
    await expect(pending).resolves.toEqual([detected])
    expect(useAppStore.getState().redetecting).toBe(false)
    expect(useAppStore.getState().browsers?.engines).toEqual([detected])
    expect(selectEngineInfo(useAppStore.getState().browsers, 'opera')?.available).toBe(true)

    bridgeHolder.api = { browsers: { status, redetect: vi.fn(async () => fail({ code: 'INTERNAL', message: 'scan failed' })) } } as unknown as ProxyQaApi
    await expect(useAppStore.getState().redetect()).rejects.toMatchObject({ code: 'INTERNAL' })
    expect(useAppStore.getState().redetecting).toBe(false)
  })
})

describe('app store — browser availability and the download-page watcher', () => {
  const braveMissing: BrowserEngineInfo = { ...operaInfo, id: 'brave', label: 'Brave (installed)', installMethod: 'portable-archive', downloadUrl: 'https://brave.com/download/' }
  const braveInstalled: BrowserEngineInfo = { ...braveMissing, available: true, executablePath: '/data/installed-browsers/brave/brave', source: 'auto-saved', managedInstall: true }
  const withEngines = (engines: BrowserEngineInfo[]): BrowsersStatus => ({ ...browsersFixture, engines })

  it('tracks the download-page watcher and what can be installed with one click', async () => {
    const openDownloadPage = vi.fn(async () => ok(undefined))
    bridgeHolder.api = { browsers: { openDownloadPage, status: vi.fn(async () => ok(withEngines([braveMissing]))) } } as unknown as ProxyQaApi
    await useAppStore.getState().loadBrowsers()
    await useAppStore.getState().openDownloadPage('brave')
    expect(useAppStore.getState().watchingEngines.brave).toBe(true)
    useAppStore.getState().applyWatchUpdate({ engine: 'brave', state: 'found', info: braveInstalled })
    expect(useAppStore.getState().watchingEngines.brave).toBe(false)
    expect(selectEngineInfo(useAppStore.getState().browsers, 'brave')).toEqual(braveInstalled)
    useAppStore.getState().applyWatchUpdate({ engine: 'vivaldi', state: 'watching', info: null })
    useAppStore.getState().applyWatchUpdate({ engine: 'vivaldi', state: 'expired', info: null })
    expect(useAppStore.getState().watchingEngines.vivaldi).toBe(false)
    expect(automaticallyInstallable(withEngines([braveMissing])).map((e) => e.id)).toEqual(['brave'])
    expect(automaticallyInstallable(withEngines([braveInstalled]))).toEqual([])
  })
})

function securityStatus(overrides: Partial<SecurityStatus> = {}): SecurityStatus {
  return {
    source: 'vault',
    configuredPools: ['residential'],
    keyBackend: 'os-keychain',
    keyBackendLabel: 'GNOME Keyring / libsecret',
    keyPath: '/data/security/vault.key',
    vaultPath: '/data/security/vault.bin',
    keyPresent: true,
    vaultPresent: true,
    decryptOk: true,
    permissionsOk: true,
    installId: 'install-1',
    keyCreatedAt: '2026-01-01T00:00:00.000Z',
    vaultUpdatedAt: '2026-01-01T00:00:00.000Z',
    lastCheckedAt: '2026-01-01T00:00:00.000Z',
    lastProxyTestAt: null,
    lastProxyTestStatus: null,
    warnings: [],
    ...overrides,
  }
}

const vaultConfig: ProxyConfigStatus = {
  configured: true,
  provider: 'dataimpulse',
  host: 'gw.dataimpulse.com',
  port: 823,
  usernameMasked: 'us**r1',
  missing: [],
  source: 'vault',
  pools: [
    { pool: 'residential', configured: true, host: 'gw.dataimpulse.com', port: 823, usernameMasked: 'us**r1', source: 'vault' },
    { pool: 'mobile', configured: false, host: null, port: null, usernameMasked: null, source: 'none' },
  ],
}

const credentialsInput = { pool: 'residential' as const, host: 'gw.dataimpulse.com', port: 823, username: 'user1', password: 'secret', sessionTemplate: null }

describe('security store', () => {
  it('load() tracks checking and stores the status; a failed check lands in error and keeps the last good status', async () => {
    const status = vi.fn(async () => ok(securityStatus()))
    bridgeHolder.api = { security: { status } } as unknown as ProxyQaApi
    const pending = useSecurityStore.getState().load()
    expect(useSecurityStore.getState().checking).toBe(true)
    expect(useSecurityStore.getState().loadStatus).toBe('loading')
    await pending
    expect(status).toHaveBeenCalledTimes(1)
    expect(useSecurityStore.getState().status?.installId).toBe('install-1')
    expect(useSecurityStore.getState().loadStatus).toBe('ready')
    expect(useSecurityStore.getState().checking).toBe(false)

    bridgeHolder.api = { security: { status: vi.fn(async () => fail<SecurityStatus>({ code: 'VAULT_ERROR', message: 'Key file unreadable' })) } } as unknown as ProxyQaApi
    await useSecurityStore.getState().load()
    expect(useSecurityStore.getState().loadStatus).toBe('error')
    expect(useSecurityStore.getState().error).toEqual({ code: 'VAULT_ERROR', message: 'Key file unreadable' })
    expect(useSecurityStore.getState().status?.installId).toBe('install-1')
    expect(useSecurityStore.getState().checking).toBe(false)
  })

  it('apply() keeps the most recently checked status when events and responses interleave', () => {
    const older = securityStatus({ lastCheckedAt: '2026-01-01T00:00:00.000Z', decryptOk: false })
    const newer = securityStatus({ lastCheckedAt: '2026-01-02T00:00:00.000Z' })
    expect(newerSecurityStatus(null, older)).toBe(older)
    expect(newerSecurityStatus(newer, older)).toBe(newer)
    expect(newerSecurityStatus(older, newer)).toBe(newer)
    useSecurityStore.getState().apply(newer)
    useSecurityStore.getState().apply(older)
    expect(useSecurityStore.getState().status).toBe(newer)
    expect(useSecurityStore.getState().loadStatus).toBe('ready')
    expect(useSecurityStore.getState().error).toBeNull()
  })

  it('testCredentials never throws: a failed envelope becomes a failed result and busy is released', async () => {
    const testCredentials = vi.fn(async () => fail({ code: 'PROXY_AUTH_FAILED', message: 'Gateway rejected the login' }))
    bridgeHolder.api = { security: { testCredentials } } as unknown as ProxyQaApi
    const pending = useSecurityStore.getState().testCredentials(credentialsInput)
    expect(useSecurityStore.getState().busy).toBe('testing')
    await expect(pending).resolves.toEqual({
      status: 'failed',
      sessionId: null,
      ip: null,
      error: { code: 'PROXY_AUTH_FAILED', message: 'Gateway rejected the login' },
    })
    expect(testCredentials).toHaveBeenCalledWith(credentialsInput)
    expect(useSecurityStore.getState().busy).toBeNull()
  })

  it('saveCredentials stores the returned status, refreshes the proxy config and clears busy', async () => {
    const saved = securityStatus({ vaultUpdatedAt: '2026-02-01T00:00:00.000Z' })
    const saveCredentials = vi.fn(async () => ok(saved))
    const getConfigStatus = vi.fn(async () => ok(vaultConfig))
    bridgeHolder.api = { security: { saveCredentials }, proxy: { getConfigStatus } } as unknown as ProxyQaApi
    const pending = useSecurityStore.getState().saveCredentials(credentialsInput)
    expect(useSecurityStore.getState().busy).toBe('saving')
    await expect(pending).resolves.toBe(saved)
    expect(saveCredentials).toHaveBeenCalledWith(credentialsInput)
    expect(useSecurityStore.getState().status).toBe(saved)
    expect(useSecurityStore.getState().busy).toBeNull()
    await vi.waitFor(() => expect(useProxyStore.getState().config).toEqual(vaultConfig))
  })

  it('rotateKey rejects with the VAULT_ERROR ApiError and releases busy; clearCredentials applies the cleared status', async () => {
    const clearedStatus = securityStatus({ source: 'none', vaultPresent: false, decryptOk: false, vaultUpdatedAt: null })
    const clearCredentials = vi.fn(async () => ok(clearedStatus))
    bridgeHolder.api = {
      security: {
        rotateKey: vi.fn(async () => fail<SecurityStatus>({ code: 'VAULT_ERROR', message: 'Cannot re-wrap the vault' })),
        clearCredentials,
      },
      proxy: { getConfigStatus: vi.fn(async () => ok({ ...vaultConfig, configured: false, source: 'none' as const, missing: ['username', 'password'] })) },
    } as unknown as ProxyQaApi
    await expect(useSecurityStore.getState().rotateKey()).rejects.toMatchObject({ code: 'VAULT_ERROR', message: 'Cannot re-wrap the vault' })
    expect(useSecurityStore.getState().busy).toBeNull()
    await expect(useSecurityStore.getState().clearCredentials('mobile')).resolves.toBe(clearedStatus)
    expect(clearCredentials).toHaveBeenCalledWith('mobile')
    expect(useSecurityStore.getState().status?.vaultPresent).toBe(false)
    expect(useSecurityStore.getState().busy).toBeNull()
    await vi.waitFor(() => expect(useProxyStore.getState().config?.source).toBe('none'))
  })
})

describe('setup store', () => {
  const setupStatus = (overrides: Partial<SetupStatus> = {}): SetupStatus => ({
    firstRun: true,
    completedAt: null,
    appVersion: '1.0.0',
    browsers: { browsersPath: '/x', chromium: true, firefox: false, webkit: false, playwrightVersion: '1.63.0', source: 'provisioned', installable: true, engines: [] },
    security: securityStatus({ source: 'none', keyBackend: 'none', keyPresent: false, vaultPresent: false, decryptOk: false }),
    proxy: { ...vaultConfig, configured: false, source: 'none', host: null, port: null, usernameMasked: null, missing: ['host', 'port', 'username', 'password'] },
    pending: ['browsers', 'credentials'],
    ...overrides,
  })

  it('load() exposes first-run state and complete() flips it', async () => {
    const status = vi.fn(async () => ok(setupStatus()))
    const complete = vi.fn(async () => ok(setupStatus({ firstRun: false, completedAt: '2026-01-05T00:00:00.000Z', pending: [] })))
    bridgeHolder.api = { setup: { status, complete } } as unknown as ProxyQaApi
    expect(selectSetupPending(null, 'idle')).toBe(true)
    const pending = useSetupStore.getState().load()
    expect(selectSetupPending(useSetupStore.getState().status, useSetupStore.getState().loadStatus)).toBe(true)
    await pending
    const state = useSetupStore.getState()
    expect(selectSetupPending(state.status, state.loadStatus)).toBe(false)
    expect(selectFirstRun(state.status)).toBe(true)
    expect(state.status?.pending).toEqual(['browsers', 'credentials'])

    const completing = useSetupStore.getState().complete()
    expect(useSetupStore.getState().completing).toBe(true)
    const done = await completing
    expect(done.firstRun).toBe(false)
    expect(complete).toHaveBeenCalledTimes(1)
    expect(selectFirstRun(useSetupStore.getState().status)).toBe(false)
    expect(useSetupStore.getState().completing).toBe(false)
  })

  it('records a failed setup.status() as an error so the normal shell is shown instead of the wizard', async () => {
    bridgeHolder.api = { setup: { status: vi.fn(async () => fail<SetupStatus>({ code: 'INTERNAL', message: 'No handler registered' })) } } as unknown as ProxyQaApi
    await useSetupStore.getState().load()
    expect(useSetupStore.getState().loadStatus).toBe('error')
    expect(useSetupStore.getState().error).toEqual({ code: 'INTERNAL', message: 'No handler registered' })
    expect(selectSetupPending(useSetupStore.getState().status, useSetupStore.getState().loadStatus)).toBe(false)
    expect(selectFirstRun(null)).toBe(false)
  })
})

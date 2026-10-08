/**
 * The preload bridge is exercised with a mocked `electron` module: every
 * `window.api` method must invoke exactly its contract channel with the given
 * arguments, and `events.on` must validate channels and unsubscribe cleanly.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { EVENTS, IPC } from '../src/shared/ipc'
import type { ProxyQaApi } from '../src/shared/ipc'
import type { ProxyCredentialsInput, QuickLaunchInput } from '../src/shared/types'

type Listener = (event: unknown, payload: unknown) => void

const exposed: Record<string, unknown> = {}
const invoke = vi.fn(async (..._args: unknown[]) => ({ ok: true, data: null }))
const listeners = new Map<string, Set<Listener>>()

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      exposed[key] = value
    },
  },
  ipcRenderer: {
    invoke,
    on: (channel: string, listener: Listener) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set())
      listeners.get(channel)?.add(listener)
    },
    removeListener: (channel: string, listener: Listener) => {
      listeners.get(channel)?.delete(listener)
    },
  },
}))

let api: ProxyQaApi

const credentials: ProxyCredentialsInput = { pool: 'residential', host: 'gw', port: 823, username: 'u', password: 'p', sessionTemplate: null }
const quickLaunch: QuickLaunchInput = {
  startUrl: null,
  engine: 'chromium',
  devicePreset: 'iphone-15',
  proxyPool: 'residential',
  providerId: 'dataimpulse',
  target: null,
  sticky: true,
  stickyTtlMinutes: null,
  locale: null,
  timezone: null,
  saveAsProfile: false,
  profileName: null,
  replaceActiveSession: false,
}

beforeAll(async () => {
  await import('../src/preload/index')
  api = exposed.api as ProxyQaApi
})

describe('preload bridge', () => {
  it('exposes exactly the ProxyQaApi groups and nothing else', () => {
    expect(Object.keys(exposed)).toEqual(['api'])
    expect(Object.keys(api).sort()).toEqual([
      'app',
      'browser',
      'browsers',
      'dashboard',
      'desktop',
      'events',
      'launcher',
      'locations',
      'logs',
      'profiles',
      'proxy',
      'qa',
      'runs',
      'security',
      'settings',
      'setup',
      'siteAccess',
      'tasks',
    ])
    for (const group of Object.keys(IPC) as Array<keyof typeof IPC>) {
      expect(Object.keys(api[group]).sort()).toEqual(Object.keys(IPC[group]).sort())
    }
  })

  it('maps each method to its contract channel with the arguments passed through', async () => {
    const cases: Array<[() => Promise<unknown>, string, unknown[]]> = [
      [() => api.desktop.status(), IPC.desktop.status, []],
      [() => api.desktop.setup({ desktop: false, startMenu: true }), IPC.desktop.setup, [{ desktop: false, startMenu: true }]],
      [() => api.desktop.showPinning(), IPC.desktop.showPinning, []],
      [() => api.desktop.launchInstalled(), IPC.desktop.launchInstalled, []],
      [() => api.desktop.chooseUsb(), IPC.desktop.chooseUsb, []],
      [() => api.desktop.applyUsb(), IPC.desktop.applyUsb, []],
      [() => api.app.getInfo(), IPC.app.getInfo, []],
      [() => api.app.openPath('/tmp/x.png'), IPC.app.openPath, ['/tmp/x.png']],
      [() => api.profiles.list(), IPC.profiles.list, []],
      [() => api.profiles.get('p1'), IPC.profiles.get, ['p1']],
      [() => api.profiles.update('p1', { name: 'n' } as never), IPC.profiles.update, ['p1', { name: 'n' }]],
      [() => api.profiles.duplicate('p1'), IPC.profiles.duplicate, ['p1']],
      [() => api.profiles.delete('p1'), IPC.profiles.delete, ['p1']],
      [() => api.profiles.presets(), IPC.profiles.presets, []],
      [() => api.proxy.providers(), IPC.proxy.providers, []],
      [() => api.proxy.getConfigStatus(), IPC.proxy.getConfigStatus, []],
      [() => api.proxy.getConfigStatus('dataimpulse'), IPC.proxy.getConfigStatus, ['dataimpulse']],
      [() => api.proxy.testConnection(null), IPC.proxy.testConnection, [null]],
      [() => api.proxy.testConnection(null, 'mobile'), IPC.proxy.testConnection, [null, 'mobile']],
      [() => api.proxy.testConnection(null, 'mobile', 'dataimpulse'), IPC.proxy.testConnection, [null, 'mobile', 'dataimpulse']],
      [() => api.proxy.getCurrentIp('p1'), IPC.proxy.getCurrentIp, ['p1']],
      [() => api.proxy.listSessions(), IPC.proxy.listSessions, []],
      [() => api.proxy.rotateSession('p1'), IPC.proxy.rotateSession, ['p1']],
      [() => api.browser.launch('p1'), IPC.browser.launch, ['p1']],
      [() => api.browser.close('s1'), IPC.browser.close, ['s1']],
      [() => api.browser.screenshot('s1'), IPC.browser.screenshot, ['s1']],
      [() => api.browser.listActive(), IPC.browser.listActive, []],
      [() => api.browser.focus('s1'), IPC.browser.focus, ['s1']],
      [() => api.tasks.list(), IPC.tasks.list, []],
      [() => api.tasks.cancel('t1'), IPC.tasks.cancel, ['t1']],
      [() => api.tasks.retry('t1'), IPC.tasks.retry, ['t1']],
      [() => api.tasks.clearFinished(), IPC.tasks.clearFinished, []],
      [() => api.browsers.status(), IPC.browsers.status, []],
      [() => api.browsers.install('all'), IPC.browsers.install, ['all']],
      [() => api.browsers.installEngine('chrome'), IPC.browsers.installEngine, ['chrome']],
      [() => api.browsers.uninstallEngine('brave'), IPC.browsers.uninstallEngine, ['brave']],
      [() => api.browsers.installAllMissing(), IPC.browsers.installAllMissing, []],
      [() => api.browsers.openDownloadPage('opera'), IPC.browsers.openDownloadPage, ['opera']],
      [() => api.browsers.engines(), IPC.browsers.engines, []],
      [() => api.browsers.redetect(), IPC.browsers.redetect, []],
      [() => api.runs.list(25), IPC.runs.list, [25]],
      [() => api.runs.get('r1'), IPC.runs.get, ['r1']],
      [() => api.runs.update('r1', { notes: 'x' }), IPC.runs.update, ['r1', { notes: 'x' }]],
      [() => api.runs.delete('r1'), IPC.runs.delete, ['r1']],
      [() => api.runs.network('r1'), IPC.runs.network, ['r1']],
      [() => api.settings.get(), IPC.settings.get, []],
      [() => api.settings.update({ ipCheckRetries: 1 }), IPC.settings.update, [{ ipCheckRetries: 1 }]],
      [() => api.logs.list({ level: 'ERROR' }), IPC.logs.list, [{ level: 'ERROR' }]],
      [() => api.logs.clear(), IPC.logs.clear, []],
      [() => api.dashboard.stats(), IPC.dashboard.stats, []],
      [() => api.security.status(), IPC.security.status, []],
      [() => api.security.testCredentials(credentials), IPC.security.testCredentials, [credentials]],
      [() => api.security.saveCredentials(credentials), IPC.security.saveCredentials, [credentials]],
      [() => api.security.clearCredentials('dataimpulse', 'mobile'), IPC.security.clearCredentials, ['dataimpulse', 'mobile']],
      [() => api.locations.search({ mode: 'state', query: 'new j', limit: 10 }), IPC.locations.search, [{ mode: 'state', query: 'new j', limit: 10 }]],
      [() => api.locations.random('zip'), IPC.locations.random, ['zip']],
      [() => api.locations.random('city', 'NJ'), IPC.locations.random, ['city', 'NJ']],
      [() => api.locations.random('city', null), IPC.locations.random, ['city']],
      [() => api.locations.query({ mode: 'city', query: 'new', limit: 50, stateCode: 'NJ' }), IPC.locations.query, [{ mode: 'city', query: 'new', limit: 50, stateCode: 'NJ' }]],
      [() => api.locations.stats(), IPC.locations.stats, []],
      [() => api.locations.states(), IPC.locations.states, []],
      [() => api.launcher.preview(quickLaunch), IPC.launcher.preview, [quickLaunch]],
      [() => api.launcher.quickLaunch(quickLaunch), IPC.launcher.quickLaunch, [quickLaunch]],
      [() => api.launcher.closeAll(), IPC.launcher.closeAll, []],
      [() => api.security.rotateKey(), IPC.security.rotateKey, []],
      [() => api.security.revealLocations('key'), IPC.security.revealLocations, ['key']],
      [() => api.security.updateCredentials({ pool: 'residential', password: 'p2' }), IPC.security.updateCredentials, [{ pool: 'residential', password: 'p2' }]],
      [() => api.security.testCredentialsPartial({ pool: 'mobile' }), IPC.security.testCredentialsPartial, [{ pool: 'mobile' }]],
      [() => api.security.openKeysWindow(), IPC.security.openKeysWindow, []],
      [() => api.security.closeKeysWindow(), IPC.security.closeKeysWindow, []],
      [() => api.setup.status(), IPC.setup.status, []],
      [() => api.setup.complete(), IPC.setup.complete, []],
      [() => api.siteAccess.status(), IPC.siteAccess.status, []],
      [() => api.siteAccess.save({ name: 'n', origins: ['https://a.example'], headerName: 'X-QA', enabled: true }), IPC.siteAccess.save, [{ name: 'n', origins: ['https://a.example'], headerName: 'X-QA', enabled: true }]],
      [() => api.siteAccess.save({ name: 'n', origins: ['https://a.example'], headerName: 'X-QA', enabled: false }, 't1'), IPC.siteAccess.save, [{ name: 'n', origins: ['https://a.example'], headerName: 'X-QA', enabled: false }, 't1']],
      [() => api.siteAccess.setEnabled('t1', false), IPC.siteAccess.setEnabled, ['t1', false]],
      [() => api.siteAccess.delete('t1'), IPC.siteAccess.delete, ['t1']],
    ]
    for (const [call, channel, args] of cases) {
      invoke.mockClear()
      await call()
      expect(invoke).toHaveBeenCalledTimes(1)
      expect(invoke).toHaveBeenCalledWith(channel, ...args)
    }
  })

  it('events.on subscribes, strips the IpcRendererEvent and unsubscribes', () => {
    const received: unknown[] = []
    const off = api.events.on(EVENTS.logEntry, (entry) => received.push(entry))
    const set = listeners.get(EVENTS.logEntry)
    expect(set?.size).toBe(1)
    for (const l of set ?? []) l({ sender: 'ipc-event' }, { id: 1, message: 'hi' })
    expect(received).toEqual([{ id: 1, message: 'hi' }])
    off()
    expect(set?.size).toBe(0)
  })

  it('rejects unknown event channels and non-function listeners', () => {
    expect(() => api.events.on('event:not-real' as never, () => {})).toThrow(/Unknown event channel/)
    expect(() => api.events.on(EVENTS.runUpdate, 'nope' as never)).toThrow(/listener function/)
  })
})

/**
 * Preload bridge: exposes exactly `ProxyQaApi` on `window.api`.
 *
 * Only channel names from the shared contract are used, and every call goes
 * through `ipcRenderer.invoke`, so the renderer never receives a raw
 * `ipcRenderer`. Push events are validated against `EVENTS` before subscribing.
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

import { EVENTS, IPC } from '@shared/ipc'
import type { EventChannel, EventPayloads, ProxyQaApi, Unsubscribe } from '@shared/ipc'

const EVENT_CHANNELS = new Set<string>(Object.values(EVENTS))

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>
}

function onEvent<C extends EventChannel>(channel: C, listener: (payload: EventPayloads[C]) => void): Unsubscribe {
  if (!EVENT_CHANNELS.has(channel)) {
    throw new Error(`Unknown event channel "${String(channel)}". Expected one of: ${[...EVENT_CHANNELS].join(', ')}`)
  }
  if (typeof listener !== 'function') {
    throw new Error('An event listener function is required.')
  }
  const wrapped = (_event: IpcRendererEvent, payload: EventPayloads[C]): void => {
    listener(payload)
  }
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

const api: ProxyQaApi = {
  desktop: {
    status: () => invoke(IPC.desktop.status),
    setup: (options) => invoke(IPC.desktop.setup, options),
    showPinning: () => invoke(IPC.desktop.showPinning),
    launchInstalled: () => invoke(IPC.desktop.launchInstalled),
    chooseUsb: () => invoke(IPC.desktop.chooseUsb),
    applyUsb: () => invoke(IPC.desktop.applyUsb),
  },
  qa: {
    visualImages: (batchId, caseId, stepIndex) => invoke(IPC.qa.visualImages, batchId, caseId, stepIndex),
    saveEnvironment: (input, id) =>
      id === undefined ? invoke(IPC.qa.saveEnvironment, input) : invoke(IPC.qa.saveEnvironment, input, id),
    deleteEnvironment: (id) => invoke(IPC.qa.deleteEnvironment, id),
    saveSuite: (input, id) =>
      id === undefined ? invoke(IPC.qa.saveSuite, input) : invoke(IPC.qa.saveSuite, input, id),
    deleteSuite: (id) => invoke(IPC.qa.deleteSuite, id),
    exportSuite: (id) => invoke(IPC.qa.exportSuite, id),
    approveBaseline: (batchId, caseId, stepIndex) => invoke(IPC.qa.approveBaseline, batchId, caseId, stepIndex),
    exportBaselines: (id) => invoke(IPC.qa.exportBaselines, id),
    startRecording: (input) => invoke(IPC.qa.startRecording, input),
    recording: () => invoke(IPC.qa.recording),
    stopRecording: () => invoke(IPC.qa.stopRecording),
    saveGateway: (input, id) =>
      id === undefined ? invoke(IPC.qa.saveGateway, input) : invoke(IPC.qa.saveGateway, input, id),
    testGateway: (id) => invoke(IPC.qa.testGateway, id),
    deleteGateway: (id) => invoke(IPC.qa.deleteGateway, id),
    checkUpdates: () => invoke(IPC.qa.checkUpdates),
    downloadUpdate: () => invoke(IPC.qa.downloadUpdate),
    exportScenario: (id) => invoke(IPC.qa.exportScenario, id),
    snapshot: () => invoke(IPC.qa.snapshot),
    createWorkspace: (name) => invoke(IPC.qa.createWorkspace, name),
    saveScenario: (input, id) =>
      id === undefined ? invoke(IPC.qa.saveScenario, input) : invoke(IPC.qa.saveScenario, input, id),
    deleteScenario: (id) => invoke(IPC.qa.deleteScenario, id),
    start: (input) => invoke(IPC.qa.start, input),
    cancel: (id) => invoke(IPC.qa.cancel, id),
    exportBatch: (id, format) => invoke(IPC.qa.exportBatch, id, format),
    savePolicy: (input) => invoke(IPC.qa.savePolicy, input),
    prune: () => invoke(IPC.qa.prune),
    backup: (passphrase) => invoke(IPC.qa.backup, passphrase),
    restore: (passphrase) => invoke(IPC.qa.restore, passphrase),
    saveSchedule: (input, id) =>
      id === undefined ? invoke(IPC.qa.saveSchedule, input) : invoke(IPC.qa.saveSchedule, input, id),
    deleteSchedule: (id) => invoke(IPC.qa.deleteSchedule, id),
    diagnostics: () => invoke(IPC.qa.diagnostics),
  },
  app: {
    getInfo: () => invoke(IPC.app.getInfo),
    openPath: (path) => invoke(IPC.app.openPath, path),
  },
  profiles: {
    list: () => invoke(IPC.profiles.list),
    get: (id) => invoke(IPC.profiles.get, id),
    create: (input) => invoke(IPC.profiles.create, input),
    update: (id, input) => invoke(IPC.profiles.update, id, input),
    duplicate: (id) => invoke(IPC.profiles.duplicate, id),
    delete: (id) => invoke(IPC.profiles.delete, id),
    presets: () => invoke(IPC.profiles.presets),
  },
  proxy: {
    getConfigStatus: () => invoke(IPC.proxy.getConfigStatus),
    // The pool argument is only forwarded when given, so older callers send exactly what they did before.
    testConnection: (profileId, pool) =>
      pool === undefined
        ? invoke(IPC.proxy.testConnection, profileId)
        : invoke(IPC.proxy.testConnection, profileId, pool),
    getCurrentIp: (profileId) => invoke(IPC.proxy.getCurrentIp, profileId),
    listSessions: () => invoke(IPC.proxy.listSessions),
    rotateSession: (profileId) => invoke(IPC.proxy.rotateSession, profileId),
  },
  browser: {
    launch: (profileId) => invoke(IPC.browser.launch, profileId),
    close: (sessionId) => invoke(IPC.browser.close, sessionId),
    screenshot: (sessionId) => invoke(IPC.browser.screenshot, sessionId),
    listActive: () => invoke(IPC.browser.listActive),
    focus: (sessionId) => invoke(IPC.browser.focus, sessionId),
  },
  browsers: {
    installEngine: (engine) => invoke(IPC.browsers.installEngine, engine),
    uninstallEngine: (engine) => invoke(IPC.browsers.uninstallEngine, engine),
    installAllMissing: () => invoke(IPC.browsers.installAllMissing),
    openDownloadPage: (engine) => invoke(IPC.browsers.openDownloadPage, engine),
    status: () => invoke(IPC.browsers.status),
    install: (engine) => invoke(IPC.browsers.install, engine),
    engines: () => invoke(IPC.browsers.engines),
    redetect: () => invoke(IPC.browsers.redetect),
  },
  runs: {
    list: (limit) => invoke(IPC.runs.list, limit),
    get: (id) => invoke(IPC.runs.get, id),
    update: (id, patch) => invoke(IPC.runs.update, id, patch),
    delete: (id) => invoke(IPC.runs.delete, id),
    network: (runId) => invoke(IPC.runs.network, runId),
  },
  settings: {
    get: () => invoke(IPC.settings.get),
    update: (patch) => invoke(IPC.settings.update, patch),
  },
  logs: {
    list: (query) => invoke(IPC.logs.list, query),
    clear: () => invoke(IPC.logs.clear),
  },
  dashboard: {
    stats: () => invoke(IPC.dashboard.stats),
  },
  security: {
    status: () => invoke(IPC.security.status),
    testCredentials: (input) => invoke(IPC.security.testCredentials, input),
    saveCredentials: (input) => invoke(IPC.security.saveCredentials, input),
    clearCredentials: (pool) => invoke(IPC.security.clearCredentials, pool),
    rotateKey: () => invoke(IPC.security.rotateKey),
    revealLocations: (which) => invoke(IPC.security.revealLocations, which),
    updateCredentials: (input) => invoke(IPC.security.updateCredentials, input),
    testCredentialsPartial: (input) => invoke(IPC.security.testCredentialsPartial, input),
    openKeysWindow: () => invoke(IPC.security.openKeysWindow),
    closeKeysWindow: () => invoke(IPC.security.closeKeysWindow),
  },
  locations: {
    search: (input) => invoke(IPC.locations.search, input),
    query: (input) => invoke(IPC.locations.query, input),
    stats: () => invoke(IPC.locations.stats),
    // Only send the state filter when there is one, so the plain call keeps its one-argument shape.
    random: (mode, stateCode) =>
      stateCode ? invoke(IPC.locations.random, mode, stateCode) : invoke(IPC.locations.random, mode),
    states: () => invoke(IPC.locations.states),
  },
  tasks: {
    list: () => invoke(IPC.tasks.list),
    cancel: (taskId) => invoke(IPC.tasks.cancel, taskId),
    retry: (taskId) => invoke(IPC.tasks.retry, taskId),
    clearFinished: () => invoke(IPC.tasks.clearFinished),
  },
  launcher: {
    preview: (input) => invoke(IPC.launcher.preview, input),
    quickLaunch: (input) => invoke(IPC.launcher.quickLaunch, input),
    closeAll: () => invoke(IPC.launcher.closeAll),
  },
  setup: {
    status: () => invoke(IPC.setup.status),
    complete: () => invoke(IPC.setup.complete),
  },
  events: {
    on: onEvent,
  },
}

contextBridge.exposeInMainWorld('api', api)

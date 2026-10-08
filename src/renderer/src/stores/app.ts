import { create } from 'zustand'
import type { AppError, AppInfo, BrowserEngine, BrowserEngineInfo, BrowserInstallTarget, BrowserWatchUpdate, BrowsersStatus, BundledBrowserEngine } from '@shared/types'
import { BUNDLED_BROWSER_ENGINES, isAutomaticInstallMethod } from '@shared/types'
import { getApi, toAppError, unwrap } from '../lib/api'
import type { LoadStatus } from '../lib/result'

export type InstallTarget = BrowserInstallTarget

/**
 * App info and browser availability. Installs and uninstalls are background tasks (stores/tasks.ts);
 * this store only reloads the status once a task finished.
 */
interface AppState {
  info: AppInfo | null
  infoStatus: LoadStatus
  infoError: AppError | null
  browsers: BrowsersStatus | null
  browsersStatus: LoadStatus
  browsersError: AppError | null
  /** Engines the main process is waiting for after "Get <Browser>" opened the vendor page. */
  watchingEngines: Partial<Record<BrowserEngine, boolean>>
  /** True while `browsers.redetect` is running. */
  redetecting: boolean
  loadInfo: () => Promise<void>
  loadBrowsers: () => Promise<void>
  /** Open the vendor download page (method 'download-page'); the main process then watches for the install. */
  openDownloadPage: (engine: BrowserEngine) => Promise<void>
  /** Apply an event:browser-watch update (waiting state, and the engine record once found). */
  applyWatchUpdate: (update: BrowserWatchUpdate) => void
  /** Re-scan the machine for installed browsers and refresh `browsers.engines`. Throws ApiError on failure. */
  redetect: () => Promise<BrowserEngineInfo[]>
  openPath: (path: string) => Promise<void>
}

export const useAppStore = create<AppState>((set) => ({
  info: null,
  infoStatus: 'idle',
  infoError: null,
  browsers: null,
  browsersStatus: 'idle',
  browsersError: null,
  watchingEngines: {},
  redetecting: false,

  loadInfo: async () => {
    set((state) => ({ infoStatus: state.info ? state.infoStatus : 'loading', infoError: null }))
    try {
      const info = await unwrap(getApi().app.getInfo())
      set({ info, infoStatus: 'ready' })
    } catch (err) {
      set({ infoStatus: 'error', infoError: toAppError(err) })
    }
  },

  loadBrowsers: async () => {
    set((state) => ({ browsersStatus: state.browsers ? state.browsersStatus : 'loading', browsersError: null }))
    try {
      const browsers = await unwrap(getApi().browsers.status())
      set({ browsers, browsersStatus: 'ready' })
    } catch (err) {
      set({ browsersStatus: 'error', browsersError: toAppError(err) })
    }
  },

  openDownloadPage: async (engine) => {
    await unwrap(getApi().browsers.openDownloadPage(engine))
    set((state) => ({ watchingEngines: { ...state.watchingEngines, [engine]: true } }))
  },

  applyWatchUpdate: (update) =>
    set((state) => {
      const watchingEngines = { ...state.watchingEngines, [update.engine]: update.state === 'watching' }
      const info = update.info
      if (!info || !state.browsers) return { watchingEngines }
      return { watchingEngines, browsers: { ...state.browsers, engines: state.browsers.engines.map((e) => (e.id === info.id ? info : e)) } }
    }),

  redetect: async () => {
    set({ redetecting: true })
    try {
      const engines = await unwrap(getApi().browsers.redetect())
      set((state) => ({ browsers: state.browsers ? { ...state.browsers, engines } : state.browsers }))
      return engines
    } finally {
      set({ redetecting: false })
    }
  },

  openPath: async (path) => unwrap(getApi().app.openPath(path)),
}))

/** Bundled Playwright engines that are not downloaded yet. Installed browsers are never "missing" in this sense. */
export function missingEngines(browsers: BrowsersStatus | null): BundledBrowserEngine[] {
  if (!browsers) return []
  return BUNDLED_BROWSER_ENGINES.filter((engine) => !browsers[engine])
}

/** Installed-kind engines that are missing and can be installed with one click. */
export function automaticallyInstallable(browsers: BrowsersStatus | null): BrowserEngineInfo[] {
  if (!browsers) return []
  return browsers.engines.filter((info) => info.kind === 'installed' && !info.available && isAutomaticInstallMethod(info.installMethod))
}

/** Availability record for one engine, or null while the status has not loaded. */
export function selectEngineInfo(browsers: BrowsersStatus | null, engine: BrowserEngine): BrowserEngineInfo | null {
  return browsers?.engines.find((info) => info.id === engine) ?? null
}

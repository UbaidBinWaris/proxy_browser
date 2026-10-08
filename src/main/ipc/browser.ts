import { z } from 'zod'

import { IPC } from '@shared/ipc'
import { BUNDLED_BROWSER_ENGINES, BrowserEngineSchema, BundledBrowserEngineSchema, isAutomaticInstallMethod, isInstalledEngine } from '@shared/types'
import type { BundledBrowserEngine, Task } from '@shared/types'

import { isAllowedDownloadUrl } from '../browser/install-support'
import { AppException } from '../contracts'
import type { IpcDeps } from './deps'
import { IdArg, NoArgs, spec } from './handle'
import type { HandlerSpec } from './handle'

/** `install` downloads Playwright's bundled engines; vendor browsers go through `installEngine`. */
const InstallArgs = z.tuple([z.union([BundledBrowserEngineSchema, z.literal('all')])])
const EngineArgs = z.tuple([BrowserEngineSchema])

export function browserHandlers(deps: IpcDeps): HandlerSpec[] {
  return [
    spec(IPC.browser.launch, IdArg, ([profileId]) => deps.browser.launch(deps.profiles.get(profileId))),
    spec(IPC.browser.close, IdArg, ([sessionId]) => deps.browser.close(sessionId)),
    spec(IPC.browser.screenshot, IdArg, ([sessionId]) => deps.browser.screenshot(sessionId)),
    spec(IPC.browser.listActive, NoArgs, () => deps.browser.listActive()),
    spec(IPC.browser.focus, IdArg, ([sessionId]) => deps.browser.focus(sessionId)),
  ]
}

/**
 * Installs and uninstalls are queued on the background task manager and return the task at once;
 * progress, verification and the outcome arrive on event:tasks-update.
 */
export function browsersHandlers(deps: IpcDeps): HandlerSpec[] {
  return [
    spec(IPC.browsers.status, NoArgs, () => deps.provisioner.status()),
    spec(IPC.browsers.install, InstallArgs, async ([target]): Promise<Task[]> => {
      if (target !== 'all') return [await deps.tasks.enqueue('install-bundled', target)]
      const status = await deps.provisioner.status()
      const missing: BundledBrowserEngine[] = BUNDLED_BROWSER_ENGINES.filter((engine) => !status[engine])
      const queued: Task[] = []
      for (const engine of missing) queued.push(await deps.tasks.enqueue('install-bundled', engine))
      return queued
    }),
    spec(IPC.browsers.installEngine, EngineArgs, ([engine]) => deps.tasks.enqueue('install-vendor', engine)),
    spec(IPC.browsers.uninstallEngine, EngineArgs, ([engine]) => deps.tasks.enqueue('uninstall', engine)),
    spec(IPC.browsers.installAllMissing, NoArgs, async (): Promise<Task[]> => {
      const targets = (await deps.provisioner.engines()).filter((info) => isInstalledEngine(info.id) && !info.available && isAutomaticInstallMethod(info.installMethod))
      deps.logger.info('browsers', targets.length === 0 ? 'Install all missing: nothing to install' : `Install all missing: queueing ${targets.map((info) => info.id).join(', ')}`)
      const queued: Task[] = []
      for (const info of targets) queued.push(await deps.tasks.enqueue('install-vendor', info.id))
      return queued
    }),
    // Only the vendor pages the provisioner knows can ever be opened; the renderer cannot pick a URL.
    // The provisioner then watches for the browser to appear and saves its path when it does.
    spec(IPC.browsers.openDownloadPage, EngineArgs, async ([engine]): Promise<void> => {
      const url = deps.provisioner.downloadUrl(engine)
      if (!url || !isAllowedDownloadUrl(url)) {
        throw new AppException('INVALID_INPUT', `There is no vendor download page for ${engine}.`)
      }
      deps.logger.info('browsers', `Opening the ${engine} download page`, { engine, url })
      await deps.shell.openExternal(url)
      deps.provisioner.watchForInstall(engine)
    }),
    spec(IPC.browsers.engines, NoArgs, () => deps.provisioner.engines()),
    spec(IPC.browsers.redetect, NoArgs, () => deps.provisioner.redetect()),
  ]
}

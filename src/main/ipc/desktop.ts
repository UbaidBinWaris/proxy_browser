import { z } from 'zod'
import { IPC } from '@shared/ipc'
import { DesktopSetupOptionsSchema } from '@shared/desktop'
import { AppException } from '../contracts'
import type { IpcDeps } from './deps'
import { NoArgs, spec } from './handle'
import type { HandlerSpec } from './handle'

export function desktopHandlers(deps: IpcDeps): HandlerSpec[] {
  const desktop = () => {
    if (!deps.desktop) throw new AppException('INTERNAL', 'Computer setup is unavailable in this build.')
    return deps.desktop
  }
  return [
    spec(IPC.desktop.status, NoArgs, () => desktop().status()),
    spec(IPC.desktop.setup, z.tuple([DesktopSetupOptionsSchema]), ([options]) => desktop().setup(options)),
    spec(IPC.desktop.showPinning, NoArgs, () => desktop().showPinning()),
    spec(IPC.desktop.launchInstalled, NoArgs, () => desktop().launchInstalled()),
    spec(IPC.desktop.chooseUsb, NoArgs, async () => {
      if (!deps.files?.chooseUsb) throw new AppException('INTERNAL', 'The USB file chooser is unavailable.')
      const path = await deps.files.chooseUsb()
      return path ? desktop().inspectUsb(path) : null
    }),
    spec(IPC.desktop.applyOnline, NoArgs, async () => {
      if (!deps.updates) throw new AppException('INTERNAL', 'Online updates are unavailable.')
      await desktop().applyOnline(await deps.updates.downloadRelease())
    }),
    spec(IPC.desktop.applyUsb, NoArgs, () => desktop().applyUsb()),
    spec(IPC.desktop.retryPendingUpdate, NoArgs, () => desktop().retryPendingUpdate()),
    spec(IPC.desktop.dismissUpdateNotice, NoArgs, () => desktop().dismissUpdateNotice()),
    spec(IPC.desktop.openDownloadPage, NoArgs, () => desktop().openDownloadPage()),
    // Answers without the integration too: builds without one simply have no known update.
    spec(IPC.desktop.updateAvailability, NoArgs, () => deps.updateAvailability?.() ?? null),
  ]
}

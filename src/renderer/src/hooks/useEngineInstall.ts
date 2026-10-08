import { useCallback } from 'react'
import type { BrowserEngine, Task } from '@shared/types'
import { BROWSER_ENGINE_LABELS } from '@shared/types'
import { shortEngineName } from '@/lib/engines'
import { useAppStore } from '@/stores/app'
import { useTasksStore } from '@/stores/tasks'
import { toast } from '@/stores/toasts'

export interface EngineInstallActions {
  /** Queue a one-click install in the background; resolves with the task (null on refusal, already toasted). */
  install: (engine: BrowserEngine) => Promise<Task | null>
  /** Open the vendor page; the app then waits for the browser to appear. */
  getIt: (engine: BrowserEngine) => Promise<void>
  /** Queue the removal of the app's own copy (the caller confirms first). */
  uninstall: (engine: BrowserEngine) => Promise<Task | null>
  installAll: () => Promise<void>
}

const nameOf = (engine: BrowserEngine): string => shortEngineName({ label: BROWSER_ENGINE_LABELS[engine] })

/**
 * Install / Get / Uninstall actions with consistent toasts, shared by Settings, Launch and the profile editor.
 * Installs run as background tasks (one at a time, each verified); the outcome is toasted when the task finishes.
 */
export function useEngineInstallActions(): EngineInstallActions {
  const installVendor = useTasksStore((s) => s.installVendor)
  const uninstallTask = useTasksStore((s) => s.uninstall)
  const installAllMissing = useTasksStore((s) => s.installAllMissing)
  const openDownloadPage = useAppStore((s) => s.openDownloadPage)

  const install = useCallback(
    async (engine: BrowserEngine): Promise<Task | null> => {
      try {
        const task = await installVendor(engine)
        toast.info(`${nameOf(engine)} queued`, 'It installs in the background and is verified before use. Follow it in Tasks.')
        return task
      } catch (err) {
        toast.fromError(err, `Could not install ${BROWSER_ENGINE_LABELS[engine]}`)
        return null
      }
    },
    [installVendor],
  )

  const getIt = useCallback(
    async (engine: BrowserEngine): Promise<void> => {
      try {
        await openDownloadPage(engine)
        toast.info(`Opened the ${nameOf(engine)} download page`, 'Install it as usual — the app detects it automatically and saves its path.')
      } catch (err) {
        toast.fromError(err, 'Could not open the download page')
      }
    },
    [openDownloadPage],
  )

  const uninstall = useCallback(
    async (engine: BrowserEngine): Promise<Task | null> => {
      try {
        return await uninstallTask(engine)
      } catch (err) {
        toast.fromError(err, `Could not uninstall ${BROWSER_ENGINE_LABELS[engine]}`)
        return null
      }
    },
    [uninstallTask],
  )

  const installAll = useCallback(async (): Promise<void> => {
    try {
      const queued = await installAllMissing()
      if (queued.length === 0) toast.info('Nothing to install', 'Every browser with a one-click install is already available.')
      else toast.info(`Queued ${queued.length} install${queued.length === 1 ? '' : 's'}`, `${queued.map((task) => nameOf(task.engine)).join(', ')} — one after another, each verified.`)
    } catch (err) {
      toast.fromError(err, 'Could not queue the missing browsers')
    }
  }, [installAllMissing])

  return { install, getIt, uninstall, installAll }
}

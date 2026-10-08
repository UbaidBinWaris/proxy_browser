import { mkdirSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import { z } from 'zod'

import { IPC } from '@shared/ipc'
import { AppSettingsPatchSchema } from '@shared/types'
import type { AppSettingsPatch } from '@shared/types'

import { originsAfterUserEdit } from '../browser/executable-paths'
import { AppException } from '../contracts'
import type { IpcDeps } from './deps'
import { NoArgs, spec } from './handle'
import type { HandlerSpec } from './handle'

const UpdateArgs = z.tuple([AppSettingsPatchSchema])

/**
 * Make sure a screenshot directory is usable: absolute, creatable and a directory.
 * Returns the normalised absolute path.
 */
export function ensureScreenshotDir(dir: string): string {
  const trimmed = dir.trim()
  if (!isAbsolute(trimmed)) {
    throw new AppException('INVALID_INPUT', 'The screenshot folder must be an absolute path (for example /home/me/qa-shots).')
  }
  const absolute = resolve(trimmed)
  try {
    mkdirSync(absolute, { recursive: true })
    if (!statSync(absolute).isDirectory()) {
      throw new AppException('INVALID_INPUT', `"${absolute}" exists but is not a folder.`)
    }
  } catch (err) {
    if (err instanceof AppException) throw err
    const detail = err instanceof Error ? err.message : String(err)
    throw new AppException('INVALID_INPUT', `The screenshot folder "${absolute}" could not be created. Pick a writable location.`, detail)
  }
  return absolute
}

export function settingsHandlers(deps: IpcDeps): HandlerSpec[] {
  return [
    spec(IPC.settings.get, NoArgs, () => deps.db.settings.get()),
    spec(IPC.settings.update, UpdateArgs, ([patch]) => {
      const next: AppSettingsPatch = { ...patch }
      const current = deps.db.settings.get()
      // Paths saved from the renderer are the user's own: mark changed entries 'user' so detection
      // never overwrites them (unless the patch states the origins itself).
      if (next.browserExecutables !== undefined && next.browserExecutableOrigins === undefined) {
        next.browserExecutableOrigins = originsAfterUserEdit({ executables: current.browserExecutables, origins: current.browserExecutableOrigins }, next.browserExecutables)
      }
      if (next.screenshotDir !== undefined && next.screenshotDir !== current.screenshotDir) {
        next.screenshotDir = ensureScreenshotDir(next.screenshotDir)
      }
      const updated = deps.db.settings.update(next)
      deps.logger.info('settings', 'Settings updated', { keys: Object.keys(next) })
      return updated
    }),
  ]
}

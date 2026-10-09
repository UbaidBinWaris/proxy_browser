import { randomUUID } from 'node:crypto'
import * as nodeFileSystem from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { RELEASE_VERSION, newerVersion } from '@shared/desktop'
import type { UpdateAvailability } from '@shared/desktop'
import type { UpdateStatus } from '@shared/qa'
import type { Logger } from '../contracts'

/** The startup check runs at most once per this interval. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
/** Lives in the app data folder next to the update downloads. */
export const UPDATE_CHECK_FILE = 'update-check.json'

const UpdateCheckStateSchema = z.object({
  checkedAt: z.string().datetime(),
  available: z.boolean(),
  version: z.string().regex(RELEASE_VERSION).nullable(),
})
export type UpdateCheckState = z.infer<typeof UpdateCheckStateSchema>

/**
 * True when no check is remembered, the timestamp is unreadable, the interval has passed, or the
 * remembered check lies in the future (the clock was set back), so a wrong clock never blocks checks.
 */
export function isUpdateCheckDue(lastCheckedAt: string | null, now: number, intervalMs = UPDATE_CHECK_INTERVAL_MS): boolean {
  if (!lastCheckedAt) return true
  const last = Date.parse(lastCheckedAt)
  if (!Number.isFinite(last) || last > now) return true
  return now - last >= intervalMs
}

/** A remembered check that still names a release newer than the running version; null otherwise. */
export function rememberedUpdate(state: UpdateCheckState | null, currentVersion: string): UpdateAvailability | null {
  if (!state?.available || !state.version || !newerVersion(state.version, currentVersion)) return null
  return { available: true, version: state.version, checkedAt: state.checkedAt }
}

export function createUpdateCheckStore(opts: {
  path: string
  fileSystem?: Pick<typeof nodeFileSystem, 'mkdir' | 'readFile' | 'rename' | 'rm' | 'writeFile'>
}) {
  const { mkdir, readFile, rename, rm, writeFile } = opts.fileSystem ?? nodeFileSystem
  return {
    /** The remembered check; null when there is none or the file is unreadable or invalid. */
    async read(): Promise<UpdateCheckState | null> {
      try {
        const parsed = UpdateCheckStateSchema.safeParse(JSON.parse(await readFile(opts.path, 'utf8')))
        return parsed.success ? parsed.data : null
      } catch {
        return null
      }
    },
    async write(state: UpdateCheckState): Promise<void> {
      const value = UpdateCheckStateSchema.parse(state)
      await mkdir(dirname(opts.path), { recursive: true, mode: 0o700 })
      const partial = `${opts.path}.${randomUUID()}.part`
      try {
        await writeFile(partial, JSON.stringify(value), { mode: 0o600 })
        await rename(partial, opts.path)
      } finally {
        await rm(partial, { force: true })
      }
    },
  }
}
export type UpdateCheckStore = ReturnType<typeof createUpdateCheckStore>

export interface StartupUpdateCheckOptions {
  /** settings.checkUpdatesOnStartup */
  enabled: boolean
  /** False for builds without a signed feed: nothing is checked or remembered. */
  configured: boolean
  currentVersion: string
  store: UpdateCheckStore
  /** The update manager's check(): verifies the signed feed, never downloads. */
  check: () => Promise<UpdateStatus>
  now: () => Date
  logger: Pick<Logger, 'info' | 'warn'>
  /** Receives the fresh (or still valid remembered) result for the renderer. */
  publish: (availability: UpdateAvailability) => void
  intervalMs?: number
}

const SCOPE = 'updates'

/**
 * The single background update check after start: at most once per interval, opt-out, never a
 * download. Failures are logged and never thrown. Returns what was published (null for nothing).
 */
export async function runStartupUpdateCheck(opts: StartupUpdateCheckOptions): Promise<UpdateAvailability | null> {
  if (!opts.configured || !opts.enabled) return null
  const state = await opts.store.read()
  const now = opts.now()
  if (!isUpdateCheckDue(state?.checkedAt ?? null, now.getTime(), opts.intervalMs)) {
    const remembered = rememberedUpdate(state, opts.currentVersion)
    if (remembered) opts.publish(remembered)
    return remembered
  }
  const checkedAt = now.toISOString()
  try {
    const result = await opts.check()
    const availability: UpdateAvailability = {
      available: result.available,
      version: result.available ? (result.version ?? null) : null,
      checkedAt,
    }
    await opts.store
      .write({ checkedAt, available: availability.available, version: availability.version })
      .catch((error: unknown) => opts.logger.warn(SCOPE, 'Could not remember the update check', { error }))
    opts.logger.info(
      SCOPE,
      availability.available ? `Startup check: v${availability.version} is available` : 'Startup check: no newer release',
    )
    opts.publish(availability)
    return availability
  } catch (error) {
    // Count the attempt so an unreachable feed is not asked again on every start; keep what was known.
    await opts.store
      .write({ checkedAt, available: state?.available ?? false, version: state?.version ?? null })
      .catch(() => undefined)
    opts.logger.warn(SCOPE, 'Startup update check failed; try again from App & updates', { error })
    const remembered = rememberedUpdate(state, opts.currentVersion)
    if (remembered) opts.publish(remembered)
    return remembered
  }
}

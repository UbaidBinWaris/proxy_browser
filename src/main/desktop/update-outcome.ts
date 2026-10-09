import { randomUUID } from 'node:crypto'
import * as nodeFileSystem from 'node:fs/promises'
import { dirname } from 'node:path'
import { UpdateOutcomeSchema, newerVersion } from '@shared/desktop'
import type { UpdateOutcome } from '@shared/desktop'
import { AppException } from '../contracts'

/** Written next to the pending-update record in the desktop integration root. */
export const LAST_UPDATE_FILE = 'last-update.json'
const MAX_MESSAGE = 300

export const UPDATE_FAILED_FALLBACK =
  'The new version could not replace the computer copy. Your current copy still works; retry or update again.'

/**
 * A message that is safe to show and store: AppException messages are written for users and carry no
 * paths; anything else (file-system errors quote paths) becomes a generic sentence.
 */
export function updateFailureMessage(error: unknown): string {
  const message = error instanceof AppException ? error.message.trim() : ''
  if (!message) return UPDATE_FAILED_FALLBACK
  return message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE - 1)}…` : message
}

/**
 * Whether a stored outcome is still worth showing to this version: a success only in the version it
 * names (an older copy opened later does not claim it was updated), a failure until a newer version
 * runs (that version replaced the computer copy some other way).
 */
export function visibleUpdateOutcome(outcome: UpdateOutcome | null, currentVersion: string): UpdateOutcome | null {
  if (!outcome) return null
  if (outcome.status === 'succeeded') return outcome.version === currentVersion ? outcome : null
  return newerVersion(currentVersion, outcome.version) ? null : outcome
}

export interface UpdateOutcomeStoreOptions {
  path: string
  /** Electron passes original-fs; tests use the default. */
  fileSystem?: Pick<typeof nodeFileSystem, 'mkdir' | 'readFile' | 'rename' | 'rm' | 'writeFile'>
  now?: () => Date
}

export function createUpdateOutcomeStore(opts: UpdateOutcomeStoreOptions) {
  const { mkdir, readFile, rename, rm, writeFile } = opts.fileSystem ?? nodeFileSystem
  const now = opts.now ?? (() => new Date())
  return {
    /** The stored outcome; null when there is none or the file is unreadable or invalid. */
    async read(): Promise<UpdateOutcome | null> {
      try {
        const parsed = UpdateOutcomeSchema.safeParse(JSON.parse(await readFile(opts.path, 'utf8')))
        return parsed.success ? parsed.data : null
      } catch {
        return null
      }
    },
    /** Replace the stored outcome (written to a temporary file first so a crash never leaves half a record). */
    async record(version: string, status: UpdateOutcome['status'], message: string): Promise<UpdateOutcome> {
      const outcome = UpdateOutcomeSchema.parse({
        version,
        status,
        message: message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE - 1)}…` : message,
        at: now().toISOString(),
      })
      await mkdir(dirname(opts.path), { recursive: true, mode: 0o700 })
      const partial = `${opts.path}.${randomUUID()}.part`
      try {
        await writeFile(partial, JSON.stringify(outcome), { mode: 0o600 })
        await rename(partial, opts.path)
      } finally {
        await rm(partial, { force: true })
      }
      return outcome
    },
    async dismiss(): Promise<void> {
      await rm(opts.path, { force: true })
    },
  }
}
export type UpdateOutcomeStore = ReturnType<typeof createUpdateOutcomeStore>

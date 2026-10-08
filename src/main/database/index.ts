/**
 * SQLite persistence via Node's built-in `node:sqlite` (no native addons).
 *
 * `openDatabase` opens (or creates) the file, enables WAL + foreign keys,
 * applies pending migrations and returns the repository bundle described by
 * `Database` in `../contracts`.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { AppException } from '../contracts'
import type { Database } from '../contracts'
import { createLogRepository } from './repositories/logs'
import { createNetworkRepository } from './repositories/network'
import { createProfileRepository } from './repositories/profiles'
import { createProxySessionRepository } from './repositories/proxySessions'
import { createSettingsRepository } from './repositories/settings'
import { createTestRunRepository } from './repositories/testRuns'
import { runMigrations } from './schema'
import { createQaStore } from '../qa/store'

export interface OpenDatabaseOptions {
  /** Default for `AppSettings.screenshotDir` until the user changes it. */
  defaultScreenshotDir: string
  /**
   * Environment to read `PROXY_QA_DEFAULT_FORM_URL` from. Defaults to
   * `process.env`; tests pass their own object.
   */
  env?: NodeJS.ProcessEnv
}

export const DEFAULT_FORM_URL_ENV = 'PROXY_QA_DEFAULT_FORM_URL'

export function openDatabase(filePath: string, options: OpenDatabaseOptions): Database {
  const env = options.env ?? process.env
  let db: DatabaseSync
  try {
    if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true })
    db = new DatabaseSync(filePath)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA synchronous = NORMAL')
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new AppException(
      'INTERNAL',
      `Could not open the application database at ${filePath}. Check that the folder is writable and not locked by another instance.`,
      detail,
    )
  }

  try {
    runMigrations(db)
  } catch (err) {
    db.close()
    if (err instanceof AppException) throw err
    const detail = err instanceof Error ? err.message : String(err)
    throw new AppException('INTERNAL', 'The application database could not be upgraded to the current schema.', detail)
  }

  let closed = false
  return {
    path: filePath,
    qa: createQaStore(db),
    profiles: createProfileRepository(db),
    proxySessions: createProxySessionRepository(db),
    testRuns: createTestRunRepository(db),
    network: createNetworkRepository(db),
    settings: createSettingsRepository(db, {
      defaultScreenshotDir: options.defaultScreenshotDir,
      defaultFormUrl: env[DEFAULT_FORM_URL_ENV] ?? null,
    }),
    logs: createLogRepository(db),
    close: () => {
      if (closed) return
      closed = true
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch {
        // Best-effort checkpoint; closing still proceeds.
      }
      db.close()
    },
  }
}

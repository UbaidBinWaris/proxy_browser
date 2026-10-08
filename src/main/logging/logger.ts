/**
 * Application logger.
 *
 * Every entry is redacted, persisted through the `LogRepository`, appended as
 * a JSON line to `<fileDir>/app-YYYY-MM-DD.log`, optionally echoed to the
 * console, and finally broadcast to `onEntry` listeners.
 *
 * Logging must never take the app down: persistence or file failures are
 * reported on stderr and the entry is still delivered to listeners.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { LogEntry, LogLevel, LogQuery } from '@shared/types'

import type { LogRepository, Logger } from '../contracts'
import { compileSecrets, redactString, redactWithPattern } from './redact'

export { redactSecrets } from './redact'

export interface CreateLoggerOptions {
  repo: LogRepository
  /** Directory for daily JSON-lines files (created if missing). */
  fileDir: string
  /** Echo entries to the process console. Default false. */
  console?: boolean
  /** Rows to keep in the database after pruning. Default 5000. */
  maxRows?: number
  /** Prune every N inserts. Default 200. */
  pruneEvery?: number
}

export const DEFAULT_MAX_LOG_ROWS = 5000
export const DEFAULT_PRUNE_EVERY = 200

export function logFileNameFor(date: Date): string {
  return `app-${date.toISOString().slice(0, 10)}.log`
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return { value }
}

export function createLogger(opts: CreateLoggerOptions): Logger {
  const maxRows = Math.max(1, Math.trunc(opts.maxRows ?? DEFAULT_MAX_LOG_ROWS))
  const pruneEvery = Math.max(1, Math.trunc(opts.pruneEvery ?? DEFAULT_PRUNE_EVERY))
  const echo = opts.console === true

  const secrets: string[] = []
  let secretPattern: RegExp | null = null
  const listeners = new Set<(entry: LogEntry) => void>()
  let insertsSincePrune = 0
  let fileDirReady = false
  let fileFailureReported = false
  let dbFailureReported = false

  const ensureFileDir = (): void => {
    if (fileDirReady) return
    mkdirSync(opts.fileDir, { recursive: true })
    fileDirReady = true
  }

  const writeFile = (entry: LogEntry): void => {
    try {
      ensureFileDir()
      appendFileSync(join(opts.fileDir, logFileNameFor(new Date(entry.timestamp))), `${JSON.stringify(entry)}\n`, 'utf8')
    } catch (err) {
      if (!fileFailureReported) {
        fileFailureReported = true
        console.error(`[logger] Could not write log file in ${opts.fileDir}:`, err instanceof Error ? err.message : err)
      }
    }
  }

  const echoConsole = (entry: LogEntry): void => {
    if (!echo) return
    const line = `${entry.timestamp} ${entry.level.padEnd(5)} [${entry.scope}] ${entry.message}`
    const args: unknown[] = entry.meta ? [line, entry.meta] : [line]
    if (entry.level === 'ERROR') console.error(...args)
    else if (entry.level === 'WARN') console.warn(...args)
    else console.log(...args)
  }

  const persist = (draft: Omit<LogEntry, 'id'>): LogEntry => {
    try {
      const saved = opts.repo.insert(draft)
      insertsSincePrune += 1
      if (insertsSincePrune >= pruneEvery) {
        insertsSincePrune = 0
        opts.repo.prune(maxRows)
      }
      return saved
    } catch (err) {
      if (!dbFailureReported) {
        dbFailureReported = true
        console.error('[logger] Could not persist log entry:', err instanceof Error ? err.message : err)
      }
      return { id: -1, ...draft }
    }
  }

  const log = (level: LogLevel, scope: string, message: string, meta?: Record<string, unknown>): void => {
    const draft: Omit<LogEntry, 'id'> = {
      timestamp: new Date().toISOString(),
      level,
      scope: redactString(String(scope), secretPattern),
      message: redactString(String(message), secretPattern),
      meta: meta === undefined ? null : toRecord(redactWithPattern(meta, secretPattern)),
    }
    const entry = persist(draft)
    writeFile(entry)
    echoConsole(entry)
    for (const listener of listeners) {
      try {
        listener(entry)
      } catch (err) {
        console.error('[logger] onEntry listener threw:', err instanceof Error ? err.message : err)
      }
    }
  }

  return {
    log,
    info: (scope, message, meta) => log('INFO', scope, message, meta),
    warn: (scope, message, meta) => log('WARN', scope, message, meta),
    error: (scope, message, meta) => log('ERROR', scope, message, meta),

    onEntry: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    query: (query?: LogQuery) => opts.repo.query(query),
    clear: () => opts.repo.clear(),

    registerSecret: (value) => {
      if (typeof value !== 'string' || value.length === 0 || secrets.includes(value)) return
      secrets.push(value)
      secretPattern = compileSecrets(secrets)
    },
  }
}

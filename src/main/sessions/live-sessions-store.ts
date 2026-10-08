/**
 * Small persistent record of the browser sessions that are open right now
 * (`<userData>/data/live-sessions.json`): written when a session starts, when
 * its browser pid becomes known and when it ends; cleared on a normal quit.
 * Whatever is still listed at the next start belongs to a run of the app that
 * crashed or was killed — orphan-cleanup.ts terminates those browsers and
 * closes their runs.
 */
import { readFileSync } from 'node:fs'

import type { BrowserEngine } from '@shared/types'
import { BROWSER_ENGINES } from '@shared/types'

import { writeFileAtomicSync } from '../util/atomic-file'

export const LIVE_SESSIONS_FILE_NAME = 'live-sessions.json'

export interface LiveSessionRecord {
  sessionId: string
  runId: string
  engine: BrowserEngine
  /** Browser process id (Chromium family, once found); null otherwise. */
  pid: number | null
  startedAt: string
}

export interface LiveSessionsStore {
  list(): LiveSessionRecord[]
  upsert(record: LiveSessionRecord): void
  remove(sessionId: string): void
  clear(): void
}

function isRecord(value: unknown): value is LiveSessionRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.sessionId === 'string' &&
    typeof record.runId === 'string' &&
    (BROWSER_ENGINES as readonly string[]).includes(record.engine as string) &&
    (record.pid === null || (typeof record.pid === 'number' && Number.isInteger(record.pid) && record.pid > 0)) &&
    typeof record.startedAt === 'string'
  )
}

export function memoryLiveSessionsStore(initial: readonly LiveSessionRecord[] = []): LiveSessionsStore {
  let records = initial.map((record) => ({ ...record }))
  return {
    list: () => records.map((record) => ({ ...record })),
    upsert: (record) => {
      records = [...records.filter((existing) => existing.sessionId !== record.sessionId), { ...record }]
    },
    remove: (sessionId) => {
      records = records.filter((record) => record.sessionId !== sessionId)
    },
    clear: () => {
      records = []
    },
  }
}

/** File-backed store; the file is re-read on every list() and rewritten atomically on every change. */
export function fileLiveSessionsStore(filePath: string, onError?: (err: unknown) => void): LiveSessionsStore {
  const read = (): LiveSessionRecord[] => {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { sessions?: unknown }
      return Array.isArray(parsed.sessions) ? parsed.sessions.filter(isRecord) : []
    } catch {
      return []
    }
  }
  const write = (records: readonly LiveSessionRecord[]): void => {
    try {
      writeFileAtomicSync(filePath, `${JSON.stringify({ version: 1, sessions: records }, null, 2)}\n`)
    } catch (err) {
      onError?.(err)
    }
  }
  return {
    list: read,
    upsert: (record) => write([...read().filter((existing) => existing.sessionId !== record.sessionId), record]),
    remove: (sessionId) => {
      const records = read()
      const next = records.filter((record) => record.sessionId !== sessionId)
      if (next.length !== records.length) write(next)
    },
    clear: () => write([]),
  }
}

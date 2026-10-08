/**
 * Open-sessions record (live-sessions.json) and the start-up clean-up after a
 * crash: only browsers carrying the marker of a recorded session are
 * terminated, and their runs are closed as 'aborted'.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LogEntry, TestRun } from '../src/shared/types'
import type { Database, Logger } from '../src/main/contracts'
import { openDatabase } from '../src/main/database/index'
import { fileLiveSessionsStore, memoryLiveSessionsStore } from '../src/main/sessions/live-sessions-store'
import { ORPHAN_ABORT_MESSAGE, cleanupOrphanedSessions } from '../src/main/sessions/orphan-cleanup'
import type { ProcessInfo, ProcessToolkit } from '../src/main/system/processes'

const runInput = (overrides: Partial<Omit<TestRun, 'id'>> = {}): Omit<TestRun, 'id'> => ({
  profileId: null,
  profileName: 'Crashed',
  engine: 'chromium',
  devicePreset: 'windows-desktop',
  proxyPool: null,
  provider: null,
  target: null,
  targetingString: null,
  targetMatch: null,
  publicIp: null,
  country: null,
  region: null,
  city: null,
  postalCode: null,
  locationAttempts: 1,
  locationMaxAttempts: 1,
  locationWarning: null,
  proxySessionId: null,
  formUrl: 'https://forms.example.com/qa',
  startedAt: '2026-10-07T09:00:00.000Z',
  endedAt: null,
  status: 'running',
  notes: '',
  httpStatus: null,
  finalUrl: null,
  screenshotPath: null,
  leadId: null,
  certificateId: null,
  errorMessage: null,
  ...overrides,
})

function memoryLogger(): Logger & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    info: (_s, message) => void lines.push(`INFO ${message}`),
    warn: (_s, message) => void lines.push(`WARN ${message}`),
    error: (_s, message) => void lines.push(`ERROR ${message}`),
    log: () => undefined,
    onEntry: () => () => undefined,
    query: (): LogEntry[] => [],
    clear: () => undefined,
    registerSecret: () => undefined,
  }
}

const marked = (pid: number, sessionId: string, ppid = 1): ProcessInfo => ({ pid, ppid, executablePath: null, commandLine: `/opt/brave/brave --proxy-qa-session=${sessionId}`, createdAtMs: null })

let work: string
let db: Database
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'proxyqa-orphans-'))
  db = openDatabase(':memory:', { defaultScreenshotDir: path.join(work, 'shots'), env: {} })
})
afterEach(() => {
  db.close()
  rmSync(work, { recursive: true, force: true })
})

describe('live sessions record', () => {
  it('memory store: upsert replaces by session id, remove and clear', () => {
    const store = memoryLiveSessionsStore()
    store.upsert({ sessionId: 's1', runId: 'r1', engine: 'brave', pid: null, startedAt: 'a' })
    store.upsert({ sessionId: 's1', runId: 'r1', engine: 'brave', pid: 42, startedAt: 'a' })
    store.upsert({ sessionId: 's2', runId: 'r2', engine: 'firefox', pid: null, startedAt: 'b' })
    expect(store.list().map((record) => [record.sessionId, record.pid])).toEqual([
      ['s1', 42],
      ['s2', null],
    ])
    store.remove('s1')
    expect(store.list().map((record) => record.sessionId)).toEqual(['s2'])
    store.clear()
    expect(store.list()).toEqual([])
  })

  it('file store survives a restart, ignores malformed entries and reports write failures', () => {
    const file = path.join(work, 'live-sessions.json')
    const store = fileLiveSessionsStore(file)
    expect(store.list()).toEqual([])
    store.upsert({ sessionId: 's1', runId: 'r1', engine: 'chrome', pid: 4100, startedAt: '2026-10-07T09:00:00.000Z' })
    expect(fileLiveSessionsStore(file).list()).toEqual([{ sessionId: 's1', runId: 'r1', engine: 'chrome', pid: 4100, startedAt: '2026-10-07T09:00:00.000Z' }])
    writeFileSync(file, JSON.stringify({ sessions: [{ sessionId: 's1', runId: 'r1', engine: 'safari', pid: 1, startedAt: 'x' }, { sessionId: 's2', runId: 'r2', engine: 'brave', pid: -3, startedAt: 'x' }, { sessionId: 's3', runId: 'r3', engine: 'brave', pid: null, startedAt: 'x' }] }))
    expect(store.list().map((record) => record.sessionId)).toEqual(['s3'])
    writeFileSync(file, '{broken')
    expect(store.list()).toEqual([])
    store.clear()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, sessions: [] })
    const errors: unknown[] = []
    fileLiveSessionsStore(path.join(work, 'no-dir', 'x.json'), (err) => errors.push(err)).upsert({ sessionId: 'a', runId: 'b', engine: 'brave', pid: null, startedAt: 'c' })
    expect(errors).toHaveLength(1)
  })
})

describe('orphan clean-up at start-up', () => {
  it('terminates only marked browsers of recorded sessions and closes their runs as aborted', async () => {
    const crashedRun = db.testRuns.create(runInput())
    const finishedRun = db.testRuns.create(runInput({ status: 'success', endedAt: '2026-10-07T09:05:00.000Z' }))
    const store = memoryLiveSessionsStore([
      { sessionId: 'aaaa-1', runId: crashedRun.id, engine: 'brave', pid: 500, startedAt: 'x' },
      { sessionId: 'bbbb-2', runId: finishedRun.id, engine: 'chromium', pid: null, startedAt: 'x' },
      { sessionId: 'cccc-3', runId: 'missing-run', engine: 'firefox', pid: null, startedAt: 'x' },
    ])
    const toolkit: Pick<ProcessToolkit, 'listMarked' | 'killTree'> = {
      listMarked: vi.fn(async () => [
        marked(500, 'aaaa-1'),
        marked(501, 'aaaa-1', 500), // a child of the orphaned browser: killed with its tree
        marked(600, 'bbbb-2'),
        marked(700, 'zzzz-9'), // another app instance's session: never touched
      ]),
      killTree: vi.fn(async () => undefined),
    }
    const logger = memoryLogger()
    const result = await cleanupOrphanedSessions({ store, toolkit, runs: db.testRuns, logger, now: () => Date.parse('2026-10-07T10:00:00Z') })
    expect(result).toEqual({ killed: [500, 600], aborted: [crashedRun.id] })
    expect(toolkit.killTree).toHaveBeenCalledTimes(2)
    expect(db.testRuns.get(crashedRun.id)).toMatchObject({ status: 'aborted', endedAt: '2026-10-07T10:00:00.000Z', errorMessage: ORPHAN_ABORT_MESSAGE })
    expect(db.testRuns.get(finishedRun.id)).toMatchObject({ status: 'success' })
    expect(store.list()).toEqual([])
    expect(logger.lines.at(-1)).toMatch(/left 3 sessions open: terminated 2 browser processes, closed 1 run as aborted/)
  })

  it('does nothing without recorded sessions, and still closes runs when the process lookup fails', async () => {
    const toolkit = { listMarked: vi.fn(async () => [marked(1, 'x')]), killTree: vi.fn(async () => undefined) }
    expect(await cleanupOrphanedSessions({ store: memoryLiveSessionsStore(), toolkit, runs: db.testRuns, logger: memoryLogger() })).toEqual({ killed: [], aborted: [] })
    expect(toolkit.listMarked).not.toHaveBeenCalled()

    const run = db.testRuns.create(runInput())
    const store = memoryLiveSessionsStore([{ sessionId: 'dddd-4', runId: run.id, engine: 'webkit', pid: null, startedAt: 'x' }])
    const logger = memoryLogger()
    const failing = { listMarked: vi.fn(async () => Promise.reject(new Error('ps failed'))), killTree: vi.fn(async () => undefined) }
    expect(await cleanupOrphanedSessions({ store, toolkit: failing, runs: db.testRuns, logger })).toEqual({ killed: [], aborted: [run.id] })
    expect(logger.lines.some((line) => line.includes('WARN Could not look for browsers left open by the previous run: ps failed'))).toBe(true)
    expect(store.list()).toEqual([])
  })

  it('a kill that fails is logged and the clean-up continues', async () => {
    const run = db.testRuns.create(runInput())
    const store = memoryLiveSessionsStore([{ sessionId: 'eeee-5', runId: run.id, engine: 'chrome', pid: 9, startedAt: 'x' }])
    const logger = memoryLogger()
    const toolkit = { listMarked: async (): Promise<ProcessInfo[]> => [marked(9, 'eeee-5')], killTree: vi.fn(async () => Promise.reject(new Error('access denied'))) }
    expect(await cleanupOrphanedSessions({ store, toolkit, runs: db.testRuns, logger })).toEqual({ killed: [], aborted: [run.id] })
    expect(logger.lines.some((line) => line.includes('Could not terminate the orphaned browser 9: access denied'))).toBe(true)
  })
})

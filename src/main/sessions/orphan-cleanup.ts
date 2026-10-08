/**
 * Start-up clean-up after a crash: sessions still listed in live-sessions.json
 * were open when the previous run of the app died. Their browsers are found
 * by the `--proxy-qa-session=<id>` marker switch and terminated (with their
 * process trees); their runs are closed as 'aborted'. Processes without the
 * marker — or with the marker of a session this installation did not record —
 * are never touched.
 */
import type { Logger, TestRunRepository } from '../contracts'
import type { ProcessToolkit } from '../system/processes'
import { sessionIdFromCommandLine, sessionRootPids } from '../system/processes'
import type { LiveSessionsStore } from './live-sessions-store'

const SCOPE = 'browser'
export const ORPHAN_ABORT_MESSAGE = 'App was closed while this session was open'

export interface OrphanCleanupDeps {
  store: LiveSessionsStore
  toolkit: Pick<ProcessToolkit, 'listMarked' | 'killTree'>
  runs: Pick<TestRunRepository, 'get' | 'update'>
  logger: Logger
  now?: () => number
}

export interface OrphanCleanupResult {
  /** Root pids of orphaned browsers that were terminated. */
  killed: number[]
  /** Runs closed as 'aborted'. */
  aborted: string[]
}

export async function cleanupOrphanedSessions(deps: OrphanCleanupDeps): Promise<OrphanCleanupResult> {
  const records = deps.store.list()
  const result: OrphanCleanupResult = { killed: [], aborted: [] }
  if (records.length === 0) return result
  const now = deps.now ?? Date.now
  const ids = new Set(records.map((record) => record.sessionId))

  try {
    const marked = (await deps.toolkit.listMarked()).filter((proc) => {
      const id = sessionIdFromCommandLine(proc.commandLine)
      return id !== null && ids.has(id)
    })
    for (const record of records) {
      for (const pid of sessionRootPids(marked, record.sessionId)) {
        try {
          await deps.toolkit.killTree(pid)
          result.killed.push(pid)
        } catch (err) {
          deps.logger.warn(SCOPE, `Could not terminate the orphaned browser ${pid}: ${err instanceof Error ? err.message : String(err)}`, { pid, sessionId: record.sessionId })
        }
      }
    }
  } catch (err) {
    deps.logger.warn(SCOPE, `Could not look for browsers left open by the previous run: ${err instanceof Error ? err.message : String(err)}`)
  }

  const endedAt = new Date(now()).toISOString()
  for (const record of records) {
    try {
      const run = deps.runs.get(record.runId)
      if (run && run.status === 'running') {
        deps.runs.update(record.runId, { status: 'aborted', endedAt, errorMessage: ORPHAN_ABORT_MESSAGE })
        result.aborted.push(record.runId)
      }
    } catch (err) {
      deps.logger.warn(SCOPE, `Could not close the run of an orphaned session: ${err instanceof Error ? err.message : String(err)}`, { runId: record.runId })
    }
  }
  deps.store.clear()
  deps.logger.info(
    SCOPE,
    `Previous run left ${records.length} session${records.length === 1 ? '' : 's'} open: terminated ${result.killed.length} browser process${result.killed.length === 1 ? '' : 'es'}, closed ${result.aborted.length} run${result.aborted.length === 1 ? '' : 's'} as aborted`,
    { killed: result.killed, aborted: result.aborted },
  )
  return result
}

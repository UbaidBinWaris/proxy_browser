/**
 * Background task manager: a serial queue for every piece of browser install
 * work (bundled Playwright downloads, vendor browser installs, uninstalls).
 *
 * - One task runs at a time, in the order it was queued. Enqueuing the same
 *   kind + engine while such a task is queued or running returns that task.
 * - States: queued → running → verifying → done | failed; cancel() moves any
 *   unfinished task to 'cancelled'. A running task is cancelled by aborting its
 *   signal AND terminating every child process it registered, with its whole
 *   process tree (Windows: `taskkill /T /F`; installers such as winget start
 *   the vendor installer as a grandchild that a plain kill would leave behind).
 * - The executor (install-executor.ts) does the work and the verification; the
 *   manager owns ordering, state, cancellation, history and events.
 * - Finished tasks: the last `historyLimit` are kept in memory and in a compact
 *   JSON history file, so the Tasks panel still shows them after a restart.
 * - Every change is pushed to `onUpdate` listeners (the renderer's Tasks panel);
 *   progress-only changes are coalesced to one update per `progressThrottleMs`.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import type { AppError, BrowserEngine, Task, TaskKind, TaskState, TaskVerification } from '@shared/types'
import { BROWSER_ENGINES, FINISHED_TASK_STATES, TASK_KINDS, TASK_STATES, isTaskActive } from '@shared/types'

import { AppException } from '../contracts'
import type { Logger, TaskManager } from '../contracts'
import { writeFileAtomicSync } from '../util/atomic-file'

const SCOPE = 'tasks'
export const TASK_HISTORY_FILE_NAME = 'task-history.json'
export const DEFAULT_HISTORY_LIMIT = 20
export const DEFAULT_PROGRESS_THROTTLE_MS = 200
/** How long cancel() waits for a running task to wind down before answering. */
export const CANCEL_SETTLE_MS = 15_000
export const QUEUED_PHASE = 'Waiting for the tasks ahead of it'
export const CANCELLED_NOTE = 'Cancelled'

export interface TaskRunContext {
  readonly taskId: string
  readonly signal: AbortSignal
  /** Status line and percentage while running. */
  progress(phase: string, percent?: number | null): void
  /** Enter the verification step. */
  verifying(phase: string): void
  /** Register a child process; cancel() terminates its whole tree. */
  trackChild(pid: number): void
}

export interface TaskOutcome {
  note: string | null
  verification: TaskVerification | null
}

export interface TaskExecutor {
  /** "Install Google Chrome". */
  label(kind: TaskKind, engine: BrowserEngine): string
  /** Throws AppException('INVALID_INPUT', …) when the work cannot be queued at all. */
  validate(kind: TaskKind, engine: BrowserEngine): Promise<void>
  /** Do the work (and the verification). Throws an AppException on failure. */
  run(kind: TaskKind, engine: BrowserEngine, ctx: TaskRunContext): Promise<TaskOutcome>
}

export interface TaskManagerOptions {
  executor: TaskExecutor
  /** Terminate a process and its descendants. */
  killTree: (pid: number) => Promise<void>
  logger: Logger
  /** JSON history of finished tasks; null keeps history in memory only. */
  historyFile?: string | null
  historyLimit?: number
  progressThrottleMs?: number
  now?: () => number
  newId?: () => string
}

/** A failure that still carries what the verification found (shown in the Tasks panel). */
export class TaskFailure extends AppException {
  readonly verification: TaskVerification | null
  constructor(code: AppError['code'], message: string, verification: TaskVerification | null, detail?: string) {
    super(code, message, detail)
    this.name = 'TaskFailure'
    this.verification = verification
  }
}

interface Running {
  task: Task
  controller: AbortController
  children: Set<number>
  done: Promise<void>
}

function toAppError(err: unknown): AppError {
  if (err instanceof AppException) return err.toAppError()
  return { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) }
}

function isTask(value: unknown): value is Task {
  if (!value || typeof value !== 'object') return false
  const task = value as Record<string, unknown>
  return (
    typeof task.id === 'string' &&
    TASK_KINDS.includes(task.kind as TaskKind) &&
    (BROWSER_ENGINES as readonly string[]).includes(task.engine as string) &&
    TASK_STATES.includes(task.state as TaskState) &&
    FINISHED_TASK_STATES.includes(task.state as TaskState) &&
    typeof task.label === 'string' &&
    typeof task.queuedAt === 'string'
  )
}

/** Finished tasks from a history file (anything malformed is skipped). */
export function readTaskHistory(filePath: string): Task[] {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { tasks?: unknown }
    return Array.isArray(parsed.tasks) ? parsed.tasks.filter(isTask) : []
  } catch {
    return []
  }
}

/** Active tasks in queue order (running first), then finished ones, newest first. */
export function orderTasks(tasks: readonly Task[]): Task[] {
  const active = tasks.filter((task) => isTaskActive(task.state))
  const rank = (task: Task): number => (task.state === 'queued' ? 1 : 0)
  active.sort((a, b) => rank(a) - rank(b) || a.queuedAt.localeCompare(b.queuedAt))
  const finished = tasks.filter((task) => !isTaskActive(task.state)).sort((a, b) => (b.finishedAt ?? b.queuedAt).localeCompare(a.finishedAt ?? a.queuedAt))
  return [...active, ...finished]
}

export function createTaskManager(options: TaskManagerOptions): TaskManager {
  const { executor, killTree, logger } = options
  const historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT
  const throttleMs = options.progressThrottleMs ?? DEFAULT_PROGRESS_THROTTLE_MS
  const now = options.now ?? Date.now
  const newId = options.newId ?? randomUUID
  const historyFile = options.historyFile ?? null
  const iso = (): string => new Date(now()).toISOString()

  let tasks: Task[] = historyFile ? readTaskHistory(historyFile).slice(0, historyLimit) : []
  let running: Running | null = null
  let disposed = false
  const listeners = new Set<(tasks: Task[]) => void>()
  let progressTimer: ReturnType<typeof setTimeout> | null = null
  let lastEmit = 0

  const snapshot = (): Task[] => orderTasks(tasks).map((task) => ({ ...task, ...(task.verification ? { verification: { ...task.verification } } : {}) }))

  const emitNow = (): void => {
    if (progressTimer) {
      clearTimeout(progressTimer)
      progressTimer = null
    }
    lastEmit = now()
    const list = snapshot()
    for (const listener of listeners) {
      try {
        listener(list)
      } catch (err) {
        logger.warn(SCOPE, `Task listener failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  /** Progress-only changes: at most one update per throttle window (the latest state always goes out). */
  const emitProgress = (): void => {
    if (throttleMs <= 0) {
      emitNow()
      return
    }
    if (progressTimer) return
    const wait = Math.max(0, throttleMs - (now() - lastEmit))
    progressTimer = setTimeout(() => {
      progressTimer = null
      emitNow()
    }, wait)
  }

  const persist = (): void => {
    if (!historyFile) return
    const finished = orderTasks(tasks).filter((task) => !isTaskActive(task.state)).slice(0, historyLimit)
    try {
      writeFileAtomicSync(historyFile, `${JSON.stringify({ version: 1, tasks: finished }, null, 2)}\n`, { mode: 0o644 })
    } catch (err) {
      logger.warn(SCOPE, `Could not save the task history: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Keep every active task plus the newest `historyLimit` finished ones. */
  const trimHistory = (): void => {
    const ordered = orderTasks(tasks)
    const active = ordered.filter((task) => isTaskActive(task.state))
    const finished = ordered.filter((task) => !isTaskActive(task.state)).slice(0, historyLimit)
    tasks = [...active, ...finished]
  }

  const finish = (task: Task, state: Extract<TaskState, 'done' | 'failed' | 'cancelled'>, patch: Partial<Task>): void => {
    Object.assign(task, patch, { state, finishedAt: iso(), percent: state === 'done' ? 100 : task.percent })
    trimHistory()
    persist()
    const outcome = state === 'done' ? `done${task.note ? ` (${task.note})` : ''}` : state === 'failed' ? `failed: ${task.error?.message ?? 'unknown error'}` : 'cancelled'
    const log = state === 'failed' ? logger.warn.bind(logger) : logger.info.bind(logger)
    log(SCOPE, `${task.label}: ${outcome}`, { taskId: task.id, kind: task.kind, engine: task.engine, state })
  }

  const runTask = async (task: Task): Promise<void> => {
    const controller = new AbortController()
    const children = new Set<number>()
    let settle: () => void = () => undefined
    const done = new Promise<void>((resolve) => {
      settle = resolve
    })
    running = { task, controller, children, done }
    Object.assign(task, { state: 'running', startedAt: iso(), phase: 'Starting…', percent: null })
    logger.info(SCOPE, `${task.label}: started`, { taskId: task.id, kind: task.kind, engine: task.engine })
    emitNow()

    const ctx: TaskRunContext = {
      taskId: task.id,
      signal: controller.signal,
      progress: (phase, percent = null) => {
        if (controller.signal.aborted || !isTaskActive(task.state)) return
        task.phase = phase
        task.percent = percent === null ? null : Math.max(0, Math.min(100, percent))
        emitProgress()
      },
      verifying: (phase) => {
        if (controller.signal.aborted || !isTaskActive(task.state)) return
        Object.assign(task, { state: 'verifying', phase, percent: null })
        emitNow()
      },
      trackChild: (pid) => {
        children.add(pid)
      },
    }

    try {
      const outcome = await executor.run(task.kind, task.engine, ctx)
      if (controller.signal.aborted) finish(task, 'cancelled', { phase: CANCELLED_NOTE, note: CANCELLED_NOTE, error: null })
      else finish(task, 'done', { phase: outcome.note ?? 'Done', note: outcome.note, verification: outcome.verification, error: null })
    } catch (err) {
      if (controller.signal.aborted) {
        finish(task, 'cancelled', { phase: CANCELLED_NOTE, note: CANCELLED_NOTE, error: null })
      } else {
        const error = toAppError(err)
        const verification = err instanceof TaskFailure ? err.verification : null
        finish(task, 'failed', { phase: error.message, error, note: null, verification })
      }
    } finally {
      running = null
      emitNow()
      settle()
      pump()
    }
  }

  const pump = (): void => {
    if (running || disposed) return
    const next = orderTasks(tasks).find((task) => task.state === 'queued')
    if (!next) return
    void runTask(next)
  }

  const find = (taskId: string): Task => {
    const task = tasks.find((candidate) => candidate.id === taskId)
    if (!task) throw new AppException('NOT_FOUND', 'That task no longer exists.')
    return task
  }

  const copy = (task: Task): Task => ({ ...task, ...(task.verification ? { verification: { ...task.verification } } : {}) })

  const enqueue = async (kind: TaskKind, engine: BrowserEngine): Promise<Task> => {
    if (disposed) throw new AppException('INTERNAL', 'The app is shutting down.')
    const existing = tasks.find((task) => task.kind === kind && task.engine === engine && isTaskActive(task.state))
    if (existing) return copy(existing)
    await executor.validate(kind, engine)
    // Validation is async: someone may have queued the same work meanwhile.
    const raced = tasks.find((task) => task.kind === kind && task.engine === engine && isTaskActive(task.state))
    if (raced) return copy(raced)
    const task: Task = {
      id: newId(),
      kind,
      engine,
      label: executor.label(kind, engine),
      state: 'queued',
      phase: QUEUED_PHASE,
      percent: null,
      queuedAt: iso(),
      startedAt: null,
      finishedAt: null,
      error: null,
      note: null,
      verification: null,
    }
    tasks.push(task)
    logger.info(SCOPE, `${task.label}: queued`, { taskId: task.id, kind, engine })
    emitNow()
    pump()
    return copy(task)
  }

  const cancelRunning = async (current: Running): Promise<void> => {
    current.controller.abort()
    current.task.phase = 'Cancelling…'
    emitNow()
    for (const pid of current.children) {
      try {
        await killTree(pid)
        logger.info(SCOPE, `${current.task.label}: terminated installer process tree ${pid}`, { taskId: current.task.id, pid })
      } catch (err) {
        logger.warn(SCOPE, `${current.task.label}: could not terminate process ${pid}: ${err instanceof Error ? err.message : String(err)}`, { taskId: current.task.id, pid })
      }
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CANCEL_SETTLE_MS)
      void current.done.then(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  return {
    enqueue,

    async cancel(taskId) {
      const task = find(taskId)
      if (!isTaskActive(task.state)) throw new AppException('INVALID_INPUT', 'This task has already finished.')
      if (task.state === 'queued') {
        finish(task, 'cancelled', { phase: CANCELLED_NOTE, note: CANCELLED_NOTE })
        emitNow()
        return copy(task)
      }
      if (running?.task === task) await cancelRunning(running)
      return copy(task)
    },

    async retry(taskId) {
      const task = find(taskId)
      if (isTaskActive(task.state)) throw new AppException('INVALID_INPUT', 'This task is still running.')
      return enqueue(task.kind, task.engine)
    },

    clearFinished() {
      tasks = tasks.filter((task) => isTaskActive(task.state))
      persist()
      emitNow()
      return snapshot()
    },

    list: snapshot,

    isEngineBusy: (engine) => tasks.some((task) => task.engine === engine && isTaskActive(task.state)),

    isEngineInstalling: (engine) => running?.task.engine === engine && running.task.state === 'running',

    onUpdate(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async dispose() {
      disposed = true
      for (const task of tasks.filter((candidate) => candidate.state === 'queued')) finish(task, 'cancelled', { phase: CANCELLED_NOTE, note: CANCELLED_NOTE })
      if (running) await cancelRunning(running)
      if (progressTimer) clearTimeout(progressTimer)
      progressTimer = null
    },
  }
}

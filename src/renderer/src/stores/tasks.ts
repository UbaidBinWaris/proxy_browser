import { create } from 'zustand'
import type { AppError, BrowserEngine, BrowserInstallProgress, BrowserInstallTarget, InstallPhase, Task, TaskKind } from '@shared/types'
import { BROWSER_ENGINE_LABELS, isTaskActive } from '@shared/types'
import { getApi, toAppError, unwrap } from '../lib/api'
import type { LoadStatus } from '../lib/result'

/**
 * Background tasks (browser installs / uninstalls) mirrored from the main process. The main process is
 * the single source of truth: every change arrives as the full list on event:tasks-update.
 */
interface TasksState {
  tasks: Task[]
  status: LoadStatus
  error: AppError | null
  /** Per-task in-flight Cancel / Retry clicks. */
  busy: Record<string, 'cancel' | 'retry' | undefined>
  load: () => Promise<void>
  apply: (tasks: Task[]) => void
  /** Queue a bundled Playwright engine, or every missing one for 'all'. */
  installBundled: (target: BrowserInstallTarget) => Promise<Task[]>
  /** Queue a vendor browser install (winget / vendor package / Playwright vendor installer). */
  installVendor: (engine: BrowserEngine) => Promise<Task>
  installAllMissing: () => Promise<Task[]>
  uninstall: (engine: BrowserEngine) => Promise<Task>
  cancel: (taskId: string) => Promise<Task>
  retry: (taskId: string) => Promise<Task>
  clearFinished: () => Promise<void>
}

/** Merge tasks returned by an enqueue call (events may be later or earlier than the response). */
function mergeTasks(current: readonly Task[], incoming: readonly Task[]): Task[] {
  const byId = new Map(current.map((task) => [task.id, task]))
  for (const task of incoming) if (!byId.has(task.id)) byId.set(task.id, task)
  return [...byId.values()]
}

export const useTasksStore = create<TasksState>((set) => {
  const withBusy = async <T>(taskId: string, kind: 'cancel' | 'retry', run: () => Promise<T>): Promise<T> => {
    set((state) => ({ busy: { ...state.busy, [taskId]: kind } }))
    try {
      return await run()
    } finally {
      set((state) => ({ busy: { ...state.busy, [taskId]: undefined } }))
    }
  }
  const remember = (incoming: readonly Task[]): void => set((state) => ({ tasks: mergeTasks(state.tasks, incoming) }))

  return {
    tasks: [],
    status: 'idle',
    error: null,
    busy: {},

    load: async () => {
      set((state) => ({ status: state.tasks.length > 0 ? state.status : 'loading', error: null }))
      try {
        const tasks = await unwrap(getApi().tasks.list())
        set({ tasks, status: 'ready' })
      } catch (err) {
        set({ status: 'error', error: toAppError(err) })
      }
    },

    apply: (tasks) => set({ tasks, status: 'ready' }),

    installBundled: async (target) => {
      const queued = await unwrap(getApi().browsers.install(target))
      remember(queued)
      return queued
    },
    installVendor: async (engine) => {
      const task = await unwrap(getApi().browsers.installEngine(engine))
      remember([task])
      return task
    },
    installAllMissing: async () => {
      const queued = await unwrap(getApi().browsers.installAllMissing())
      remember(queued)
      return queued
    },
    uninstall: async (engine) => {
      const task = await unwrap(getApi().browsers.uninstallEngine(engine))
      remember([task])
      return task
    },
    cancel: (taskId) => withBusy(taskId, 'cancel', async () => unwrap(getApi().tasks.cancel(taskId))),
    retry: (taskId) =>
      withBusy(taskId, 'retry', async () => {
        const task = await unwrap(getApi().tasks.retry(taskId))
        remember([task])
        return task
      }),
    clearFinished: async () => {
      const tasks = await unwrap(getApi().tasks.clearFinished())
      set({ tasks })
    },
  }
})

// ---------------------------------------------------------------------------
// Pure selectors (unit-tested)
// ---------------------------------------------------------------------------

/** Running/verifying first, then queued in queue order. */
export function selectActiveTasks(tasks: readonly Task[]): Task[] {
  const rank = (task: Task): number => (task.state === 'queued' ? 1 : 0)
  return tasks.filter((task) => isTaskActive(task.state)).sort((a, b) => rank(a) - rank(b) || a.queuedAt.localeCompare(b.queuedAt))
}

/** Finished tasks, newest first. */
export function selectFinishedTasks(tasks: readonly Task[]): Task[] {
  return tasks.filter((task) => !isTaskActive(task.state)).sort((a, b) => (b.finishedAt ?? b.queuedAt).localeCompare(a.finishedAt ?? a.queuedAt))
}

/** The task that describes an engine right now: its active one, else its most recent finished one. */
export function selectEngineTask(tasks: readonly Task[], engine: BrowserEngine, kinds?: readonly TaskKind[]): Task | null {
  const relevant = tasks.filter((task) => task.engine === engine && (!kinds || kinds.includes(task.kind)))
  return selectActiveTasks(relevant)[0] ?? selectFinishedTasks(relevant)[0] ?? null
}

/** 1-based position among queued tasks ("Queued (2nd)"); 0 when the task is not queued. */
export function queuePosition(tasks: readonly Task[], task: Task): number {
  if (task.state !== 'queued') return 0
  return selectActiveTasks(tasks).filter((candidate) => candidate.state === 'queued').findIndex((candidate) => candidate.id === task.id) + 1
}

export function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}

/** One short status for rows and badges: "Queued (2nd)", "Downloading … · 42%", "Verifying…", "Verified ✓", "Failed". */
export function taskStatusLabel(tasks: readonly Task[], task: Task): string {
  switch (task.state) {
    case 'queued':
      return `Queued (${ordinal(Math.max(1, queuePosition(tasks, task)))})`
    case 'running':
      return task.kind === 'uninstall' ? 'Uninstalling…' : `Installing${task.percent !== null ? ` · ${Math.round(task.percent)}%` : '…'}`
    case 'verifying':
      return 'Verifying…'
    case 'done':
      return task.kind === 'uninstall' ? 'Uninstalled' : 'Verified ✓'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
  }
}

/** True while a queued/running/verifying task targets the engine (launches are refused). */
export function isEngineBusy(tasks: readonly Task[], engine: BrowserEngine): boolean {
  return tasks.some((task) => task.engine === engine && isTaskActive(task.state))
}

/** Same wording as the main process's ENGINE_BUSY refusal, or null when the engine can be launched. */
export function engineBusyReason(tasks: readonly Task[], engine: BrowserEngine): string | null {
  const task = selectActiveTasks(tasks).find((candidate) => candidate.engine === engine)
  if (!task) return null
  const name = BROWSER_ENGINE_LABELS[engine].replace(/\s*\([^)]*\)\s*$/, '').trim()
  return task.kind === 'uninstall' ? `${name} is being uninstalled — choose another browser.` : `${name} is being installed — launch will be available when the install finishes.`
}

export type TasksIndicatorKind = 'idle' | 'active' | 'done' | 'failed'

export interface TasksIndicator {
  kind: TasksIndicatorKind
  activeCount: number
  failedCount: number
}

/** Sidebar indicator: spinner + count while anything runs, red dot when something failed, check when all done. */
export function selectTasksIndicator(tasks: readonly Task[]): TasksIndicator {
  const activeCount = tasks.filter((task) => isTaskActive(task.state)).length
  const failedCount = tasks.filter((task) => task.state === 'failed').length
  const kind: TasksIndicatorKind = activeCount > 0 ? 'active' : failedCount > 0 ? 'failed' : tasks.length > 0 ? 'done' : 'idle'
  return { kind, activeCount, failedCount }
}

export interface TaskTransition {
  task: Task
  outcome: 'done' | 'failed'
}

/** Tasks that finished (done/failed) between two lists — for one toast each. Cancellations are not toasted. */
export function taskTransitions(previous: readonly Task[], next: readonly Task[]): TaskTransition[] {
  const before = new Map(previous.map((task) => [task.id, task.state]))
  const result: TaskTransition[] = []
  for (const task of next) {
    const was = before.get(task.id)
    if (was === undefined || !isTaskActive(was)) continue
    if (task.state === 'done' || task.state === 'failed') result.push({ task, outcome: task.state })
  }
  return result
}

const STATE_PHASE: Record<Task['state'], InstallPhase> = {
  queued: 'starting',
  running: 'downloading',
  verifying: 'verifying',
  done: 'done',
  failed: 'error',
  cancelled: 'error',
}

/** A task as the progress-bar model (`InstallProgressBar`). */
export function taskProgress(task: Task): BrowserInstallProgress {
  return {
    engine: task.engine,
    phase: STATE_PHASE[task.state],
    message: task.state === 'failed' ? (task.error?.message ?? task.phase) : task.phase,
    percent: task.state === 'done' ? 100 : task.state === 'running' ? task.percent : null,
  }
}

/** "42 s", "3 m 05 s" — time since the task started (or how long it took once finished). */
export function elapsedLabel(task: Task, nowMs: number): string {
  if (!task.startedAt) return '—'
  const start = Date.parse(task.startedAt)
  const end = task.finishedAt ? Date.parse(task.finishedAt) : nowMs
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} m ${String(seconds % 60).padStart(2, '0')} s`
}

/**
 * Renderer side of the background tasks: the store (bridge calls, merging
 * enqueue responses with pushed lists) and the pure selectors behind the
 * sidebar indicator, the Tasks panel, Settings rows and the launch guards.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProxyQaApi } from '../src/shared/ipc'
import type { Task } from '../src/shared/types'
import { fail, ok } from '../src/shared/types'
import {
  elapsedLabel,
  engineBusyReason,
  isEngineBusy,
  ordinal,
  queuePosition,
  selectActiveTasks,
  selectEngineTask,
  selectFinishedTasks,
  selectTasksIndicator,
  taskProgress,
  taskStatusLabel,
  taskTransitions,
  useTasksStore,
} from '../src/renderer/src/stores/tasks'

const bridgeHolder = globalThis as unknown as { api?: ProxyQaApi }

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    kind: 'install-vendor',
    engine: 'chrome',
    label: 'Install Google Chrome',
    state: 'queued',
    phase: 'Waiting for the tasks ahead of it',
    percent: null,
    queuedAt: `2026-10-07T10:00:0${id.length % 10}.000Z`,
    startedAt: null,
    finishedAt: null,
    error: null,
    note: null,
    verification: null,
    ...overrides,
  }
}

afterEach(() => {
  delete bridgeHolder.api
  useTasksStore.setState({ tasks: [], status: 'idle', error: null, busy: {} })
})

describe('task selectors', () => {
  const running = task('r', { engine: 'brave', state: 'running', percent: 42, phase: 'Downloading brave.zip · 40 of 95 MB', queuedAt: '2026-10-07T10:00:00.000Z', startedAt: '2026-10-07T10:00:01.000Z' })
  const first = task('q1', { engine: 'opera', queuedAt: '2026-10-07T10:00:02.000Z' })
  const second = task('q2', { engine: 'chrome', queuedAt: '2026-10-07T10:00:03.000Z' })
  const done = task('d', { engine: 'firefox', kind: 'install-bundled', state: 'done', note: 'Verified · 142.0', queuedAt: '2026-10-07T09:00:00.000Z', finishedAt: '2026-10-07T09:05:00.000Z' })
  const failed = task('f', { engine: 'vivaldi', state: 'failed', error: { code: 'BROWSER_LAUNCH_FAILED', message: 'Vivaldi installed but does not support automation; choose another engine.' }, finishedAt: '2026-10-07T09:10:00.000Z' })
  const all = [second, done, failed, first, running]

  it('orders active and finished tasks and finds the task describing an engine', () => {
    expect(selectActiveTasks(all).map((t) => t.id)).toEqual(['r', 'q1', 'q2'])
    expect(selectFinishedTasks(all).map((t) => t.id)).toEqual(['f', 'd'])
    expect(selectEngineTask(all, 'brave')?.id).toBe('r')
    expect(selectEngineTask(all, 'firefox')?.id).toBe('d')
    expect(selectEngineTask(all, 'firefox', ['uninstall'])).toBeNull()
    expect(selectEngineTask(all, 'webkit')).toBeNull()
    const newer = task('n', { engine: 'firefox', kind: 'install-bundled', state: 'failed', finishedAt: '2026-10-07T11:00:00.000Z' })
    expect(selectEngineTask([...all, newer], 'firefox')?.id).toBe('n')
  })

  it('labels rows: Queued (2nd), progress, verifying, verified, failed', () => {
    expect(queuePosition(all, first)).toBe(1)
    expect(queuePosition(all, second)).toBe(2)
    expect(queuePosition(all, running)).toBe(0)
    expect(taskStatusLabel(all, second)).toBe('Queued (2nd)')
    expect(taskStatusLabel(all, running)).toBe('Installing · 42%')
    expect(taskStatusLabel(all, { ...running, percent: null })).toBe('Installing…')
    expect(taskStatusLabel(all, { ...running, kind: 'uninstall' })).toBe('Uninstalling…')
    expect(taskStatusLabel(all, { ...running, state: 'verifying' })).toBe('Verifying…')
    expect(taskStatusLabel(all, done)).toBe('Verified ✓')
    expect(taskStatusLabel(all, { ...done, kind: 'uninstall' })).toBe('Uninstalled')
    expect(taskStatusLabel(all, failed)).toBe('Failed')
    expect(taskStatusLabel(all, { ...failed, state: 'cancelled' })).toBe('Cancelled')
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 102, 111].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '102nd', '111th'])
  })

  it('maps tasks to the progress bar model and elapsed time', () => {
    expect(taskProgress(running)).toEqual({ engine: 'brave', phase: 'downloading', message: 'Downloading brave.zip · 40 of 95 MB', percent: 42 })
    expect(taskProgress({ ...running, state: 'verifying' })).toMatchObject({ phase: 'verifying', percent: null })
    expect(taskProgress(done)).toMatchObject({ phase: 'done', percent: 100 })
    expect(taskProgress(failed)).toMatchObject({ phase: 'error', message: 'Vivaldi installed but does not support automation; choose another engine.' })
    expect(elapsedLabel(first, Date.now())).toBe('—')
    expect(elapsedLabel(running, Date.parse('2026-10-07T10:00:43.000Z'))).toBe('42 s')
    expect(elapsedLabel(running, Date.parse('2026-10-07T10:03:06.000Z'))).toBe('3 m 05 s')
    expect(elapsedLabel({ ...done, startedAt: '2026-10-07T09:00:00.000Z' }, 0)).toBe('5 m 00 s')
  })

  it('drives the sidebar indicator: spinner + count, red dot on failure, check when done', () => {
    expect(selectTasksIndicator([])).toEqual({ kind: 'idle', activeCount: 0, failedCount: 0 })
    expect(selectTasksIndicator(all)).toEqual({ kind: 'active', activeCount: 3, failedCount: 1 })
    expect(selectTasksIndicator([done, failed])).toEqual({ kind: 'failed', activeCount: 0, failedCount: 1 })
    expect(selectTasksIndicator([done])).toEqual({ kind: 'done', activeCount: 0, failedCount: 0 })
  })

  it('blocks launches of busy engines with the main process wording', () => {
    expect(isEngineBusy(all, 'opera')).toBe(true)
    expect(isEngineBusy(all, 'firefox')).toBe(false)
    expect(engineBusyReason(all, 'chrome')).toBe('Google Chrome is being installed — launch will be available when the install finishes.')
    expect(engineBusyReason([task('u', { kind: 'uninstall', engine: 'brave', state: 'running' })], 'brave')).toBe('Brave is being uninstalled — choose another browser.')
    expect(engineBusyReason(all, 'vivaldi')).toBeNull()
  })

  it('reports which tasks just finished (for one toast each), ignoring cancellations and old news', () => {
    const before = [running, first]
    const after = [{ ...running, state: 'done' as const }, { ...first, state: 'cancelled' as const }]
    expect(taskTransitions(before, after).map((t) => [t.task.id, t.outcome])).toEqual([['r', 'done']])
    expect(taskTransitions(after, after)).toEqual([])
    expect(taskTransitions([], [failed])).toEqual([])
    expect(taskTransitions([{ ...failed, state: 'verifying' }], [failed]).map((t) => t.outcome)).toEqual(['failed'])
  })
})

describe('tasks store', () => {
  it('loads, applies pushed lists and merges enqueue responses without duplicates', async () => {
    const queued = task('t1')
    const api = {
      tasks: {
        list: vi.fn(async () => ok([queued])),
        cancel: vi.fn(async () => ok({ ...queued, state: 'cancelled' as const })),
        retry: vi.fn(async () => ok(task('t2'))),
        clearFinished: vi.fn(async () => ok([])),
      },
      browsers: {
        install: vi.fn(async () => ok([task('b1', { kind: 'install-bundled', engine: 'firefox' })])),
        installEngine: vi.fn(async () => ok(queued)),
        installAllMissing: vi.fn(async () => ok([task('v1', { engine: 'brave' })])),
        uninstallEngine: vi.fn(async () => ok(task('u1', { kind: 'uninstall', engine: 'brave' }))),
      },
    }
    bridgeHolder.api = api as unknown as ProxyQaApi
    const store = useTasksStore.getState()
    await store.load()
    expect(useTasksStore.getState()).toMatchObject({ status: 'ready', tasks: [queued] })
    await store.installVendor('chrome')
    expect(useTasksStore.getState().tasks).toHaveLength(1)
    await store.installBundled('all')
    await store.installAllMissing()
    await store.uninstall('brave')
    expect(api.browsers.install).toHaveBeenCalledWith('all')
    expect(useTasksStore.getState().tasks.map((t) => t.id)).toEqual(['t1', 'b1', 'v1', 'u1'])

    useTasksStore.getState().apply([{ ...queued, state: 'running' }])
    expect(useTasksStore.getState().tasks).toEqual([{ ...queued, state: 'running' }])

    const pending = store.cancel('t1')
    expect(useTasksStore.getState().busy.t1).toBe('cancel')
    await expect(pending).resolves.toMatchObject({ state: 'cancelled' })
    expect(useTasksStore.getState().busy.t1).toBeUndefined()
    await expect(store.retry('t1')).resolves.toMatchObject({ id: 't2' })
    expect(useTasksStore.getState().tasks.map((t) => t.id)).toEqual(['t1', 't2'])
    await store.clearFinished()
    expect(useTasksStore.getState().tasks).toEqual([])
  })

  it('surfaces failures: load errors land in state, refusals reject', async () => {
    bridgeHolder.api = {
      tasks: { list: vi.fn(async () => fail({ code: 'INTERNAL', message: 'boom' })) },
      browsers: { installEngine: vi.fn(async () => fail({ code: 'INVALID_INPUT', message: 'Opera cannot be installed automatically on this machine.' })) },
    } as unknown as ProxyQaApi
    await useTasksStore.getState().load()
    expect(useTasksStore.getState()).toMatchObject({ status: 'error', error: { code: 'INTERNAL', message: 'boom' } })
    await expect(useTasksStore.getState().installVendor('opera')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

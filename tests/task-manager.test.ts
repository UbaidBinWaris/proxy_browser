/**
 * Background task manager (serial queue, dedupe, cancel with process-tree
 * kill, failures, retry, history, events) and the install executor's
 * "check and balance": verification pass/fail, the Vivaldi message, the
 * Windows post-install sweep, validation and the ENGINE_BUSY wording.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BrowserEngine, BrowserEngineInfo, BrowserInstallProgress, BrowsersStatus, LogEntry, Task, TaskKind } from '../src/shared/types'
import { BROWSER_ENGINES, BROWSER_ENGINE_FAMILY, BROWSER_ENGINE_KIND, BROWSER_ENGINE_LABELS } from '../src/shared/types'
import { AppException } from '../src/main/contracts'
import type { BrowserProvisioner, InstallRunOptions, Logger } from '../src/main/contracts'
import { VERIFICATION_FAILED_PREFIX, VIVALDI_AUTOMATION_MESSAGE, createInstallExecutor, engineBusyMessage, taskLabel, verifiedNote, verifyEngine } from '../src/main/tasks/install-executor'
import type { VerificationResult } from '../src/main/tasks/install-executor'
import { smokeLaunchOptions } from '../src/main/tasks/smoke-launch'
import type { SmokeLauncher } from '../src/main/tasks/smoke-launch'
import { CANCELLED_NOTE, QUEUED_PHASE, TaskFailure, createTaskManager, orderTasks, readTaskHistory } from '../src/main/tasks/task-manager'
import type { TaskExecutor, TaskRunContext } from '../src/main/tasks/task-manager'

function silentLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    log: () => undefined,
    onEntry: () => () => undefined,
    query: (): LogEntry[] => [],
    clear: () => undefined,
    registerSecret: () => undefined,
  }
}

interface Deferred {
  promise: Promise<void>
  resolve: () => void
  reject: (err: Error) => void
}
function deferred(): Deferred {
  let resolve: () => void = () => undefined
  let reject: (err: Error) => void = () => undefined
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** An executor whose runs wait for the test to finish them. */
function scriptedExecutor(): TaskExecutor & { started: string[]; gates: Map<string, Deferred>; contexts: Map<string, TaskRunContext>; validate: ReturnType<typeof vi.fn> } {
  const started: string[] = []
  const gates = new Map<string, Deferred>()
  const contexts = new Map<string, TaskRunContext>()
  const validate = vi.fn(async (kind: TaskKind, engine: BrowserEngine) => {
    if (engine === 'opera' && kind === 'install-vendor') throw new AppException('INVALID_INPUT', 'Opera cannot be installed automatically on this machine.')
  })
  return {
    started,
    gates,
    contexts,
    validate,
    label: taskLabel,
    async run(kind, engine, ctx) {
      const key = `${kind}:${engine}`
      started.push(key)
      contexts.set(key, ctx)
      const gate = deferred()
      gates.set(key, gate)
      ctx.signal.addEventListener('abort', () => gate.reject(new Error('aborted')), { once: true })
      ctx.progress(`Downloading ${engine}`, 40)
      await gate.promise
      ctx.verifying('Verifying…')
      return { note: `Verified · ${engine}`, verification: { exists: true, version: '1.0', executablePath: null, smoke: 'passed', smokeDetail: null, pathSaved: true } }
    },
  }
}

async function until(predicate: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

let work: string
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'proxyqa-tasks-'))
})
afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

describe('task manager', () => {
  it('runs tasks one at a time in queue order and dedupes identical work', async () => {
    const executor = scriptedExecutor()
    const updates: Task[][] = []
    const manager = createTaskManager({ executor, killTree: async () => undefined, logger: silentLogger(), progressThrottleMs: 0 })
    manager.onUpdate((tasks) => updates.push(tasks))
    const brave = await manager.enqueue('install-vendor', 'brave')
    const opera = await manager.enqueue('install-vendor', 'opera-gx')
    const firefox = await manager.enqueue('install-bundled', 'firefox')
    expect(await manager.enqueue('install-vendor', 'brave')).toMatchObject({ id: brave.id })
    // Nothing else was queued: the first task starts at once; the next ones wait.
    expect(brave).toMatchObject({ label: 'Install Brave', state: 'running' })
    expect(opera).toMatchObject({ state: 'queued', phase: QUEUED_PHASE })
    await until(() => executor.started.length === 1, 'first task')
    expect(executor.started).toEqual(['install-vendor:brave'])
    expect(manager.list().map((task) => [task.engine, task.state])).toEqual([
      ['brave', 'running'],
      ['opera-gx', 'queued'],
      ['firefox', 'queued'],
    ])
    expect(manager.list()[0]).toMatchObject({ phase: 'Downloading brave', percent: 40 })
    expect(manager.isEngineBusy('opera-gx')).toBe(true)
    expect(manager.isEngineInstalling('brave')).toBe(true)
    expect(manager.isEngineInstalling('opera-gx')).toBe(false)
    expect(manager.isEngineBusy('chrome')).toBe(false)

    executor.gates.get('install-vendor:brave')?.resolve()
    await until(() => executor.started.length === 2, 'second task')
    expect(manager.list().find((task) => task.id === brave.id)).toMatchObject({ state: 'done', note: 'Verified · brave', percent: 100, verification: { smoke: 'passed' } })
    // Verification is not "installing": detection may read the version again.
    expect(manager.isEngineInstalling('brave')).toBe(false)
    executor.gates.get('install-vendor:opera-gx')?.resolve()
    await until(() => executor.started.length === 3, 'third task')
    executor.gates.get('install-bundled:firefox')?.resolve()
    await until(() => manager.list().every((task) => task.state === 'done'), 'all done')
    expect(executor.started).toEqual(['install-vendor:brave', 'install-vendor:opera-gx', 'install-bundled:firefox'])
    expect(manager.list().find((task) => task.id === opera.id)?.state).toBe('done')
    expect(manager.list().find((task) => task.id === firefox.id)?.state).toBe('done')
    // Every state change reached the listeners (queued, running, verifying, done …).
    expect(updates.some((tasks) => tasks.some((task) => task.state === 'verifying'))).toBe(true)
    expect(updates.at(-1)?.every((task) => task.state === 'done')).toBe(true)
  })

  it('refuses invalid work at enqueue time', async () => {
    const executor = scriptedExecutor()
    const manager = createTaskManager({ executor, killTree: async () => undefined, logger: silentLogger(), progressThrottleMs: 0 })
    await expect(manager.enqueue('install-vendor', 'opera')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(manager.list()).toEqual([])
  })

  it('cancels a queued task without running it, and a running one by killing its process tree', async () => {
    const executor = scriptedExecutor()
    const killed: number[] = []
    const manager = createTaskManager({ executor, killTree: async (pid) => void killed.push(pid), logger: silentLogger(), progressThrottleMs: 0 })
    const chrome = await manager.enqueue('install-vendor', 'chrome')
    const edge = await manager.enqueue('install-vendor', 'msedge')
    await until(() => executor.started.length === 1, 'chrome running')
    expect(await manager.cancel(edge.id)).toMatchObject({ state: 'cancelled', note: CANCELLED_NOTE })
    executor.contexts.get('install-vendor:chrome')?.trackChild(4321)
    executor.contexts.get('install-vendor:chrome')?.trackChild(4322)
    const result = await manager.cancel(chrome.id)
    expect(result).toMatchObject({ state: 'cancelled', error: null })
    expect(killed).toEqual([4321, 4322])
    expect(executor.started).toEqual(['install-vendor:chrome'])
    expect(manager.isEngineBusy('chrome')).toBe(false)
    await expect(manager.cancel(chrome.id)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(manager.cancel('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' })

    // Retry queues the same work again as a new task.
    const again = await manager.retry(edge.id)
    expect(again).toMatchObject({ kind: 'install-vendor', engine: 'msedge' })
    expect(again.id).not.toBe(edge.id)
    await until(() => executor.started.length === 2, 'retry running')
    await expect(manager.retry(again.id)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    executor.gates.get('install-vendor:msedge')?.resolve()
    await until(() => manager.list().find((task) => task.id === again.id)?.state === 'done', 'retry done')
  })

  it('records failures with their AppError and verification, keeps going, and clears finished tasks', async () => {
    const executor: TaskExecutor = {
      label: taskLabel,
      validate: async () => undefined,
      run: async (_kind, engine) => {
        if (engine === 'vivaldi') {
          throw new TaskFailure('BROWSER_LAUNCH_FAILED', VIVALDI_AUTOMATION_MESSAGE, { exists: true, version: '8.2', executablePath: '/v', smoke: 'failed', smokeDetail: 'timeout', pathSaved: true })
        }
        if (engine === 'brave') throw new Error('disk full')
        return { note: 'ok', verification: null }
      },
    }
    const manager = createTaskManager({ executor, killTree: async () => undefined, logger: silentLogger(), progressThrottleMs: 0 })
    const vivaldi = await manager.enqueue('install-vendor', 'vivaldi')
    const brave = await manager.enqueue('install-vendor', 'brave')
    const chrome = await manager.enqueue('install-vendor', 'chrome')
    await until(() => manager.list().every((task) => task.state !== 'queued' && task.state !== 'running'), 'all finished')
    const byId = new Map(manager.list().map((task) => [task.id, task]))
    expect(byId.get(vivaldi.id)).toMatchObject({ state: 'failed', error: { code: 'BROWSER_LAUNCH_FAILED', message: VIVALDI_AUTOMATION_MESSAGE }, verification: { smoke: 'failed' } })
    expect(byId.get(brave.id)).toMatchObject({ state: 'failed', error: { code: 'INTERNAL', message: 'disk full' } })
    expect(byId.get(chrome.id)).toMatchObject({ state: 'done', note: 'ok' })
    expect(manager.clearFinished()).toEqual([])
    expect(manager.list()).toEqual([])
  })

  it('keeps the newest finished tasks in a history file and reads them back', async () => {
    const file = path.join(work, 'task-history.json')
    let clock = Date.parse('2026-10-07T10:00:00Z')
    const executor: TaskExecutor = { label: taskLabel, validate: async () => undefined, run: async () => ({ note: 'ok', verification: null }) }
    const manager = createTaskManager({ executor, killTree: async () => undefined, logger: silentLogger(), historyFile: file, historyLimit: 2, progressThrottleMs: 0, now: () => (clock += 1_000) })
    for (const engine of ['chrome', 'msedge', 'brave'] as const) {
      await manager.enqueue('install-vendor', engine)
      await until(() => manager.list().every((task) => task.state === 'done'), engine)
    }
    expect(manager.list().map((task) => task.engine)).toEqual(['brave', 'msedge'])
    const saved = readTaskHistory(file)
    expect(saved.map((task) => task.engine)).toEqual(['brave', 'msedge'])
    const reloaded = createTaskManager({ executor, killTree: async () => undefined, logger: silentLogger(), historyFile: file })
    expect(reloaded.list().map((task) => [task.engine, task.state])).toEqual([
      ['brave', 'done'],
      ['msedge', 'done'],
    ])
    writeFileSync(file, JSON.stringify({ tasks: [{ id: 'x', kind: 'install-vendor', engine: 'chrome', state: 'running', label: 'x', queuedAt: 'y' }, { nope: true }] }))
    expect(readTaskHistory(file)).toEqual([])
    writeFileSync(file, 'garbage')
    expect(readTaskHistory(file)).toEqual([])
  })

  it('coalesces progress-only updates but always publishes state changes', async () => {
    vi.useFakeTimers()
    try {
      const executor = scriptedExecutor()
      const updates: Task[][] = []
      const manager = createTaskManager({ executor, killTree: async () => undefined, logger: silentLogger(), progressThrottleMs: 200 })
      manager.onUpdate((tasks) => updates.push(tasks))
      await manager.enqueue('install-bundled', 'webkit')
      await vi.advanceTimersByTimeAsync(0)
      const ctx = executor.contexts.get('install-bundled:webkit')
      const before = updates.length
      for (let percent = 1; percent <= 50; percent += 1) ctx?.progress('Downloading', percent)
      expect(updates.length).toBe(before)
      await vi.advanceTimersByTimeAsync(250)
      expect(updates.length).toBe(before + 1)
      expect(updates.at(-1)?.[0]?.percent).toBe(50)
      ctx?.verifying('Verifying…')
      expect(updates.at(-1)?.[0]?.state).toBe('verifying')
      await manager.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose cancels queued and running work', async () => {
    const executor = scriptedExecutor()
    const manager = createTaskManager({ executor, killTree: async () => undefined, logger: silentLogger(), progressThrottleMs: 0 })
    await manager.enqueue('install-vendor', 'chrome')
    await manager.enqueue('install-vendor', 'brave')
    await until(() => executor.started.length === 1, 'running')
    await manager.dispose()
    expect(manager.list().map((task) => task.state)).toEqual(['cancelled', 'cancelled'])
    await expect(manager.enqueue('install-vendor', 'msedge')).rejects.toMatchObject({ code: 'INTERNAL' })
  })

  it('orders active tasks (running first, then queue order) before finished ones (newest first)', () => {
    const base = { kind: 'install-vendor' as const, label: 'x', phase: '', percent: null, startedAt: null, error: null, note: null, verification: null }
    const tasks: Task[] = [
      { ...base, id: 'f1', engine: 'chrome', state: 'done', queuedAt: '1', finishedAt: '5' },
      { ...base, id: 'q2', engine: 'brave', state: 'queued', queuedAt: '3', finishedAt: null },
      { ...base, id: 'r', engine: 'opera', state: 'verifying', queuedAt: '2', finishedAt: null },
      { ...base, id: 'q1', engine: 'vivaldi', state: 'queued', queuedAt: '1', finishedAt: null },
      { ...base, id: 'f2', engine: 'msedge', state: 'failed', queuedAt: '1', finishedAt: '9' },
    ]
    expect(orderTasks(tasks).map((task) => task.id)).toEqual(['r', 'q1', 'q2', 'f2', 'f1'])
  })
})

// ---------------------------------------------------------------------------
// Install executor
// ---------------------------------------------------------------------------

function engineInfo(engine: BrowserEngine, overrides: Partial<BrowserEngineInfo> = {}): BrowserEngineInfo {
  const kind = BROWSER_ENGINE_KIND[engine]
  return {
    id: engine,
    label: BROWSER_ENGINE_LABELS[engine],
    family: BROWSER_ENGINE_FAMILY[engine],
    kind,
    available: true,
    executablePath: kind === 'bundled' ? null : `/opt/${engine}/${engine}`,
    version: '141.0.1.2',
    source: kind === 'bundled' ? 'bundled' : 'auto-saved',
    note: 'ok',
    installMethod: kind === 'bundled' ? 'bundled' : 'vendor-package',
    installNote: '',
    downloadUrl: null,
    managedInstall: kind === 'installed',
    ...overrides,
  }
}

interface FakeProvisioner {
  provisioner: BrowserProvisioner
  calls: string[]
  infos: Map<BrowserEngine, BrowserEngineInfo>
}

function fakeProvisioner(platformInfo: Partial<Record<BrowserEngine, Partial<BrowserEngineInfo>>> = {}): FakeProvisioner {
  const calls: string[] = []
  const infos = new Map<BrowserEngine, BrowserEngineInfo>(BROWSER_ENGINES.map((engine) => [engine, engineInfo(engine, platformInfo[engine])]))
  const status = async (): Promise<BrowsersStatus> => ({ browsersPath: '/b', chromium: true, firefox: true, webkit: true, playwrightVersion: '1.63.0', source: 'provisioned', installable: true, engines: [...infos.values()] })
  const install = async (engine: string, onProgress: (p: BrowserInstallProgress) => void, options?: InstallRunOptions): Promise<BrowsersStatus> => {
    calls.push(`install:${engine}`)
    options?.onChildProcess?.(777)
    onProgress({ engine: engine as BrowserEngine, phase: 'downloading', message: 'Downloading 10 of 100 MB', percent: 10 })
    onProgress({ engine: engine as BrowserEngine, phase: 'error', message: 'ignored', percent: null })
    return status()
  }
  const provisioner: BrowserProvisioner = {
    status,
    install: vi.fn(install),
    installEngine: vi.fn(async (engine, onProgress, options) => {
      calls.push(`installEngine:${engine}`)
      return install(engine, onProgress, options)
    }),
    uninstallEngine: vi.fn(async (engine) => {
      calls.push(`uninstall:${engine}`)
      return status()
    }),
    installAllMissing: async () => ({ status: await status(), installed: [], failed: [] }),
    watchForInstall: () => undefined,
    onWatchUpdate: () => () => undefined,
    dispose: () => undefined,
    downloadUrl: () => null,
    browsersPath: () => '/b',
    engines: async () => {
      calls.push('engines')
      return [...infos.values()]
    },
    redetect: async () => {
      calls.push('redetect')
      return [...infos.values()]
    },
    resolveEngine: async (engine) => infos.get(engine) ?? engineInfo(engine),
    assertInstalled: async () => undefined,
  }
  return { provisioner, calls, infos }
}

function context(): TaskRunContext & { phases: Array<[string, number | null]>; verifyingPhases: string[]; children: number[] } {
  const phases: Array<[string, number | null]> = []
  const verifyingPhases: string[] = []
  const children: number[] = []
  return {
    taskId: 't',
    signal: new AbortController().signal,
    phases,
    verifyingPhases,
    children,
    progress: (phase, percent = null) => void phases.push([phase, percent]),
    verifying: (phase) => void verifyingPhases.push(phase),
    trackChild: (pid) => void children.push(pid),
  }
}

const passing: VerificationResult = { ok: true, reason: null, code: null, info: null, verification: { exists: true, version: '141.0.1.2', executablePath: '/opt/brave/brave', smoke: 'passed', smokeDetail: null, pathSaved: true } }

describe('install executor', () => {
  it('verifyEngine: exists → version → headless smoke → path saved', async () => {
    const { provisioner } = fakeProvisioner({ brave: { source: 'auto-saved' }, opera: { available: false, executablePath: null, note: 'Not installed on this machine.' } })
    const smoke = vi.fn<SmokeLauncher>(async () => ({ ok: true, detail: null, durationMs: 900 }))
    const ok = await verifyEngine('brave', { provisioner, isFile: () => true, smoke, smokeTimeoutMs: 1234 })
    expect(ok).toMatchObject({ ok: true, verification: { exists: true, version: '141.0.1.2', executablePath: '/opt/brave/brave', smoke: 'passed', pathSaved: true } })
    expect(smoke).toHaveBeenCalledWith(expect.objectContaining({ id: 'brave' }), { timeoutMs: 1234 })

    const missing = await verifyEngine('opera', { provisioner, isFile: () => true, smoke })
    expect(missing).toMatchObject({ ok: false, code: 'BROWSER_MISSING', verification: { exists: false, smoke: 'skipped' } })
    expect(missing.reason).toMatch(/Opera was not found after the install\. Not installed/)

    const fileGone = await verifyEngine('brave', { provisioner, isFile: () => false, smoke })
    expect(fileGone).toMatchObject({ ok: false, code: 'BROWSER_MISSING' })

    const hung = vi.fn<SmokeLauncher>(async () => ({ ok: false, detail: 'did not open a page within 30 s', durationMs: 30_000 }))
    expect(await verifyEngine('brave', { provisioner, isFile: () => true, smoke: hung })).toMatchObject({ ok: false, code: 'BROWSER_LAUNCH_FAILED', reason: 'the headless test launch did not open a page within 30 s', verification: { smoke: 'failed', smokeDetail: 'did not open a page within 30 s' } })

    const bundled = await verifyEngine('chromium', { provisioner, isFile: () => false, smoke })
    expect(bundled).toMatchObject({ ok: true, verification: { exists: true, pathSaved: true, executablePath: null } })
    expect(verifiedNote(passing.verification)).toBe('Verified · 141.0.1.2 · /opt/brave/brave')
  })

  it('installs, forwards progress and child pids, verifies, and reports the outcome', async () => {
    const { provisioner, calls } = fakeProvisioner()
    const verify = vi.fn(async () => passing)
    const executor = createInstallExecutor({ provisioner, verify, logger: silentLogger(), platform: 'linux' })
    const ctx = context()
    expect(await executor.run('install-vendor', 'brave', ctx)).toEqual({ note: 'Verified · 141.0.1.2 · /opt/brave/brave', verification: passing.verification })
    expect(calls).toEqual(['installEngine:brave', 'install:brave'])
    expect(ctx.phases).toEqual([['Downloading 10 of 100 MB', 10]])
    expect(ctx.children).toEqual([777])
    expect(ctx.verifyingPhases).toEqual(['Verifying Brave (headless test launch, no window)…'])

    const bundledCtx = context()
    await executor.run('install-bundled', 'firefox', bundledCtx)
    expect(verify).toHaveBeenLastCalledWith('firefox', bundledCtx.signal)

    const removal = await executor.run('uninstall', 'brave', context())
    expect(removal).toEqual({ note: 'Removed from the app data folder', verification: null })
  })

  it('turns a failed verification into "Installed, but failed verification" (Vivaldi: its own message)', async () => {
    const { provisioner } = fakeProvisioner()
    const failing: VerificationResult = { ...passing, ok: false, code: 'BROWSER_LAUNCH_FAILED', reason: 'the headless test launch did not open a page within 30 s', verification: { ...passing.verification, smoke: 'failed', smokeDetail: 'timeout' } }
    const executor = createInstallExecutor({ provisioner, verify: async () => failing, logger: silentLogger(), platform: 'linux' })
    await expect(executor.run('install-vendor', 'brave', context())).rejects.toMatchObject({
      code: 'BROWSER_LAUNCH_FAILED',
      message: `${VERIFICATION_FAILED_PREFIX}the headless test launch did not open a page within 30 s`,
      verification: { smoke: 'failed' },
    })
    await expect(executor.run('install-vendor', 'vivaldi', context())).rejects.toMatchObject({ message: VIVALDI_AUTOMATION_MESSAGE })
    const missing = createInstallExecutor({ provisioner, verify: async () => ({ ...failing, code: 'BROWSER_MISSING', reason: 'Vivaldi was not found after the install.' }), logger: silentLogger(), platform: 'linux' })
    await expect(missing.run('install-vendor', 'vivaldi', context())).rejects.toMatchObject({ code: 'BROWSER_MISSING', message: `${VERIFICATION_FAILED_PREFIX}Vivaldi was not found after the install.` })
  })

  it('on Windows sweeps installer-opened windows after the install and again after the verification', async () => {
    const { provisioner } = fakeProvisioner({ opera: { executablePath: 'C:\\Users\\qa\\AppData\\Local\\Programs\\Opera\\opera.exe' } })
    const sweep = vi.fn(async (_engine: string, _executablePath: string, _startedAtMs: number) => [4100])
    let clock = 1_000
    const order: string[] = []
    const executor = createInstallExecutor({
      provisioner,
      verify: async () => {
        order.push('verify')
        return passing
      },
      sweep: async (engine, executablePath, startedAtMs) => {
        order.push('sweep')
        return sweep(engine, executablePath, startedAtMs)
      },
      logger: silentLogger(),
      platform: 'win32',
      now: () => clock++,
    })
    await executor.run('install-vendor', 'opera', context())
    expect(order).toEqual(['sweep', 'verify', 'sweep'])
    expect(sweep).toHaveBeenCalledWith('opera', 'C:\\Users\\qa\\AppData\\Local\\Programs\\Opera\\opera.exe', 1_000)
    // Linux never sweeps (no vendor installer runs there).
    const linux = createInstallExecutor({ provisioner, verify: async () => passing, sweep, logger: silentLogger(), platform: 'linux' })
    sweep.mockClear()
    await linux.run('install-vendor', 'opera', context())
    expect(sweep).not.toHaveBeenCalled()
  })

  it('validates work before it is queued', async () => {
    const { provisioner } = fakeProvisioner({ opera: { installMethod: 'download-page', installNote: 'Get it from the vendor page.' }, chrome: { managedInstall: false } })
    const executor = createInstallExecutor({ provisioner, verify: async () => passing, logger: silentLogger(), platform: 'linux' })
    await expect(executor.validate('install-vendor', 'brave')).resolves.toBeUndefined()
    await expect(executor.validate('install-vendor', 'opera')).rejects.toMatchObject({ code: 'INVALID_INPUT', message: /cannot be installed automatically/ })
    await expect(executor.validate('install-vendor', 'chromium')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(executor.validate('install-bundled', 'chrome')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(executor.validate('install-bundled', 'webkit')).resolves.toBeUndefined()
    await expect(executor.validate('uninstall', 'chrome')).rejects.toMatchObject({ code: 'INVALID_INPUT', message: /was not installed by this app/ })
    await expect(executor.validate('uninstall', 'brave')).resolves.toBeUndefined()
    const readOnly = { ...provisioner, status: async (): Promise<BrowsersStatus> => ({ ...(await provisioner.status()), installable: false }) }
    await expect(createInstallExecutor({ provisioner: readOnly, verify: async () => passing, logger: silentLogger() }).validate('install-bundled', 'webkit')).rejects.toMatchObject({ code: 'INVALID_INPUT', message: /bundled with this build/ })
  })

  it('names busy engines the way ENGINE_BUSY refusals do', () => {
    const base = { label: 'x', phase: '', percent: null, queuedAt: '1', startedAt: null, finishedAt: null, error: null, note: null, verification: null }
    const tasks: Task[] = [
      { ...base, id: '1', kind: 'install-vendor', engine: 'chrome', state: 'queued' },
      { ...base, id: '2', kind: 'uninstall', engine: 'brave', state: 'running' },
      { ...base, id: '3', kind: 'install-bundled', engine: 'firefox', state: 'done' },
    ]
    expect(engineBusyMessage(tasks, 'chrome')).toBe('Google Chrome is being installed — launch will be available when the install finishes.')
    expect(engineBusyMessage(tasks, 'brave')).toBe('Brave is being uninstalled — choose another browser.')
    expect(engineBusyMessage(tasks, 'firefox')).toBeNull()
    expect(taskLabel('install-bundled', 'webkit')).toBe('Install WebKit / Safari-compatible QA')
  })

  it('smoke launch options: headless, marker for Chromium family, bundled Chromium via its channel, real executable for vendor browsers', () => {
    const marker = 'verify-0f8c2a52-3b1e-4c4d-9e1f-2a3b4c5d6e7f'
    expect(smokeLaunchOptions(engineInfo('chromium'), marker, 30_000, null)).toEqual({ headless: true, timeout: 30_000, args: [`--proxy-qa-session=${marker}`], channel: 'chromium' })
    expect(smokeLaunchOptions(engineInfo('brave'), marker, 30_000, null)).toEqual({ headless: true, timeout: 30_000, args: [`--proxy-qa-session=${marker}`], executablePath: '/opt/brave/brave' })
    expect(smokeLaunchOptions(engineInfo('firefox'), marker, 30_000, null)).toEqual({ headless: true, timeout: 30_000 })
    const webkit = smokeLaunchOptions(engineInfo('webkit'), marker, 30_000, '/res/webkit-libs')
    expect(webkit.env?.LD_LIBRARY_PATH?.startsWith('/res/webkit-libs')).toBe(true)
    expect(webkit.args).toBeUndefined()
  })
})

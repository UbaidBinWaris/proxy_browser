/**
 * The work behind each background task (task-manager.ts), with the "check and
 * balance" after every install:
 *
 *   install → [Windows: close browser windows the vendor installer opened]
 *           → verify: (a) the executable / install marker exists
 *                     (b) its version is read (never by running it on Windows/macOS)
 *                     (c) a HEADLESS smoke launch (no window on any OS): launch →
 *                         context → about:blank → close within 30 s
 *                     (d) the executable path is remembered (auto-saved origin)
 *           → "Verified · <version> · <path>"  or  failed:
 *             "Installed, but failed verification: <reason>" (Retry is offered).
 *
 * Vivaldi hangs under automation; when its smoke launch fails the message says
 * so plainly instead of a generic timeout.
 */
import type { BrowserEngine, BrowserEngineInfo, BrowserInstallProgress, InstalledBrowserEngine, Task, TaskKind, TaskVerification } from '@shared/types'
import { BROWSER_ENGINE_LABELS, isAutomaticInstallMethod, isBundledEngine, isInstalledEngine, isTaskActive } from '@shared/types'

import { AppException } from '../contracts'
import type { BrowserProvisioner, Logger } from '../contracts'
import { BUNDLED_INSTALL_MESSAGE, engineNotInstallableMessage } from '../browser/browser-provisioner'
import type { SmokeLauncher } from './smoke-launch'
import { SMOKE_TIMEOUT_MS } from './smoke-launch'
import { TaskFailure } from './task-manager'
import type { TaskExecutor, TaskOutcome, TaskRunContext } from './task-manager'

const SCOPE = 'tasks'
export const VIVALDI_AUTOMATION_MESSAGE = 'Vivaldi installed but does not support automation; choose another engine.'
export const VERIFICATION_FAILED_PREFIX = 'Installed, but failed verification: '

/** "Google Chrome (installed)" → "Google Chrome". */
export function engineName(engine: BrowserEngine): string {
  const label = BROWSER_ENGINE_LABELS[engine]
  return label.replace(/\s*\([^)]*\)\s*$/, '').trim() || label
}

export function taskLabel(kind: TaskKind, engine: BrowserEngine): string {
  return `${kind === 'uninstall' ? 'Uninstall' : 'Install'} ${engineName(engine)}`
}

/** ENGINE_BUSY message for an engine with an active task, or null when it can be launched. */
export function engineBusyMessage(tasks: readonly Task[], engine: BrowserEngine): string | null {
  const task = tasks.find((candidate) => candidate.engine === engine && isTaskActive(candidate.state))
  if (!task) return null
  return task.kind === 'uninstall'
    ? `${engineName(engine)} is being uninstalled — choose another browser.`
    : `${engineName(engine)} is being installed — launch will be available when the install finishes.`
}

export interface VerificationResult {
  ok: boolean
  /** Human reason when not ok. */
  reason: string | null
  code: 'BROWSER_MISSING' | 'BROWSER_LAUNCH_FAILED' | null
  verification: TaskVerification
  info: BrowserEngineInfo | null
}

export interface VerifyDeps {
  provisioner: Pick<BrowserProvisioner, 'redetect'>
  isFile: (filePath: string) => boolean
  smoke: SmokeLauncher
  smokeTimeoutMs?: number
}

/** Steps (a)–(d) for one engine right after its install. Never throws for a failed check. */
export async function verifyEngine(engine: BrowserEngine, deps: VerifyDeps, signal?: AbortSignal): Promise<VerificationResult> {
  const info = (await deps.provisioner.redetect()).find((candidate) => candidate.id === engine) ?? null
  const executablePath = info?.executablePath ?? null
  const exists = info !== null && info.available && (info.kind === 'bundled' || (executablePath !== null && deps.isFile(executablePath)))
  const pathSaved = info !== null && (info.kind === 'bundled' || info.source === 'auto-saved' || info.source === 'settings')
  const base: TaskVerification = { exists, version: info?.version ?? null, executablePath, smoke: 'skipped', smokeDetail: null, pathSaved }
  if (!info || !exists) {
    return { ok: false, code: 'BROWSER_MISSING', reason: `${engineName(engine)} was not found after the install. ${info?.note ?? ''}`.trim(), verification: base, info }
  }
  const smoke = await deps.smoke(info, { timeoutMs: deps.smokeTimeoutMs ?? SMOKE_TIMEOUT_MS, ...(signal ? { signal } : {}) })
  const verification: TaskVerification = { ...base, smoke: smoke.ok ? 'passed' : 'failed', smokeDetail: smoke.detail }
  if (!smoke.ok) return { ok: false, code: 'BROWSER_LAUNCH_FAILED', reason: `the headless test launch ${smoke.detail ?? 'failed'}`, verification, info }
  return { ok: true, code: null, reason: null, verification, info }
}

/** "Verified · 154.0.8037.97 · /path/to/chrome". */
export function verifiedNote(verification: TaskVerification): string {
  return ['Verified', verification.version, verification.executablePath].filter((part): part is string => Boolean(part)).join(' · ')
}

export interface InstallExecutorOptions {
  provisioner: BrowserProvisioner
  verify: (engine: BrowserEngine, signal: AbortSignal) => Promise<VerificationResult>
  logger: Logger
  platform?: NodeJS.Platform
  /**
   * Windows: close browser processes a vendor installer started (see installers/post-install-sweep.ts).
   * Called right after the installer exits and again after the verification.
   */
  sweep?: (engine: InstalledBrowserEngine, executablePath: string, startedAtMs: number) => Promise<number[]>
  now?: () => number
}

/** BrowserInstallProgress → task status line. */
function progressPhase(progress: BrowserInstallProgress): string {
  return progress.message.trim() || `${progress.phase.charAt(0).toUpperCase()}${progress.phase.slice(1)}…`
}

export function createInstallExecutor(options: InstallExecutorOptions): TaskExecutor {
  const { provisioner, logger } = options
  const platform = options.platform ?? process.platform
  const now = options.now ?? Date.now

  const verifyOrFail = async (engine: BrowserEngine, ctx: TaskRunContext): Promise<TaskOutcome> => {
    ctx.verifying(`Verifying ${engineName(engine)} (headless test launch, no window)…`)
    const result = await options.verify(engine, ctx.signal)
    if (!result.ok) {
      const message = engine === 'vivaldi' && result.code === 'BROWSER_LAUNCH_FAILED' ? VIVALDI_AUTOMATION_MESSAGE : `${VERIFICATION_FAILED_PREFIX}${result.reason ?? 'unknown reason'}`
      logger.warn(SCOPE, `${engineName(engine)}: ${message}`, { engine, verification: result.verification })
      throw new TaskFailure(result.code ?? 'BROWSER_LAUNCH_FAILED', message, result.verification, result.verification.smokeDetail ?? undefined)
    }
    return { note: verifiedNote(result.verification), verification: result.verification }
  }

  const sweep = async (engine: InstalledBrowserEngine, startedAtMs: number): Promise<void> => {
    if (platform !== 'win32' || !options.sweep) return
    try {
      const info = (await provisioner.engines()).find((candidate) => candidate.id === engine)
      if (info?.executablePath) await options.sweep(engine, info.executablePath, startedAtMs)
    } catch (err) {
      logger.warn(SCOPE, `${engineName(engine)}: post-install window check failed: ${err instanceof Error ? err.message : String(err)}`, { engine })
    }
  }

  return {
    label: taskLabel,

    async validate(kind, engine) {
      if (kind === 'install-bundled') {
        if (!isBundledEngine(engine)) throw new AppException('INVALID_INPUT', `${BROWSER_ENGINE_LABELS[engine]} is a vendor browser, not a Playwright download.`)
        const status = await provisioner.status()
        if (!status.installable) throw new AppException('INVALID_INPUT', BUNDLED_INSTALL_MESSAGE)
        return
      }
      if (!isInstalledEngine(engine)) throw new AppException('INVALID_INPUT', `${BROWSER_ENGINE_LABELS[engine]} is a Playwright engine; use the bundled browsers installer.`)
      const info = (await provisioner.engines()).find((candidate) => candidate.id === engine)
      if (!info) throw new AppException('NOT_FOUND', `${BROWSER_ENGINE_LABELS[engine]} is unknown.`)
      if (kind === 'install-vendor' && !isAutomaticInstallMethod(info.installMethod)) {
        throw new AppException('INVALID_INPUT', engineNotInstallableMessage(engine, info.installNote), `installMethod=${info.installMethod}`)
      }
      if (kind === 'uninstall' && !info.managedInstall) {
        throw new AppException('INVALID_INPUT', `${BROWSER_ENGINE_LABELS[engine]} was not installed by this app, so it cannot be uninstalled here. Remove it with your system's tools.`)
      }
    },

    async run(kind, engine, ctx) {
      const onProgress = (progress: BrowserInstallProgress): void => {
        if (progress.phase === 'error') return
        ctx.progress(progressPhase(progress), progress.percent)
      }
      const runOptions = { signal: ctx.signal, onChildProcess: (pid: number) => ctx.trackChild(pid) }
      if (kind === 'uninstall') {
        ctx.progress(`Removing ${engineName(engine)}…`)
        await provisioner.uninstallEngine(engine)
        return { note: 'Removed from the app data folder', verification: null }
      }
      if (kind === 'install-bundled') {
        if (!isBundledEngine(engine)) throw new AppException('INVALID_INPUT', `${BROWSER_ENGINE_LABELS[engine]} is not a Playwright download.`)
        await provisioner.install(engine, onProgress, runOptions)
        return verifyOrFail(engine, ctx)
      }
      if (!isInstalledEngine(engine)) throw new AppException('INVALID_INPUT', `${BROWSER_ENGINE_LABELS[engine]} is a Playwright engine.`)
      const startedAtMs = now()
      await provisioner.installEngine(engine, onProgress, runOptions)
      await sweep(engine, startedAtMs)
      try {
        return await verifyOrFail(engine, ctx)
      } finally {
        // Some installers start the browser a few seconds after they exit.
        await sweep(engine, startedAtMs)
      }
    },
  }
}

/**
 * Windows post-install sweep: some vendor installers (Opera, Opera GX, Brave…)
 * start the browser when they finish, even when run silently. After a winget
 * install the app closes exactly those windows:
 *
 *   processes whose executable lies inside the newly installed browser's
 *   directory AND that were created at or after the moment the install began,
 *
 * excluding the app's own browser sessions (their pids, their direct children
 * and anything carrying the `--proxy-qa-session=` marker). Processes created
 * before the install began — the user's own browsing — are never touched, and
 * neither are processes whose creation time is unknown. Windows are asked to
 * close first (CloseMainWindow), then the processes are stopped.
 *
 * `selectPostInstallStrays` is pure and unit-tested; the PowerShell side lives
 * in system/processes.ts.
 */
import path from 'node:path'

import type { Logger } from '../../contracts'
import type { ProcessInfo, ProcessToolkit } from '../../system/processes'
import { sessionIdFromCommandLine } from '../../system/processes'

const SCOPE = 'browsers'

export interface StraySelection {
  /** Directory the new executable lives in. */
  installDir: string
  /** Epoch ms when the install started (processes created earlier are left alone). */
  startedAtMs: number
  /** Browser processes of the app's own sessions. */
  ownPids: ReadonlySet<number>
}

function insideDir(executablePath: string, dir: string): boolean {
  const normalizedDir = dir.replace(/[\\/]+$/, '').toLowerCase()
  const normalizedExe = executablePath.toLowerCase()
  return normalizedExe.startsWith(`${normalizedDir}\\`) || normalizedExe.startsWith(`${normalizedDir}/`)
}

/** The processes a post-install sweep may close. */
export function selectPostInstallStrays(processes: readonly ProcessInfo[], selection: StraySelection): ProcessInfo[] {
  return processes.filter((proc) => {
    if (!proc.executablePath || !insideDir(proc.executablePath, selection.installDir)) return false
    if (proc.createdAtMs === null || proc.createdAtMs < selection.startedAtMs) return false
    if (selection.ownPids.has(proc.pid) || (proc.ppid !== null && selection.ownPids.has(proc.ppid))) return false
    return sessionIdFromCommandLine(proc.commandLine) === null
  })
}

/** Directory a sweep looks in: the folder holding the browser executable (win32 path rules). */
export function sweepDirFor(executablePath: string): string {
  return path.win32.dirname(executablePath)
}

export interface SweepOptions {
  executablePath: string
  startedAtMs: number
  ownPids: () => ReadonlySet<number>
  toolkit: ProcessToolkit
  logger: Logger
  label: string
}

/** Close browser windows the installer opened. Resolves with the pids that were closed; never rejects. */
export async function sweepPostInstall(options: SweepOptions): Promise<number[]> {
  const installDir = sweepDirFor(options.executablePath)
  try {
    const processes = await options.toolkit.listUnderDir(installDir)
    const strays = selectPostInstallStrays(processes, { installDir, startedAtMs: options.startedAtMs, ownPids: options.ownPids() })
    if (strays.length === 0) return []
    const pids = strays.map((proc) => proc.pid)
    await options.toolkit.closeGracefully(pids)
    options.logger.info(SCOPE, `Closed ${pids.length} ${options.label} process${pids.length === 1 ? '' : 'es'} the installer started: ${strays.map((proc) => `${proc.pid} ${proc.executablePath ?? ''}`).join('; ')}`, {
      pids,
      installDir,
    })
    return pids
  } catch (err) {
    options.logger.warn(SCOPE, `Could not check for ${options.label} windows opened by the installer: ${err instanceof Error ? err.message : String(err)}`, { installDir })
    return []
  }
}

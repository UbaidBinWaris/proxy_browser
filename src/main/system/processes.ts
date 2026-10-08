/**
 * Process discovery and termination for session maintenance and installer
 * clean-up, per platform:
 *
 * - Windows: one hidden `powershell.exe -NoProfile -NonInteractive
 *   -ExecutionPolicy Bypass -EncodedCommand …` querying Win32_Process through
 *   CIM (output forced to UTF-8 JSON), `taskkill /PID <pid> /T /F` for trees.
 *   The script travels base64-encoded, so no quoting can break it and the
 *   PowerShell process's own command line never contains the session marker.
 * - Linux: a scan of /proc/<pid>/cmdline and /proc/<pid>/stat (nothing spawned).
 * - macOS: `ps -axo pid=,ppid=,command=`.
 *
 * Only processes carrying the `--proxy-qa-session=<id>` marker switch (added to
 * every Chromium-family session launch) are ever looked up for sessions; the
 * post-install sweep (Windows) only sees processes under a browser's install
 * directory. Every child process is spawned with `windowsHide: true`.
 *
 * The parsing and script builders are pure and unit-tested.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { nodeSpawn } from '../browser/installers/system-tools'
import type { SpawnFn } from '../browser/installers/system-tools'

/** Command-line switch identifying a session's browser process (Chromium ignores unknown switches). */
export const SESSION_MARKER_SWITCH = '--proxy-qa-session'
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/
const MARKER_PATTERN = /--proxy-qa-session=([A-Za-z0-9-]{1,64})/

export interface ProcessInfo {
  pid: number
  ppid: number | null
  executablePath: string | null
  commandLine: string | null
  /** Creation time (epoch ms), when the platform reports it. */
  createdAtMs: number | null
}

/** `--proxy-qa-session=<id>`; ids are UUIDs (anything else is refused so the switch can never inject text). */
export function sessionMarkerArg(sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error(`Invalid session id for the process marker: ${sessionId}`)
  return `${SESSION_MARKER_SWITCH}=${sessionId}`
}

export function sessionIdFromCommandLine(commandLine: string | null | undefined): string | null {
  if (!commandLine) return null
  return MARKER_PATTERN.exec(commandLine)?.[1] ?? null
}

/**
 * The browser (root) process of a session among marked processes: the one whose parent does not carry the
 * same marker. Chromium does not forward unknown switches to its child processes, so normally there is one.
 */
export function sessionRootPids(processes: readonly ProcessInfo[], sessionId: string): number[] {
  const own = processes.filter((proc) => sessionIdFromCommandLine(proc.commandLine) === sessionId)
  const pids = new Set(own.map((proc) => proc.pid))
  return own.filter((proc) => proc.ppid === null || !pids.has(proc.ppid)).map((proc) => proc.pid)
}

// ---------------------------------------------------------------------------
// PowerShell (Windows)
// ---------------------------------------------------------------------------

/** `-EncodedCommand` payload: base64 of the UTF-16LE script. */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

export function powerShellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShellCommand(script)]
}

/** A PowerShell single-quoted string literal (only `'` needs escaping, by doubling). */
export function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

const PS_PREAMBLE = "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8"
const PS_SELECT =
  "Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine, @{Name='CreationDate';Expression={ if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null } }}"

export interface ProcessQuery {
  /** Only processes whose executable lies inside this directory (case-insensitive prefix + separator). */
  underDir?: string
  /** Only processes whose command line contains the session marker switch. */
  withSessionMarker?: boolean
}

/** CIM query listing processes as a JSON array (always an array: `-InputObject @(...)`). */
export function processQueryScript(query: ProcessQuery): string {
  const clauses: string[] = []
  if (query.underDir !== undefined) {
    const dir = query.underDir.replace(/[\\/]+$/, '')
    clauses.push(`$_.ExecutablePath -and $_.ExecutablePath.StartsWith(${psSingleQuote(`${dir}\\`)}, [System.StringComparison]::OrdinalIgnoreCase)`)
  }
  if (query.withSessionMarker) {
    clauses.push(`$_.CommandLine -and $_.CommandLine.Contains(${psSingleQuote(`${SESSION_MARKER_SWITCH}=`)})`)
  }
  const where = clauses.length > 0 ? ` | Where-Object { ${clauses.join(' -and ')} }` : ''
  return `${PS_PREAMBLE}; $items = @(Get-CimInstance -ClassName Win32_Process${where} | ${PS_SELECT}); ConvertTo-Json -InputObject $items -Compress -Depth 3`
}

/** Ask each process to close its main window, wait, then stop whatever is left (missing processes are ignored). */
export function closeProcessesScript(pids: readonly number[], graceMs = 1_500): string {
  const ids = pids.filter((pid) => Number.isInteger(pid) && pid > 0)
  if (ids.length === 0) throw new Error('No process ids to close.')
  const list = ids.join(',')
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$ids = @(${list})`,
    'foreach ($id in $ids) { $p = Get-Process -Id $id; if ($p -and $p.MainWindowHandle -ne 0) { [void]$p.CloseMainWindow() } }',
    `Start-Sleep -Milliseconds ${Math.max(0, Math.round(graceMs))}`,
    'Stop-Process -Id $ids -Force',
  ].join('; ')
}

/** JSON printed by ConvertTo-Json: an array, a single object (older shells), or nothing for no results. */
export function parsePowerShellJson(text: string): unknown[] {
  const trimmed = text.replace(/^\uFEFF/, '').trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed) as unknown
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object') return [parsed]
  return []
}

function toPid(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function toText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Win32_Process rows from `processQueryScript` → ProcessInfo (rows without a pid are dropped). */
export function parseCimProcesses(text: string): ProcessInfo[] {
  const result: ProcessInfo[] = []
  for (const row of parsePowerShellJson(text)) {
    if (!row || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    const pid = toPid(record.ProcessId)
    if (pid === null) continue
    const created = toText(record.CreationDate)
    const createdAtMs = created ? Date.parse(created) : Number.NaN
    result.push({
      pid,
      ppid: toPid(record.ParentProcessId),
      executablePath: toText(record.ExecutablePath),
      commandLine: toText(record.CommandLine),
      createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : null,
    })
  }
  return result
}

/** `%SystemRoot%\System32\…` (absolute, so a planted powershell.exe on PATH is never picked up). */
export function windowsSystemTool(relative: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot?.trim() || env.SYSTEMROOT?.trim() || env.windir?.trim() || 'C:\\Windows'
  return path.win32.join(root, 'System32', relative)
}

export interface RunOptions {
  spawn: SpawnFn
  timeoutMs: number
}

/** Run a hidden child, resolve with stdout on exit code 0, reject otherwise (stderr tail in the message). */
export function runHidden(command: string, args: readonly string[], options: RunOptions): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = options.spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${path.basename(command)} did not finish within ${options.timeoutMs} ms`))
    }, options.timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2_000)
    })
    child.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(`${path.basename(command)} exited with code ${String(code)}${stderr.trim() ? `: ${stderr.trim()}` : ''}`))
    })
  })
}

// ---------------------------------------------------------------------------
// POSIX
// ---------------------------------------------------------------------------

/** /proc/<pid>/cmdline: NUL-separated arguments → one space-joined line. */
export function parseProcCmdline(raw: Buffer | string): string {
  return raw.toString().replace(/\0+$/, '').split('\0').join(' ')
}

/** Parent pid from /proc/<pid>/stat ("pid (comm) state ppid …"; comm may contain spaces and parentheses). */
export function parseProcStatPpid(stat: string): number | null {
  const close = stat.lastIndexOf(')')
  if (close === -1) return null
  const fields = stat.slice(close + 2).split(' ')
  const ppid = Number(fields[1])
  return Number.isInteger(ppid) && ppid >= 0 ? ppid : null
}

/** `ps -axo pid=,ppid=,command=` output. */
export function parsePsOutput(text: string): ProcessInfo[] {
  const result: ProcessInfo[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!match?.[1] || !match[2]) continue
    result.push({ pid: Number(match[1]), ppid: Number(match[2]), executablePath: null, commandLine: match[3]?.trim() || null, createdAtMs: null })
  }
  return result
}

/** Every process visible in /proc (Linux). Unreadable entries are skipped. */
export function scanProc(procRoot = '/proc'): ProcessInfo[] {
  const result: ProcessInfo[] = []
  let entries: string[]
  try {
    entries = readdirSync(procRoot)
  } catch {
    return result
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const commandLine = parseProcCmdline(readFileSync(path.join(procRoot, entry, 'cmdline')))
      const ppid = parseProcStatPpid(readFileSync(path.join(procRoot, entry, 'stat'), 'utf8'))
      result.push({ pid: Number(entry), ppid, executablePath: null, commandLine: commandLine || null, createdAtMs: null })
    } catch {
      // The process exited while scanning, or belongs to another user.
    }
  }
  return result
}

/** `root` and every descendant, children before parents. */
export function processTree(processes: readonly ProcessInfo[], root: number): number[] {
  const children = new Map<number, number[]>()
  for (const proc of processes) {
    if (proc.ppid === null) continue
    const list = children.get(proc.ppid) ?? []
    list.push(proc.pid)
    children.set(proc.ppid, list)
  }
  const order: number[] = []
  const visit = (pid: number, depth: number): void => {
    if (depth > 64) return
    for (const child of children.get(pid) ?? []) visit(child, depth + 1)
    order.push(pid)
  }
  visit(root, 0)
  return [...new Set(order)]
}

// ---------------------------------------------------------------------------
// Toolkit
// ---------------------------------------------------------------------------

export interface ProcessToolkit {
  /** Processes carrying the session marker switch (any session id). */
  listMarked(): Promise<ProcessInfo[]>
  /** Processes running from inside `dir` (Windows only; other platforms resolve with []). */
  listUnderDir(dir: string): Promise<ProcessInfo[]>
  /** Terminate a process and all its descendants. Never rejects for a process that is already gone. */
  killTree(pid: number): Promise<void>
  /** Close windows politely, then stop the processes (Windows); terminate the trees elsewhere. */
  closeGracefully(pids: readonly number[]): Promise<void>
}

export interface ProcessToolkitOptions {
  platform?: NodeJS.Platform
  spawn?: SpawnFn
  env?: NodeJS.ProcessEnv
  procRoot?: string
  /** This process (never listed, never killed). */
  selfPid?: number
  /** Grace period before SIGKILL on POSIX. */
  killGraceMs?: number
  timeoutMs?: number
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function createProcessToolkit(options: ProcessToolkitOptions = {}): ProcessToolkit {
  const platform = options.platform ?? process.platform
  const spawn = options.spawn ?? nodeSpawn
  const env = options.env ?? process.env
  const selfPid = options.selfPid ?? process.pid
  const timeoutMs = options.timeoutMs ?? 30_000
  const killGraceMs = options.killGraceMs ?? 3_000
  const run = { spawn, timeoutMs }

  const powershell = async (script: string): Promise<string> => runHidden(windowsSystemTool('WindowsPowerShell\\v1.0\\powershell.exe', env), powerShellArgs(script), run)

  const listAllPosix = async (): Promise<ProcessInfo[]> => {
    const all = platform === 'linux' ? scanProc(options.procRoot) : parsePsOutput(await runHidden('ps', ['-axo', 'pid=,ppid=,command='], run))
    return all.filter((proc) => proc.pid !== selfPid)
  }

  const killTreePosix = async (pid: number): Promise<void> => {
    const tree = processTree(await listAllPosix(), pid).filter((candidate) => candidate !== selfPid)
    for (const target of tree) {
      try {
        process.kill(target, 'SIGTERM')
      } catch {
        // Already gone.
      }
    }
    const deadline = Date.now() + killGraceMs
    while (tree.some(isAlive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
    for (const target of tree.filter(isAlive)) {
      try {
        process.kill(target, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
  }

  const killTree = async (pid: number): Promise<void> => {
    if (!Number.isInteger(pid) || pid <= 0 || pid === selfPid) return
    if (platform === 'win32') {
      // Exit code 128 = "process not found": the tree is gone either way.
      await runHidden(windowsSystemTool('taskkill.exe', env), ['/PID', String(pid), '/T', '/F'], run).catch((err: unknown) => {
        if (!/code 128\b/.test(err instanceof Error ? err.message : String(err))) throw err
      })
      return
    }
    await killTreePosix(pid)
  }

  return {
    async listMarked() {
      if (platform === 'win32') return parseCimProcesses(await powershell(processQueryScript({ withSessionMarker: true }))).filter((proc) => proc.pid !== selfPid)
      return (await listAllPosix()).filter((proc) => sessionIdFromCommandLine(proc.commandLine) !== null)
    },
    async listUnderDir(dir) {
      if (platform !== 'win32') return []
      return parseCimProcesses(await powershell(processQueryScript({ underDir: dir }))).filter((proc) => proc.pid !== selfPid)
    },
    killTree,
    async closeGracefully(pids) {
      const targets = pids.filter((pid) => pid !== selfPid)
      if (targets.length === 0) return
      if (platform === 'win32') {
        await powershell(closeProcessesScript(targets))
        return
      }
      for (const pid of targets) await killTree(pid)
    },
  }
}

/**
 * Process discovery / termination helpers (session markers, PowerShell CIM
 * queries, /proc and ps parsing, process trees) and the Windows post-install
 * sweep that closes browser windows a vendor installer opened.
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LogEntry } from '../src/shared/types'
import type { Logger } from '../src/main/contracts'
import type { SpawnFn } from '../src/main/browser/installers/system-tools'
import { selectPostInstallStrays, sweepDirFor, sweepPostInstall } from '../src/main/browser/installers/post-install-sweep'
import {
  SESSION_MARKER_SWITCH,
  closeProcessesScript,
  createProcessToolkit,
  encodePowerShellCommand,
  parseCimProcesses,
  parsePowerShellJson,
  parseProcCmdline,
  parseProcStatPpid,
  parsePsOutput,
  powerShellArgs,
  processQueryScript,
  processTree,
  psSingleQuote,
  scanProc,
  sessionIdFromCommandLine,
  sessionMarkerArg,
  sessionRootPids,
  windowsSystemTool,
} from '../src/main/system/processes'
import type { ProcessInfo, ProcessToolkit } from '../src/main/system/processes'

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

const proc = (pid: number, overrides: Partial<ProcessInfo> = {}): ProcessInfo => ({ pid, ppid: null, executablePath: null, commandLine: null, createdAtMs: null, ...overrides })

let work: string
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'proxyqa-proc-'))
})
afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

describe('session markers', () => {
  it('builds the switch for UUID-like ids only and reads it back from a command line', () => {
    const id = '0f8c2a52-3b1e-4c4d-9e1f-2a3b4c5d6e7f'
    expect(sessionMarkerArg(id)).toBe(`${SESSION_MARKER_SWITCH}=${id}`)
    expect(() => sessionMarkerArg('x; rm -rf /')).toThrow(/Invalid session id/)
    expect(() => sessionMarkerArg('')).toThrow()
    expect(sessionIdFromCommandLine(`"C:\\Chrome\\chrome.exe" --no-first-run ${SESSION_MARKER_SWITCH}=${id} about:blank`)).toBe(id)
    expect(sessionIdFromCommandLine('chrome.exe --type=renderer')).toBeNull()
    expect(sessionIdFromCommandLine(null)).toBeNull()
  })

  it('finds the browser root among marked processes and orders process trees children-first', () => {
    const id = 'aaaa-1'
    const processes = [proc(10, { ppid: 1, commandLine: `chrome --proxy-qa-session=${id}` }), proc(11, { ppid: 10, commandLine: `chrome --type=gpu --proxy-qa-session=${id}` }), proc(20, { ppid: 1, commandLine: 'chrome --proxy-qa-session=other' })]
    expect(sessionRootPids(processes, id)).toEqual([10])
    expect(sessionRootPids(processes, 'missing')).toEqual([])
    const tree = [proc(1), proc(2, { ppid: 1 }), proc(3, { ppid: 2 }), proc(4, { ppid: 1 }), proc(5, { ppid: 99 })]
    expect(processTree(tree, 1)).toEqual([3, 2, 4, 1])
    expect(processTree(tree, 5)).toEqual([5])
  })
})

describe('PowerShell (Windows)', () => {
  it('encodes scripts as UTF-16LE base64 and runs them hidden without a profile', () => {
    const script = "Write-Output 'é'"
    expect(Buffer.from(encodePowerShellCommand(script), 'base64').toString('utf16le')).toBe(script)
    expect(powerShellArgs(script)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShellCommand(script)])
    expect(psSingleQuote("C:\\Users\\O'Brien\\")).toBe("'C:\\Users\\O''Brien\\'")
    expect(windowsSystemTool('taskkill.exe', { SystemRoot: 'D:\\Windows' })).toBe('D:\\Windows\\System32\\taskkill.exe')
    expect(windowsSystemTool('taskkill.exe', {})).toBe('C:\\Windows\\System32\\taskkill.exe')
  })

  it('builds the CIM query for an install directory (literal prefix, no wildcards) and for session markers', () => {
    const underDir = processQueryScript({ underDir: "C:\\Users\\qa\\AppData\\Local\\Programs\\Opera [x]\\" })
    expect(underDir).toContain("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8")
    expect(underDir).toContain("Get-CimInstance -ClassName Win32_Process")
    expect(underDir).toContain(".StartsWith('C:\\Users\\qa\\AppData\\Local\\Programs\\Opera [x]\\', [System.StringComparison]::OrdinalIgnoreCase)")
    expect(underDir).not.toContain('-like')
    expect(underDir).toContain("ToUniversalTime().ToString('o')")
    expect(underDir).toContain('ConvertTo-Json -InputObject $items -Compress')
    expect(processQueryScript({ withSessionMarker: true })).toContain(".Contains('--proxy-qa-session=')")
    expect(closeProcessesScript([12, 34], 500)).toBe(
      "$ErrorActionPreference = 'SilentlyContinue'; $ids = @(12,34); foreach ($id in $ids) { $p = Get-Process -Id $id; if ($p -and $p.MainWindowHandle -ne 0) { [void]$p.CloseMainWindow() } }; Start-Sleep -Milliseconds 500; Stop-Process -Id $ids -Force",
    )
    expect(() => closeProcessesScript([0, -1])).toThrow()
  })

  it('parses ConvertTo-Json output: arrays, a single object, nothing at all, a BOM', () => {
    expect(parsePowerShellJson('')).toEqual([])
    expect(parsePowerShellJson('  \r\n')).toEqual([])
    expect(parsePowerShellJson('{"ProcessId":4}')).toEqual([{ ProcessId: 4 }])
    expect(parsePowerShellJson('\uFEFF[{"ProcessId":4},{"ProcessId":5}]')).toHaveLength(2)
    expect(parsePowerShellJson('null')).toEqual([])
    expect(() => parsePowerShellJson('{oops')).toThrow()
    const rows = parseCimProcesses(
      JSON.stringify([
        { ProcessId: 4100, ParentProcessId: 900, ExecutablePath: 'C:\\Opera\\opera.exe', CommandLine: '"C:\\Opera\\opera.exe"', CreationDate: '2026-10-07T10:00:05.0000000Z' },
        { ProcessId: 4101, ParentProcessId: null, ExecutablePath: null, CommandLine: null, CreationDate: null },
        { ProcessId: 'x' },
      ]),
    )
    expect(rows).toEqual([
      { pid: 4100, ppid: 900, executablePath: 'C:\\Opera\\opera.exe', commandLine: '"C:\\Opera\\opera.exe"', createdAtMs: Date.parse('2026-10-07T10:00:05Z') },
      { pid: 4101, ppid: null, executablePath: null, commandLine: null, createdAtMs: null },
    ])
    expect(parseCimProcesses('{"ProcessId":7,"CreationDate":"garbage"}')).toEqual([{ pid: 7, ppid: null, executablePath: null, commandLine: null, createdAtMs: null }])
  })

  it('the Windows toolkit spawns powershell.exe / taskkill.exe hidden with the expected arguments', async () => {
    const calls: Array<{ command: string; args: readonly string[]; windowsHide: unknown }> = []
    const output = { current: '[{"ProcessId":4100,"ParentProcessId":1,"ExecutablePath":"C:\\\\Opera\\\\opera.exe","CommandLine":"opera --proxy-qa-session=abc-1","CreationDate":"2026-10-07T10:00:00Z"}]' }
    const fakeSpawn: SpawnFn = (command, args, options) => {
      calls.push({ command, args, windowsHide: options.windowsHide })
      const child = new EventEmitter() as ChildProcess
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      Object.assign(child, { stdout, stderr, kill: () => true })
      setImmediate(() => {
        stdout.end(command.endsWith('powershell.exe') ? output.current : '')
        stderr.end(command.endsWith('taskkill.exe') && args[1] === '999' ? 'ERROR: The process "999" not found.' : '')
        setImmediate(() => child.emit('close', command.endsWith('taskkill.exe') && args[1] === '999' ? 128 : 0, null))
      })
      return child
    }
    const toolkit = createProcessToolkit({ platform: 'win32', spawn: fakeSpawn, env: { SystemRoot: 'C:\\Windows' }, selfPid: 1 })
    expect(await toolkit.listMarked()).toMatchObject([{ pid: 4100, commandLine: 'opera --proxy-qa-session=abc-1' }])
    expect(await toolkit.listUnderDir('C:\\Opera')).toHaveLength(1)
    await toolkit.killTree(4100)
    // "Not found" means the tree is already gone.
    await expect(toolkit.killTree(999)).resolves.toBeUndefined()
    await toolkit.closeGracefully([4100])
    await toolkit.killTree(1)
    expect(calls.map((call) => call.command)).toEqual([
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Windows\\System32\\taskkill.exe',
      'C:\\Windows\\System32\\taskkill.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ])
    expect(calls.every((call) => call.windowsHide === true)).toBe(true)
    expect(calls[2]?.args).toEqual(['/PID', '4100', '/T', '/F'])
    expect(calls[0]?.args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
    expect(Buffer.from(String(calls[1]?.args[5]), 'base64').toString('utf16le')).toContain("StartsWith('C:\\Opera\\'")
  })
})

describe('POSIX process listing', () => {
  it('parses /proc cmdline and stat (comm with spaces and parentheses) and ps output', () => {
    expect(parseProcCmdline(Buffer.from('/opt/brave/brave\0--proxy-qa-session=abc\0about:blank\0'))).toBe('/opt/brave/brave --proxy-qa-session=abc about:blank')
    expect(parseProcStatPpid('1234 (Web Content (x)) S 987 1234 1234 0')).toBe(987)
    expect(parseProcStatPpid('garbage')).toBeNull()
    expect(parsePsOutput('  101     1 /Applications/Brave Browser.app/Contents/MacOS/Brave Browser --proxy-qa-session=abc\n  102   101 helper\nbad line\n')).toEqual([
      { pid: 101, ppid: 1, executablePath: null, commandLine: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser --proxy-qa-session=abc', createdAtMs: null },
      { pid: 102, ppid: 101, executablePath: null, commandLine: 'helper', createdAtMs: null },
    ])
  })

  it('scans a /proc-like directory and skips unreadable entries', () => {
    const write = (pid: string, cmdline: string, stat: string): void => {
      mkdirSync(path.join(work, pid))
      writeFileSync(path.join(work, pid, 'cmdline'), cmdline)
      writeFileSync(path.join(work, pid, 'stat'), stat)
    }
    write('42', 'chrome\0--proxy-qa-session=s-1\0', '42 (chrome) S 1 42')
    write('43', '', '43 (kworker) S 2 0')
    mkdirSync(path.join(work, '44'))
    mkdirSync(path.join(work, 'self'))
    expect(scanProc(work).sort((a, b) => a.pid - b.pid)).toEqual([
      { pid: 42, ppid: 1, executablePath: null, commandLine: 'chrome --proxy-qa-session=s-1', createdAtMs: null },
      { pid: 43, ppid: 2, executablePath: null, commandLine: null, createdAtMs: null },
    ])
    expect(scanProc(path.join(work, 'missing'))).toEqual([])
  })

  it.skipIf(process.platform !== 'linux')('finds a real marked process tree and terminates it (Linux)', async () => {
    const id = randomUUID()
    // A parent with a child, both alive; only the parent carries the marker.
    const parent = spawn(process.execPath, ['-e', "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); setTimeout(() => {}, 60000)", '--', sessionMarkerArg(id)], { stdio: 'ignore' })
    const exited = new Promise<void>((resolve) => parent.once('exit', () => resolve()))
    try {
      const toolkit = createProcessToolkit({ platform: 'linux', killGraceMs: 2_000 })
      let roots: number[] = []
      for (let i = 0; i < 50 && roots.length === 0; i += 1) {
        roots = sessionRootPids(await toolkit.listMarked(), id)
        if (roots.length === 0) await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(roots).toEqual([parent.pid])
      let children: number[] = []
      for (let i = 0; i < 100 && children.length === 0; i += 1) {
        children = processTree(scanProc(), parent.pid ?? 0).filter((pid) => pid !== parent.pid)
        if (children.length === 0) await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(children.length).toBeGreaterThan(0)
      await toolkit.killTree(parent.pid ?? 0)
      await exited
      for (const pid of children) expect(() => process.kill(pid, 0)).toThrow()
      expect(sessionRootPids(await toolkit.listMarked(), id)).toEqual([])
    } finally {
      parent.kill('SIGKILL')
    }
  })
})

describe('post-install sweep (Windows)', () => {
  const dir = 'C:\\Users\\qa\\AppData\\Local\\Programs\\Opera'
  const started = Date.parse('2026-10-07T10:00:00Z')

  it('selects only processes inside the install dir that started after the install, excluding the app\'s own sessions', () => {
    const processes = [
      proc(1, { executablePath: `${dir}\\opera.exe`, createdAtMs: started + 5_000 }),
      proc(2, { executablePath: `${dir.toUpperCase()}\\118.0\\opera_crashreporter.exe`, createdAtMs: started + 6_000 }),
      proc(3, { executablePath: `${dir}\\opera.exe`, createdAtMs: started - 60_000 }), // the user's own Opera, opened before
      proc(4, { executablePath: `${dir}\\opera.exe`, createdAtMs: null }), // unknown start time: never touched
      proc(5, { executablePath: `${dir} GX\\opera.exe`, createdAtMs: started + 1 }), // another directory with the same prefix
      proc(6, { executablePath: `${dir}\\opera.exe`, createdAtMs: started + 1, commandLine: 'opera --proxy-qa-session=abc' }),
      proc(7, { executablePath: `${dir}\\opera.exe`, createdAtMs: started + 1 }), // an own session pid
      proc(8, { executablePath: `${dir}\\opera.exe`, createdAtMs: started + 1, ppid: 7 }), // a child of it
      proc(9, { executablePath: null, createdAtMs: started + 1 }),
      proc(10, { executablePath: `${dir}\\opera.exe`, createdAtMs: started }),
    ]
    expect(selectPostInstallStrays(processes, { installDir: dir, startedAtMs: started, ownPids: new Set([7]) }).map((p) => p.pid)).toEqual([1, 2, 10])
    expect(selectPostInstallStrays(processes, { installDir: `${dir}\\`, startedAtMs: started, ownPids: new Set() }).map((p) => p.pid)).toContain(7)
    expect(sweepDirFor('C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe')).toBe('C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application')
  })

  it('closes the strays gracefully, logs them and never rejects', async () => {
    const toolkit: ProcessToolkit = {
      listMarked: vi.fn(async () => []),
      listUnderDir: vi.fn(async () => [proc(41, { executablePath: `${dir}\\opera.exe`, createdAtMs: started + 10 }), proc(42, { executablePath: `${dir}\\opera.exe`, createdAtMs: started - 10 })]),
      killTree: vi.fn(async () => undefined),
      closeGracefully: vi.fn(async () => undefined),
    }
    const logger = memoryLogger()
    expect(await sweepPostInstall({ executablePath: `${dir}\\opera.exe`, startedAtMs: started, ownPids: () => new Set(), toolkit, logger, label: 'Opera' })).toEqual([41])
    expect(toolkit.listUnderDir).toHaveBeenCalledWith(dir)
    expect(toolkit.closeGracefully).toHaveBeenCalledWith([41])
    expect(logger.lines.join('\n')).toMatch(/Closed 1 Opera process the installer started: 41/)

    const quiet = { ...toolkit, listUnderDir: vi.fn(async () => []), closeGracefully: vi.fn(async () => undefined) }
    expect(await sweepPostInstall({ executablePath: `${dir}\\opera.exe`, startedAtMs: started, ownPids: () => new Set(), toolkit: quiet, logger, label: 'Opera' })).toEqual([])
    expect(quiet.closeGracefully).not.toHaveBeenCalled()

    const broken = { ...toolkit, listUnderDir: vi.fn(async () => Promise.reject(new Error('powershell missing'))) }
    expect(await sweepPostInstall({ executablePath: `${dir}\\opera.exe`, startedAtMs: started, ownPids: () => new Set(), toolkit: broken, logger, label: 'Opera' })).toEqual([])
    expect(logger.lines.at(-1)).toMatch(/WARN Could not check for Opera windows opened by the installer: powershell missing/)
  })
})

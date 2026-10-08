/**
 * Windows installs through the Windows Package Manager (`winget`, part of "App
 * Installer" on Windows 10 1809+ and Windows 11).
 *
 *   winget install --id <ID> -e --silent --accept-package-agreements
 *     --accept-source-agreements --disable-interactivity [--scope user]
 *     [--override "<vendor switches>"]   (Opera / Opera GX: never start the browser)
 *
 * Per-user installers (Brave, Opera, Opera GX, Vivaldi) get `--scope user` so no
 * administrator prompt appears; Chrome's installer is machine-wide and may raise
 * a UAC prompt. winget's progress bars ("██▒▒ 52%", "12.0 MB / 120 MB") are
 * parsed into percentages for the UI. "Already installed / no upgrade
 * available" exit codes count as success: the browser is there either way.
 *
 * Everything here except `runWingetInstall` / `probeWinget` is pure and unit-tested.
 */
import type { ChildProcess } from 'node:child_process'

import type { InstalledBrowserEngine } from '@shared/types'

import { tailCollector } from './system-tools'
import type { SpawnFn } from './system-tools'

export const WINGET_PACKAGE_IDS: Readonly<Record<InstalledBrowserEngine, string>> = {
  chrome: 'Google.Chrome',
  msedge: 'Microsoft.Edge',
  brave: 'Brave.Brave',
  opera: 'Opera.Opera',
  'opera-gx': 'Opera.OperaGX',
  vivaldi: 'Vivaldi.Vivaldi',
  'system-chromium': 'Hibbiki.Chromium',
}

/** Packages whose installers support a per-user install (no administrator rights needed). */
export const WINGET_USER_SCOPE: ReadonlySet<InstalledBrowserEngine> = new Set(['brave', 'opera', 'opera-gx', 'vivaldi'])

/**
 * winget exit codes that still mean "the package is on this machine":
 * APPINSTALLER_CLI_ERROR_PACKAGE_ALREADY_INSTALLED (0x8A15002B) and
 * APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE (0x8A15002C) / NO_APPLICABLE_UPGRADE (0x8A150061).
 * Node reports them either as unsigned or as signed 32-bit values.
 */
export const WINGET_ALREADY_INSTALLED_CODES: readonly number[] = [0x8a15002b, 0x8a15002c, 0x8a150061].flatMap((code) => [code, code | 0])

/**
 * `--override` arguments: winget passes these to the vendor installer INSTEAD of the manifest's
 * switches, so each entry repeats the manifest's silent/scope switches and adds the ones that stop
 * the installer from opening the browser. Only switches that can be justified are used; every
 * other engine keeps winget's defaults and relies on the post-install sweep
 * (post-install-sweep.ts), which closes browser windows the installer started.
 *
 * - Opera / Opera GX: the winget-pkgs manifests (Opera.Opera, Opera.OperaGX) use `/silent` with
 *   `/allusers=0` for the user scope; Opera's installer also takes `/launchopera=0` (do not start
 *   Opera when done), `/setdefaultbrowser=0`, `/desktopshortcut=0` and `/pintotaskbar=0`. Without
 *   `/launchopera=0` the silent installer starts the browser.
 * - Vivaldi: not overridden — its manifest already adds `--do-not-launch-chrome` to
 *   `--vivaldi-silent` for the user scope.
 * - Brave: not overridden — the manifest's Omaha `/silent /install` has no documented
 *   "do not launch" switch; the sweep covers it.
 * - Chrome (MSI), Edge, Chromium: not overridden — their installers do not open the browser.
 */
export const WINGET_OVERRIDES: Readonly<Partial<Record<InstalledBrowserEngine, string>>> = {
  opera: '/silent /allusers=0 /launchopera=0 /setdefaultbrowser=0 /desktopshortcut=0 /pintotaskbar=0',
  'opera-gx': '/silent /allusers=0 /launchopera=0 /setdefaultbrowser=0 /desktopshortcut=0 /pintotaskbar=0',
}

export function wingetInstallArgs(engine: InstalledBrowserEngine): string[] {
  const args = [
    'install',
    '--id',
    WINGET_PACKAGE_IDS[engine],
    '-e',
    '--silent',
    '--accept-package-agreements',
    '--accept-source-agreements',
    '--disable-interactivity',
  ]
  if (WINGET_USER_SCOPE.has(engine)) args.push('--scope', 'user')
  const override = WINGET_OVERRIDES[engine]
  if (override) args.push('--override', override)
  return args
}

export function isWingetSuccess(code: number | null): boolean {
  return code === 0 || (code !== null && WINGET_ALREADY_INSTALLED_CODES.includes(code))
}

const UNIT_BYTES: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }

/** Percentage carried by one winget output line ("52%", or "12.0 MB / 120 MB"), or null. */
export function parseWingetProgress(line: string): number | null {
  const percent = /(\d{1,3})\s*%/.exec(line)
  if (percent?.[1]) return Math.min(100, Number(percent[1]))
  const sizes = /([\d.]+)\s*(B|KB|MB|GB)\s*\/\s*([\d.]+)\s*(B|KB|MB|GB)/i.exec(line)
  if (sizes?.[1] && sizes[2] && sizes[3] && sizes[4]) {
    const done = Number(sizes[1]) * (UNIT_BYTES[sizes[2].toUpperCase()] ?? 1)
    const total = Number(sizes[3]) * (UNIT_BYTES[sizes[4].toUpperCase()] ?? 1)
    if (total > 0 && Number.isFinite(done)) return Math.min(100, Math.floor((done / total) * 100))
  }
  return null
}

/** Text worth showing from a winget line: progress-bar glyphs and spinners removed. */
export function cleanWingetLine(line: string): string {
  return line
    .replace(/[█▓▒░]+/g, ' ')
    .replace(/^[\s\\|/-]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** True when `winget --version` runs (cached by the caller). Never rejects. */
export function probeWinget(spawnImpl: SpawnFn, timeoutMs = 10_000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let child: ChildProcess
    try {
      child = spawnImpl('winget', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      resolve(false)
      return
    }
    let output = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve(false)
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 && /v?\d+\.\d+/.test(output))
    })
  })
}

export interface WingetRunOptions {
  spawn: SpawnFn
  /** Each cleaned output line with its parsed percentage (null when the line carries none). */
  onLine: (line: string, percent: number | null) => void
  signal?: AbortSignal
  /** Called with winget's pid once it started (the task manager kills the whole tree on cancel). */
  onSpawn?: (pid: number) => void
}

/** Run `winget install` for an engine; rejects with the tail of winget's output on failure. */
export function runWingetInstall(engine: InstalledBrowserEngine, options: WingetRunOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = options.spawn('winget', wingetInstallArgs(engine), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    if (child.pid !== undefined) options.onSpawn?.(child.pid)
    const tail = tailCollector()
    const abort = (): void => {
      child.kill()
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    const reader = (stream: NodeJS.ReadableStream | null): void => {
      if (!stream) return
      let buffer = ''
      stream.on('data', (chunk: Buffer) => {
        tail.push(chunk)
        buffer += chunk.toString()
        const parts = buffer.split(/\r?\n|\r/)
        buffer = parts.pop() ?? ''
        for (const part of parts) {
          const line = cleanWingetLine(part)
          if (line) options.onLine(line, parseWingetProgress(part))
        }
      })
    }
    reader(child.stdout)
    reader(child.stderr)
    child.once('error', (err) => {
      options.signal?.removeEventListener('abort', abort)
      reject(new Error(`winget could not be started: ${err.message}`))
    })
    child.once('close', (code) => {
      options.signal?.removeEventListener('abort', abort)
      if (isWingetSuccess(code)) resolve()
      else if (options.signal?.aborted) reject(new Error('The installation was cancelled.'))
      else reject(new Error(`winget exited with code ${String(code)}${tail.text() ? `: ${tail.text()}` : ''}`))
    })
  })
}

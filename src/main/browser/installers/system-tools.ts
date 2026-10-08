/**
 * Locating and running the few system tools the installers may use (`tar`,
 * `xz`, `zstd`, `bzip2`, `winget`). Lookups scan PATH on disk — nothing is
 * spawned just to find a tool — and every child process is started without a
 * shell, so no argument is ever interpreted by one.
 */
import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { statSync } from 'node:fs'
import path from 'node:path'

/** Absolute path of `command` on PATH (POSIX: must be an executable regular file), or null. */
export function findCommand(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const raw = (platform === 'win32' ? (env.Path ?? env.PATH ?? env.path) : env.PATH) ?? ''
  const delimiter = platform === 'win32' ? ';' : ':'
  const extensions = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of raw.split(delimiter).map((entry) => entry.replace(/^"|"$/g, '').trim()).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${command}${extension}`)
      try {
        const stat = statSync(candidate)
        if (stat.isFile() && (platform === 'win32' || (stat.mode & 0o111) !== 0)) return candidate
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return null
}

/** Spawner signature (Node's `spawn`), injectable for tests. */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export const nodeSpawn: SpawnFn = (command, args, options) => spawn(command, [...args], options)

/** Collect the last `maxLines` lines a stream printed (for error messages). */
export function tailCollector(maxLines = 8): { push(chunk: Buffer | string): void; text(): string } {
  const lines: string[] = []
  let partial = ''
  return {
    push(chunk) {
      const parts = (partial + chunk.toString()).split(/\r?\n|\r/)
      partial = parts.pop() ?? ''
      for (const line of parts) {
        const trimmed = line.trim()
        if (!trimmed) continue
        lines.push(trimmed)
        if (lines.length > maxLines) lines.shift()
      }
    },
    text() {
      return [...lines, partial.trim()].filter(Boolean).join('\n')
    },
  }
}

/** Resolves when the child exits with code 0, rejects with its stderr tail otherwise. */
export function waitForExit(child: ChildProcess, label: string): Promise<void> {
  const stderr = tailCollector()
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
  return new Promise<void>((resolve, reject) => {
    child.once('error', (err) => reject(new Error(`${label} could not be started: ${err.message}`)))
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${label} ${signal ? `was terminated by ${signal}` : `exited with code ${String(code)}`}${stderr.text() ? `: ${stderr.text()}` : ''}`))
    })
  })
}

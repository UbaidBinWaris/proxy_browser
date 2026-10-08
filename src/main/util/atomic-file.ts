/**
 * Crash-safe file replacement: write to a sibling temp file, fsync, rename
 * over the destination. Readers either see the old content or the new one,
 * never a partial write.
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** Owner-only file mode for key and vault files (POSIX only; ignored on Windows). */
export const PRIVATE_FILE_MODE = 0o600

export interface WriteFileAtomicOptions {
  mode?: number
  platform?: NodeJS.Platform
}

export function writeFileAtomicSync(filePath: string, data: string | Buffer, options: WriteFileAtomicOptions = {}): void {
  const mode = options.mode ?? PRIVATE_FILE_MODE
  const platform = options.platform ?? process.platform
  const tmp = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  const fd = openSync(tmp, 'w', mode)
  try {
    writeSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, filePath)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // The temp file could not be removed; the rename error is the one that matters.
    }
    throw err
  }
  // `openSync` honours the umask, so re-assert the exact mode after the rename.
  if (platform !== 'win32') chmodSync(filePath, mode)
}

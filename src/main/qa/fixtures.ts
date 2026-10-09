/**
 * Upload fixtures in the main process.
 *
 * - `readFixtureFile` turns a file the operator chose in main's own file dialog into a scenario fixture: it
 *   is read exactly once (≤ 2 MB, allowed type only) and only its sanitized base name is kept. The path never
 *   crosses IPC, and no host path is stored or read again later.
 * - `createFixtureFiles` writes a run's fixtures into that attempt's private artifact folder for
 *   `setInputFiles` and removes them when the attempt ends.
 */
import { mkdir, open, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { QA_FIXTURE_MAX_BYTES, QA_FIXTURE_TYPES, QaFixtureSchema, sanitizeFixtureName } from '@shared/qa-fixtures'
import type { QaFixture } from '@shared/qa-fixtures'
import { AppException } from '../contracts'

export const FIXTURE_TYPES_TEXT = Object.keys(QA_FIXTURE_TYPES)
  .map((ext) => ext.slice(1))
  .join(', ')

export async function readFixtureFile(path: string): Promise<QaFixture> {
  const name = sanitizeFixtureName(basename(path))
  if (!name)
    throw new AppException('INVALID_INPUT', `This file type cannot be used as an upload fixture. Allowed types: ${FIXTURE_TYPES_TEXT}.`)
  // Refuse devices, pipes and folders before opening (opening a FIFO would block).
  if (!(await stat(path)).isFile()) throw new AppException('INVALID_INPUT', 'Choose a regular file.')
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    if (size > QA_FIXTURE_MAX_BYTES) throw new AppException('INVALID_INPUT', 'Upload fixtures are limited to 2 MB.')
    // One extra byte detects a file that grew after stat.
    const buffer = Buffer.alloc(size + 1)
    let length = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
      if (length === buffer.length) break
    }
    if (length > QA_FIXTURE_MAX_BYTES || length > size)
      throw new AppException('INVALID_INPUT', 'The file changed while it was read. Choose it again.')
    return QaFixtureSchema.parse({ name, data: buffer.subarray(0, length).toString('base64') })
  } finally {
    await handle.close()
  }
}

export interface FixtureFiles {
  /** Absolute paths of the named fixtures, written on first use. */
  paths(names: readonly string[]): Promise<string[]>
  /** Delete every fixture written for this attempt. */
  remove(): Promise<void>
}

export function createFixtureFiles(dir: string, fixtures: readonly QaFixture[]): FixtureFiles {
  const written = new Map<string, string>()
  return {
    async paths(names) {
      const files: string[] = []
      for (const name of names) {
        let file = written.get(name)
        if (!file) {
          const fixture = fixtures.find((item) => item.name === name)
          if (!fixture) throw new Error(`The upload fixture ${name} is not attached to this scenario.`)
          // Re-validated here: a stored name is a plain file name, never a path.
          const { name: safe, data } = QaFixtureSchema.parse(fixture)
          await mkdir(dir, { recursive: true, mode: 0o700 })
          file = join(dir, safe)
          if (relative(dir, file) !== safe) throw new Error('Invalid upload fixture name.')
          // wx: never follow or overwrite something already at that path.
          await writeFile(file, Buffer.from(data, 'base64'), { mode: 0o600, flag: 'wx' })
          written.set(name, file)
        }
        files.push(file)
      }
      return files
    },
    async remove() {
      if (written.size) await rm(dir, { recursive: true, force: true })
      written.clear()
    },
  }
}

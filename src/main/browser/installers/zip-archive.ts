/**
 * Minimal, dependency-free ZIP extractor (used for vendor portable archives such
 * as Brave's `brave-browser-<version>-linux-amd64.zip`). Works on every platform
 * without `unzip` or Python.
 *
 * Reads the central directory (ZIP64 included), then streams each entry from
 * its local header through `zlib.createInflateRaw` (method 8) or as-is (method
 * 0) into the destination, verifying the CRC-32 of every file. Unix modes stored
 * in the external attributes (archives made on Unix) are applied, so the
 * executable bit survives; symlink entries become symlinks. Entries that would
 * land outside the destination are refused.
 */
import { chmodSync, createReadStream, createWriteStream, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'

import { ArchiveFormatError, openFileSource } from './ar-archive'
import type { ByteSource } from './ar-archive'
import { safeJoin } from './tar-archive'

const EOCD_SIGNATURE = 0x06054b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const ZIP64_EOCD_SIGNATURE = 0x06064b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const MAX_COMMENT = 0xffff

const S_IFMT = 0o170000
const S_IFLNK = 0o120000
const S_IFDIR = 0o040000

export interface ZipEntry {
  name: string
  method: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
  /** Unix mode bits when the archive was made on Unix, else null. */
  unixMode: number | null
  isDirectory: boolean
  isSymlink: boolean
}

function u16(buffer: Buffer, offset: number): number {
  return buffer.readUInt16LE(offset)
}
function u32(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset)
}
function u64(buffer: Buffer, offset: number): number {
  return Number(buffer.readBigUInt64LE(offset))
}

/** Parse the central directory of a ZIP archive. */
export function listZipEntries(source: ByteSource): ZipEntry[] {
  const tailLength = Math.min(source.size, 22 + MAX_COMMENT)
  const tailStart = source.size - tailLength
  const tail = source.read(tailStart, tailLength)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (u32(tail, i) === EOCD_SIGNATURE) {
      eocd = i
      break
    }
  }
  if (eocd === -1) throw new ArchiveFormatError('Not a ZIP archive (no end-of-central-directory record).')

  let entryCount = u16(tail, eocd + 10)
  let directorySize = u32(tail, eocd + 12)
  let directoryOffset = u32(tail, eocd + 16)
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    const locatorAt = tailStart + eocd - 20
    const locator = source.read(locatorAt, 20)
    if (locator.length < 20 || u32(locator, 0) !== ZIP64_LOCATOR_SIGNATURE) throw new ArchiveFormatError('ZIP64 archive without a ZIP64 locator.')
    const record = source.read(u64(locator, 8), 56)
    if (record.length < 56 || u32(record, 0) !== ZIP64_EOCD_SIGNATURE) throw new ArchiveFormatError('Corrupt ZIP64 end-of-central-directory record.')
    entryCount = u64(record, 32)
    directorySize = u64(record, 40)
    directoryOffset = u64(record, 48)
  }
  if (directoryOffset + directorySize > source.size) throw new ArchiveFormatError('Truncated ZIP archive (central directory past the end).')

  const directory = source.read(directoryOffset, directorySize)
  const entries: ZipEntry[] = []
  let position = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (position + 46 > directory.length || u32(directory, position) !== CENTRAL_SIGNATURE) throw new ArchiveFormatError(`Corrupt ZIP central directory at entry ${index}.`)
    const madeBy = u16(directory, position + 4)
    const flags = u16(directory, position + 8)
    const method = u16(directory, position + 10)
    const crc32 = u32(directory, position + 16)
    let compressedSize = u32(directory, position + 20)
    let uncompressedSize = u32(directory, position + 24)
    const nameLength = u16(directory, position + 28)
    const extraLength = u16(directory, position + 30)
    const commentLength = u16(directory, position + 32)
    const externalAttributes = u32(directory, position + 38)
    let localHeaderOffset = u32(directory, position + 42)
    const nameBytes = directory.subarray(position + 46, position + 46 + nameLength)
    const name = nameBytes.toString(flags & 0x800 ? 'utf8' : 'latin1')
    const extra = directory.subarray(position + 46 + nameLength, position + 46 + nameLength + extraLength)

    // ZIP64 extended information: only the fields whose 32-bit value is saturated are present, in order.
    for (let e = 0; e + 4 <= extra.length; ) {
      const id = u16(extra, e)
      const size = u16(extra, e + 2)
      if (id === 0x0001) {
        let cursor = e + 4
        if (uncompressedSize === 0xffffffff) {
          uncompressedSize = u64(extra, cursor)
          cursor += 8
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = u64(extra, cursor)
          cursor += 8
        }
        if (localHeaderOffset === 0xffffffff) localHeaderOffset = u64(extra, cursor)
      }
      e += 4 + size
    }

    const unixMode = madeBy >> 8 === 3 ? externalAttributes >>> 16 : null
    const isDirectory = name.endsWith('/') || (unixMode !== null && (unixMode & S_IFMT) === S_IFDIR)
    const isSymlink = unixMode !== null && (unixMode & S_IFMT) === S_IFLNK
    entries.push({ name, method, crc32, compressedSize, uncompressedSize, localHeaderOffset, unixMode, isDirectory, isSymlink })
    position += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** Byte offset of an entry's data: after its local header, whose name/extra lengths may differ from the central copy. */
function dataOffset(source: ByteSource, entry: ZipEntry): number {
  const local = source.read(entry.localHeaderOffset, 30)
  if (local.length < 30 || u32(local, 0) !== LOCAL_SIGNATURE) throw new ArchiveFormatError(`Corrupt local header for "${entry.name}".`)
  return entry.localHeaderOffset + 30 + u16(local, 26) + u16(local, 28)
}

function crcCounter(): { transform: Transform; value(): number; bytes(): number } {
  let crc = 0
  let bytes = 0
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      crc = zlib.crc32(chunk, crc)
      bytes += chunk.length
      callback(null, chunk)
    },
  })
  return { transform, value: () => crc >>> 0, bytes: () => bytes }
}

export interface ZipExtractProgress {
  /** Entries done so far / total entries. */
  done: number
  total: number
}

/** Extract every entry of the ZIP at `zipPath` into `destDir`. */
export async function extractZipFile(zipPath: string, destDir: string, onProgress?: (progress: ZipExtractProgress) => void): Promise<{ files: number }> {
  const source = openFileSource(zipPath)
  try {
    const entries = listZipEntries(source)
    mkdirSync(destDir, { recursive: true })
    const root = path.resolve(destDir)
    const realRoot = realpathSync(root)
    let files = 0
    let done = 0
    for (const entry of entries) {
      done += 1
      const target = safeJoin(root, entry.name)
      if (!target) continue
      if (entry.isDirectory) {
        mkdirSync(target, { recursive: true })
        continue
      }
      const parent = path.dirname(target)
      mkdirSync(parent, { recursive: true })
      const realParent = realpathSync(parent)
      if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${path.sep}`)) continue
      if (entry.method !== 0 && entry.method !== 8) throw new ArchiveFormatError(`"${entry.name}" uses unsupported ZIP compression method ${entry.method}.`)

      const start = dataOffset(source, entry)
      /** Stream the entry's bytes (inflated when needed) into `sink`, then check CRC-32 and size. */
      const copyTo = async (sink: Writable): Promise<void> => {
        const raw = entry.compressedSize === 0 ? Readable.from([]) : createReadStream(zipPath, { start, end: start + entry.compressedSize - 1 })
        const counter = crcCounter()
        if (entry.method === 8) await pipeline(raw, zlib.createInflateRaw(), counter.transform, sink)
        else await pipeline(raw, counter.transform, sink)
        if (counter.bytes() !== entry.uncompressedSize || counter.value() !== entry.crc32 >>> 0) {
          throw new ArchiveFormatError(`"${entry.name}" is corrupt (CRC or size mismatch). Download it again.`)
        }
      }

      rmSync(target, { force: true })
      if (entry.isSymlink) {
        const chunks: Buffer[] = []
        await copyTo(
          new Writable({
            write(chunk: Buffer, _encoding, callback) {
              chunks.push(chunk)
              callback()
            },
          }),
        )
        symlinkSync(Buffer.concat(chunks).toString('utf8'), target)
        continue
      }

      await copyTo(createWriteStream(target))
      const mode = entry.unixMode !== null ? entry.unixMode & 0o777 : 0o644
      chmodSync(target, mode | 0o600)
      files += 1
      onProgress?.({ done, total: entries.length })
    }
    return { files }
  } finally {
    source.close()
  }
}

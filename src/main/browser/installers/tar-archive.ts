/**
 * Unpacking the `data.tar.*` payload of a Debian package.
 *
 * Decompression: gzip and zstd run in-process (zlib; zstd needs a Node with
 * `zlib.createZstdDecompress`, otherwise the `zstd` tool), xz and bzip2 through
 * the `xz` / `bzip2` tools (Node has no codec for them; both ship on practically
 * every Linux distribution because the package managers depend on them).
 *
 * Extraction: the system `tar` when present (robust, handles every tar dialect),
 * otherwise a minimal in-process reader that understands what vendor packages
 * contain — regular files, directories, symlinks, hard links, GNU long names
 * ('L'/'K') and pax headers ('x' path / linkpath / size). Modes (the executable
 * bit) are preserved; ownership never is. Entries that would land outside the
 * destination (absolute paths, `..`, writes through a symlink) are refused.
 */
import { copyFileSync, chmodSync, closeSync, lstatSync, mkdirSync, openSync, realpathSync, rmSync, symlinkSync, writeSync } from 'node:fs'
import path from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'

import type { TarCompression } from './ar-archive'
import { ArchiveFormatError } from './ar-archive'
import { findCommand, nodeSpawn, waitForExit } from './system-tools'
import type { SpawnFn } from './system-tools'

export interface TarTools {
  /** Absolute path of a system `tar`, or null to use the in-process reader. */
  tar: string | null
  xz: string | null
  zstd: string | null
  bzip2: string | null
  spawn: SpawnFn
}

export function detectTarTools(env: NodeJS.ProcessEnv = process.env): TarTools {
  return { tar: findCommand('tar', env), xz: findCommand('xz', env), zstd: findCommand('zstd', env), bzip2: findCommand('bzip2', env), spawn: nodeSpawn }
}

type ZstdFactory = () => NodeJS.ReadWriteStream
/** Node ≥ 22.15 / 23.8 ships zstd in zlib; older runtimes fall back to the `zstd` tool. */
function zstdFactory(): ZstdFactory | null {
  const candidate = (zlib as unknown as { createZstdDecompress?: ZstdFactory }).createZstdDecompress
  return typeof candidate === 'function' ? candidate : null
}

export function missingToolMessage(tool: string): string {
  return `Unpacking this package needs the "${tool}" tool, which was not found on this system. Install it with your package manager (for example: sudo apt install ${tool === 'xz' ? 'xz-utils' : tool}, sudo dnf install ${tool}, sudo pacman -S ${tool}) and try again.`
}

/**
 * A consumer (tar, xz, zstd) closing its input before we finished writing is normal: tar stops
 * at the end-of-archive marker and ignores the trailing record padding. Node reports that as
 * EPIPE or ERR_STREAM_PREMATURE_CLOSE depending on timing. Success is decided by the tool's exit
 * status (tar fails on a truncated archive), so both are tolerated here.
 */
export function isEarlyCloseError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'EPIPE' || code === 'ERR_STREAM_PREMATURE_CLOSE'
}

function tolerateEarlyClose(err: unknown): void {
  if (!isEarlyCloseError(err)) throw err
}

/**
 * Pipe `input` through the right decompressor. Returns the decompressed stream and a promise
 * that settles when the decompressor itself finishes (rejects on a tool failure).
 */
export function decompress(input: Readable, compression: TarCompression, tools: TarTools): { stream: Readable; done: Promise<void> } {
  const viaTool = (tool: string | null, name: string): { stream: Readable; done: Promise<void> } => {
    if (!tool) throw new Error(missingToolMessage(name))
    const child = tools.spawn(tool, ['-dc'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    if (!child.stdin || !child.stdout) throw new Error(`${name} could not be started.`)
    const fed = pipeline(input, child.stdin).catch(tolerateEarlyClose)
    const exited = waitForExit(child, name)
    return { stream: child.stdout, done: Promise.all([fed, exited]).then(() => undefined) }
  }
  const viaZlib = (transform: NodeJS.ReadWriteStream): { stream: Readable; done: Promise<void> } => {
    const output = new PassThrough()
    const done = pipeline(input, transform, output).catch(tolerateEarlyClose)
    return { stream: output, done }
  }
  switch (compression) {
    case 'none': {
      const output = new PassThrough()
      return { stream: output, done: pipeline(input, output).catch(tolerateEarlyClose) }
    }
    case 'gz':
      return viaZlib(zlib.createGunzip())
    case 'zst': {
      const factory = zstdFactory()
      return factory ? viaZlib(factory()) : viaTool(tools.zstd, 'zstd')
    }
    case 'xz':
      return viaTool(tools.xz, 'xz')
    case 'bz2':
      return viaTool(tools.bzip2, 'bzip2')
  }
}

/** Extract a plain (already decompressed) tar stream into `destDir` with the system tar or the in-process reader. */
export async function extractTar(stream: Readable, destDir: string, tools: Pick<TarTools, 'tar' | 'spawn'>): Promise<void> {
  mkdirSync(destDir, { recursive: true })
  if (!tools.tar) {
    await extractTarStream(stream, destDir)
    return
  }
  const child = tools.spawn(tools.tar, ['-x', '-f', '-', '-C', destDir], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
  if (!child.stdin) throw new Error('tar could not be started.')
  const fed = pipeline(stream, child.stdin).catch(tolerateEarlyClose)
  await Promise.all([fed, waitForExit(child, 'tar')])
}

// ---------------------------------------------------------------------------
// In-process tar reader
// ---------------------------------------------------------------------------

const BLOCK = 512

/** Pull exact byte counts out of an async chunk stream. */
class ChunkReader {
  private readonly iterator: AsyncIterator<Buffer>
  private buffer: Buffer = Buffer.alloc(0)
  private ended = false

  constructor(stream: AsyncIterable<Buffer | string>) {
    const source = stream[Symbol.asyncIterator]()
    this.iterator = {
      next: async () => {
        const result = await source.next()
        if (result.done) return { done: true, value: undefined }
        return { done: false, value: typeof result.value === 'string' ? Buffer.from(result.value) : result.value }
      },
    }
  }

  private async fill(n: number): Promise<boolean> {
    while (this.buffer.length < n && !this.ended) {
      const next = await this.iterator.next()
      if (next.done) this.ended = true
      else this.buffer = this.buffer.length === 0 ? next.value : Buffer.concat([this.buffer, next.value])
    }
    return this.buffer.length >= n
  }

  /** Exactly `n` bytes, or null at a clean end of stream; throws when the stream ends mid-way. */
  async readExact(n: number): Promise<Buffer | null> {
    if (!(await this.fill(n))) {
      if (this.buffer.length === 0) return null
      throw new ArchiveFormatError('Truncated tar archive.')
    }
    const out = this.buffer.subarray(0, n)
    this.buffer = this.buffer.subarray(n)
    return out
  }

  /** Hand `n` bytes to `sink` chunk by chunk (no full copy in memory). */
  async forEach(n: number, sink: (chunk: Buffer) => void): Promise<void> {
    let remaining = n
    while (remaining > 0) {
      if (this.buffer.length === 0 && !(await this.fill(1))) throw new ArchiveFormatError('Truncated tar archive.')
      const take = Math.min(remaining, this.buffer.length)
      sink(this.buffer.subarray(0, take))
      this.buffer = this.buffer.subarray(take)
      remaining -= take
    }
  }
}

function cString(header: Buffer, start: number, length: number): string {
  const slice = header.subarray(start, start + length)
  const end = slice.indexOf(0)
  return slice.toString('utf8', 0, end === -1 ? slice.length : end)
}

/** Octal field, or GNU base-256 when the high bit of the first byte is set. */
export function parseTarNumber(header: Buffer, start: number, length: number): number {
  const first = header[start] ?? 0
  if (first & 0x80) {
    let value = first & 0x7f
    for (let i = 1; i < length; i += 1) value = value * 256 + (header[start + i] ?? 0)
    return value
  }
  const text = cString(header, start, length).trim()
  if (text === '') return 0
  const value = Number.parseInt(text, 8)
  if (!Number.isFinite(value)) throw new ArchiveFormatError(`Invalid number in tar header: "${text}".`)
  return value
}

function checksumOk(header: Buffer): boolean {
  const stored = parseTarNumber(header, 148, 8)
  let sum = 0
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0)
  return sum === stored
}

/** `len key=value\n` records of a pax extended header. */
export function parsePaxRecords(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {}
  let position = 0
  while (position < data.length) {
    const space = data.indexOf(0x20, position)
    if (space === -1) break
    const length = Number.parseInt(data.toString('utf8', position, space), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = data.toString('utf8', space + 1, position + length - 1)
    const equals = record.indexOf('=')
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1)
    position += length
  }
  return records
}

/** `destRoot/entry` when the entry stays inside the destination; null for absolute or escaping paths. */
export function safeJoin(destRoot: string, entry: string): string | null {
  const normalized = entry.replace(/\\/g, '/').replace(/^(\.\/)+/, '')
  if (normalized === '' || normalized === '.') return null
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null
  const target = path.resolve(destRoot, normalized)
  const relative = path.relative(destRoot, target)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return target
}

/** The parent directory exists, and resolves inside the destination (no writing through a symlink). */
function prepareParent(realRoot: string, target: string): boolean {
  const parent = path.dirname(target)
  mkdirSync(parent, { recursive: true })
  const realParent = realpathSync(parent)
  return realParent === realRoot || realParent.startsWith(`${realRoot}${path.sep}`)
}

function removeExisting(target: string): void {
  try {
    const stat = lstatSync(target)
    rmSync(target, { recursive: stat.isDirectory(), force: true })
  } catch {
    // Nothing there.
  }
}

/** Extract a plain tar stream with the in-process reader (see the module comment for what is supported). */
export async function extractTarStream(stream: AsyncIterable<Buffer | string>, destDir: string): Promise<{ files: number }> {
  mkdirSync(destDir, { recursive: true })
  const root = path.resolve(destDir)
  const realRoot = realpathSync(root)
  const reader = new ChunkReader(stream)
  let longName: string | null = null
  let longLink: string | null = null
  let pax: Record<string, string> = {}
  let files = 0

  for (;;) {
    const header = await reader.readExact(BLOCK)
    if (!header || header.every((byte) => byte === 0)) break
    if (!checksumOk(header)) throw new ArchiveFormatError('Corrupt tar header (checksum mismatch).')

    const type = String.fromCharCode(header[156] ?? 0)
    let size = parseTarNumber(header, 124, 12)
    if (pax.size !== undefined && /^\d+$/.test(pax.size)) size = Number(pax.size)
    const padding = (BLOCK - (size % BLOCK)) % BLOCK

    if (type === 'L' || type === 'K' || type === 'x' || type === 'g') {
      const data = (await reader.readExact(size + padding)) ?? Buffer.alloc(0)
      const body = data.subarray(0, size)
      if (type === 'L') longName = cString(body, 0, body.length)
      else if (type === 'K') longLink = cString(body, 0, body.length)
      else if (type === 'x') pax = { ...pax, ...parsePaxRecords(body) }
      continue
    }

    let name = cString(header, 0, 100)
    if (header.toString('latin1', 257, 262) === 'ustar') {
      const prefix = cString(header, 345, 155)
      if (prefix) name = `${prefix}/${name}`
    }
    const entryPath = pax.path ?? longName ?? name
    const linkPath = pax.linkpath ?? longLink ?? cString(header, 157, 100)
    const mode = parseTarNumber(header, 100, 8) & 0o777
    longName = null
    longLink = null
    pax = {}

    const target = safeJoin(root, entryPath)
    const writable = target !== null && prepareParent(realRoot, target)

    if (writable && type === '5') {
      mkdirSync(target, { recursive: true })
      chmodSync(target, mode | 0o700)
    } else if (writable && (type === '0' || type === '\0' || type === '7')) {
      removeExisting(target)
      const fd = openSync(target, 'w', mode | 0o600)
      try {
        await reader.forEach(size, (chunk) => {
          let written = 0
          while (written < chunk.length) written += writeSync(fd, chunk, written)
        })
      } finally {
        closeSync(fd)
      }
      chmodSync(target, mode | 0o600)
      files += 1
      if (padding > 0) await reader.readExact(padding)
      continue
    } else if (writable && type === '2') {
      removeExisting(target)
      symlinkSync(linkPath, target)
    } else if (writable && type === '1') {
      const source = safeJoin(root, linkPath)
      if (source) {
        removeExisting(target)
        copyFileSync(source, target)
        chmodSync(target, lstatSync(source).mode & 0o777)
        files += 1
      }
    }
    // Skip whatever data this entry carries (unsupported types, refused paths).
    if (size + padding > 0) await reader.forEach(size + padding, () => undefined)
  }
  return { files }
}

/** Convenience for tests and callers holding an in-memory tar. */
export function extractTarBuffer(buffer: Buffer, destDir: string): Promise<{ files: number }> {
  return extractTarStream(Readable.from([buffer]), destDir)
}

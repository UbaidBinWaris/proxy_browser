/**
 * Minimal reader for Unix `ar` archives — the container format of Debian `.deb`
 * packages — so a vendor package can be unpacked on any Linux distribution
 * without `dpkg` or `ar` installed.
 *
 * Layout: the global header `!<arch>\n`, then members, each with a 60-byte
 * header (name[16] mtime[12] uid[6] gid[6] mode[8] size[10] magic "`\n") followed
 * by `size` bytes of data padded to an even offset. Member names follow either
 * the GNU convention (`name/`, `/` symbol table, `//` long-name table, `/123`
 * offsets into it) or the BSD one (`#1/<len>`: the name precedes the data).
 *
 * The reader only lists members (name, data offset, size); callers stream the
 * bytes they need straight from the file, so a 150 MB package is never loaded
 * into memory.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

export const AR_MAGIC = '!<arch>\n'
const HEADER_SIZE = 60
const HEADER_END = '`\n'

/** Random access to the bytes of an archive (a file descriptor in production, a Buffer in tests). */
export interface ByteSource {
  readonly size: number
  /** Up to `length` bytes starting at `offset` (fewer only at the end of the source). */
  read(offset: number, length: number): Buffer
}

export function bufferSource(buffer: Buffer): ByteSource {
  return {
    size: buffer.length,
    read: (offset, length) => buffer.subarray(offset, Math.min(buffer.length, offset + length)),
  }
}

/** A file opened for random reads; `close()` must be called when done. */
export interface FileSource extends ByteSource {
  close(): void
}

export function openFileSource(filePath: string): FileSource {
  const fd = openSync(filePath, 'r')
  const size = fstatSync(fd).size
  return {
    size,
    read(offset, length) {
      const wanted = Math.max(0, Math.min(length, size - offset))
      const buffer = Buffer.alloc(wanted)
      let done = 0
      while (done < wanted) {
        const n = readSync(fd, buffer, done, wanted - done, offset + done)
        if (n === 0) break
        done += n
      }
      return buffer.subarray(0, done)
    },
    close() {
      closeSync(fd)
    },
  }
}

export interface ArMember {
  name: string
  /** Absolute offset of the member's data in the archive. */
  offset: number
  size: number
}

export class ArchiveFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArchiveFormatError'
  }
}

function field(header: Buffer, start: number, length: number): string {
  return header.toString('latin1', start, start + length).trim()
}

/** List every member of an `ar` archive in order. Throws ArchiveFormatError on anything malformed. */
export function listArMembers(source: ByteSource): ArMember[] {
  if (source.size < AR_MAGIC.length || source.read(0, AR_MAGIC.length).toString('latin1') !== AR_MAGIC) {
    throw new ArchiveFormatError('Not an ar archive (missing "!<arch>" header).')
  }
  const members: ArMember[] = []
  let longNames: string | null = null
  let position = AR_MAGIC.length
  while (position + HEADER_SIZE <= source.size) {
    const header = source.read(position, HEADER_SIZE)
    if (header.toString('latin1', 58, 60) !== HEADER_END) {
      throw new ArchiveFormatError(`Corrupt ar member header at byte ${position}.`)
    }
    const rawName = header.toString('latin1', 0, 16)
    const size = Number.parseInt(field(header, 48, 10), 10)
    if (!Number.isFinite(size) || size < 0) throw new ArchiveFormatError(`Invalid ar member size at byte ${position}.`)
    let dataOffset = position + HEADER_SIZE
    let dataSize = size
    if (dataOffset + size > source.size) throw new ArchiveFormatError(`Truncated ar archive: member at byte ${position} runs past the end.`)

    const trimmed = rawName.trimEnd()
    let name: string
    if (trimmed.startsWith('#1/')) {
      // BSD: the real name is stored at the start of the data.
      const nameLength = Number.parseInt(trimmed.slice(3), 10)
      if (!Number.isFinite(nameLength) || nameLength < 0 || nameLength > size) throw new ArchiveFormatError(`Invalid BSD ar name length at byte ${position}.`)
      name = source.read(dataOffset, nameLength).toString('utf8').replace(/\0+$/, '')
      dataOffset += nameLength
      dataSize -= nameLength
    } else if (trimmed === '//') {
      longNames = source.read(dataOffset, size).toString('utf8')
      name = '//'
    } else if (trimmed === '/' || trimmed === '/SYM64/') {
      name = trimmed
    } else if (/^\/\d+$/.test(trimmed)) {
      const index = Number.parseInt(trimmed.slice(1), 10)
      if (longNames === null) throw new ArchiveFormatError('GNU ar long name used before the name table.')
      const end = longNames.indexOf('/\n', index)
      name = longNames.slice(index, end === -1 ? undefined : end)
    } else {
      // GNU terminates names with '/', plain System V ar pads with spaces.
      name = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
    }

    if (name !== '/' && name !== '//' && name !== '/SYM64/') members.push({ name, offset: dataOffset, size: dataSize })
    position += HEADER_SIZE + size + (size % 2)
  }
  return members
}

export type TarCompression = 'xz' | 'zst' | 'gz' | 'bz2' | 'none'

/** The `data.tar.*` member of a Debian package and how it is compressed. */
export function findDebDataMember(members: readonly ArMember[]): { member: ArMember; compression: TarCompression } {
  const member = members.find((m) => /^data\.tar(\.(xz|zst|gz|bz2))?$/.test(m.name))
  if (!member) {
    throw new ArchiveFormatError(`Not a Debian package: no data.tar.* member (found ${members.map((m) => m.name).join(', ') || 'nothing'}).`)
  }
  const extension = member.name.slice('data.tar'.length).replace(/^\./, '')
  const compression: TarCompression = extension === '' ? 'none' : (extension as TarCompression)
  return { member, compression }
}

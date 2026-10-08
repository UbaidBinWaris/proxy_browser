/**
 * Test-only builders for the archive formats the installers read: `ar` (Debian
 * packages), raw ustar headers (for malicious-entry cases) and ZIP (stored and
 * deflated entries with Unix modes). Real tarballs come from the system `tar`.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

export interface ArInput {
  name: string
  data: Buffer
}

function arHeader(name: string, size: number): Buffer {
  const field = (value: string, width: number): string => value.padEnd(width, ' ').slice(0, width)
  return Buffer.from(`${field(name, 16)}${field('0', 12)}${field('0', 6)}${field('0', 6)}${field('100644', 8)}${field(String(size), 10)}\`\n`, 'latin1')
}

/** GNU-style ar: names end with '/', names longer than 15 bytes go through the '//' table. */
export function gnuAr(members: readonly ArInput[]): Buffer {
  const parts: Buffer[] = [Buffer.from('!<arch>\n', 'latin1')]
  const longNames = members.filter((m) => m.name.length > 15)
  let table = ''
  const offsets = new Map<string, number>()
  for (const member of longNames) {
    offsets.set(member.name, table.length)
    table += `${member.name}/\n`
  }
  const push = (header: Buffer, data: Buffer): void => {
    parts.push(header, data)
    if (data.length % 2 === 1) parts.push(Buffer.from('\n'))
  }
  if (table) push(arHeader('//', table.length), Buffer.from(table, 'latin1'))
  for (const member of members) {
    const name = offsets.has(member.name) ? `/${offsets.get(member.name) ?? 0}` : `${member.name}/`
    push(arHeader(name, member.data.length), member.data)
  }
  return Buffer.concat(parts)
}

/** BSD-style ar: "#1/<len>" with the name stored in front of the data. */
export function bsdAr(members: readonly ArInput[]): Buffer {
  const parts: Buffer[] = [Buffer.from('!<arch>\n', 'latin1')]
  for (const member of members) {
    const name = Buffer.from(member.name, 'utf8')
    const data = Buffer.concat([name, member.data])
    parts.push(arHeader(`#1/${name.length}`, data.length), data)
    if (data.length % 2 === 1) parts.push(Buffer.from('\n'))
  }
  return Buffer.concat(parts)
}

/** One raw ustar header block (checksum computed). */
export function ustarHeader(name: string, size: number, type = '0', mode = 0o644, linkname = ''): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 'latin1')
  header.write('0000000\0', 108, 'latin1')
  header.write('0000000\0', 116, 'latin1')
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1')
  header.write(`${'0'.padStart(11, '0')}\0`, 136, 'latin1')
  header.write('        ', 148, 'latin1')
  header.write(type, 156, 'latin1')
  header.write(linkname, 157, 100, 'utf8')
  header.write('ustar\0', 257, 'latin1')
  header.write('00', 263, 'latin1')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
  return header
}

/** A file entry (header + padded data). */
export function ustarFile(name: string, data: Buffer, mode = 0o644): Buffer {
  const padding = (512 - (data.length % 512)) % 512
  return Buffer.concat([ustarHeader(name, data.length, '0', mode), data, Buffer.alloc(padding)])
}

export const TAR_END = Buffer.alloc(1024)

export interface ZipInput {
  name: string
  data: Buffer
  /** Unix permission bits (regular file unless `symlink`). */
  mode?: number
  method: 0 | 8
  symlink?: boolean
}

/** A minimal ZIP with Unix "version made by" so modes travel in the external attributes. */
export function zipArchive(entries: readonly ZipInput[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const compressed = entry.method === 8 ? zlib.deflateRawSync(entry.data) : entry.data
    const crc = zlib.crc32(entry.data) >>> 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(entry.method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, compressed)

    const type = entry.symlink ? 0o120000 : entry.name.endsWith('/') ? 0o040000 : 0o100000
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(entry.method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((type | (entry.mode ?? 0o644)) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + compressed.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

export interface TreeFile {
  path: string
  content: Buffer | string
  mode?: number
}

/** Build a gzip tarball of `files` with the system tar (as a .deb's data.tar.gz). */
export function systemTarGz(files: readonly TreeFile[], extraArgs: readonly string[] = []): Buffer {
  const work = mkdtempSync(path.join(tmpdir(), 'proxyqa-tar-'))
  try {
    const tree = path.join(work, 'tree')
    for (const file of files) {
      const target = path.join(tree, file.path)
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, file.content)
      chmodSync(target, file.mode ?? 0o644)
    }
    const out = path.join(work, 'data.tar.gz')
    execFileSync('tar', ['-czf', out, ...extraArgs, '-C', tree, '.'])
    return readFileSync(out)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** A Debian package: debian-binary, control.tar.gz, data.tar.gz. */
export function fakeDeb(dataTarGz: Buffer): Buffer {
  return gnuAr([
    { name: 'debian-binary', data: Buffer.from('2.0\n') },
    { name: 'control.tar.gz', data: zlib.gzipSync(TAR_END) },
    { name: 'data.tar.gz', data: dataTarGz },
  ])
}

/** A fetch that serves fixed bodies by URL (404 otherwise) and records what was requested. */
export function fakeFetch(routes: Record<string, Buffer | string | object>): { fetch: (url: string) => Promise<Response>; requested: string[] } {
  const requested: string[] = []
  return {
    requested,
    fetch: async (url: string): Promise<Response> => {
      requested.push(url)
      const body = routes[url]
      if (body === undefined) return new Response('not found', { status: 404 })
      if (Buffer.isBuffer(body)) return new Response(new Uint8Array(body), { status: 200, headers: { 'content-length': String(body.length) } })
      if (typeof body === 'string') return new Response(body, { status: 200 })
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  }
}

/**
 * Reads the file version of a Windows executable WITHOUT running it.
 *
 * Why: `chrome.exe --version` (and msedge/brave/opera/vivaldi) does not print a
 * version on Windows — it opens a browser window and keeps running. Detection
 * must therefore never execute a browser binary on Windows.
 *
 * How: every Chromium-family installer stamps a VERSIONINFO resource into the
 * executable. Its fixed part, VS_FIXEDFILEINFO, starts with the signature
 * 0xFEEF04BD followed by dwStrucVersion and dwFileVersionMS/LS. The PE headers
 * are parsed (DOS e_lfanew → "PE\0\0" → COFF header → optional header PE32 or
 * PE32+ → resource data directory / section table) to find the resource
 * section, which is read with positioned reads (no need to load a 4 MB binary)
 * and scanned for the signature.
 *
 * Fallback: Chromium-family installs keep a directory named after the version
 * next to the executable (…\Application\154.0.8037.97\); the highest dotted
 * version among the sibling directories is used when the resource is missing.
 *
 * Everything except the two file-reading helpers is pure and unit-tested with a
 * synthetic PE image built in the test.
 */
import { open, readdir } from 'node:fs/promises'
import path from 'node:path'

/** VS_FIXEDFILEINFO.dwSignature. */
export const VS_FIXEDFILEINFO_SIGNATURE = 0xfeef04bd
/** VS_FIXEDFILEINFO.dwStrucVersion of every VERSIONINFO written since Windows 3.1 (1.0). */
const VS_STRUC_VERSION = 0x00010000
/** Resource sections larger than this are not read (real browsers carry a few hundred KB). */
export const MAX_RESOURCE_BYTES = 64 * 1024 * 1024
const PE32_MAGIC = 0x10b
const PE32_PLUS_MAGIC = 0x20b
const RESOURCE_DIRECTORY_INDEX = 2

/** Random-access view of a file (a Buffer in tests, positioned reads in production). */
export interface ByteSource {
  readonly size: number
  read(offset: number, length: number): Promise<Buffer>
}

export function bufferSource(buffer: Buffer): ByteSource {
  return {
    size: buffer.length,
    read: async (offset, length) => buffer.subarray(Math.max(0, offset), Math.min(buffer.length, offset + length)),
  }
}

export interface PeSection {
  name: string
  virtualAddress: number
  virtualSize: number
  rawOffset: number
  rawSize: number
}

export interface PeLayout {
  /** 'pe32' (32-bit) or 'pe32+' (64-bit). */
  format: 'pe32' | 'pe32+'
  sections: PeSection[]
  /** RVA of the resource directory from the optional header's data directory, or null. */
  resourceRva: number | null
}

/** Parse the headers of a PE image; null when the bytes are not a PE file. */
export async function readPeLayout(source: ByteSource): Promise<PeLayout | null> {
  if (source.size < 64) return null
  const dos = await source.read(0, 64)
  if (dos.length < 64 || dos.toString('latin1', 0, 2) !== 'MZ') return null
  const peOffset = dos.readUInt32LE(0x3c)
  if (peOffset <= 0 || peOffset + 24 > source.size) return null
  const coff = await source.read(peOffset, 24)
  if (coff.length < 24 || coff.readUInt32LE(0) !== 0x00004550) return null
  const sectionCount = coff.readUInt16LE(6)
  const optionalSize = coff.readUInt16LE(20)
  if (sectionCount === 0 || sectionCount > 96) return null
  const optionalOffset = peOffset + 24
  const optional = await source.read(optionalOffset, optionalSize)
  if (optional.length < 2) return null
  const magic = optional.readUInt16LE(0)
  if (magic !== PE32_MAGIC && magic !== PE32_PLUS_MAGIC) return null
  const format = magic === PE32_MAGIC ? 'pe32' : 'pe32+'
  const countOffset = format === 'pe32' ? 92 : 108
  const directoriesOffset = format === 'pe32' ? 96 : 112
  let resourceRva: number | null = null
  if (optional.length >= countOffset + 4) {
    const directoryCount = optional.readUInt32LE(countOffset)
    const entry = directoriesOffset + RESOURCE_DIRECTORY_INDEX * 8
    if (directoryCount > RESOURCE_DIRECTORY_INDEX && optional.length >= entry + 8) {
      const rva = optional.readUInt32LE(entry)
      resourceRva = rva > 0 ? rva : null
    }
  }
  const table = await source.read(optionalOffset + optionalSize, sectionCount * 40)
  const sections: PeSection[] = []
  for (let index = 0; index < sectionCount && (index + 1) * 40 <= table.length; index += 1) {
    const base = index * 40
    sections.push({
      name: table.toString('latin1', base, base + 8).replace(/\0+$/, ''),
      virtualSize: table.readUInt32LE(base + 8),
      virtualAddress: table.readUInt32LE(base + 12),
      rawSize: table.readUInt32LE(base + 16),
      rawOffset: table.readUInt32LE(base + 20),
    })
  }
  return { format, sections, resourceRva }
}

/** The section holding the resources: the one the data directory points into, else the one named `.rsrc`. */
export function resourceSection(layout: PeLayout): PeSection | null {
  if (layout.resourceRva !== null) {
    const rva = layout.resourceRva
    const containing = layout.sections.find((section) => rva >= section.virtualAddress && rva < section.virtualAddress + Math.max(section.virtualSize, section.rawSize))
    if (containing) return containing
  }
  return layout.sections.find((section) => section.name === '.rsrc') ?? null
}

/** "a.b.c.d" from the first valid VS_FIXEDFILEINFO in `bytes`, or null. */
export function findFixedFileVersion(bytes: Buffer): string | null {
  for (let offset = 0; offset + 16 <= bytes.length; offset += 4) {
    if (bytes.readUInt32LE(offset) !== VS_FIXEDFILEINFO_SIGNATURE) continue
    const strucVersion = bytes.readUInt32LE(offset + 4)
    if (strucVersion !== VS_STRUC_VERSION && strucVersion !== 0) continue
    const ms = bytes.readUInt32LE(offset + 8)
    const ls = bytes.readUInt32LE(offset + 12)
    if (ms === 0 && ls === 0) continue
    return `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`
  }
  return null
}

/** File version of a PE image (from its resource section), or null when it has none / is not a PE file. */
export async function readPeVersion(source: ByteSource): Promise<string | null> {
  const layout = await readPeLayout(source)
  if (!layout) return null
  const section = resourceSection(layout)
  if (!section || section.rawSize === 0 || section.rawOffset >= source.size) return null
  const length = Math.min(section.rawSize, MAX_RESOURCE_BYTES, source.size - section.rawOffset)
  return findFixedFileVersion(await source.read(section.rawOffset, length))
}

/** Positioned-read view of a file on disk. The caller closes it. */
async function fileSource(filePath: string): Promise<ByteSource & { close(): Promise<void> }> {
  const handle = await open(filePath, 'r')
  const { size } = await handle.stat()
  return {
    size,
    read: async (offset, length) => {
      const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - offset)))
      if (buffer.length === 0) return buffer
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      return buffer.subarray(0, bytesRead)
    },
    close: () => handle.close(),
  }
}

/** File version stamped into a Windows executable; null on any failure (never throws). */
export async function readPeFileVersion(filePath: string): Promise<string | null> {
  let source: (ByteSource & { close(): Promise<void> }) | null = null
  try {
    source = await fileSource(filePath)
    return await readPeVersion(source)
  } catch {
    return null
  } finally {
    await source?.close().catch(() => undefined)
  }
}

const DOTTED_VERSION = /^\d+(?:\.\d+){1,3}$/

/** Compare two dotted versions numerically ("154.0.10.1" > "154.0.9.99"). */
export function compareDottedVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export interface DirEntryLike {
  name: string
  isDirectory: boolean
}

/** The highest dotted-version directory name among `entries` (Chromium install layout), or null. */
export function versionFromSiblingDirs(entries: readonly DirEntryLike[]): string | null {
  const versions = entries.filter((entry) => entry.isDirectory && DOTTED_VERSION.test(entry.name)).map((entry) => entry.name)
  if (versions.length === 0) return null
  return versions.sort(compareDottedVersions)[versions.length - 1] ?? null
}

/** Version from the directories next to `executablePath`; null on any failure. */
export async function readSiblingDirVersion(executablePath: string): Promise<string | null> {
  try {
    const entries = await readdir(path.dirname(executablePath), { withFileTypes: true })
    return versionFromSiblingDirs(entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() })))
  } catch {
    return null
  }
}

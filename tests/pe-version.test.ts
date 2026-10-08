/**
 * Non-executing version reads for Windows executables: a synthetic minimal PE
 * image (DOS header → PE header → optional header PE32/PE32+ → section table
 * with .text and .rsrc, a VS_FIXEDFILEINFO inside .rsrc) is built here, plus
 * the Chromium "version directory next to the exe" fallback.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  VS_FIXEDFILEINFO_SIGNATURE,
  bufferSource,
  compareDottedVersions,
  findFixedFileVersion,
  readPeFileVersion,
  readPeLayout,
  readPeVersion,
  readSiblingDirVersion,
  resourceSection,
  versionFromSiblingDirs,
} from '../src/main/browser/pe-version'

interface PeOptions {
  format?: 'pe32' | 'pe32+'
  /** File version a.b.c.d stamped into .rsrc; null leaves the resource without VERSIONINFO. */
  version?: [number, number, number, number] | null
  /** Point the resource data directory at .rsrc (true) or leave it empty so only the section name finds it. */
  dataDirectory?: boolean
  rsrcName?: string
}

const PE_OFFSET = 0x80
const TEXT_RAW = 0x400
const RSRC_RAW = 0x600
const RSRC_SIZE = 0x400

function fixedFileInfo(version: [number, number, number, number], strucVersion = 0x00010000): Buffer {
  const info = Buffer.alloc(52)
  info.writeUInt32LE(VS_FIXEDFILEINFO_SIGNATURE, 0)
  info.writeUInt32LE(strucVersion, 4)
  info.writeUInt32LE(((version[0] << 16) | version[1]) >>> 0, 8)
  info.writeUInt32LE(((version[2] << 16) | version[3]) >>> 0, 12)
  return info
}

/** A minimal but structurally valid PE image. */
function buildPe(options: PeOptions = {}): Buffer {
  const format = options.format ?? 'pe32+'
  const version: [number, number, number, number] | null = options.version === undefined ? [154, 0, 8037, 97] : options.version
  const optionalSize = format === 'pe32+' ? 240 : 224
  const image = Buffer.alloc(RSRC_RAW + RSRC_SIZE)
  image.write('MZ', 0, 'latin1')
  image.writeUInt32LE(PE_OFFSET, 0x3c)
  image.write('PE\0\0', PE_OFFSET, 'latin1')
  image.writeUInt16LE(format === 'pe32+' ? 0x8664 : 0x14c, PE_OFFSET + 4)
  image.writeUInt16LE(2, PE_OFFSET + 6)
  image.writeUInt16LE(optionalSize, PE_OFFSET + 20)
  const optional = PE_OFFSET + 24
  image.writeUInt16LE(format === 'pe32+' ? 0x20b : 0x10b, optional)
  image.writeUInt32LE(16, optional + (format === 'pe32+' ? 108 : 92))
  if (options.dataDirectory ?? true) {
    const entry = optional + (format === 'pe32+' ? 112 : 96) + 2 * 8
    image.writeUInt32LE(0x2000 + 0x10, entry)
    image.writeUInt32LE(RSRC_SIZE - 0x10, entry + 4)
  }
  const table = optional + optionalSize
  const section = (index: number, name: string, va: number, raw: number, size: number): void => {
    const base = table + index * 40
    image.write(name, base, 'latin1')
    image.writeUInt32LE(size, base + 8)
    image.writeUInt32LE(va, base + 12)
    image.writeUInt32LE(size, base + 16)
    image.writeUInt32LE(raw, base + 20)
  }
  section(0, '.text', 0x1000, TEXT_RAW, 0x200)
  section(1, options.rsrcName ?? '.rsrc', 0x2000, RSRC_RAW, RSRC_SIZE)
  // A signature in code must never be mistaken for the version resource.
  fixedFileInfo([1, 2, 3, 4]).copy(image, TEXT_RAW + 0x20)
  // Inside .rsrc: first a stray signature with an invalid dwStrucVersion, then the real VS_FIXEDFILEINFO.
  fixedFileInfo([9, 9, 9, 9], 0x12345678).copy(image, RSRC_RAW + 0x40)
  if (version) fixedFileInfo(version).copy(image, RSRC_RAW + 0x100)
  return image
}

let work: string
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'proxyqa-pe-'))
})
afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

describe('PE VERSIONINFO reader', () => {
  it('parses the headers of PE32+ and PE32 images and finds the resource section', async () => {
    for (const format of ['pe32+', 'pe32'] as const) {
      const layout = await readPeLayout(bufferSource(buildPe({ format })))
      expect(layout).toMatchObject({ format, resourceRva: 0x2010 })
      expect(layout?.sections.map((s) => s.name)).toEqual(['.text', '.rsrc'])
      expect(layout ? resourceSection(layout) : null).toMatchObject({ name: '.rsrc', rawOffset: RSRC_RAW, rawSize: RSRC_SIZE })
    }
  })

  it('reads a.b.c.d from VS_FIXEDFILEINFO in .rsrc only, skipping invalid signatures', async () => {
    expect(await readPeVersion(bufferSource(buildPe()))).toBe('154.0.8037.97')
    expect(await readPeVersion(bufferSource(buildPe({ format: 'pe32', version: [141, 1, 96, 61] })))).toBe('141.1.96.61')
    // Without a data directory entry the section is found by its name.
    expect(await readPeVersion(bufferSource(buildPe({ dataDirectory: false, version: [118, 0, 5461, 60] })))).toBe('118.0.5461.60')
    // The data directory wins over the name (packers rename sections).
    expect(await readPeVersion(bufferSource(buildPe({ rsrcName: '.data2' })))).toBe('154.0.8037.97')
    // No VERSIONINFO in the resources: the signature in .text is not used.
    expect(await readPeVersion(bufferSource(buildPe({ version: null })))).toBeNull()
  })

  it('returns null for anything that is not a PE image', async () => {
    expect(await readPeVersion(bufferSource(Buffer.from('#!/bin/sh\necho hi\n')))).toBeNull()
    expect(await readPeVersion(bufferSource(Buffer.alloc(0)))).toBeNull()
    const noPeSignature = buildPe()
    noPeSignature.write('XX', PE_OFFSET, 'latin1')
    expect(await readPeVersion(bufferSource(noPeSignature))).toBeNull()
    const pointsOutside = buildPe()
    pointsOutside.writeUInt32LE(0xffffff, 0x3c)
    expect(await readPeVersion(bufferSource(pointsOutside))).toBeNull()
    const truncated = buildPe().subarray(0, RSRC_RAW + 0x80)
    expect(await readPeVersion(bufferSource(truncated))).toBeNull()
  })

  it('findFixedFileVersion validates dwStrucVersion and ignores all-zero versions', () => {
    expect(findFixedFileVersion(Buffer.concat([Buffer.alloc(8), fixedFileInfo([7, 1, 3570, 42])]))).toBe('7.1.3570.42')
    expect(findFixedFileVersion(fixedFileInfo([0, 0, 0, 0]))).toBeNull()
    expect(findFixedFileVersion(fixedFileInfo([5, 0, 0, 0], 0xdeadbeef))).toBeNull()
    expect(findFixedFileVersion(Buffer.alloc(3))).toBeNull()
  })

  it('reads a real file with positioned reads and never throws for missing or unreadable files', async () => {
    const exe = path.join(work, 'chrome.exe')
    writeFileSync(exe, buildPe({ version: [155, 0, 8059, 40] }))
    expect(await readPeFileVersion(exe)).toBe('155.0.8059.40')
    expect(await readPeFileVersion(path.join(work, 'missing.exe'))).toBeNull()
    expect(await readPeFileVersion(work)).toBeNull()
  })
})

describe('version directory next to the executable (Chromium install layout)', () => {
  it('picks the highest dotted-version directory, ignoring files and other names', () => {
    expect(
      versionFromSiblingDirs([
        { name: '153.0.8010.52', isDirectory: true },
        { name: '154.0.8037.97', isDirectory: true },
        { name: '154.0.10.1', isDirectory: true },
        { name: '999.0.0.0', isDirectory: false },
        { name: 'SetupMetrics', isDirectory: true },
        { name: 'chrome.exe', isDirectory: false },
      ]),
    ).toBe('154.0.8037.97')
    expect(versionFromSiblingDirs([{ name: 'Dictionaries', isDirectory: true }])).toBeNull()
    expect(compareDottedVersions('154.0.10.1', '154.0.9.99')).toBeGreaterThan(0)
    expect(compareDottedVersions('1.2', '1.2.0.0')).toBe(0)
  })

  it('reads the directory listing of the executable folder', async () => {
    const app = path.join(work, 'Application')
    mkdirSync(path.join(app, '154.0.8037.97'), { recursive: true })
    mkdirSync(path.join(app, '153.0.8010.52'))
    writeFileSync(path.join(app, 'chrome.exe'), 'x')
    expect(await readSiblingDirVersion(path.join(app, 'chrome.exe'))).toBe('154.0.8037.97')
    expect(await readSiblingDirVersion(path.join(work, 'nowhere', 'chrome.exe'))).toBeNull()
  })
})

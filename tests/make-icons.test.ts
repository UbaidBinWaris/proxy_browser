import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import { beforeAll, describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '..')
const SCRIPT = join(ROOT, 'scripts', 'make-icons.mjs')
const ICONS_DIR = join(ROOT, 'build', 'icons')
const RENDERER_ICON = join(ROOT, 'src', 'renderer', 'src', 'assets', 'app-icon.png')

interface PngInfo {
  width: number
  height: number
  bitDepth: number
  colorType: number
}

interface IcoEntry {
  width: number
  height: number
  bitCount: number
  data: Buffer
}

interface IconsModule {
  ICON_SIZES: number[]
  ICO_SIZES: number[]
  SMALL_ICON_MAX: number
  sourceFor(size: number): string
  pageFor(svg: string, size: number): string
  crc32(buf: Buffer): number
  encodePng(rgba: Buffer, width: number, height: number): Buffer
  readPngInfo(png: Buffer): PngInfo
  encodeIco(images: Array<{ png: Buffer; size: number }>): Buffer
  readIco(ico: Buffer): IcoEntry[]
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function readChunks(png: Buffer): Array<{ type: string; data: Buffer; crc: number }> {
  const chunks: Array<{ type: string; data: Buffer; crc: number }> = []
  let offset = 8
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.subarray(offset + 4, offset + 8).toString('ascii')
    const data = png.subarray(offset + 8, offset + 8 + length)
    const crc = png.readUInt32BE(offset + 8 + length)
    chunks.push({ type, data, crc })
    offset += 12 + length
  }
  return chunks
}

/** Decode an 8-bit RGBA, non-interlaced PNG (any filter types) into raw pixels. */
function decodeRgba(png: Buffer): { width: number; height: number; pixels: Buffer } {
  const chunks = readChunks(png)
  const ihdr = chunks.find((c) => c.type === 'IHDR')!.data
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  expect(ihdr[8]).toBe(8)
  expect(ihdr[9]).toBe(6)
  expect(ihdr[12]).toBe(0)
  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)))
  const stride = width * 4
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x]!
      const a = x >= 4 ? pixels[y * stride + x - 4]! : 0
      const b = y > 0 ? pixels[(y - 1) * stride + x]! : 0
      const c = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4]! : 0
      let predictor = 0
      if (filter === 1) predictor = a
      else if (filter === 2) predictor = b
      else if (filter === 3) predictor = (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      pixels[y * stride + x] = (value + predictor) & 0xff
    }
  }
  return { width, height, pixels }
}

describe('make-icons', () => {
  let mod: IconsModule

  beforeAll(async () => {
    mod = (await import(SCRIPT)) as IconsModule
  })

  it('computes the standard CRC-32 of "123456789"', () => {
    expect(mod.crc32(Buffer.from('123456789', 'ascii'))).toBe(0xcbf43926)
  })

  it('encodes a valid PNG with matching IHDR, CRCs and pixel payload', () => {
    const width = 3
    const height = 2
    const rgba = Buffer.alloc(width * height * 4)
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37) & 0xff

    const png = mod.encodePng(rgba, width, height)
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)

    const chunks = readChunks(png)
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
    expect(mod.readPngInfo(png)).toEqual({ width, height, bitDepth: 8, colorType: 6 })

    for (const c of chunks) {
      const expectedCrc = mod.crc32(Buffer.concat([Buffer.from(c.type, 'ascii'), c.data]))
      expect(c.crc).toBe(expectedCrc)
    }
    expect(decodeRgba(png).pixels.equals(rgba)).toBe(true)
  })

  it('rejects non-PNG input', () => {
    expect(() => mod.readPngInfo(Buffer.from('not a png at all, definitely not one'))).toThrow('Not a PNG')
  })

  it('packs several PNGs into a multi-size ICO sorted by size (256 encoded as 0)', () => {
    const images = [256, 16, 48].map((size) => ({ size, png: mod.encodePng(Buffer.alloc(size * size * 4, 0x80), size, size) }))
    const ico = mod.encodeIco(images)

    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBe(3)
    expect(ico[6]).toBe(16)
    expect(ico[6 + 32]).toBe(0)
    expect(ico.readUInt32LE(6 + 12)).toBe(6 + 16 * 3)

    const entries = mod.readIco(ico)
    expect(entries.map((e) => e.width)).toEqual([16, 48, 256])
    for (const entry of entries) {
      expect(entry.bitCount).toBe(32)
      expect(entry.data.equals(images.find((i) => i.size === entry.width)!.png)).toBe(true)
    }
  })

  it('draws 16–32 px from the simplified source and larger sizes from the full mark', () => {
    expect(mod.ICON_SIZES).toEqual([16, 24, 32, 48, 64, 128, 256, 512])
    expect(mod.ICO_SIZES).toEqual([16, 24, 32, 48, 64, 128, 256])
    expect(mod.ICON_SIZES.filter((size) => mod.sourceFor(size) === 'icon-small.svg')).toEqual([16, 24, 32])
    expect(mod.sourceFor(48)).toBe('icon.svg')
    const page = mod.pageFor('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"></svg>', 24)
    expect(page).toContain('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 512 512">')
    expect(page).toContain('background:transparent')
  })

  describe('committed icon set (regenerate with `node scripts/make-icons.mjs`)', () => {
    it('keeps vector sources for the application tile, browser frame and route mark', () => {
      for (const name of ['icon.svg', 'icon-small.svg']) {
        const svg = readFileSync(join(ICONS_DIR, name), 'utf8')
        expect(svg).toContain('viewBox="0 0 512 512"')
        expect(svg).toContain('#25319C')
        expect(svg).toContain('#FFFFFF')
        expect(svg).toMatch(/<rect\b/)
        expect(svg).toMatch(/<path\b/)
        expect(svg).toMatch(/<circle\b/)
      }
    })

    it('has 512 and 256 px RGBA PNGs and the 64 px renderer asset', () => {
      for (const [file, size] of [
        [join(ICONS_DIR, 'icon.png'), 512],
        [join(ICONS_DIR, '256.png'), 256],
        [RENDERER_ICON, 64],
      ] as const) {
        expect(existsSync(file)).toBe(true)
        expect(mod.readPngInfo(readFileSync(file))).toEqual({ width: size, height: size, bitDepth: 8, colorType: 6 })
      }
    })

    it('has a multi-size ICO with PNG entries for 16–256 px (including 256)', () => {
      const entries = mod.readIco(readFileSync(join(ICONS_DIR, 'icon.ico')))
      expect(entries.length).toBeGreaterThanOrEqual(6)
      expect(entries.map((e) => e.width)).toEqual([16, 24, 32, 48, 64, 128, 256])
      for (const entry of entries) {
        expect(entry.height).toBe(entry.width)
        expect(entry.bitCount).toBe(32)
        expect(mod.readPngInfo(entry.data)).toEqual({ width: entry.width, height: entry.height, bitDepth: 8, colorType: 6 })
      }
      // The 256 entry is the same rendering as 256.png.
      expect(entries.at(-1)!.data.equals(readFileSync(join(ICONS_DIR, '256.png')))).toBe(true)
    })

    it('renders a transparent outside, opaque indigo tile and a legible browser route mark', () => {
      const { width, pixels } = decodeRgba(readFileSync(join(ICONS_DIR, 'icon.png')))
      const pixel = (x: number, y: number): number[] => {
        const i = (y * width + x) * 4
        return [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!, pixels[i + 3]!]
      }
      // Corner outside the rounded square: fully transparent (omitBackground).
      expect(pixel(2, 2)[3]).toBe(0)
      // Opaque indigo tile.
      const tile = pixel(256, 40)
      expect(tile[3]).toBe(255)
      expect(tile[2]!).toBeGreaterThan(tile[0]!)
      // Mint route contrasted against the tile.
      const route = pixel(242, 291)
      expect(route[3]).toBe(255)
      expect(route[1]!).toBeGreaterThan(220)
      expect(route[0]!).toBeLessThan(210)
      // Browser frame and header divider remain white.
      expect(pixel(102, 256)).toEqual([255, 255, 255, 255])
      expect(pixel(256, 192)).toEqual([255, 255, 255, 255])
    })
  })
})

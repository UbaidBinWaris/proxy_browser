#!/usr/bin/env node
/**
 * Rasterizes the app mark (build/icons/icon.svg, plus build/icons/icon-small.svg for 16–32 px)
 * with the Playwright Chromium the project already uses, and writes:
 *
 *   build/icons/icon.png                 512×512 RGBA PNG (Linux AppImage icon, Linux window icon)
 *   build/icons/256.png                  256×256 RGBA PNG
 *   build/icons/icon.ico                 multi-size ICO (16, 24, 32, 48, 64, 128, 256; PNG-compressed
 *                                        entries, valid on Windows Vista and later)
 *   build/icons/icon.icns                macOS icon family (16–512 pt plus the @2x Retina variants up to
 *                                        1024 px; PNG elements, the format `iconutil` writes since 10.7)
 *   src/renderer/src/assets/app-icon.png 64×64 RGBA PNG (sidebar / setup / keys window header)
 *
 * Each size is rendered in a page of exactly that size and captured with a transparent
 * background (`omitBackground: true`), so every size is rasterized from vectors rather than
 * downscaled from 512.
 *
 * The Chromium build is the one playwright-core resolves (~/.cache/ms-playwright, or
 * PLAYWRIGHT_BROWSERS_PATH); run `npm run browsers:install` first on a fresh machine.
 *
 * Usage: node scripts/make-icons.mjs
 */
/* global process, Buffer */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ICONS_DIR = join(ROOT, 'build', 'icons')
const RENDERER_ASSET = join(ROOT, 'src', 'renderer', 'src', 'assets', 'app-icon.png')

/** Every size rasterized; the ICO embeds all of them up to 256, the ICNS its own subset up to 1024. */
export const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
export const ICO_SIZES = ICON_SIZES.filter((size) => size <= 256)
/**
 * ICNS element types with PNG payloads and their pixel sizes: `icp4`/`icp5` are 16/32 pt at 1x,
 * `ic11`–`ic14` and `ic10` the Retina (@2x) variants of 16, 32, 128, 256 and 512 pt.
 */
export const ICNS_ENTRIES = [
  ['icp4', 16],
  ['icp5', 32],
  ['ic11', 32],
  ['ic12', 64],
  ['ic07', 128],
  ['ic13', 256],
  ['ic08', 256],
  ['ic14', 512],
  ['ic09', 512],
  ['ic10', 1024],
]
/** Sizes drawn from the simplified source (heavier strokes, larger badge). */
export const SMALL_ICON_MAX = 32

export function sourceFor(size) {
  return size <= SMALL_ICON_MAX ? 'icon-small.svg' : 'icon.svg'
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

export function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crc])
}

/** Encode raw RGBA pixels as an 8-bit RGBA PNG. */
export function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter type: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const idat = deflateSync(raw, { level: 9 })
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

/** Width, height, bit depth and colour type from a PNG's IHDR (throws on anything that is not a PNG). */
export function readPngInfo(png) {
  if (png.length < 33 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error('Not a PNG file')
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), bitDepth: png[24], colorType: png[25] }
}

// ---------------------------------------------------------------------------
// ICO (PNG-compressed entries)
// ---------------------------------------------------------------------------

/** Pack PNG images into an ICO container; entries are sorted from small to large. */
export function encodeIco(pngBuffers) {
  const images = [...pngBuffers].sort((a, b) => a.size - b.size)
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)

  const entries = []
  let offset = 6 + 16 * images.length
  for (const { png, size } of images) {
    const entry = Buffer.alloc(16)
    entry[0] = size >= 256 ? 0 : size // 0 means 256
    entry[1] = size >= 256 ? 0 : size
    entry[2] = 0 // palette colours
    entry[3] = 0 // reserved
    entry.writeUInt16LE(1, 4) // colour planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += png.length
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)])
}

/** Directory entries of an ICO file with their embedded image bytes. */
export function readIco(ico) {
  if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) throw new Error('Not an ICO file')
  const count = ico.readUInt16LE(4)
  const entries = []
  for (let i = 0; i < count; i++) {
    const base = 6 + 16 * i
    const length = ico.readUInt32LE(base + 8)
    const offset = ico.readUInt32LE(base + 12)
    entries.push({
      width: ico[base] === 0 ? 256 : ico[base],
      height: ico[base + 1] === 0 ? 256 : ico[base + 1],
      bitCount: ico.readUInt16LE(base + 6),
      data: ico.subarray(offset, offset + length),
    })
  }
  return entries
}

// ---------------------------------------------------------------------------
// ICNS (PNG elements)
// ---------------------------------------------------------------------------

/** Pack `{ type, png }` elements into an ICNS container (big-endian lengths that include each 8-byte header). */
export function encodeIcns(elements) {
  const parts = elements.map(({ type, png }) => {
    if (!/^[a-z0-9]{4}$/i.test(type)) throw new Error(`Invalid ICNS element type: ${type}`)
    const header = Buffer.alloc(8)
    header.write(type, 0, 'ascii')
    header.writeUInt32BE(png.length + 8, 4)
    return Buffer.concat([header, png])
  })
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'ascii')
  header.writeUInt32BE(8 + parts.reduce((total, part) => total + part.length, 0), 4)
  return Buffer.concat([header, ...parts])
}

/** Elements of an ICNS file; throws when the container or an element length is inconsistent. */
export function readIcns(icns) {
  if (icns.length < 8 || icns.subarray(0, 4).toString('ascii') !== 'icns' || icns.readUInt32BE(4) !== icns.length) {
    throw new Error('Not an ICNS file')
  }
  const elements = []
  let offset = 8
  while (offset < icns.length) {
    const type = icns.subarray(offset, offset + 4).toString('ascii')
    const length = offset + 8 <= icns.length ? icns.readUInt32BE(offset + 4) : 0
    if (length < 8 || offset + length > icns.length) throw new Error(`Corrupt ICNS element ${type}`)
    elements.push({ type, data: icns.subarray(offset + 8, offset + length) })
    offset += length
  }
  return elements
}

// ---------------------------------------------------------------------------
// Rasterization (Playwright Chromium)
// ---------------------------------------------------------------------------

/** HTML page showing `svg` at exactly `size`×`size` CSS pixels on a transparent page. */
export function pageFor(svg, size) {
  const sized = svg.replace(/<svg\b([^>]*?)\swidth="[^"]*"\s+height="[^"]*"/, `<svg$1 width="${size}" height="${size}"`)
  return `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block}</style></head><body>${sized}</body></html>`
}

async function rasterize(sources, sizes) {
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({ headless: true })
  try {
    const out = new Map()
    for (const size of sizes) {
      const context = await browser.newContext({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
      const page = await context.newPage()
      await page.setContent(pageFor(sources[sourceFor(size)], size))
      const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size }, type: 'png' })
      await context.close()
      const info = readPngInfo(png)
      if (info.width !== size || info.height !== size || info.colorType !== 6 || info.bitDepth !== 8) {
        throw new Error(`Unexpected ${size}px rasterization: ${JSON.stringify(info)}`)
      }
      out.set(size, png)
    }
    return out
  } finally {
    await browser.close()
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const sources = {
    'icon.svg': readFileSync(join(ICONS_DIR, 'icon.svg'), 'utf8'),
    'icon-small.svg': readFileSync(join(ICONS_DIR, 'icon-small.svg'), 'utf8'),
  }
  const pngs = await rasterize(sources, ICON_SIZES)
  const png = (size) => {
    const buffer = pngs.get(size)
    if (!buffer) throw new Error(`Missing ${size}px rendering`)
    return buffer
  }

  const files = [
    [join(ICONS_DIR, 'icon.png'), png(512)],
    [join(ICONS_DIR, '256.png'), png(256)],
    [join(ICONS_DIR, 'icon.ico'), encodeIco(ICO_SIZES.map((size) => ({ png: png(size), size })))],
    [join(ICONS_DIR, 'icon.icns'), encodeIcns(ICNS_ENTRIES.map(([type, size]) => ({ type, png: png(size) })))],
    [RENDERER_ASSET, png(64)],
  ]
  for (const [target, data] of files) {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
    process.stdout.write(`wrote ${target} (${data.length} bytes)\n`)
  }
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`make-icons failed: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  })
}

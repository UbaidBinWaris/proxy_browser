import { createHash, createPublicKey, randomUUID, timingSafeEqual, verify } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeWebStream } from 'node:stream/web'
import { z } from 'zod'

export const versionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/).refine(v => v.split('.').every(n => Number.isSafeInteger(Number(n))))
export const fileSchema = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(exe|AppImage|dmg|zip)$/).max(180)
const sizeSchema = z.int().positive().max(2 * 1024 ** 3), sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const assetSchema = z.object({ platform: z.enum(['win32', 'linux']), arch: z.literal('x64'), fileName: fileSchema.refine(name => /\.(exe|AppImage)$/.test(name)), size: sizeSchema, sha256: sha256Schema })
const assetsSchema = z.array(assetSchema).length(2).refine(a => new Set(a.map(x => x.platform)).size === 2 && new Set(a.map(x => x.fileName)).size === 2)
/**
 * Optional macOS downloads (a DMG and/or ZIP per architecture). They live in `macAssets`, not `assets`,
 * so desktop releases up to 1.4.x — which accept exactly the two Windows/Linux assets and ignore unknown
 * keys — keep verifying the same signed manifests.
 */
const macAssetSchema = z.object({ platform: z.literal('darwin'), arch: z.enum(['arm64', 'x64']), fileName: fileSchema.refine(name => /\.(dmg|zip)$/.test(name)), size: sizeSchema, sha256: sha256Schema })
const macAssetsSchema = z.array(macAssetSchema).max(4).refine(a => new Set(a.map(x => x.fileName)).size === a.length)
const APP_ID = 'com.ubaidbinwaris.proxy-qa-browser'
/** SHA-256 of identities used by releases before 1.4.0; their signed manifests remain publishable. */
const LEGACY_APP_ID_SHA256 = new Set(['75d9a5c16dc6183903353723cf75ce6289ee562066cf3aaa07ca63180d44d8be'])
const appIdSchema = z.string().max(200).refine(id => id === APP_ID || LEGACY_APP_ID_SHA256.has(createHash('sha256').update(id).digest('hex')), 'Unknown application identity.')
const manifestSchema = z.object({ format: z.literal(1), appId: appIdSchema, version: versionSchema, releasedAt: z.iso.datetime(), notes: z.array(z.string().min(1).max(500)).min(1).max(30), assets: assetsSchema, macAssets: macAssetsSchema.optional() })
const onlineSchema = manifestSchema.pick({ version: true, releasedAt: true, notes: true }).extend({ assets: z.array(assetSchema.extend({ url: z.url() })).length(2), macAssets: z.array(macAssetSchema.extend({ url: z.url() })).max(4).optional() })
type Asset = z.infer<typeof assetSchema> | z.infer<typeof macAssetSchema>
/** Every downloadable file of a release: the Windows/Linux pair plus any macOS downloads. */
export function releaseFiles(release: Release): Asset[] { return [...release.assets, ...(release.macAssets ?? [])] }
const envelopeSchema = z.object({ payload: z.string().max(65536), signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(256) })
export type Release = z.infer<typeof manifestSchema>
export class ReleaseError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
export function siteUrl() {
  const url = new URL(process.env.SITE_URL || 'https://proxybrowser.ubaidbinwaris.com')
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('SITE_URL must be a plain HTTPS origin.')
  return url.origin
}
export function storeRoot() { return resolve(/* turbopackIgnore: true */ process.env.RELEASE_ROOT || '/var/lib/proxy-browser') }
export function newer(a: string, b: string) {
  versionSchema.parse(a); versionSchema.parse(b)
  const left = a.split('.').map(Number), right = b.split('.').map(Number)
  const i = left.findIndex((n, index) => n !== right[index])
  return i >= 0 && left[i]! > right[i]!
}
export async function publicKey() { return readFile(/* turbopackIgnore: true */ resolve(/* turbopackIgnore: true */ process.env.RELEASE_PUBLIC_KEY_FILE || 'public-key.pem'), 'utf8') }
export function decodeSigned(raw: unknown, key: string) {
  const e = envelopeSchema.parse(raw), publicKey = createPublicKey(key)
  if (publicKey.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(e.payload), publicKey, Buffer.from(e.signature, 'base64'))) throw new ReleaseError(422, 'Release signature is invalid.')
  return JSON.parse(e.payload) as unknown
}
export function verifyPair(usbRaw: unknown, onlineRaw: unknown, key: string, origin: string): Release {
  const usb = manifestSchema.parse(decodeSigned(usbRaw, key)), online = onlineSchema.parse(decodeSigned(onlineRaw, key))
  if (usb.version !== online.version || usb.releasedAt !== online.releasedAt || JSON.stringify(usb.notes) !== JSON.stringify(online.notes)) throw new ReleaseError(422, 'Signed manifests disagree.')
  for (const asset of usb.assets) {
    const counterpart = online.assets.find(a => a.platform === asset.platform)
    if (!counterpart || ['arch', 'fileName', 'size', 'sha256'].some(k => counterpart[k as keyof typeof counterpart] !== asset[k as keyof typeof asset]) || counterpart.url !== `${origin}/api/download/${usb.version}/${asset.fileName}` || !asset.fileName.includes(`-${usb.version}-`) || !asset.fileName.endsWith(asset.platform === 'win32' ? '.exe' : '.AppImage')) throw new ReleaseError(422, 'Release assets or URLs disagree.')
  }
  const usbMac = usb.macAssets ?? [], onlineMac = online.macAssets ?? []
  if (usbMac.length !== onlineMac.length) throw new ReleaseError(422, 'macOS release assets disagree.')
  for (const asset of usbMac) {
    const counterpart = onlineMac.find(a => a.fileName === asset.fileName)
    if (!counterpart || counterpart.arch !== asset.arch || counterpart.size !== asset.size || counterpart.sha256 !== asset.sha256 || counterpart.url !== `${origin}/api/download/${usb.version}/${asset.fileName}` || !asset.fileName.includes(`-${usb.version}-macOS-${asset.arch}.`) || usb.assets.some(a => a.fileName === asset.fileName)) throw new ReleaseError(422, 'macOS release assets disagree.')
  }
  return usb
}
export async function boundedJson(request: Request) {
  if (!request.body) throw new ReleaseError(400, 'A JSON body is required.')
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0
  try {
    while (true) { const item = await reader.read(); if (item.done) break; bytes += item.value.length; if (bytes > 100000) throw new ReleaseError(413, 'JSON exceeds the size limit.'); chunks.push(item.value) }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } finally { await reader.cancel().catch(() => undefined) }
}
export function authorize(request: Request) {
  const token = process.env.ADMIN_TOKEN || ''
  if (token.length < 32) throw new ReleaseError(503, 'Administration is not configured.')
  const value = request.headers.get('authorization') || ''
  if (!timingSafeEqual(createHash('sha256').update(value).digest(), createHash('sha256').update(`Bearer ${token}`).digest())) throw new ReleaseError(401, 'Authorization required.')
  const origin = request.headers.get('origin')
  if (origin && origin !== siteUrl()) throw new ReleaseError(403, 'Origin is not allowed.')
  if (process.env.NODE_ENV === 'production' && request.headers.get('x-forwarded-proto') !== 'https') throw new ReleaseError(403, 'Administration requires HTTPS through the reverse proxy.')
}
export async function currentRelease(): Promise<Release | null> {
  let version: string
  try { version = versionSchema.parse(JSON.parse(await readFile(join(storeRoot(), 'current.json'), 'utf8')).version) }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
  return releaseByVersion(version)
}
export async function releaseByVersion(version: string): Promise<Release> {
  versionSchema.parse(version)
  const folder = join(storeRoot(), 'releases', version), key = await publicKey()
  const [usb, online] = await Promise.all([readFile(join(folder, 'Proxy-QA-Browser-Update.json'), 'utf8'), readFile(join(folder, 'update.json'), 'utf8')])
  const release = verifyPair(JSON.parse(usb), JSON.parse(online), key, siteUrl())
  if (release.version !== version) throw new ReleaseError(422, 'Release directory does not match its version.')
  return release
}
async function lease(version: string) {
  const root = storeRoot(); await mkdir(join(root, 'locks'), { recursive: true, mode: 0o700 })
  const path = join(root, 'locks', version)
  try { await mkdir(path, { mode: 0o700 }) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new ReleaseError(409, 'A release operation is already running.'); throw e }
  return () => rm(path, { recursive: true, force: true })
}
async function immutable(version: string) {
  try { await stat(join(storeRoot(), 'releases', version)); throw new ReleaseError(409, 'Published releases cannot be overwritten.') }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
}
export async function uploadAsset(version: string, fileName: string, request: Request) {
  versionSchema.parse(version); fileSchema.parse(fileName)
  if (!fileName.includes(`-${version}-`)) throw new ReleaseError(400, 'Filename must contain its release version.')
  const length = Number(request.headers.get('content-length'))
  if (!Number.isSafeInteger(length) || length < 1 || length > 2 * 1024 ** 3 || !request.body) throw new ReleaseError(411, 'A bounded Content-Length is required (maximum 2 GiB).')
  const unlock = await lease(version), folder = join(storeRoot(), 'staging', version)
  const partial = join(folder, `${fileName}.${randomUUID()}.part`)
  try {
    await immutable(version); await mkdir(folder, { recursive: true, mode: 0o700 })
    const handle = await open(partial, 'wx', 0o600); let bytes = 0
    const meter = new Transform({ transform(chunk: Buffer, _, callback) { bytes += chunk.length; callback(bytes > length ? new ReleaseError(413, 'Upload exceeds declared size.') : null, chunk) } })
    try { await pipeline(Readable.fromWeb(request.body as NodeWebStream<Uint8Array>), meter, handle.createWriteStream(), { signal: request.signal }) } finally { await handle.close() }
    if (bytes !== length) throw new ReleaseError(422, 'Upload is incomplete.')
    await rename(partial, join(folder, fileName))
    return { fileName, bytes }
  } finally { await rm(partial, { force: true }); await unlock() }
}
async function hashAsset(path: string, expected: Asset) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat(); if (!info.isFile() || info.size !== expected.size) throw new ReleaseError(422, 'Asset size or type is invalid.')
    const hash = createHash('sha256')
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk)
    if (hash.digest('hex') !== expected.sha256) throw new ReleaseError(422, 'Asset checksum is invalid.')
  } finally { await file.close() }
}
export async function publishRelease(usb: unknown, online: unknown) {
  const release = verifyPair(usb, online, await publicKey(), siteUrl()), root = storeRoot()
  // A global lease serializes pointer updates across all versions.
  const unlock = await lease('publish'), unlockVersion = await lease(release.version).catch(async e => { await unlock(); throw e })
  const pointer = join(root, `current.${randomUUID()}.tmp`)
  try {
    await immutable(release.version)
    const current = await currentRelease(); if (current && !newer(release.version, current.version)) throw new ReleaseError(409, 'The new version must increase.')
    const folder = join(root, 'staging', release.version)
    for (const asset of releaseFiles(release)) await hashAsset(join(folder, asset.fileName), asset)
    for (const [file, value] of [['Proxy-QA-Browser-Update.json', usb], ['update.json', online]] as const) {
      const handle = await open(join(folder, file), 'w', 0o600); try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
    }
    await mkdir(join(root, 'releases'), { recursive: true, mode: 0o700 })
    await rename(folder, join(root, 'releases', release.version))
    const handle = await open(pointer, 'wx', 0o600); try { await handle.writeFile(JSON.stringify({ version: release.version })); await handle.sync() } finally { await handle.close() }
    await rename(pointer, join(root, 'current.json'))
    console.info(JSON.stringify({ event: 'release-published', version: release.version, time: new Date().toISOString() }))
    return release
  } finally { await rm(pointer, { force: true }); await unlockVersion(); await unlock() }
}
export function errorResponse(error: unknown) {
  const status = error instanceof ReleaseError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 404 : 500
  return Response.json({ error: status === 500 ? 'The operation could not be completed.' : status === 404 ? 'Release not found.' : (error as Error).message }, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
}
export async function downloadResponse(request: Request, version: string, name: string, head = false) {
  versionSchema.parse(version); fileSchema.parse(name)
  const release = await releaseByVersion(version), asset = releaseFiles(release).find(a => a.fileName === name)
  if (!asset) throw new ReleaseError(404, 'Release asset not found.')
  const handle = await open(join(storeRoot(), 'releases', version, name), constants.O_RDONLY | constants.O_NOFOLLOW)
  let transferred = false
  try {
    const info = await handle.stat(); if (!info.isFile() || info.size !== asset.size) throw new ReleaseError(422, 'Release file is unavailable.')
    const headers = new Headers({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"`, 'Accept-Ranges': 'bytes', 'ETag': `"${asset.sha256}"`, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex' })
    let start = 0, end = asset.size - 1, status = 200
    const range = request.headers.get('range')
    if (range && (!request.headers.get('if-range') || request.headers.get('if-range') === headers.get('etag'))) {
      const parts = /^bytes=(\d*)-(\d*)$/.exec(range)
      if (!parts || (!parts[1] && !parts[2])) { headers.set('Content-Range', `bytes */${asset.size}`); return new Response(null, { status: 416, headers }) }
      if (parts[1]) { start = Number(parts[1]); end = parts[2] ? Number(parts[2]) : end } else { const suffix = Number(parts[2]); start = Math.max(0, asset.size - suffix); if (!suffix) start = asset.size }
      end = Math.min(end, asset.size - 1)
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= asset.size) { headers.set('Content-Range', `bytes */${asset.size}`); return new Response(null, { status: 416, headers }) }
      status = 206; headers.set('Content-Range', `bytes ${start}-${end}/${asset.size}`)
    }
    headers.set('Content-Length', String(end - start + 1))
    if (head) return new Response(null, { status, headers })
    const stream = handle.createReadStream({ start, end })
    request.signal.addEventListener('abort', () => stream.destroy(), { once: true })
    transferred = true
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers })
  } finally { if (!transferred) await handle.close() }
}

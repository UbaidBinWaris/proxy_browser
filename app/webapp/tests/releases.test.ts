import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authorize, boundedJson, currentRelease, downloadResponse, newer, publishRelease, ReleaseError, uploadAsset, verifyPair } from '../src/lib/releases.ts'
const keys = generateKeyPairSync('ed25519'), origin = 'https://proxybrowser.ubaidbinwaris.com', token = 'a'.repeat(64)
let root: string
before(async () => { root = await mkdtemp(join(tmpdir(), 'proxy-release-test-')); process.env.RELEASE_ROOT = root; process.env.SITE_URL = origin; process.env.ADMIN_TOKEN = token; process.env.RELEASE_PUBLIC_KEY_FILE = join(root, 'public.pem'); await writeFile(process.env.RELEASE_PUBLIC_KEY_FILE, keys.publicKey.export({ type: 'spki', format: 'pem' })) })
after(async () => { await rm(root, { recursive: true, force: true }) })
function envelope(payload: unknown) { const value = JSON.stringify(payload); return { payload: value, signature: sign(null, Buffer.from(value), keys.privateKey).toString('base64') } }
function fixture(version = '1.3.0') {
  const assets = (['win32', 'linux'] as const).map(platform => { const bytes = Buffer.from(`fixture-${platform}-${version}`); return { platform, arch: 'x64', fileName: `Proxy-QA-Browser-${version}-${platform === 'win32' ? 'Windows-x64.exe' : 'x86_64.AppImage'}`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } })
  const data = { format: 1, appId: 'com.ubaidbinwaris.proxy-qa-browser', version, releasedAt: '2026-10-08T10:00:00.000Z', notes: ['Verified test release'], assets }
  const online = { version, releasedAt: data.releasedAt, notes: data.notes, assets: assets.map(a => ({ ...a, url: `${origin}/api/download/${version}/${a.fileName}` })) }
  return { data, online, usb: envelope(data), feed: envelope(online) }
}
function upload(bytes: string) { return new Request(`${origin}/api/admin/uploads`, { method: 'PUT', body: bytes, headers: { 'Content-Length': String(Buffer.byteLength(bytes)) } }) }
test('admin is closed without token, rejects wrong tokens and foreign origins', () => {
  assert.throws(() => authorize(new Request(origin)), (e: unknown) => e instanceof ReleaseError && e.status === 401)
  assert.throws(() => authorize(new Request(origin, { headers: { authorization: 'Bearer bad' } })))
  authorize(new Request(origin, { headers: { authorization: `Bearer ${token}` } }))
  assert.throws(() => authorize(new Request(origin, { headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' } })))
  process.env.ADMIN_TOKEN = ''; assert.throws(() => authorize(new Request(origin)), (e: unknown) => e instanceof ReleaseError && e.status === 503); process.env.ADMIN_TOKEN = token
})
test('production administration requires TLS', () => {
  const env = process.env as Record<string, string | undefined>; const previous = env.NODE_ENV; env.NODE_ENV = 'production'
  try { assert.throws(() => authorize(new Request(origin, { headers: { authorization: `Bearer ${token}` } }))); authorize(new Request(origin, { headers: { authorization: `Bearer ${token}`, 'x-forwarded-proto': 'https' } })) } finally { if (previous) env.NODE_ENV = previous; else delete env.NODE_ENV }
})
test('signatures and exact asset origins are enforced', () => {
  const f = fixture(); assert.equal(verifyPair(f.usb, f.feed, keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), origin).version, '1.3.0')
  const key = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  assert.throws(() => verifyPair({ ...f.usb, payload: f.usb.payload.replace('1.3.0', '9.0.0') }, f.feed, key, origin))
  f.online.assets[0]!.url = 'https://evil.example/file.exe'; assert.throws(() => verifyPair(f.usb, envelope(f.online), key, origin))
})
test('duplicate platforms and mismatched hashes cannot be signed into a valid pair', () => {
  const f = fixture(), key = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  f.online.assets[0]!.sha256 = '0'.repeat(64); assert.throws(() => verifyPair(f.usb, envelope(f.online), key, origin))
  f.data.assets[1]!.platform = 'win32'; assert.throws(() => verifyPair(envelope(f.data), f.feed, key, origin))
})
test('JSON bodies are bounded', async () => { await assert.rejects(boundedJson(new Request(origin, { method: 'POST', body: 'x'.repeat(100001) })), (e: unknown) => e instanceof ReleaseError && e.status === 413) })
test('release store starts empty and prevents path traversal', async () => {
  assert.equal(await currentRelease(), null)
  await assert.rejects(uploadAsset('../escape', 'a.exe', upload('123')))
  await assert.rejects(uploadAsset('1.3.0', '../a.exe', upload('123')))
  await assert.rejects(uploadAsset('1.3.0', 'Proxy-1.3.0.exe', new Request(origin, { method: 'PUT', body: '123' })))
})
test('truncated uploads do not become completed assets', async () => {
  const request = new Request(origin, { method: 'PUT', body: '123', headers: { 'Content-Length': '10' } })
  await assert.rejects(uploadAsset('1.3.0', 'Proxy-1.3.0-Windows.exe', request)); await assert.rejects(readFile(join(root, 'staging', '1.3.0', 'Proxy-1.3.0-Windows.exe')))
})
test('tampered asset keeps the current pointer unpublished; corrected upload publishes', async () => {
  const f = fixture()
  for (const a of f.data.assets) await uploadAsset('1.3.0', a.fileName, upload(`fixture-${a.platform}-1.3.0`))
  await writeFile(join(root, 'staging', '1.3.0', f.data.assets[0]!.fileName), 'x'.repeat(f.data.assets[0]!.size))
  await assert.rejects(publishRelease(f.usb, f.feed)); assert.equal(await currentRelease(), null)
  await uploadAsset('1.3.0', f.data.assets[0]!.fileName, upload('fixture-win32-1.3.0'))
  await publishRelease(f.usb, f.feed); assert.equal((await currentRelease())?.version, '1.3.0')
})
test('published assets are immutable, downgrades rejected and previous release retained', async () => {
  const f = fixture(); await assert.rejects(uploadAsset('1.3.0', f.data.assets[0]!.fileName, upload('wrong'))); await assert.rejects(publishRelease(f.usb, f.feed))
  const older = fixture('1.2.0'); await assert.rejects(publishRelease(older.usb, older.feed)); assert.equal((await currentRelease())?.version, '1.3.0')
  assert.equal(newer('1.10.0', '1.9.9'), true); assert.equal(newer('1.3.0', '1.3.0'), false)
})
test('streamed downloads support ranges, HEAD, and deny unknown filenames', async () => {
  const a = fixture().data.assets[0]!, url = `${origin}/api/download/1.3.0/${a.fileName}`
  const full = await downloadResponse(new Request(url), '1.3.0', a.fileName); assert.equal(await full.text(), 'fixture-win32-1.3.0')
  const partial = await downloadResponse(new Request(url, { headers: { range: 'bytes=0-6' } }), '1.3.0', a.fileName); assert.equal(partial.status, 206); assert.equal(await partial.text(), 'fixture')
  const suffix = await downloadResponse(new Request(url, { headers: { range: 'bytes=-5' } }), '1.3.0', a.fileName); assert.equal(await suffix.text(), '1.3.0')
  const invalid = await downloadResponse(new Request(url, { headers: { range: 'bytes=9999-' } }), '1.3.0', a.fileName); assert.equal(invalid.status, 416)
  const head = await downloadResponse(new Request(url), '1.3.0', a.fileName, true); assert.equal(await head.text(), ''); assert.equal(head.headers.get('content-length'), String(a.size))
  await assert.rejects(downloadResponse(new Request(url), '1.3.0', '.env.exe'))
})
test('symlinks cannot be published as assets', async () => {
  const f = fixture('1.4.0'), folder = join(root, 'staging', '1.4.0'); await mkdir(folder, { recursive: true })
  const outside = join(root, 'outside'); await writeFile(outside, 'fixture-win32-1.4.0'); await symlink(outside, join(folder, f.data.assets[0]!.fileName))
  await writeFile(join(folder, f.data.assets[1]!.fileName), 'fixture-linux-1.4.0'); await assert.rejects(publishRelease(f.usb, f.feed)); assert.equal((await currentRelease())?.version, '1.3.0')
})
/** A release with the required Windows/Linux pair plus optional macOS downloads (`macAssets`). */
function macFixture(version: string, files: Array<['arm64' | 'x64', 'dmg' | 'zip']> = [['arm64', 'dmg'], ['x64', 'zip']]) {
  const base = fixture(version)
  const macAssets = files.map(([arch, ext]) => { const bytes = Buffer.from(`fixture-darwin-${arch}-${ext}-${version}`); return { platform: 'darwin' as const, arch, fileName: `Proxy-QA-Browser-${version}-macOS-${arch}.${ext}`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } })
  const data = { ...base.data, macAssets }
  const online = { ...base.online, macAssets: macAssets.map(a => ({ ...a, url: `${origin}/api/download/${version}/${a.fileName}` })) }
  return { data, online, usb: envelope(data), feed: envelope(online) }
}
test('macOS downloads are optional: both manifests must list the same files, URLs and hashes', () => {
  const key = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const f = macFixture('1.5.0')
  assert.equal(verifyPair(f.usb, f.feed, key, origin).macAssets?.length, 2)
  assert.equal(verifyPair(fixture('1.5.0').usb, fixture('1.5.0').feed, key, origin).macAssets, undefined)
  const { macAssets: _dropped, ...withoutMac } = f.online
  assert.throws(() => verifyPair(f.usb, envelope(withoutMac), key, origin), /macOS release assets disagree/)
  const wrongUrl = macFixture('1.5.0'); wrongUrl.online.macAssets[0]!.url = 'https://evil.example/app.dmg'
  assert.throws(() => verifyPair(wrongUrl.usb, envelope(wrongUrl.online), key, origin), /macOS release assets disagree/)
  const wrongHash = macFixture('1.5.0'); wrongHash.online.macAssets[1]!.sha256 = '0'.repeat(64)
  assert.throws(() => verifyPair(wrongHash.usb, envelope(wrongHash.online), key, origin), /macOS release assets disagree/)
  const wrongArch = macFixture('1.5.0'); wrongArch.data.macAssets[0]!.arch = 'x64'; wrongArch.online.macAssets[0]!.arch = 'x64'
  assert.throws(() => verifyPair(envelope(wrongArch.data), envelope(wrongArch.online), key, origin), /macOS release assets disagree/)
  const exe = macFixture('1.5.0'); exe.data.macAssets[0]!.fileName = 'Proxy-QA-Browser-1.5.0-macOS-arm64.exe'
  assert.throws(() => verifyPair(envelope(exe.data), f.feed, key, origin))
  // A darwin file can never take the place of a required Windows or Linux asset.
  const swapped = macFixture('1.5.0'); (swapped.data.assets as unknown[])[1] = swapped.data.macAssets[0]
  assert.throws(() => verifyPair(envelope(swapped.data), f.feed, key, origin))
})
test('a release with macOS downloads publishes only after every file verifies, and serves the DMG', async () => {
  const f = macFixture('1.5.0')
  for (const a of f.data.assets) await uploadAsset('1.5.0', a.fileName, upload(`fixture-${a.platform}-1.5.0`))
  for (const a of f.data.macAssets) await uploadAsset('1.5.0', a.fileName, upload('tampered'))
  await assert.rejects(publishRelease(f.usb, f.feed)); assert.equal((await currentRelease())?.version, '1.3.0')
  for (const a of f.data.macAssets) await uploadAsset('1.5.0', a.fileName, upload(`fixture-darwin-${a.arch}-${a.fileName.endsWith('.dmg') ? 'dmg' : 'zip'}-1.5.0`))
  await publishRelease(f.usb, f.feed)
  const current = await currentRelease(); assert.equal(current?.version, '1.5.0'); assert.deepEqual(current?.macAssets?.map(a => a.fileName), f.data.macAssets.map(a => a.fileName))
  const dmg = f.data.macAssets[0]!
  const response = await downloadResponse(new Request(`${origin}/api/download/1.5.0/${dmg.fileName}`), '1.5.0', dmg.fileName)
  assert.equal(await response.text(), 'fixture-darwin-arm64-dmg-1.5.0'); assert.equal(response.headers.get('etag'), `"${dmg.sha256}"`)
  await assert.rejects(downloadResponse(new Request(origin), '1.5.0', 'Proxy-QA-Browser-1.5.0-macOS-x64.dmg'))
})

/* global process, console, URL, Buffer, setTimeout, document, window, fetch */
/** Tests the production website with ephemeral signed fixtures, never real proxy credentials. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'

const root = resolve(import.meta.dirname, '..'), web = join(root, 'app/webapp')
const state = await mkdtemp(join(tmpdir(), 'proxy-web-smoke-')), keys = generateKeyPairSync('ed25519')
const origin = 'https://proxybrowser.ubaidbinwaris.com', local = 'http://127.0.0.1:4501', version = '1.3.0', token = 'test-only-'.repeat(8)
const keyPath = join(state, 'public.pem'); await writeFile(keyPath, keys.publicKey.export({ type: 'spki', format: 'pem' }))
const folder = join(state, 'releases', version); await mkdir(folder, { recursive: true })
const assets = []
for (const platform of ['win32', 'linux']) {
  const fileName = `Proxy-QA-Browser-${version}-${platform === 'win32' ? 'Windows-x64.exe' : 'x86_64.AppImage'}`
  const bytes = Buffer.from(`browser-smoke-fixture-${platform}`)
  await writeFile(join(folder, fileName), bytes)
  assets.push({ platform, arch: 'x64', fileName, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
}
function envelope(data) { const payload = JSON.stringify(data); return { payload, signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64') } }
const data = { format: 1, appId: 'com.ubaidbinwaris.proxy-qa-browser', version, releasedAt: '2026-10-08T10:00:00.000Z', notes: ['A test-only release for browser verification.'], assets }
await writeFile(join(folder, 'Proxy-QA-Browser-Update.json'), JSON.stringify(envelope(data)))
await writeFile(join(folder, 'update.json'), JSON.stringify(envelope({ version, releasedAt: data.releasedAt, notes: data.notes, assets: assets.map(a => ({ ...a, url: `${origin}/api/download/${version}/${a.fileName}` })) })))
await writeFile(join(state, 'current.json'), JSON.stringify({ version }))
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '4501'], { cwd: web, env: { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', RELEASE_ROOT: state, RELEASE_PUBLIC_KEY_FILE: keyPath, SITE_URL: origin, ADMIN_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
let browser, logs = ''
server.stdout.on('data', chunk => { logs += chunk }); server.stderr.on('data', chunk => { logs += chunk })
try {
  let ready = false
  for (let attempt = 0; attempt < 50; attempt++) { if (server.exitCode !== null) throw new Error(logs); try { const r = await fetch(`${local}/api/health`); if (r.ok && logs.includes('Ready')) { ready = true; break } } catch { /* startup */ } await new Promise(r => setTimeout(r, 100)) }
  assert(ready, logs)
  assert.equal((await fetch(`${local}/api/admin/releases`)).status, 401)
  assert.equal((await fetch(`${local}/api/admin/releases`, { headers: { authorization: `Bearer ${token}` } })).status, 403)
  assert.equal((await fetch(`${local}/api/admin/releases`, { headers: { authorization: `Bearer ${token}`, 'x-forwarded-proto': 'https' } })).status, 200)
  const releaseResponse = await fetch(`${local}/api/releases?current=1.2.0`); assert.equal((await releaseResponse.json()).updateAvailable, true)
  assert.equal((await (await fetch(`${local}/api/releases?current=1.3.0`)).json()).updateAvailable, false)
  const range = await fetch(`${local}/api/download/${version}/${assets[0].fileName}`, { headers: { range: 'bytes=0-6' } }); assert.equal(range.status, 206); assert.equal(await range.text(), 'browser')
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
  // Simulate the TLS reverse proxy locally; no request is sent to the public domain.
  await context.route(`${origin}/**`, async route => {
    const request = route.request(), url = request.url().replace(origin, local)
    const response = await route.fetch({ url, headers: { ...request.headers(), host: new URL(origin).host, 'x-forwarded-proto': 'https' } })
    await route.fulfill({ response })
  })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })
  await page.goto(origin, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Your browser. Your rules. Less friction.' }).waitFor()
  assert(await page.getByRole('link', { name: 'Download for Windows' }).count())
  await page.getByRole('button', { name: 'Check for updates' }).click()
  await page.getByRole('status').filter({ hasText: 'Latest release: 1.3.0' }).waitFor()
  const downloadPromise = page.waitForEvent('download'); await page.getByRole('link', { name: 'Download for Windows' }).click(); const download = await downloadPromise
  assert.equal(download.suggestedFilename(), assets[0].fileName); assert.equal(await readFile(await download.path(), 'utf8'), 'browser-smoke-fixture-win32')
  await mkdir(join(root, 'smoke-output'), { recursive: true })
  await page.screenshot({ path: join(root, 'smoke-output/website-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)); await page.screenshot({ path: join(root, 'smoke-output/website-mobile.png'), fullPage: true })
  await page.goto(`${origin}/admin`, { waitUntil: 'networkidle' })
  await page.getByLabel('Administrator token').fill(token); await page.getByLabel('Release version').fill('1.4.0')
  const newerAssets = assets.map(a => ({ ...a, fileName: a.fileName.replace('1.3.0', '1.4.0') }))
  const newerData = { ...data, version: '1.4.0', assets: newerAssets }
  const fileInputs = page.locator('input[type="file"]')
  await fileInputs.nth(0).setInputFiles(newerAssets.map(a => ({ name: a.fileName, mimeType: 'application/octet-stream', buffer: Buffer.from(`browser-smoke-fixture-${a.platform}`) })))
  await fileInputs.nth(1).setInputFiles({ name: 'Proxy-QA-Browser-Update.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(envelope(newerData))) })
  await fileInputs.nth(2).setInputFiles({ name: 'update.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(envelope({ version: '1.4.0', releasedAt: data.releasedAt, notes: data.notes, assets: newerAssets.map(a => ({ ...a, url: `${origin}/api/download/1.4.0/${a.fileName}` })) }))) })
  await page.getByRole('button', { name: 'Upload and publish' }).click()
  await page.getByRole('status').filter({ hasText: 'Published version 1.4.0' }).waitFor({ timeout: 20000 })
  await page.reload(); assert.equal(await page.getByLabel('Administrator token').inputValue(), '')
  await page.goto(origin, { waitUntil: 'networkidle' }); assert((await page.getByRole('link', { name: 'Download for Windows' }).getAttribute('href')).includes('1.4.0'))
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'WEBSITE SMOKE PASSED', checks: ['production CSP hydration', 'public downloads', 'update check', 'range download', 'admin auth and TLS', 'browser upload and signed publication', 'token clears on reload', 'responsive layout'], screenshots: ['smoke-output/website-desktop.png', 'smoke-output/website-mobile.png'] }, null, 2))
} finally {
  if (browser) await browser.close(); try { if (process.platform === 'win32') server.kill('SIGTERM'); else process.kill(-server.pid, 'SIGTERM') } catch (e) { if (e.code !== 'ESRCH') console.error('Could not stop the test server.') } await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve) }); await rm(state, { recursive: true, force: true })
}

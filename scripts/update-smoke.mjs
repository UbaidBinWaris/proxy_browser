#!/usr/bin/env node
/* global process, console, window, Buffer, setTimeout, WebSocket */
/**
 * Real end-to-end update test for the packaged app (Windows portable EXE or Linux AppImage):
 *
 *   build "old" + "new" release (throwaway publisher key, own output folder)
 *   → open the OLD packaged app → verify a signed update → restart
 *   → the NEW release finishes the update by itself (computer copy, shortcuts, pending file removed)
 *
 * This is the path users take from App & updates; the restart and finishing steps run in a process
 * Playwright does not control, so the result is read back from disk. Online updates differ only in
 * where the verified file comes from (covered by tests/desktop-integration.test.ts).
 *
 * Usage: npm run build && node scripts/update-smoke.mjs [--skip-build]
 * Windows: CI only (it uses the real Start menu and Desktop of the machine).
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, statSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'

const ROOT = resolve(import.meta.dirname, '..')
const APP_ID = 'com.ubaidbinwaris.proxy-qa-browser'
const windows = process.platform === 'win32'
if (!windows && process.platform !== 'linux') throw new Error('The update smoke runs on Windows or Linux.')
if (windows && process.env.CI !== 'true')
  throw new Error('On Windows this smoke writes real Start menu and Desktop shortcuts; run it in CI (CI=true).')

const skipBuild = process.argv.includes('--skip-build')
const base = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const [major, minor, patch] = base.split('.').map(Number)
const next = `${major}.${minor}.${patch + 1}`
const out = join(ROOT, 'release-update-smoke')
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const checks = []
/** Failures as GitHub annotations: readable through the public API, unlike step logs (admin only). */
function annotate(title, message) {
  if (process.env.GITHUB_ACTIONS !== 'true') return
  const text = String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
  console.log(`::error title=${title}::${text}`)
}
const check = (name, ok, detail = '') => {
  checks.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) {
    annotate('Update smoke', `${name}${detail ? ` (${detail})` : ''}`)
    throw new Error(`Update smoke failed: ${name}${detail ? ` (${detail})` : ''}`)
  }
}

const keyFile = join(out, 'test-public-key.pem')
const privateKeyFile = join(out, 'test-private-key.pem')
const artifacts = (folder, version) =>
  windows
    ? { unpacked: join(folder, 'win-unpacked', 'Proxy-QA-Browser.exe'), dist: join(folder, `Proxy-QA-Browser-${version}-Windows-x64.exe`) }
    : { unpacked: join(folder, 'linux-unpacked', 'proxy-qa-browser'), dist: join(folder, `Proxy-QA-Browser-${version}-x86_64.AppImage`) }
const oldApp = artifacts(join(out, 'old'), base)
const newApp = artifacts(join(out, 'new'), next)

function build(version, folder) {
  console.log(`Building ${version} into ${folder}`)
  const env = { ...process.env, PROXY_QA_TEST_PUBLIC_KEY_FILE: keyFile, PROXY_QA_TEST_OUTPUT: folder, PROXY_QA_TEST_VERSION: version }
  delete env.PROXY_QA_SIGNED_RELEASE
  delete env.ELECTRON_RUN_AS_NODE
  const cli = join(ROOT, 'node_modules', 'electron-builder', 'cli.js')
  execFileSync(process.execPath, [cli, windows ? '--win' : '--linux', '--x64', '--config', 'electron-builder.config.mjs'], { cwd: ROOT, env, stdio: 'inherit' })
}

function killAppsUsing(marker) {
  if (windows)
    spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker.replaceAll("'", "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`])
  else spawnSync('pkill', ['-TERM', '-f', marker])
}

async function waitFor(what, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate().catch(() => null)
    if (value) return value
    await sleep(1000)
  }
  throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${what}`)
}

if (!skipBuild) {
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })
  const keys = generateKeyPairSync('ed25519')
  await writeFile(keyFile, keys.publicKey.export({ type: 'spki', format: 'pem' }))
  await writeFile(privateKeyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  build(base, join(out, 'old'))
  build(next, join(out, 'new'))
}
for (const file of [oldApp.unpacked, oldApp.dist, newApp.dist, privateKeyFile])
  if (!existsSync(file)) throw new Error(`Missing ${file}; run without --skip-build first.`)

// Isolated state: the computer copy (LOCALAPPDATA / XDG_DATA_HOME), Linux menu + Desktop (HOME), app data.
const state = await mkdtemp(join(tmpdir(), 'qa-update-smoke-'))
const userData = join(state, 'app')
// XDG_CONFIG_HOME must exist: Chromium's GPU process aborts when it points at a missing folder.
await mkdir(join(state, 'config'), { recursive: true })
const env = { ...process.env, LOCALAPPDATA: state, XDG_DATA_HOME: state, XDG_CONFIG_HOME: join(state, 'config') }
// The AppImage runs FUSE-mounted, as on users' machines (extract-and-run would unpack ~1.5 GB per launch).
if (!windows) Object.assign(env, { HOME: state, APPIMAGE: oldApp.dist })
delete env.APPIMAGE_EXTRACT_AND_RUN
for (const key of ['ELECTRON_RUN_AS_NODE', 'PLAYWRIGHT_BROWSERS_PATH', 'PROXY_QA_WEBKIT_LIBS', 'PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS'])
  delete env[key]
const computerRoot = windows ? join(state, 'ProxyQABrowser') : join(state, 'proxy-qa-browser')
const menuShortcut = windows
  ? join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Proxy QA Browser.lnk')
  : join(state, 'applications', `${APP_ID}.desktop`)
const desktopShortcut = windows
  ? join(process.env.USERPROFILE ?? '', 'Desktop', 'Proxy QA Browser.lnk')
  : join(state, 'Desktop', `${APP_ID}.desktop`)
if (windows) for (const shortcut of [menuShortcut, desktopShortcut]) await rm(shortcut, { force: true })

// A signed USB-style release next to the new binary, exactly as `npm run release:usb` lays it out.
const usb = join(state, 'usb')
await mkdir(usb, { recursive: true })
const fileName = windows ? `Proxy-QA-Browser-${next}-Windows-x64.exe` : `Proxy-QA-Browser-${next}-x86_64.AppImage`
await copyFile(newApp.dist, join(usb, fileName))
const payload = JSON.stringify({
  format: 1,
  appId: APP_ID,
  version: next,
  releasedAt: new Date().toISOString(),
  notes: ['Update smoke test release'],
  assets: [{ platform: process.platform, arch: 'x64', fileName, size: statSync(newApp.dist).size, sha256: sha256(newApp.dist) }],
})
const signature = sign(null, Buffer.from(payload), readFileSync(privateKeyFile)).toString('base64')
const manifest = join(usb, 'Proxy-QA-Browser-Update.json')
await writeFile(manifest, JSON.stringify({ payload, signature }))

/** On failure: the app's own update log lines and its processes, so CI shows where the update stopped. */
async function diagnose() {
  console.log(`--- diagnostics (state kept at ${state}) ---`)
  const logs = join(userData, 'data', 'logs')
  for (const file of existsSync(logs) ? (await import('node:fs')).readdirSync(logs).sort() : []) {
    const lines = readFileSync(join(logs, file), 'utf8').split('\n').filter(Boolean)
    for (const line of lines.filter((l) => /desktop|update|pending|error|warn|app ready|bootstrap/i.test(l)).slice(-40))
      console.log(`[${file}] ${line.slice(0, 600)}`)
  }
  console.log('pending file present:', existsSync(join(computerRoot, 'pending-usb-update.json')))
  const staged = join(userData, 'data', 'usb-updates')
  console.log('staged updates:', existsSync(staged) ? (await import('node:fs')).readdirSync(staged).join(', ') : 'none')
  const ps = windows
    ? spawnSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'Proxy-QA-Browser*' } | Select-Object ProcessId,CommandLine | Format-List"], { encoding: 'utf8' })
    : spawnSync('sh', ['-c', 'ps -eo pid,etime,args | grep -i "[p]roxy-qa-browser" | cut -c1-240'], { encoding: 'utf8' })
  console.log('app processes:\n' + (ps.stdout || '(none)'))
}

/**
 * Start the old release the way a user does: a detached process whose output goes to a file, with no
 * test-runner launch flags or pipes for the restarted release to inherit, so the restart being tested
 * is exactly the app's own (src/main/desktop/restart.ts). The harness drives it from outside: the
 * DevTools Protocol for the window and Node's inspector for one main-process stub (the file dialog).
 */
async function launchLikeAUser() {
  const logPath = join(state, 'old-release-output.log')
  const fd = openSync(logPath, 'a')
  const child = spawn(oldApp.unpacked, [`--user-data-dir=${userData}`, '--inspect=0', '--remote-debugging-port=0'], {
    env,
    detached: !windows,
    stdio: ['ignore', fd, fd],
  })
  closeSync(fd)
  child.unref()
  const exited = new Promise((done) => child.once('exit', done))
  const inspector = await waitFor('the Node inspector address', async () => readFileSync(logPath, 'utf8').match(/ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/)?.[0] ?? null, 90000)
  const cdpPort = await waitFor('the DevTools port', async () => readFileSync(join(userData, 'DevToolsActivePort'), 'utf8').split('\n')[0]?.trim() || null, 90000)
  return { child, exited, inspector, cdpPort }
}

/** Evaluate one expression in the old release's main process through Node's inspector. */
async function evaluateInMain(inspectorUrl, expression) {
  const socket = new WebSocket(inspectorUrl)
  await new Promise((done, fail) => {
    socket.onopen = done
    socket.onerror = () => fail(new Error('Could not connect to the Node inspector'))
  })
  const reply = await new Promise((done) => {
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id === 1) done(message)
    }
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, includeCommandLineAPI: true, awaitPromise: true } }))
  })
  socket.close()
  if (reply.error || reply.result?.exceptionDetails) throw new Error(`Main-process evaluation failed: ${JSON.stringify(reply.error ?? reply.result.exceptionDetails)}`)
}


let failed = true
try {
  console.log(`Opening the packaged ${base} release like a user`)
  const old = await launchLikeAUser()
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${old.cdpPort}`)
  const page = await waitFor('the app window', async () => {
    for (const context of browser.contexts())
      for (const candidate of context.pages())
        if (await candidate.evaluate(() => typeof window.api === 'object').catch(() => false)) return candidate
    return null
  }, 90000)
  const api = async (fn, arg) => {
    const result = await page.evaluate(fn, arg)
    if (!result.ok) throw new Error(result.error?.message ?? 'IPC call failed')
    return result.data
  }
  check('old release runs packaged', (await api(() => window.api.app.getInfo())).version === base, base)
  const before = await api(() => window.api.desktop.status())
  check('old release supports updates and has no computer copy yet', before.supported && !before.installedPath)

  await evaluateInMain(
    old.inspector,
    `process.mainModule.require('electron').dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(manifest)}] })`,
  )
  const preview = await api(() => window.api.desktop.chooseUsb())
  check('signed update verified by the old release', preview?.version === next, JSON.stringify(preview))

  await page.evaluate(() => window.api.desktop.applyUsb()).catch(() => undefined) // the app restarts mid-call
  await Promise.race([old.exited, sleep(60000)])
  check('old release closed for the restart', old.child.exitCode !== null || old.child.signalCode !== null)
  await browser.close().catch(() => {})
  console.log('Old release closed; waiting for the new release to finish the update by itself')

  const marker = await waitFor(
    `the ${next} computer copy`,
    async () => {
      const value = JSON.parse(await readFile(join(computerRoot, 'Application', 'proxy-qa-application.json'), 'utf8'))
      return value.version === next ? value : null
    },
    240000,
  )
  check('new release set up the computer copy', marker.version === next && marker.appId === APP_ID, JSON.stringify(marker))
  await waitFor('the pending update to be cleared', async () => !existsSync(join(computerRoot, 'pending-usb-update.json')), 30000)
  check('pending update cleared after finishing', true)
  const installed = join(computerRoot, 'Application', windows ? 'Proxy-QA-Browser.exe' : 'Proxy-QA-Browser.AppImage')
  check('computer copy executable present', existsSync(installed), installed)
  if (!windows) check('computer copy is the new AppImage', sha256(installed) === sha256(newApp.dist))
  check('menu shortcut created for the updated copy', existsSync(menuShortcut), menuShortcut)
  check('Desktop shortcut created for the updated copy', existsSync(desktopShortcut), desktopShortcut)
  if (!windows) {
    const entry = await readFile(menuShortcut, 'utf8')
    check('menu entry opens the computer copy', entry.includes(`Exec="${installed}"`))
  }
  failed = false
  console.log(JSON.stringify({ result: 'UPDATE SMOKE PASSED', platform: process.platform, from: base, to: next, checks }, null, 2))
} catch (error) {
  // Timeouts and crashes (check() already annotated its own failures).
  if (!String(error?.message).startsWith('Update smoke failed:')) annotate('Update smoke', error?.stack || error)
  throw error
} finally {
  if (failed) await diagnose().catch((error) => console.log('diagnostics failed:', error.message))
  killAppsUsing(userData)
  await sleep(2000)
  if (!failed) await rm(state, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 }).catch(() => {})
}

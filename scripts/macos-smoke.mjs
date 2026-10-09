#!/usr/bin/env node
/**
 * End-to-end smoke test of the packaged macOS app (release/mac-arm64 or release/mac). Run on a Mac or
 * the GitHub Actions macos runner after `npm run build:mac:dir` (or a dmg/zip build, which leaves the
 * same unpacked .app):
 *
 *   node scripts/macos-smoke.mjs
 *
 * It checks the bundle (identity, minimum macOS, icon, bundled data, no bundled browsers, a valid code
 * signature — ad-hoc for unsigned builds), then drives the real app through playwright-core's Electron
 * driver: app info, the macOS desktop status (computer setup unsupported, updates via the download
 * page), the vault key in the Keychain under ~/Library/Application Support/ProxyQABrowser-keys, browser
 * detection in /Applications that never starts a browser (the runner image ships Chrome and Edge), the
 * first-run browser download into the app data folder, and a direct Chromium launch against a local page.
 * No proxy credentials or Apple account are needed. Exits non-zero when any check fails; screenshots and
 * results.json go to smoke-output/macos/.
 */
/* global process, console, setTimeout, window */
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'smoke-output', 'macos')
const APP_ID = 'com.ubaidbinwaris.proxy-qa-browser'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const results = []
/** Failures as GitHub annotations: readable through the public API, unlike step logs (admin only). */
function annotate(title, message) {
  if (process.env.GITHUB_ACTIONS !== 'true') return
  const text = String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
  console.log(`::error title=${title}::${text}`)
}

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail: String(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) annotate('macOS smoke', `${name}${detail ? ` (${detail})` : ''}`)
}

/** The unpacked .app for this Mac's architecture (electron-builder: release/mac-arm64 or release/mac). */
export function findAppBundle(releaseDir, arch) {
  const folders = arch === 'arm64' ? ['mac-arm64', 'mac-universal'] : ['mac', 'mac-universal']
  for (const folder of folders) {
    const bundle = path.join(releaseDir, folder, 'Proxy-QA-Browser.app')
    if (existsSync(bundle)) return bundle
  }
  return null
}

function plist(file) {
  return JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }))
}

function countProcesses(args) {
  try {
    return execFileSync('pgrep', args, { encoding: 'utf8' }).split('\n').filter(Boolean).length
  } catch {
    return 0 // pgrep exits 1 when nothing matches
  }
}

async function waitForTask(api, taskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let task = null
  while (Date.now() < deadline) {
    task = (await api(() => window.api.tasks.list())).data.find((t) => t.id === taskId) || task
    if (task && ['done', 'failed', 'cancelled'].includes(task.state)) return task
    await sleep(1000)
  }
  return task
}

function checkBundle(bundle) {
  const info = plist(path.join(bundle, 'Contents', 'Info.plist'))
  check('bundle identifier is the stable app id', info.CFBundleIdentifier === APP_ID, info.CFBundleIdentifier)
  check('minimum macOS is 12.0', info.LSMinimumSystemVersion === '12.0', info.LSMinimumSystemVersion)
  check('category is Developer Tools', info.LSApplicationCategoryType === 'public.app-category.developer-tools', info.LSApplicationCategoryType)
  const icon = path.join(bundle, 'Contents', 'Resources', info.CFBundleIconFile?.endsWith('.icns') ? info.CFBundleIconFile : `${info.CFBundleIconFile}.icns`)
  check('bundle icon (.icns) is present', existsSync(icon), icon)
  const resources = path.join(bundle, 'Contents', 'Resources')
  check('location dataset is bundled', existsSync(path.join(resources, 'geonames')))
  check('no browsers are bundled (downloaded on first run)', !existsSync(path.join(resources, 'playwright-browsers')))
  check('playwright-core is unpacked from app.asar', existsSync(path.join(resources, 'app.asar.unpacked', 'node_modules', 'playwright-core', 'cli.js')))
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'pipe' })
    const details = execFileSync('codesign', ['-dv', bundle], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    check('code signature verifies', true, details.split('\n').find((line) => line.startsWith('Signature=')) ?? 'signed')
  } catch (err) {
    check('code signature verifies', false, String(err.stderr || err.message).trim())
  }
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('scripts/macos-smoke.mjs runs on macOS only.')
  mkdirSync(OUT, { recursive: true })
  const bundle = findAppBundle(path.join(ROOT, 'release'), process.arch)
  if (!bundle) throw new Error(`No packaged .app for ${process.arch} under release/. Run "npm run build:mac:dir" first.`)
  const executable = path.join(bundle, 'Contents', 'MacOS', 'Proxy-QA-Browser')
  checkBundle(bundle)

  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html><html><body><h1>macOS smoke page</h1></body></html>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const pageUrl = `http://127.0.0.1:${server.address().port}/`

  const userData = mkdtempSync(path.join(tmpdir(), 'pqa-macos-smoke-'))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.PLAYWRIGHT_BROWSERS_PATH
  for (const key of Object.keys(env)) if (key.startsWith('DATAIMPULSE_')) delete env[key]

  let keyFile
  const app = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${userData}`], env, timeout: 120_000 })
  try {
    const errors = []
    const win = await app.firstWindow({ timeout: 120_000 })
    win.on('pageerror', (error) => errors.push(error.message))
    await win.waitForLoadState('domcontentloaded')
    await win.waitForFunction(() => Boolean(window.api))
    const api = (fn, arg) => win.evaluate(fn, arg)

    const info = (await api(() => window.api.app.getInfo())).data
    check('platform is darwin', info.platform === 'darwin', info.platform)
    check('packaged build', info.isPackaged === true)
    check('user data in the requested folder', path.resolve(info.userDataPath) === path.resolve(userData), info.userDataPath)
    await win.screenshot({ path: path.join(OUT, '01-first-run.png') })

    const desktop = await api(() => window.api.desktop.status())
    check('desktop.status answers', desktop.ok, desktop.ok ? '' : JSON.stringify(desktop.error))
    if (desktop.ok) {
      const status = desktop.data
      check('desktop status is for this Mac', status.platform === 'darwin' && status.arch === process.arch, `${status.platform}/${status.arch}`)
      check('computer setup is not offered on macOS', status.supported === false && status.installedPath === null)
      check('updates are delivered through the download page', status.updateDelivery === 'download-page', status.updateDelivery)
      check('download page comes from the signed feed origin', status.downloadPageUrl === null || /^https:\/\/[^/]+\/#download$/.test(status.downloadPageUrl), status.downloadPageUrl)
    }
    const setupAttempt = await api(() => window.api.desktop.setup({ desktop: true, startMenu: true }))
    check('desktop.setup explains the Applications folder', !setupAttempt.ok && /Applications/.test(setupAttempt.error.message), setupAttempt.ok ? 'accepted' : setupAttempt.error.message)

    const setup = (await api(() => window.api.setup.status())).data
    const security = setup.security
    const keysDir = path.join(homedir(), 'Library', 'Application Support', 'ProxyQABrowser-keys')
    keyFile = security.keyPath
    check('vault key lives in ~/Library/Application Support/ProxyQABrowser-keys', path.resolve(security.keyPath).startsWith(`${keysDir}${path.sep}`), security.keyPath)
    // No key exists before credentials are first saved ('no key yet'); a key, once written, must name the Keychain.
    check(
      'vault key backend is labelled for macOS',
      security.keyBackend === 'none' || security.keyBackendLabel === 'macOS Keychain' || /machine-derived/.test(security.keyBackendLabel),
      `${security.keyBackend}: ${security.keyBackendLabel}`,
    )
    const siteAccess = await api(() => window.api.siteAccess.status())
    check('Electron safeStorage (macOS Keychain) is usable', siteAccess.ok && siteAccess.data.available === true, siteAccess.ok ? siteAccess.data.reason ?? '' : JSON.stringify(siteAccess.error))
    check('no credentials configured (nothing baked into the app)', setup.proxy.configured === false)

    // Detection reads Info.plist and never starts a browser (the runner image has Chrome and Edge installed).
    const before = { chrome: countProcesses(['-x', 'Google Chrome']), edge: countProcesses(['-x', 'Microsoft Edge']) }
    for (let i = 0; i < 3; i++) await api(() => window.api.browsers.redetect())
    await sleep(3000)
    const after = { chrome: countProcesses(['-x', 'Google Chrome']), edge: countProcesses(['-x', 'Microsoft Edge']) }
    check('3 redetects start no Chrome / Edge process', after.chrome <= before.chrome && after.edge <= before.edge, `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)
    const engines = (await api(() => window.api.browsers.engines())).data
    const installed = engines.filter((engine) => engine.kind === 'installed')
    check('every vendor browser installs through its download page on macOS', installed.every((engine) => engine.installMethod === 'download-page'), installed.map((e) => `${e.id}=${e.installMethod}`).join(' '))
    for (const engine of installed.filter((e) => e.available)) {
      // A binary Info.plist yields no version (by design: the browser is never run to ask); Chrome ships XML.
      const versionOk = engine.id === 'chrome' ? /^\d+(\.\d+)+$/.test(engine.version ?? '') : engine.version === null || /^\d+(\.\d+)+$/.test(engine.version)
      check(
        `${engine.label} detected in an Applications folder${engine.id === 'chrome' ? ' with its Info.plist version' : ''}`,
        /\/Applications\/[^/]+\.app\/Contents\/MacOS\//.test(engine.executablePath) && versionOk,
        `${engine.executablePath} ${engine.version}`,
      )
    }

    // First run provisions the Playwright browsers into the app data folder, as on Windows.
    let browsers = (await api(() => window.api.browsers.status())).data
    check('browsers are provisioned under the app data folder', path.resolve(browsers.browsersPath) === path.resolve(info.dataPath, 'browsers'), browsers.browsersPath)
    check('the provisioned browsers are installable (not bundled)', browsers.installable === true, browsers.source)
    if (!browsers.chromium) {
      const deadline = Date.now() + 30_000
      let task = null
      while (Date.now() < deadline && !task) {
        task = (await api(() => window.api.tasks.list())).data.find((t) => t.kind === 'install-bundled' && t.engine === 'chromium') ?? null
        if (!task) await sleep(250)
      }
      if (!task) {
        const queued = await api(() => window.api.browsers.install('chromium'))
        task = queued.ok ? queued.data[0] : null
      }
      const done = task ? await waitForTask(api, task.id, 20 * 60_000) : null
      check('Chromium download task finishes verified', done && done.state === 'done' && done.verification?.smoke === 'passed', done ? `${done.state} ${done.note || done.error?.message || ''}` : 'no task')
      browsers = (await api(() => window.api.browsers.status())).data
    }
    check('Chromium is available', browsers.chromium)
    const unexpected = readdirSync(browsers.browsersPath).filter((name) => name.startsWith('chromium_headless_shell-'))
    check('no headless shell is kept', unexpected.length === 0, unexpected.join(', '))

    await api(() => window.api.setup.complete())
    if (browsers.chromium) {
      const launched = await api((input) => window.api.launcher.quickLaunch(input), {
        startUrl: pageUrl,
        engine: 'chromium',
        devicePreset: 'macos-desktop',
        proxyPool: 'none',
        target: null,
        sticky: false,
        stickyTtlMinutes: null,
        locale: null,
        timezone: null,
        saveAsProfile: false,
        profileName: null,
        replaceActiveSession: true,
      })
      let session = launched.ok ? launched.data : null
      for (let i = 0; session && i < 90 && !['open', 'error', 'closed'].includes(session.status); i++) {
        await sleep(1000)
        session = (await api(() => window.api.browser.listActive())).data.find((s) => s.id === launched.data.id) || session
      }
      const run = session ? (await api((id) => window.api.runs.get(id), session.runId)).data : null
      check('a direct Chromium session opens the local page', session?.status === 'open' && run?.httpStatus === 200, launched.ok ? `status=${session?.status} http=${run?.httpStatus}` : JSON.stringify(launched.error))
      check('the session browser carries the --proxy-qa-session marker', countProcesses(['-f', '--', '--proxy-qa-session=']) > 0)
      await win.screenshot({ path: path.join(OUT, '02-session.png') })
      await api(() => window.api.launcher.closeAll())
    }
    check('no renderer errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await app.close().catch(() => undefined)
    server.close()
  }
  await sleep(3000)
  check('no --proxy-qa-session process remains after quitting', countProcesses(['-f', '--', '--proxy-qa-session=']) === 0)

  // Leave nothing behind outside the temporary user data folder (the key file is per installation).
  const keysDir = path.join(homedir(), 'Library', 'Application Support', 'ProxyQABrowser-keys')
  if (keyFile && path.dirname(path.resolve(keyFile)) === keysDir) rmSync(keyFile, { force: true })
  rmSync(userData, { recursive: true, force: true })

  writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2))
  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun)
  main().catch((err) => {
    console.error('MACOS SMOKE TEST CRASHED:', err)
    annotate('macOS smoke crashed', err?.stack || err)
    try {
      mkdirSync(OUT, { recursive: true })
      writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ crashed: String(err?.stack || err), results }, null, 2))
    } catch {
      /* ignore */
    }
    process.exit(1)
  })

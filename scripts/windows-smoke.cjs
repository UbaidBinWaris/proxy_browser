/**
 * End-to-end smoke test of the packaged Windows app (release/win-unpacked).
 * Run on a real Windows machine or the GitHub Actions windows runner:
 *
 *   node scripts/windows-smoke.cjs
 *
 * It drives the real app through playwright-core's Electron driver and checks the
 * things that differ between Windows and Linux: DPAPI key protection, %APPDATA% /
 * %LOCALAPPDATA% paths, first-run browser download into the app data folder,
 * engine detection (Edge is preinstalled on Windows) and a real browser launch.
 * It also proves the fixes for "browsers open by themselves on Windows":
 * detection never starts a browser (process counts around redetects), installs
 * run as verified background tasks, a launch of an engine that is installing is
 * refused with ENGINE_BUSY, bring-to-front works, and no session browser
 * (--proxy-qa-session=…) survives app.close().
 * No proxy credentials are needed: the launch uses a direct connection.
 * Exits non-zero when any check fails. Screenshots go to smoke-output/.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, __dirname, process, console, setTimeout, window, Buffer, module */
const { _electron: electron } = require('playwright-core')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const ROOT = path.resolve(__dirname, '..')
const EXE = path.join(ROOT, 'release', 'win-unpacked', 'Proxy-QA-Browser.exe')
const OUT = path.join(ROOT, 'smoke-output')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail: String(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

/** Running instances of an image name, from `tasklist /FO CSV` (hidden window). */
function countImage(image) {
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH', '/FI', `IMAGENAME eq ${image}`], {
      encoding: 'utf8',
      windowsHide: true,
    })
    return out.split(/\r?\n/).filter((line) => line.toLowerCase().startsWith(`"${image.toLowerCase()}"`)).length
  } catch {
    return -1
  }
}

/** Processes whose command line carries the session marker (CIM through a hidden PowerShell). */
function markedProcesses() {
  const script =
    "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('--proxy-qa-session=') } | ForEach-Object { $_.ProcessId }"
  try {
    const out = execFileSync(
      'powershell.exe',
      // An encoded query also keeps its own command line free of the browser marker.
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { encoding: 'utf8', windowsHide: true },
    )
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  } catch (err) {
    return [`error: ${err.message}`]
  }
}

async function waitForTask(api, taskId, timeoutMs) {
  const started = Date.now()
  let task = null
  while (Date.now() - started < timeoutMs) {
    task = (await api(() => window.api.tasks.list())).data.find((t) => t.id === taskId) || task
    if (task && ['done', 'failed', 'cancelled'].includes(task.state)) return task
    await sleep(1000)
  }
  return task
}

async function checkComputerSetup(api, app, sourceExecutable = EXE, report = check) {
  // Electron resolves Windows Known Folders independently of env.APPDATA. Check
  // the same native folder used by the app, preserving a local user's shortcut.
  const appData = await app.evaluate(({ app }) => app.getPath('appData'))
  const shortcutPath = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Proxy QA Browser.lnk')
  const originalShortcut = fs.existsSync(shortcutPath) ? fs.readFileSync(shortcutPath) : null
  let localExe
  try {
    const computerSetup = await api(() => window.api.desktop.setup({ desktop: false, startMenu: true }))
    report('computer setup succeeds', computerSetup.ok, computerSetup.error?.message || '')
    if (!computerSetup.ok) {
      const logs = await api(() => window.api.logs.list({ level: 'ERROR', limit: 10 }))
      console.error('Computer setup diagnostics:', JSON.stringify(logs.data))
    }
    localExe = computerSetup.ok ? computerSetup.data.installedPath : null
    report('computer copy is outside the packaged source', localExe && localExe !== sourceExecutable && fs.existsSync(localExe), localExe || '')
    if (localExe) {
      const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
      report(
        'computer copy preserves the exact packaged app.asar',
        digest(path.join(path.dirname(localExe), 'resources', 'app.asar')) === digest(path.join(path.dirname(sourceExecutable), 'resources', 'app.asar')),
      )
    }
    report(
      'Start menu shortcut created',
      computerSetup.ok && computerSetup.data.startMenuShortcut && fs.existsSync(shortcutPath),
      `${shortcutPath}${computerSetup.ok && computerSetup.data.warnings.length ? `; ${computerSetup.data.warnings.join('; ')}` : ''}`,
    )
    if (fs.existsSync(shortcutPath)) {
      const link = await app.evaluate(({ shell }, file) => shell.readShortcutLink(file), shortcutPath)
      // Windows Shell expands 8.3 names (RUNNER~1) and may change path casing.
      const canonical = (file) => fs.realpathSync.native(file).toLowerCase()
      report('shortcut targets the stable executable', canonical(link.target) === canonical(localExe), link.target)
      report('shortcut uses the stable app identity', link.appUserModelId === 'com.ubaidbinwaris.proxy-qa-browser', link.appUserModelId)
    }
  } finally {
    if (originalShortcut !== null) fs.writeFileSync(shortcutPath, originalShortcut)
    else fs.rmSync(shortcutPath, { force: true })
  }

  return localExe
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  if (!fs.existsSync(EXE)) throw new Error(`Packaged app not found at ${EXE}. Run "npm run build:windows" first.`)
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pqa-smoke-'))
  const env = { ...process.env, APPDATA: path.join(userData, 'Roaming'), LOCALAPPDATA: path.join(userData, 'Local') }
  fs.mkdirSync(env.APPDATA, { recursive: true })
  fs.mkdirSync(env.LOCALAPPDATA, { recursive: true })
  delete env.ELECTRON_RUN_AS_NODE
  for (const key of Object.keys(env)) if (key.startsWith('DATAIMPULSE_')) delete env[key]

  const t0 = Date.now()
  const app = await electron.launch({
    executablePath: EXE,
    args: [`--user-data-dir=${userData}`],
    env,
    timeout: 120_000,
  })
  const consoleErrors = []
  const win = await app.firstWindow({ timeout: 120_000 })
  win.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  win.on('pageerror', (e) => consoleErrors.push(e.message))
  await win.waitForLoadState('domcontentloaded')
  await sleep(2500)
  check('app window opens', true, `${Date.now() - t0} ms`)
  const api = (fn, arg) => win.evaluate(fn, arg)

  const info = (await api(() => window.api.app.getInfo())).data
  check('platform is win32', info.platform === 'win32', info.platform)
  check('packaged build', info.isPackaged === true)
  await win.screenshot({ path: path.join(OUT, '01-first-run.png') })

  const setup = (await api(() => window.api.setup.status())).data
  check('first run detected', setup.firstRun === true)
  const sec = setup.security
  check(
    'vault key uses Windows DPAPI',
    sec.keyBackend === 'os-keychain' && /DPAPI/i.test(sec.keyBackendLabel),
    sec.keyBackendLabel,
  )
  check('key stored under %LOCALAPPDATA%', /ProxyQABrowser[\\/]keys/i.test(sec.keyPath), sec.keyPath)
  check('no credentials configured (nothing baked into the EXE)', setup.proxy.configured === false)

  // No install API call or wizard click: opening the portable app must queue preparation itself.
  let initialStatus = (await api(() => window.api.browsers.status())).data
  const missing = ['chromium', 'firefox', 'webkit'].filter((engine) => !initialStatus[engine])
  if (initialStatus.installable && missing.length > 0) {
    const deadline = Date.now() + 30_000
    let automaticTasks = []
    while (Date.now() < deadline) {
      automaticTasks = (await api(() => window.api.tasks.list())).data.filter((task) => task.kind === 'install-bundled')
      if (missing.every((engine) => automaticTasks.some((task) => task.engine === engine))) break
      await sleep(250)
    }
    check(
      'first opening automatically queues missing browsers without a click',
      missing.every((engine) => automaticTasks.some((task) => task.engine === engine)),
      automaticTasks.map((task) => task.engine).join(', '),
    )
    await win.getByRole('heading', { name: 'Browser engines', exact: true }).waitFor()

    // A queued browser remains unavailable until its download and verification finish.
    const firefox = automaticTasks.find(
      (task) => task.engine === 'firefox' && ['queued', 'running', 'verifying'].includes(task.state),
    )
    if (firefox) {
      const busy = await api((input) => window.api.launcher.quickLaunch(input), {
        startUrl: 'https://example.com/',
        engine: 'firefox',
        devicePreset: 'windows-desktop',
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
      check(
        'launching an automatically queued Firefox is refused with ENGINE_BUSY',
        !busy.ok && busy.error.code === 'ENGINE_BUSY',
        busy.ok ? 'launched' : busy.error.code,
      )
    }

    // Reloading while downloads run must reuse active tasks, never duplicate them.
    await win.reload()
    await win.waitForLoadState('domcontentloaded')
    await sleep(2500)
    const afterReload = (await api(() => window.api.tasks.list())).data.filter(
      (task) => task.kind === 'install-bundled',
    )
    check(
      'reload reuses first-run preparation tasks',
      afterReload.length === automaticTasks.length &&
        automaticTasks.every((task) => afterReload.some((candidate) => candidate.id === task.id)),
    )
    for (const queued of automaticTasks) {
      const task = await waitForTask(api, queued.id, 20 * 60_000)
      check(
        `${queued.engine} automatic preparation finishes verified`,
        task && task.state === 'done' && task.verification && task.verification.smoke === 'passed',
        task ? `${task.state} ${task.note || (task.error && task.error.message) || ''}` : 'no task',
      )
    }
    initialStatus = (await api(() => window.api.browsers.status())).data
    check(
      'all three prepared engines are available',
      initialStatus.chromium && initialStatus.firefox && initialStatus.webkit,
    )
  }

  // Leave the first-run wizard so Settings → Browsers can be opened.
  await api(() => window.api.setup.complete())
  await win.evaluate(() => {
    window.location.hash = '#/launch'
  })
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await sleep(2000)

  // (a) Detection must never start a browser: chrome.exe / msedge.exe ignore --version on Windows and open a window.
  const before = { msedge: countImage('msedge.exe'), chrome: countImage('chrome.exe') }
  for (let i = 0; i < 3; i++) await api(() => window.api.browsers.redetect())
  await win.evaluate(() => {
    window.location.hash = '#/settings/browsers'
  })
  await sleep(5000)
  const after = { msedge: countImage('msedge.exe'), chrome: countImage('chrome.exe') }
  check(
    '3 redetects + Settings → Browsers start no msedge.exe / chrome.exe',
    after.msedge <= before.msedge && after.chrome <= before.chrome,
    `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
  )

  const engines = (await api(() => window.api.browsers.engines())).data
  const edge = engines.find((e) => e.id === 'msedge')
  check('Microsoft Edge detected (preinstalled on Windows)', edge && edge.available, edge && edge.executablePath)
  check(
    'Edge version read from the .exe resources (not by running it)',
    edge && /^\d+\.\d+\.\d+\.\d+$/.test(edge.version || ''),
    edge && edge.version,
  )

  let status = (await api(() => window.api.browsers.status())).data
  check(
    'bundled browsers dir under app data',
    status.browsersPath.toLowerCase() === path.join(info.dataPath, 'browsers').toLowerCase() ||
      status.source !== 'provisioned',
    status.browsersPath,
  )
  if (!status.chromium) {
    // (b) Installs are queued background tasks, verified with a headless launch before they count as done.
    const t1 = Date.now()
    const queued = await api(() => window.api.browsers.install('chromium'))
    const task = queued.ok && queued.data[0] ? await waitForTask(api, queued.data[0].id, 20 * 60_000) : null
    status = (await api(() => window.api.browsers.status())).data
    check(
      'first-run Chromium download task finishes verified',
      task && task.state === 'done' && task.verification && task.verification.smoke === 'passed' && status.chromium,
      task
        ? `${task.state} ${task.note || (task.error && task.error.message) || ''} in ${Math.round((Date.now() - t1) / 1000)} s`
        : JSON.stringify(queued.error),
    )
  } else {
    check('Chromium available', true, status.source)
  }

  // (c) A launch of an engine with a queued/running install is refused with ENGINE_BUSY.
  if (status.installable && !status.firefox) {
    const queued = await api(() => window.api.browsers.install('firefox'))
    const busy = await api((input) => window.api.launcher.quickLaunch(input), {
      startUrl: 'https://example.com/',
      engine: 'firefox',
      devicePreset: 'windows-desktop',
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
    check(
      'launching Firefox while it installs is refused with ENGINE_BUSY',
      !busy.ok && busy.error.code === 'ENGINE_BUSY',
      busy.ok ? 'launched' : `${busy.error.code}: ${busy.error.message}`,
    )
    if (queued.ok && queued.data[0]) {
      const task = await waitForTask(api, queued.data[0].id, 20 * 60_000)
      check(
        'Firefox download task finishes verified',
        task && task.state === 'done',
        task ? `${task.state} ${task.note || (task.error && task.error.message) || ''}` : 'no task',
      )
    }
  }

  const states = (await api(() => window.api.locations.search({ mode: 'state', query: 'new j', limit: 5 }))).data
  check('location search works', states.length > 0 && /New Jersey/.test(states[0].label), states[0] && states[0].label)

  await api(() => window.api.setup.complete())

  async function launchDirect(engine, preset) {
    const r = await api((input) => window.api.launcher.quickLaunch(input), {
      startUrl: 'https://example.com/',
      engine,
      devicePreset: preset,
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
    if (!r.ok) return { ok: false, detail: `${r.error.code}: ${r.error.message}` }
    let s = r.data
    for (let i = 0; i < 90 && !['open', 'error', 'closed'].includes(s.status); i++) {
      await sleep(1000)
      s = (await api(() => window.api.browser.listActive())).data.find((x) => x.id === r.data.id) || s
    }
    const shot = s.status === 'open' ? await api((id) => window.api.browser.screenshot(id), s.id) : null
    // (d) Bring to front works on an open session.
    const focus = s.status === 'open' ? await api((id) => window.api.browser.focus(id), s.id) : null
    if (focus) check(`bring ${engine} to the front`, focus.ok, focus.ok ? '' : JSON.stringify(focus.error))
    await api(() => window.api.launcher.closeAll())
    await sleep(1500)
    const run = (await api((id) => window.api.runs.get(id), s.runId)).data
    return {
      ok: s.status === 'open' && run.httpStatus === 200,
      detail: `status=${s.status} http=${run.httpStatus} ip=${run.publicIp} shot=${shot && shot.ok}${s.error ? ` err=${s.error.message}` : ''}`,
    }
  }

  if (status.chromium) {
    const r = await launchDirect('chromium', 'pixel-9')
    check('launch bundled Chromium (Pixel 9 emulation) to example.com', r.ok, r.detail)
  }
  if (edge && edge.available) {
    const r = await launchDirect('msedge', 'windows-desktop')
    check('launch installed Microsoft Edge to example.com', r.ok, r.detail)
  }

  await win.screenshot({ path: path.join(OUT, '02-after-launches.png') })
  check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

  const localExe = await checkComputerSetup(api, app)

  // (e) app.close() with a session still open leaves no --proxy-qa-session browser behind.
  if (status.chromium) {
    await api((input) => window.api.launcher.quickLaunch(input), {
      startUrl: 'https://example.com/',
      engine: 'chromium',
      devicePreset: 'windows-desktop',
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
    await sleep(8000)
    check(
      'a session browser carries the --proxy-qa-session marker',
      markedProcesses().length > 0,
      markedProcesses().join(','),
    )
  }
  await app.close()
  await sleep(3000)
  const leftovers = markedProcesses()
  check('no --proxy-qa-session process remains after app.close()', leftovers.length === 0, leftovers.join(','))

  const restart = await electron.launch({
    executablePath: localExe || EXE,
    args: [`--user-data-dir=${userData}`],
    env,
    timeout: 120_000,
  })
  const win2 = await restart.firstWindow({ timeout: 120_000 })
  await win2.waitForLoadState('domcontentloaded')
  await sleep(2500)
  const localStatus = (await win2.evaluate(() => window.api.desktop.status())).data
  check('second start uses the computer copy', localStatus.runningInstalledCopy === true)
  const setup2 = (await win2.evaluate(() => window.api.setup.status())).data
  check('second start continues from saved setup', setup2.firstRun === false && setup2.security.decryptOk === true)
  const status2 = (await win2.evaluate(() => window.api.browsers.status())).data
  check(
    'second start reuses prepared browsers',
    status2.chromium === initialStatus.chromium &&
      status2.firefox === initialStatus.firefox &&
      status2.webkit === initialStatus.webkit &&
      status2.browsersPath === initialStatus.browsersPath,
  )
  const tasks2 = (await win2.evaluate(() => window.api.tasks.list())).data
  check(
    'second start queues no new browser downloads',
    !tasks2.some((task) => ['queued', 'running', 'verifying'].includes(task.state)),
  )
  const runs = (await win2.evaluate(() => window.api.runs.list(20))).data
  check('runs persisted across restart (SQLite)', runs.length >= 1, `${runs.length} runs`)
  await win2.screenshot({ path: path.join(OUT, '03-restart.png') })
  await restart.close()

  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2))
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

module.exports = { checkComputerSetup }

if (require.main === module) main().catch((err) => {
  console.error('SMOKE TEST CRASHED:', err)
  try {
    fs.writeFileSync(
      path.join(OUT, 'results.json'),
      JSON.stringify({ crashed: String((err && err.stack) || err), results }, null, 2),
    )
  } catch {
    /* ignore */
  }
  process.exit(1)
})

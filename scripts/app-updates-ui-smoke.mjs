/* global process, console, window, document */
/** Real Electron UI with isolated Windows desktop IPC fixtures. No OS shortcuts or relaunches. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const root = resolve(import.meta.dirname, '..')
const stateDir = await mkdtemp(join(tmpdir(), 'qa-app-updates-ui-'))
const output = join(root, 'smoke-output')
await mkdir(output, { recursive: true })
const env = { ...process.env, XDG_DATA_HOME: stateDir, LOCALAPPDATA: stateDir, PROXY_QA_TEST_DATA_DIR: join(stateDir, 'app') }
delete env.ELECTRON_RUN_AS_NODE
let app
try {
  app = await electron.launch({ args: [root, `--user-data-dir=${join(stateDir, 'app')}`], env, timeout: 60000 })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const browserWindow = BrowserWindow.getAllWindows()[0]
    browserWindow.webContents.setBackgroundThrottling(false)
    browserWindow.setBounds({ width: 1280, height: 1100 })
    browserWindow.show()
    browserWindow.focus()
    const state = { setup: [], pins: 0, launches: 0, apply: 0, online: 0, retries: 0, dismissed: 0, failSetup: true, failUsb: true, failRetry: true, cancelUsb: false,
      status: { supported: true, platform: 'win32', arch: 'x64', currentVersion: '1.2.0', installedVersion: null, installedPath: null, runningInstalledCopy: false, desktopShortcut: false, startMenuShortcut: false, offlineUpdatesReady: true, releaseNotes: ['Faster Windows launches from the computer copy.'], warnings: [],
        lastUpdate: { version: '1.2.0', status: 'failed', message: 'The prepared USB update has changed.', at: '2026-10-09T08:00:00.000Z' } } }
    globalThis.qaDesktopUi = state
    const replace = (channel, handler) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler) }
    const ok = (data) => ({ ok: true, data })
    replace('desktop:status', () => ok(state.status))
    replace('desktop:setup', (_event, options) => {
      state.setup.push(options)
      if (state.failSetup) { state.failSetup = false; return { ok: false, error: { code: 'INTERNAL', message: 'Setup copy failed; please retry.' } } }
      Object.assign(state.status, { installedVersion: '1.2.0', installedPath: 'C:\\Users\\Tester\\AppData\\Local\\ProxyQABrowser\\Application\\Proxy-QA-Browser.exe', desktopShortcut: options.desktop, startMenuShortcut: options.startMenu })
      return ok(state.status)
    })
    replace('desktop:show-pinning', () => { state.pins++; return ok(undefined) })
    replace('desktop:launch-installed', () => { state.launches++; return ok(undefined) })
    replace('desktop:choose-usb', () => {
      if (state.failUsb) { state.failUsb = false; return { ok: false, error: { code: 'INVALID_INPUT', message: 'This USB update is not signed by your publisher.' } } }
      if (state.cancelUsb) { state.cancelUsb = false; return ok(null) }
      return ok({ version: '1.3.0', fileName: 'Proxy-QA-Browser-1.3.0-Windows-x64.exe', notes: ['Example verified release'], size: 100 * 1024 * 1024 })
    })
    replace('qa:check-updates', () => ok({ configured: true, available: true, currentVersion: '1.2.0', version: '1.3.0', fileName: 'Proxy-QA-Browser-1.3.0-Windows-x64.exe' }))
    replace('desktop:apply-online', () => { state.online++; return ok(undefined) })
    replace('desktop:apply-usb', () => { state.apply++; return ok(undefined) })
    // The simulated install runs v1.2.0 everywhere (sidebar version, badge comparison, About facts).
    replace('app:get-info', () => ok({ version: '1.2.0', platform: 'win32', userDataPath: 'C:\\Users\\Tester\\AppData\\Roaming\\proxy-qa-browser', dataPath: 'C:\\Users\\Tester\\AppData\\Roaming\\proxy-qa-browser\\data', isPackaged: true }))
    replace('desktop:update-availability', () => ok({ available: true, version: '1.3.0', checkedAt: '2026-10-09T08:00:00.000Z' }))
    replace('desktop:retry-pending-update', () => {
      state.retries++
      if (state.failRetry) { state.failRetry = false; return { ok: false, error: { code: 'INVALID_INPUT', message: 'The prepared USB update has changed.' } } }
      state.status.lastUpdate = { version: '1.2.0', status: 'succeeded', message: 'Your shortcuts and local data were kept.', at: '2026-10-09T08:01:00.000Z' }
      return ok(state.status)
    })
    replace('desktop:dismiss-update-notice', () => { state.dismissed++; state.status.lastUpdate = null; return ok(undefined) })
  })
  await page.waitForFunction(() => Boolean(window.api))
  assert((await page.evaluate(() => window.api.setup.complete())).ok)
  await page.evaluate(() => { window.location.hash = '#/launch' })
  await page.reload()
  // Startup check result: the sidebar badge, without the App & updates card's own check.
  const badge = page.getByRole('link', { name: /Update available: v1\.3\.0/ })
  await badge.waitFor()
  assert.equal(await badge.getByText('Update', { exact: true }).isVisible(), true)
  // Update result notice: a failure with Retry and a link to App & updates.
  const failure = page.getByRole('alert').filter({ hasText: 'Update to v1.2.0 did not finish' })
  await failure.waitFor()
  await failure.getByText('The prepared USB update has changed.').waitFor()
  assert.equal(await failure.getByRole('link', { name: 'Open App & updates' }).count(), 1)
  await page.screenshot({ path: join(output, 'update-notice.png') })
  await failure.getByRole('button', { name: 'Retry update' }).click()
  await page.getByText('The update still did not finish').waitFor()
  await failure.waitFor() // still failed: the stored outcome is shown again
  await failure.getByRole('button', { name: 'Retry update' }).click()
  const success = page.getByRole('status').filter({ hasText: 'Updated to v1.2.0' })
  await success.waitFor()
  await success.getByRole('button', { name: 'Dismiss update notice' }).click()
  await success.waitFor({ state: 'detached' })
  assert.deepEqual(await app.evaluate(() => ({ retries: globalThis.qaDesktopUi.retries, dismissed: globalThis.qaDesktopUi.dismissed })), { retries: 2, dismissed: 1 })
  while (await page.getByRole('button', { name: 'Dismiss notification' }).count()) await page.getByRole('button', { name: 'Dismiss notification' }).first().click()
  await badge.click()
  await page.getByRole('heading', { name: 'App & updates', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Download v1.3.0 and restart' }).click()
  await page.getByRole('checkbox', { name: 'Desktop shortcut' }).uncheck()
  await page.getByRole('button', { name: 'Set up on this computer', exact: true }).click()
  await page.getByText(/Setup copy failed; please retry/).waitFor()
  await page.getByRole('button', { name: 'Set up on this computer', exact: true }).click()
  await page.getByRole('button', { name: 'Use computer copy', exact: true }).waitFor()
  const setupCalls = await app.evaluate(() => globalThis.qaDesktopUi.setup)
  assert.deepEqual(setupCalls, [{ desktop: false, startMenu: true }, { desktop: false, startMenu: true }])
  await page.getByRole('button', { name: 'Pin to Start or taskbar' }).click()
  await page.getByText(/The Start menu shortcut is selected/).waitFor()
  await page.getByRole('button', { name: 'Use computer copy' }).click()
  await page.getByRole('button', { name: 'Choose USB update' }).click()
  await page.getByText(/This USB update is not signed by your publisher/).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Restart with v1.3.0' }).count(), 0)
  await page.getByRole('button', { name: 'Choose USB update' }).click()
  await page.getByRole('button', { name: 'Restart with v1.3.0' }).waitFor()
  while (await page.getByRole('button', { name: 'Dismiss notification' }).count()) await page.getByRole('button', { name: 'Dismiss notification' }).first().click()
  await page.screenshot({ path: join(output, 'app-updates.png'), fullPage: true })
  await page.getByRole('button', { name: 'Restart with v1.3.0' }).click()
  await app.evaluate(() => { globalThis.qaDesktopUi.cancelUsb = true })
  await page.getByRole('button', { name: 'Choose USB update' }).click()
  await page.getByRole('button', { name: 'Choose USB update' }).waitFor({ state: 'visible' })
  await page.waitForFunction(() => !document.body.textContent.includes('Verified update · v1.3.0'))
  const calls = await app.evaluate(() => { const state = globalThis.qaDesktopUi; return { pins: state.pins, launches: state.launches, apply: state.apply, online: state.online } })
  assert.deepEqual(calls, { pins: 1, launches: 1, apply: 1, online: 1 })
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(720, 650); win.setSize(760, 1050) })
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'App screen should not overflow horizontally')
  // A later startup-check event moves the badge to the newer release.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('event:update-available', { available: true, version: '1.4.0', checkedAt: '2026-10-09T09:00:00.000Z' }))
  await page.getByRole('link', { name: /Update available: v1\.4\.0/ }).waitFor()
  await page.evaluate(() => { window.location.hash = '#/settings/general' })
  const startupSwitch = page.getByRole('switch', { name: 'Check for updates on startup' })
  await startupSwitch.waitFor()
  assert.equal(await startupSwitch.getAttribute('aria-checked'), 'true')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'APP UPDATES UI SMOKE PASSED', checks: ['startup update badge', 'update failure notice', 'retry failure and success', 'dismiss notice', 'update-available event', 'startup check setting', 'online update discovery and restart', 'setup and retry', 'shortcut choices', 'pin guidance', 'computer-copy launch', 'invalid signature', 'verified release preview', 'restart action', 'cancel chooser', 'narrow layout'], screenshot: 'smoke-output/app-updates.png', notice: 'smoke-output/update-notice.png' }, null, 2))
} finally {
  if (app) await app.close().catch(() => {})
  await rm(stateDir, { recursive: true, force: true })
}

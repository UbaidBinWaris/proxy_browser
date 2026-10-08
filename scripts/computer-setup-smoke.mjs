/* global process, console, window */
/** Linux packaged runtime → real computer AppImage copy → reopen with the same local data. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const root = resolve(import.meta.dirname, '..')
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const distribution = join(root, 'release', `Proxy-QA-Browser-${version}-x86_64.AppImage`)
const state = await mkdtemp(join(tmpdir(), 'qa-computer-setup-'))
const env = { ...process.env, XDG_DATA_HOME: state, LOCALAPPDATA: state, APPIMAGE: distribution }
delete env.ELECTRON_RUN_AS_NODE
delete env.PLAYWRIGHT_BROWSERS_PATH
delete env.PROXY_QA_WEBKIT_LIBS
delete env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS
const args = [`--user-data-dir=${join(state, 'app')}`]
let app
try {
  console.log('Launching the packaged Linux runtime')
  app = await electron.launch({ executablePath: join(root, 'release', 'linux-unpacked', 'proxy-qa-browser'), args, env, timeout: 60000 })
  const page = await app.firstWindow()
  const api = async (fn, arg) => { const result = await page.evaluate(fn, arg); assert(result.ok, result.error?.message); return result.data }
  const info = await api(() => window.api.app.getInfo())
  assert(info.isPackaged && info.userDataPath.startsWith(state))
  await api(() => window.api.setup.complete())
  const profile = await api(() => window.api.profiles.create({ name: 'Preserved profile', engine: 'chromium', deviceType: 'desktop', devicePreset: 'linux-desktop', viewportWidth: 1280, viewportHeight: 800, userAgent: null, locale: 'en-US', timezone: 'UTC', proxyMode: 'none', stickySessionId: null, formUrlOverride: 'https://saved.example.test/', notes: '', proxyPool: 'residential', target: null }))
  const before = await api(() => window.api.browsers.status())
  const installed = await api(() => window.api.desktop.setup({ desktop: false, startMenu: true }))
  assert.equal(installed.installedVersion, version)
  assert(installed.installedPath.startsWith(state))
  assert(installed.startMenuShortcut)
  const entry = await readFile(join(state, 'applications', 'com.ubaidbinwaris.proxy-qa-browser.desktop'), 'utf8')
  assert(entry.includes(`Exec="${installed.installedPath}"`))
  await app.close()
  app = null
  delete env.APPIMAGE
  console.log('Reopening the installed AppImage copy')
  app = await electron.launch({ executablePath: installed.installedPath, args, env, timeout: 60000 })
  const reopened = await app.firstWindow()
  const status = await reopened.evaluate(() => window.api.desktop.status())
  assert(status.ok && status.data.runningInstalledCopy)
  const profiles = await reopened.evaluate(() => window.api.profiles.list())
  assert(profiles.ok && profiles.data.some((item) => item.id === profile.id))
  const setup = await reopened.evaluate(() => window.api.setup.status())
  assert(setup.ok && !setup.data.firstRun)
  const browsers = await reopened.evaluate(() => window.api.browsers.status())
  assert(browsers.ok && browsers.data.source === before.source && browsers.data.chromium)
  await mkdir(join(root, 'smoke-output'), { recursive: true })
  await reopened.evaluate(() => { window.location.hash = '#/settings/about' })
  await reopened.getByRole('heading', { name: 'App & updates', exact: true }).waitFor()
  await reopened.screenshot({ path: join(root, 'smoke-output', 'computer-copy-linux.png') })
  console.log(JSON.stringify({ result: 'LINUX COMPUTER SETUP SMOKE PASSED', version, checks: ['real AppImage copied', 'Applications entry created', 'stable AppImage opens', 'profile and setup state preserved', 'bundled browsers available'] }, null, 2))
} finally {
  if (app) await app.close().catch(() => {})
  await rm(state, { recursive: true, force: true })
}

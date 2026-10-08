/* global process, console, window, setTimeout */
/**
 * Runs the built Electron renderer with Windows first-run IPC fixtures.
 * Checks automatic preparation, retry, progress, reload and completed-setup reuse
 * without downloading engines. Native Windows downloads are tested separately
 * by windows-smoke.cjs; this simulation does not verify Windows executables.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const root = resolve(import.meta.dirname, '..')
const stateDir = await mkdtemp(join(tmpdir(), 'qa-first-run-smoke-'))
const output = join(root, 'smoke-output')
await mkdir(output, { recursive: true })
const env = { ...process.env, XDG_DATA_HOME: stateDir, LOCALAPPDATA: stateDir }
delete env.ELECTRON_RUN_AS_NODE
let app
try {
  app = await electron.launch({ args: [root, `--user-data-dir=${join(stateDir, 'app')}`], env, timeout: 60000 })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.api))
  const base = await page.evaluate(async () => ({
    info: (await window.api.app.getInfo()).data,
    setup: (await window.api.setup.status()).data,
  }))
  await app.evaluate(({ ipcMain }, base) => {
    const browsers = {
      ...base.setup.browsers,
      source: 'provisioned',
      installable: true,
      chromium: false,
      firefox: false,
      webkit: false,
    }
    const state = { browsers, tasks: [], calls: 0, firstRun: true, failNext: true }
    globalThis.qaFirstRunSmoke = state
    const setup = () => ({
      ...base.setup,
      proxy: {
        ...base.setup.proxy,
        configured: false,
        source: 'none',
        pools: base.setup.proxy.pools.map((pool) => ({ ...pool, configured: false, source: 'none', usernameMasked: null })),
      },
      firstRun: state.firstRun,
      completedAt: state.firstRun ? null : new Date().toISOString(),
      browsers,
      pending: [...(browsers.chromium ? [] : ['browsers']), 'credentials'],
    })
    const replace = (channel, handler) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, handler)
    }
    const ok = (data) => ({ ok: true, data })
    // Delay app info to check the setup/status versus platform-info startup race.
    replace('app:get-info', async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
      return ok({ ...base.info, platform: 'win32', isPackaged: true })
    })
    replace('setup:status', () => ok(setup()))
    replace('setup:complete', () => {
      state.firstRun = false
      return ok(setup())
    })
    replace('browsers:status', () => ok(browsers))
    replace('tasks:list', () => ok(state.tasks))
    replace('browsers:install', (_event, target) => {
      state.calls++
      if (target !== 'all') throw new Error('First launch must request all missing engines')
      if (state.failNext) {
        state.failNext = false
        return { ok: false, error: { code: 'INTERNAL', message: 'Download service unavailable (test fixture)' } }
      }
      for (const engine of ['chromium', 'firefox', 'webkit']) {
        if (browsers[engine] || state.tasks.some((task) => task.engine === engine)) continue
        state.tasks.push({
          id: engine,
          engine,
          kind: 'install-bundled',
          label: `Install ${engine}`,
          state: 'queued',
          phase: 'Waiting',
          percent: null,
          queuedAt: new Date().toISOString(),
          startedAt: null,
          finishedAt: null,
          error: null,
          note: null,
          verification: null,
        })
      }
      return ok(state.tasks)
    })
  }, base)
  const snapshot = () => app.evaluate(() => globalThis.qaFirstRunSmoke)
  await page.reload()
  await page.getByRole('heading', { name: 'Browser engines', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Retry install', exact: true }).waitFor()
  assert.equal((await snapshot()).calls, 1, 'first opening must start preparation without any click')
  await page.getByRole('button', { name: 'Retry install', exact: true }).click()
  await page.getByRole('button', { name: 'Installing…', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Installing…', exact: true }).isDisabled(), true)
  assert.deepEqual(
    (await snapshot()).tasks.map((task) => task.engine),
    ['chromium', 'firefox', 'webkit'],
  )
  await page.screenshot({ path: join(output, 'first-run-automatic-preparation.png') })
  await page.reload()
  await page.getByRole('button', { name: 'Installing…', exact: true }).waitFor()
  assert.equal((await snapshot()).tasks.length, 3, 'reload must reuse active preparation tasks')
  await app.evaluate(({ BrowserWindow }) => {
    const state = globalThis.qaFirstRunSmoke
    for (const task of state.tasks) {
      state.browsers[task.engine] = true
      Object.assign(task, {
        state: 'done',
        phase: 'Verified',
        finishedAt: new Date().toISOString(),
        verification: { executableExists: true, version: '1.0', smoke: 'passed', smokeDetail: null, pathSaved: true },
      })
    }
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('event:tasks-update', state.tasks)
  })
  await page.getByRole('button', { name: 'Continue', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: 'Skip for now', exact: true }).click()
  await page.getByRole('button', { name: 'Open launcher', exact: true }).click()
  await page.getByRole('heading', { name: 'Launch', exact: true }).waitFor()
  const calls = (await snapshot()).calls
  await page.reload()
  await page.getByRole('heading', { name: 'Launch', exact: true }).waitFor()
  assert.equal((await snapshot()).calls, calls, 'completed setup must never queue more downloads on opening')
  assert.deepEqual(errors, [])
  console.log(
    'Windows first-launch UI simulation passed: automatic preparation, error retry, progress, reload, optional credentials and completed-setup reuse.',
  )
} finally {
  if (app) await app.close()
  await rm(stateDir, { recursive: true, force: true })
}

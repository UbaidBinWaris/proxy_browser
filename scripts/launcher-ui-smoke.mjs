/* global process, console, window */
/** Verify the built launcher against isolated SQLite history and saved profiles. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron } from 'playwright-core'

const root = resolve(import.meta.dirname, '..')
const stateDir = await mkdtemp(join(tmpdir(), 'qa-launcher-ui-smoke-'))
const output = join(root, 'smoke-output')
await mkdir(output, { recursive: true })
const env = { ...process.env, XDG_DATA_HOME: stateDir, LOCALAPPDATA: stateDir }
delete env.ELECTRON_RUN_AS_NODE
const frequentUrl = 'https://frequent.example.test/forms/contact?locale=en'
const olderUrl = 'https://older.example.test/forms/signup'
const savedUrl = 'https://saved.example.test/checkout'
let app
try {
  app = await electron.launch({ args: [root, `--user-data-dir=${join(stateDir, 'app')}`], env, timeout: 60000 })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.webContents.setBackgroundThrottling(false)
    window.setBounds({ width: 1280, height: 1000 })
    window.show()
    window.focus()
  })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.api))
  const api = async (fn, arg) => {
    const result = await page.evaluate(fn, arg)
    assert(result.ok, result.error?.message)
    return result.data
  }
  const info = await api(() => window.api.app.getInfo())
  assert(info.userDataPath.startsWith(stateDir), 'Smoke test must use isolated app data')
  await api(() => window.api.setup.complete())
  await api(() => window.api.settings.update({ defaultFormUrl: 'https://default.example.test/' }))
  await api(
    (url) =>
      window.api.profiles.create({
        name: 'Saved checkout',
        engine: 'chromium',
        deviceType: 'desktop',
        devicePreset: 'linux-desktop',
        viewportWidth: 1280,
        viewportHeight: 800,
        userAgent: null,
        locale: 'en-US',
        timezone: 'UTC',
        proxyMode: 'none',
        stickySessionId: null,
        formUrlOverride: url,
        notes: '',
        proxyPool: 'residential',
        target: null,
        stickyTtlMinutes: null,
        ephemeral: false,
      }),
    savedUrl,
  )
  const db = new DatabaseSync(join(info.dataPath, 'proxy-qa.sqlite'))
  try {
    const insert = db.prepare(
      'INSERT INTO test_runs (id, profile_name, engine, device_preset, form_url, started_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    const add = (url, at) => insert.run(randomUUID(), 'UI smoke', 'chromium', 'linux-desktop', url, at, 'success')
    for (let i = 0; i < 55; i++)
      add(`https://recent.example.test/form-${i}`, new Date(Date.UTC(2026, 9, 7, 12, 0, i)).toISOString())
    for (let i = 0; i < 3; i++) add(frequentUrl, `2026-10-03T12:00:0${i}.000Z`)
    add(olderUrl, '2026-09-01T12:00:00.000Z')
  } finally {
    db.close()
  }
  await page.evaluate(() => {
    window.location.hash = '#/launch'
  })
  await page.reload()
  await page.getByRole('heading', { name: 'Launch', exact: true }).waitFor()
  const input = page.getByRole('combobox', { name: 'Start URL', exact: true })
  const session = page
    .locator('form > div')
    .filter({ has: page.getByRole('heading', { name: 'Session', exact: true }) })
  await page.getByRole('button', { name: `Use ${frequentUrl}`, exact: true }).waitFor()
  await session.scrollIntoViewIfNeeded()
  const bounds = await input.boundingBox()
  const cardBounds = await session.boundingBox()
  assert(bounds.width >= cardBounds.width - 44, 'Start URL must span the session card, excluding padding')
  assert.equal(await page.getByRole('checkbox', { name: 'Save as profile', exact: true }).isChecked(), false)
  await page.getByRole('button', { name: `Use ${frequentUrl}`, exact: true }).click()
  assert.equal(await input.inputValue(), frequentUrl)
  assert.equal(await input.getAttribute('aria-expanded'), 'false')
  await session.screenshot({ path: join(output, 'launcher-session.png') })

  await input.click()
  await page.getByRole('listbox', { name: 'Previously used URLs' }).waitFor()
  assert.equal(
    (await page.getByRole('option').first().innerText()).split('\n')[0],
    'https://recent.example.test/form-54',
  )
  await page.getByRole('option').first().click()
  assert.equal(await input.inputValue(), 'https://recent.example.test/form-54')
  await input.fill('older.example')
  await page.getByRole('option').filter({ hasText: olderUrl }).click()
  assert.equal(await input.inputValue(), olderUrl, 'History older than the global 50-run cache must be reusable')
  await input.fill('saved.example')
  await page.getByRole('option').filter({ hasText: savedUrl }).waitFor()
  await input.press('ArrowDown')
  await input.press('Enter')
  assert.equal(await input.inputValue(), savedUrl)
  assert.equal(await input.getAttribute('aria-expanded'), 'false')
  assert.deepEqual(await api(() => window.api.browser.listActive()), [], 'Picking a URL must not launch a browser')

  await input.click()
  await input.press('Escape')
  assert.equal(await input.getAttribute('aria-expanded'), 'false')
  await input.click()
  await page.screenshot({ path: join(output, 'launcher-url-history.png') })
  await input.press('Tab')
  assert.equal(await input.getAttribute('aria-expanded'), 'false')
  const saveProfile = page.getByRole('checkbox', { name: 'Save as profile', exact: true })
  await saveProfile.check()
  await page.getByRole('textbox', { name: 'Profile name', exact: true }).fill('My reusable profile')
  await saveProfile.uncheck()
  assert.equal(await page.getByRole('textbox', { name: 'Profile name', exact: true }).count(), 0)

  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setMinimumSize(600, 600)
    window.setBounds({ width: 720, height: 950 })
  })
  await session.scrollIntoViewIfNeeded()
  const narrowInput = await input.boundingBox()
  const narrowCard = await session.boundingBox()
  assert(narrowInput.width >= narrowCard.width - 44, 'Narrow layouts must retain the full-width URL input')
  assert(await session.evaluate((card) => card.scrollWidth <= card.clientWidth), 'Session content must not overflow')
  await session.screenshot({ path: join(output, 'launcher-session-narrow.png') })
  await page.reload()
  await page.getByRole('button', { name: `Use ${frequentUrl}`, exact: true }).waitFor()
  await input.fill('older.example')
  await page.getByRole('option').filter({ hasText: olderUrl }).click()
  assert.equal(await input.inputValue(), olderUrl, 'Suggestions must survive a renderer reload')
  assert.equal(
    (await api(() => window.api.runs.list(1000))).length,
    59,
    'Using shortcuts must not create launch history',
  )
  assert.deepEqual(errors, [])
  console.log(
    'Launcher UI passed: full-width URL, compact profile checkbox, frequency ranking, older SQLite history, saved links, keyboard selection, reload and narrow layout.',
  )
} finally {
  if (app) await app.close()
  await rm(stateDir, { recursive: true, force: true })
}

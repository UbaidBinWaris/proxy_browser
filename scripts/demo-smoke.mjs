/* global process, console, window */
/** Real desktop demo flow, with isolated app data. --packaged selects this host's native build. */
import assert from 'node:assert/strict'
import { _electron as electron, chromium } from 'playwright-core'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chromiumCacheDir } from './smoke-helpers.mjs'

const root = resolve(import.meta.dirname, '..')
const state = await mkdtemp(join(tmpdir(), 'qa-demo-smoke-'))
const output = join(root, 'smoke-output')
await mkdir(output, { recursive: true })
const custom = process.argv.indexOf('--executable')
const packaged = process.argv.includes('--packaged') || custom !== -1
const executable = custom !== -1 ? process.argv[custom + 1] : process.platform === 'win32'
  ? join(root, 'release', 'win-unpacked', 'Proxy-QA-Browser.exe')
  : process.platform === 'darwin'
    ? join(root, 'release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Proxy-QA-Browser.app', 'Contents', 'MacOS', 'Proxy-QA-Browser')
    : join(root, 'release', 'linux-unpacked', 'proxy-qa-browser')
const bundled = packaged && process.platform === 'linux' && executable
  ? join(dirname(executable), 'resources', 'playwright-browsers') : null
const env = {
  ...process.env, PROXY_QA_TEST_DATA_DIR: join(state, 'app'), XDG_DATA_HOME: state, LOCALAPPDATA: state,
  PLAYWRIGHT_BROWSERS_PATH: bundled && existsSync(bundled) ? bundled
    : process.env.PLAYWRIGHT_BROWSERS_PATH ?? chromiumCacheDir(chromium.executablePath()),
}
delete env.ELECTRON_RUN_AS_NODE
for (const key of Object.keys(env)) if (key.startsWith('DATAIMPULSE_') || key.startsWith('QA_PROVIDER') || key.startsWith('QA_PROXY_')) delete env[key]
let app, page
const summary = { platform: process.platform, packaged, checks: [] }
try {
  if (packaged && (!executable || !existsSync(executable))) throw new Error('Build the native packaged app or supply --executable before running this smoke test.')
  app = await electron.launch({ ...(packaged ? { executablePath: executable } : {}),
    args: [...(packaged ? [] : [root]), `--user-data-dir=${join(state, 'app')}`], env, timeout: 60000 })
  page = await app.firstWindow()
  page.setDefaultTimeout(30000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.api))
  const api = async (fn, arg) => {
    const result = await page.evaluate(fn, arg)
    assert.equal(result.ok, true, result.error?.message)
    return result.data
  }
  const expectedVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
  const info = await api(() => window.api.app.getInfo())
  assert.equal(info.version, expectedVersion, 'The smoke test must run the current project version.')
  summary.version = info.version
  // Wait for the first-run guard before completing setup, so this also exercises the /setup route.
  await page.getByRole('heading', { name: 'Set up Proxy QA Browser', exact: true }).waitFor()
  await api(() => window.api.setup.complete())
  await page.reload()
  // Reload preserves #/setup. Wait for the completed setup state, then navigate through the sidebar.
  await page.getByRole('link', { name: 'Launch', exact: true }).click()
  await page.getByRole('heading', { name: 'Launch', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Try demo', exact: true }).click()
  await page.getByRole('heading', { name: 'QA automation', exact: true }).waitFor()
  await page.getByRole('heading', { name: 'Demo signup', exact: true }).waitFor()
  let snapshot = await api(() => window.api.qa.snapshot())
  const scenario = snapshot.scenarios.find((item) => item.name === 'Demo signup')
  assert.ok(scenario)
  const profile = await api((id) => window.api.profiles.get(id), scenario.profileId)
  assert.equal(profile.proxyMode, 'none')
  summary.checks.push('Launch → Try demo creates a direct profile and a seven-step synthetic scenario')
  const runDemo = async (expected) => {
    await page.getByRole('tab', { name: 'Scenarios', exact: true }).click()
    await page.getByRole('button', { name: 'Try demo', exact: true }).click()
    await page.getByRole('button', { name: 'Start matrix', exact: true }).click()
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      const latest = (await api(() => window.api.qa.snapshot())).batches
      if (latest.length === expected && latest[0]?.endedAt) return latest[0]
      await delay(100)
    }
    throw new Error(`Demo run ${expected} did not complete within 60 seconds.`)
  }
  let batch = await runDemo(1)
  assert.equal(batch.status, 'passed', JSON.stringify(batch))
  assert.equal(batch.cases[0].steps.length, 7)
  for (const step of batch.cases[0].steps) assert.ok(step.screenshot && existsSync(step.screenshot))
  await page.screenshot({ path: join(output, 'demo-first-run.png') })
  for (const format of ['json', 'junit', 'html']) {
    const file = await api(({ id, format }) => window.api.qa.exportBatch(id, format), { id: batch.id, format })
    assert.ok((await readFile(file, 'utf8')).length > 100)
    if (format === 'json') assert.equal(JSON.parse(await readFile(file, 'utf8')).status, 'passed')
  }
  summary.checks.push('Sample replay passes, saves screenshot evidence, and exports JSON, JUnit and HTML reports')
  batch = await runDemo(2)
  assert.equal(batch.status, 'passed')
  await page.getByText('Compared 1 matching case with', { exact: false }).first().waitFor()
  assert.equal((await api(() => window.api.qa.snapshot())).scenarios.length, 1)
  summary.checks.push('Second run compares the same case and reuses the sample')
  // A controlled failure and recovery prove the comparison uses real executions.
  const broken = { ...scenario, timeoutMs: 1000, steps: [{ action: 'assertText', selector: '#result', value: 'Incorrect expected text' }] }
  await api(({ input, id }) => window.api.qa.saveScenario(input, id), { input: broken, id: scenario.id })
  batch = await runDemo(3)
  assert.equal(batch.status, 'failed')
  await page.getByText('1 new failure', { exact: true }).first().waitFor()
  await api(({ input, id }) => window.api.qa.saveScenario(input, id), { input: scenario, id: scenario.id })
  batch = await runDemo(4)
  assert.equal(batch.status, 'passed')
  await page.getByText('1 recovered', { exact: true }).first().waitFor()
  await page.getByRole('heading', { name: 'QA automation', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(output, 'demo-run-comparison.png') })
  summary.checks.push('Changed expectation produces a new failure; restoring it produces a recovery')
  await page.getByRole('tab', { name: 'Scenarios', exact: true }).click()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByRole('switch', { name: 'Strict form execution', exact: true }).click()
  assert.equal(await page.getByLabel('Self-healing', { exact: true }).isDisabled(), true)
  await page.getByRole('switch', { name: 'Strict form execution', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(output, 'qa-strict-editor.png') })
  await page.getByRole('button', { name: 'Save scenario', exact: true }).click()
  batch = await runDemo(5)
  assert.equal(batch.status, 'passed', JSON.stringify(batch))
  assert.equal((await api(() => window.api.qa.snapshot())).scenarios[0].strict, true)
  summary.checks.push('Strict form execution persists through the editor and verifies a passing demo run')
  await page.getByRole('tab', { name: 'Scenarios', exact: true }).click()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByRole('button', { name: 'Record actions', exact: true }).click()
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click()
  await page.getByText('stopped · 0 captured actions', { exact: true }).waitFor()
  summary.checks.push('Scenario editor opens and closes the real recorder on the bundled form')
  const exported = await api((id) => window.api.qa.exportScenario(id), scenario.id)
  assert.equal(JSON.parse(await readFile(exported, 'utf8')).scenario.startUrl, 'http://demo.proxyqa.test/')
  const cliOutput = join(state, 'cli-results')
  await promisify(execFile)(process.execPath, [join(root, 'out', 'main', 'qa-cli.js'), '--config', exported, '--output', cliOutput],
    { env, timeout: 60000, maxBuffer: 1024 * 1024 })
  const cliResult = JSON.parse(await readFile(join(cliOutput, 'results.json'), 'utf8'))
  assert.equal(cliResult.status, 'passed')
  for (const file of ['results.json', 'results.xml', 'results.html']) assert.ok(existsSync(join(cliOutput, file)))
  summary.checks.push('Exported demo runs in the headless CLI and produces passing JSON, JUnit and HTML reports')
  await page.reload()
  await page.getByRole('heading', { name: 'QA automation', exact: true }).waitFor()
  snapshot = await api(() => window.api.qa.snapshot())
  assert.equal(snapshot.batches.length, 5)
  assert.equal(snapshot.scenarios.length, 1)
  assert.equal((await api(() => window.api.setup.status())).firstRun, false)
  assert.deepEqual(errors, [])
  summary.checks.push('Reload retains setup, scenario and run history with no renderer errors')
  await writeFile(join(output, `demo-smoke-${process.platform}${packaged ? '-packaged' : ''}.json`), JSON.stringify(summary, null, 2))
  console.log(`Demo smoke passed (${process.platform}${packaged ? ', packaged' : ', source'}): ${summary.checks.length} checks.`)
} catch (error) {
  await page?.screenshot({ path: join(output, 'demo-smoke-failure.png') }).catch(() => undefined)
  throw error
} finally {
  await app?.close()
  await rm(state, { recursive: true, force: true })
}

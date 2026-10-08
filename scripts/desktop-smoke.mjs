/* global process, console, window, document, setTimeout, Buffer */
import { _electron as electron, chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const root = resolve(import.meta.dirname, '..')
const output = join(root, 'smoke-output')
await mkdir(output, { recursive: true })
const state = await mkdtemp(join(tmpdir(), 'qa-desktop-smoke-'))
const server = createServer((_req, response) => {
  response.setHeader('content-type', 'text/html')
  response.end(
    (pageChanged ? '<style>body{background:#222;color:white}</style>' : '') +
      '<!doctype html><html><body><h1>QA smoke form</h1><input id="email" type="email"><button id="submit" onclick="document.querySelector(\'#result\').textContent=\'Submitted\'">Submit</button><div id="result"></div></body></html>',
  )
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const env = {
  ...process.env,
  PROXY_QA_TEST_DATA_DIR: join(state, 'app'),
  XDG_DATA_HOME: state,
  LOCALAPPDATA: state,
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? resolve(chromium.executablePath(), '../../..'),
}
delete env.ELECTRON_RUN_AS_NODE
// An isolated OS user-data directory keeps this smoke test away from personal profiles and keys.
let app
let pageChanged = false
try {
  app = await electron.launch({ args: [root, `--user-data-dir=${join(state, 'app')}`], env, timeout: 60000 })
  const page = await app.firstWindow()
  page.on('pageerror', (error) => console.error('Renderer error:', error.message))
  await page.waitForFunction(() => Boolean(window.api))
  const api = async (fn, arg) => {
    const result = await page.evaluate(fn, arg)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.data
  }
  const waitForSnapshot = async (predicate) => {
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      const snapshot = await api(() => window.api.qa.snapshot())
      if (predicate(snapshot)) return snapshot
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('Timed out waiting for QA state.')
  }
  await api(() => window.api.setup.complete())
  await api(
    (startUrl) =>
      window.api.profiles.create({
        name: 'Smoke profile',
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
        formUrlOverride: startUrl,
        notes: '',
        proxyPool: 'residential',
        target: null,
        stickyTtlMinutes: null,
        ephemeral: false,
      }),
    origin,
  )
  await page.reload()
  await page.evaluate(() => {
    window.location.hash = '#/automation'
  })
  await page.getByRole('heading', { name: 'QA automation', exact: true }).waitFor()
  await page.getByRole('textbox', { name: 'New workspace name' }).fill('Smoke workspace')
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click()
  await page.getByRole('button', { name: 'New scenario', exact: true }).click()
  await page.getByLabel('Scenario name', { exact: true }).fill('Smoke scenario')
  await page.getByLabel('Starting URL', { exact: true }).fill(origin)
  await page.getByRole('button', { name: 'Add step', exact: true }).click()
  await page.getByLabel('Step 2 selector', { exact: true }).fill('#email')
  await page.getByLabel('Step 2 value', { exact: true }).fill('{{email}}')
  await page.getByRole('button', { name: 'Add step', exact: true }).click()
  await page.getByLabel('Step 3 action', { exact: true }).selectOption('click')
  await page.getByLabel('Step 3 selector', { exact: true }).fill('#submit')
  await page.getByRole('button', { name: 'Add step', exact: true }).click()
  await page.getByLabel('Step 4 action', { exact: true }).selectOption('assertText')
  await page.getByLabel('Step 4 selector', { exact: true }).fill('#result')
  await page.getByLabel('Step 4 value', { exact: true }).fill('Submitted')
  await page.getByText('Variables and datasets', { exact: true }).click()
  await page
    .getByLabel('Default variables (JSON)', { exact: true })
    .fill(JSON.stringify({ email: 'synthetic@example.test' }))
  await page
    .getByLabel('Import dataset CSV', { exact: true })
    .setInputFiles({
      name: 'datasets.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('_name,email\nFirst,first@example.test\nSecond,second@example.test'),
    })
  await page.waitForFunction(() => document.querySelector('#qa-datasets').value.includes('row-2'))
  await page.getByRole('button', { name: 'Record actions', exact: true }).click()
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click()
  await page.getByText('stopped · 0 captured actions', { exact: true }).waitFor()
  await page.screenshot({ path: join(output, 'automation-editor.png') })
  await page.getByRole('button', { name: 'Save scenario', exact: true }).click()
  await page.getByRole('button', { name: 'Run matrix', exact: true }).click()
  await page.getByRole('button', { name: 'Start matrix', exact: true }).click()
  const snapshot = await waitForSnapshot((state) => state.batches.some((batch) => batch.endedAt))
  const batch = snapshot.batches[0]
  if (batch.status !== 'passed' || batch.completed !== 2)
    throw new Error(`Desktop matrix failed: ${JSON.stringify(batch)}`)
  await page.screenshot({ path: join(output, 'automation-results.png') })
  for (const format of ['json', 'junit', 'html']) {
    const file = await api(({ id, format }) => window.api.qa.exportBatch(id, format), { id: batch.id, format })
    if (!(await readFile(file, 'utf8')).length) throw new Error(`Empty ${format} report`)
  }
  const config = await api((id) => window.api.qa.exportScenario(id), snapshot.scenarios[0].id)
  // Verify the exported desktop scenario runs through the headless CI entry point too.
  const cliResult = await promisify(execFile)(
    process.execPath,
    [join(root, 'out/main/qa-cli.js'), '--config', config, '--output', join(state, 'cli-results')],
    { env, timeout: 60000 },
  )
  if (JSON.parse(await readFile(join(state, 'cli-results/results.json'), 'utf8')).status !== 'passed')
    throw new Error('CLI failed the exported scenario')
  await page.getByRole('tab', { name: 'Suites & environments', exact: true }).click()
  await page.getByLabel('Environment name', { exact: true }).fill('Local staging')
  await page.getByLabel('Environment base origin', { exact: true }).fill(origin)
  await page.getByRole('button', { name: 'Save environment', exact: true }).click()
  await waitForSnapshot((state) => state.environments.some((env) => env.name === 'Local staging'))
  await page.getByLabel('Suite name', { exact: true }).fill('Smoke suite')
  await page.getByLabel('Smoke scenario', { exact: true }).check()
  await page.getByRole('button', { name: 'Save suite', exact: true }).click()
  const grouped = await waitForSnapshot((state) => state.suites.length === 1)
  await page.screenshot({ path: join(output, 'automation-suites-environments.png') })
  await page.getByRole('button', { name: 'Run suite', exact: true }).click()
  await page.getByLabel('Environment', { exact: true }).selectOption(grouped.environments[0].id)
  await page.getByRole('button', { name: 'Start matrix', exact: true }).click()
  const suiteRun = await waitForSnapshot((state) => state.batches.some((item) => item.suiteId && item.endedAt))
  const suiteBatch = suiteRun.batches.find((item) => item.suiteId)
  if (suiteBatch.status !== 'passed' || suiteBatch.total !== 2) throw new Error('Suite/dataset/environment run failed')
  const suiteConfig = await api((id) => window.api.qa.exportSuite(id), grouped.suites[0].id)
  await promisify(execFile)(
    process.execPath,
    [
      join(root, 'out/main/qa-cli.js'),
      '--config',
      suiteConfig,
      '--environment',
      'Local staging',
      '--output',
      join(state, 'cli-suite'),
    ],
    { env, timeout: 60000 },
  )
  if (JSON.parse(await readFile(join(state, 'cli-suite/results.json'), 'utf8')).total !== 2)
    throw new Error('CLI suite did not expand datasets')
  const visualScenario = await api((input) => window.api.qa.saveScenario(input), {
    ...snapshot.scenarios[0],
    name: 'Visual smoke',
    datasets: [],
    steps: [{ action: 'assertScreenshot', name: 'page', maxDiffRatio: 0.01 }],
  })
  const startVisual = async () => {
    const batch = await api(
      (id) =>
        window.api.qa.start({ scenarioId: id, engines: [], devices: [], targets: [], concurrency: 1, retries: 0 }),
      visualScenario.id,
    )
    return (
      await waitForSnapshot((state) => state.batches.some((item) => item.id === batch.id && item.endedAt))
    ).batches.find((item) => item.id === batch.id)
  }
  const missing = await startVisual()
  if (missing.cases[0].steps[0].visual.status !== 'missing')
    throw new Error('Visual baseline was unexpectedly approved')
  await page.getByRole('tab', { name: 'Scenarios', exact: true }).click()
  await page.getByRole('tab', { name: 'Results', exact: true }).click()
  const visualResults = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Visual smoke', exact: true }) })
    .first()
  await visualResults.locator('summary').click()
  await visualResults.getByRole('button', { name: 'View comparison', exact: true }).click()
  await visualResults.getByRole('img', { name: 'Current screenshot', exact: true }).waitFor()
  await visualResults.getByRole('button', { name: 'Approve baseline', exact: true }).click()
  const matched = await startVisual()
  if (matched.status !== 'passed') throw new Error(`Approved baseline did not match: ${JSON.stringify(matched)}`)
  const baselinePack = await api((id) => window.api.qa.exportBaselines(id), matched.id)
  const visualConfig = await api((id) => window.api.qa.exportScenario(id), visualScenario.id)
  await promisify(execFile)(
    process.execPath,
    [
      join(root, 'out/main/qa-cli.js'),
      '--config',
      visualConfig,
      '--baselines',
      baselinePack,
      '--output',
      join(state, 'cli-visual'),
    ],
    { env, timeout: 60000 },
  )
  pageChanged = true
  const changed = await startVisual()
  if (changed.cases[0].steps[0].visual.status !== 'changed') throw new Error('Visual regression was not detected')
  await page.getByRole('tab', { name: 'Scenarios', exact: true }).click()
  await page.getByRole('tab', { name: 'Results', exact: true }).click()
  const changedResults = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Visual smoke', exact: true }) })
    .first()
  await changedResults.locator('summary').click()
  await changedResults.getByRole('button', { name: 'View comparison', exact: true }).click()
  await changedResults.getByRole('img', { name: 'Highlighted differences', exact: true }).waitFor()
  await page.screenshot({ path: join(output, 'automation-visual-comparison.png') })
  pageChanged = false
  await page.getByRole('tab', { name: 'Schedules', exact: true }).click()
  await page.getByLabel('Scheduled scenario', { exact: true }).selectOption(snapshot.scenarios[0].id)
  await page.getByRole('button', { name: 'Schedule every 60 minutes', exact: true }).click()
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await page.getByRole('button', { name: 'Resume', exact: true }).waitFor()
  await page.getByRole('tab', { name: 'Data controls', exact: true }).click()
  await page.getByLabel('Maximum cases per matrix', { exact: true }).fill('12')
  await page.getByRole('button', { name: 'Save policy', exact: true }).click()
  await waitForSnapshot((state) => state.policy.maxCombinations === 12)
  const backup = await api((password) => window.api.qa.backup(password), 'smoke-only-backup-passphrase')
  if ((await readFile(backup)).subarray(0, 5).toString() !== 'PQAB1') throw new Error('Backup was not encrypted')
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click()
  await page
    .getByText('The publisher has not configured a signed update feed for this build.', { exact: true })
    .waitFor()
  await page.screenshot({ path: join(output, 'automation-data-controls.png') })
  await page.getByRole('tab', { name: 'Audit history', exact: true }).click()
  await page.getByRole('cell', { name: 'scenario.created', exact: true }).first().waitFor()
  console.log(
    'PASS: native desktop scenario editing → CSV datasets → recorder lifecycle → suite/environment matrix → visual approval/difference → exported CLI suite/visual run → evidence → reports → schedules → policy → encrypted backup → update status → local audit.',
  )
  console.log(cliResult.stdout.trim())
} finally {
  await app?.close()
  await new Promise((resolve) => server.close(resolve))
  await rm(state, { recursive: true, force: true })
}

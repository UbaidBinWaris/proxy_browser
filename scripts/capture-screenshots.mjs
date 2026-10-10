#!/usr/bin/env node
/* global process, console, window, location, setTimeout, clearTimeout */
/**
 * Captures the screenshots used by the documentation and the website from the real desktop app.
 *
 *   npm run build && node scripts/capture-screenshots.mjs [--only name,name] [--raw <dir>]
 *
 * The app runs with fresh, isolated app data (the repository .env is never read and no real proxy
 * credentials exist in it). Everything on screen is demo content: placeholder proxy keys, a demo quote
 * form served on 127.0.0.1, and run history whose exit IPs come from the documentation ranges of
 * RFC 5737 (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24). No browser is ever sent through a proxy.
 *
 * On Linux the app gets a throw-away D-Bus session with its own unlocked GNOME Keyring (in a temporary
 * directory), so screens show the normal "OS keychain" state without touching the user's keyring.
 *
 * Output: docs/site/images/<name>.webp (1600×1000) plus <name>-720.webp, used by docs/site/*.md and
 * the website home page. Raw PNGs go to smoke-output/screenshots (gitignored).
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'

const ROOT = resolve(import.meta.dirname, '..')

// Re-run inside a private D-Bus session with a temporary, unlocked keyring (Linux, when available).
if (process.platform === 'linux' && !process.env.QA_SCREENSHOTS_KEYRING && spawnSync('which', ['dbus-run-session', 'gnome-keyring-daemon']).status === 0) {
  const keyring = await mkdtemp(join(tmpdir(), 'qa-screenshots-keyring-'))
  await mkdir(join(keyring, 'run'), { mode: 0o700 })
  const run = spawnSync('dbus-run-session', ['--', 'sh', '-c', 'printf %s throwaway | gnome-keyring-daemon --unlock --components=secrets >/dev/null && exec "$0" "$@"', process.execPath, ...process.argv.slice(1)], {
    stdio: ['inherit', 'inherit', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, QA_SCREENSHOTS_KEYRING: '1', QA_SCREENSHOTS_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '', XDG_DATA_HOME: join(keyring, 'data'), XDG_RUNTIME_DIR: join(keyring, 'run') },
  })
  await rm(keyring, { recursive: true, force: true })
  // Drop the session bus's own chatter (portal and service activation logs).
  const noise = /^(dbus-daemon\[|\*\* \(|\(\/usr\/lib\/|A connection to the bus|$)/
  process.stderr.write(String(run.stderr ?? '').split('\n').filter((line) => !noise.test(line)).map((line) => `${line}\n`).join(''))
  process.exit(run.status ?? 1)
}

const { values: args } = parseArgs({ options: { only: { type: 'string' }, raw: { type: 'string' } } })
const only = args.only ? new Set(args.only.split(',')) : null
const rawDir = resolve(args.raw ?? join(ROOT, 'smoke-output', 'screenshots'))
const imagesDir = join(ROOT, 'docs', 'site', 'images')
const require = createRequire(join(ROOT, 'package.json'))
const { chromium } = require('playwright-core')
const electronBinary = require('electron')
// sharp is a dependency of the website (Next.js image tooling), not of the desktop app.
const sharp = createRequire(join(ROOT, 'app', 'webapp', 'package.json'))('sharp')

const WIDTH = 1600, HEIGHT = 1000, SMALL = 720
await mkdir(rawDir, { recursive: true })
await mkdir(imagesDir, { recursive: true })
const state = await mkdtemp(join(tmpdir(), 'qa-screenshots-'))

const DISCLOSURE =
  'By clicking Get my quote, I agree that Example Solar may contact me about my quote at the phone number I provided, including by automated calls and text messages. Consent is not a condition of purchase. Message and data rates may apply.'
const FORM = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Get a solar quote — Example Solar (demo)</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;background:#f6f7fb;color:#1d2433}
main{max-width:480px;margin:32px auto;padding:24px;background:#fff;border-radius:12px}
h1{font-size:24px;margin:0 0 16px}label{display:block;font-size:14px;margin:12px 0 4px}
input[type=text],input[type=tel]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #8a90a0;border-radius:6px;font-size:16px}
.consent{display:flex;gap:8px;align-items:flex-start;margin-top:16px}.consent label{margin:0}
#disclosure{font-size:12px;line-height:1.5;color:#3b4252;margin:12px 0}
button{background:#2747d6;color:#fff;border:0;border-radius:6px;padding:12px 16px;font-size:16px;width:100%}
@media (max-width:600px){#disclosure{font-size:9px}}
</style></head><body><main><h1>Get your free solar quote</h1>
<form id="quote" onsubmit="event.preventDefault();document.querySelector('#result').textContent='Thanks! Your quote request was received.'">
<label for="full-name">Full name</label><input id="full-name" type="text" autocomplete="name">
<label for="phone">Phone</label><input id="phone" type="tel" autocomplete="tel">
<label for="zip">ZIP code</label><input id="zip" type="text" inputmode="numeric">
<div class="consent"><input id="consent" type="checkbox"><label for="consent">I agree to be contacted about my quote.</label></div>
<p id="disclosure">${DISCLOSURE}</p>
<button id="submit" type="submit">Get my quote</button></form>
<p id="result" role="status"></p></main></body></html>`
const server = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(FORM)
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`

const env = { ...process.env, PROXY_QA_TEST_DATA_DIR: join(state, 'app'), XDG_DATA_HOME: state, LOCALAPPDATA: state, PLAYWRIGHT_BROWSERS_PATH: join(chromium.executablePath(), '../../..') }
delete env.ELECTRON_RUN_AS_NODE
// The keyring is reached over the private D-Bus session; the display (Wayland/X11) needs the real runtime dir.
if (process.env.QA_SCREENSHOTS_RUNTIME_DIR) env.XDG_RUNTIME_DIR = process.env.QA_SCREENSHOTS_RUNTIME_DIR
for (const key of Object.keys(env)) if (/PROXY_(HOST|PORT|USERNAME|PASSWORD)$|^DATAIMPULSE_|_PROXY_/.test(key)) delete env[key]

const captured = []
// Launched directly (not with Playwright's _electron, which forces --password-store=basic) and driven over CDP.
const keychain = process.env.QA_SCREENSHOTS_KEYRING ? ['--password-store=gnome-libsecret'] : []
const app = spawn(electronBinary, [ROOT, `--user-data-dir=${join(state, 'app')}`, ...keychain, '--remote-debugging-port=0'], { env, cwd: state, stdio: ['ignore', 'ignore', 'pipe'] })
const browser = await new Promise((done, fail) => {
  let output = ''
  const timer = setTimeout(() => fail(new Error('The app did not start within 60 s')), 60000)
  app.stderr.on('data', (chunk) => {
    output += chunk
    const endpoint = /DevTools listening on (ws:\/\/\S+)/.exec(output)?.[1]
    if (endpoint) { clearTimeout(timer); app.stderr.removeAllListeners('data'); app.stderr.resume(); done(chromium.connectOverCDP(endpoint)) }
  })
  app.once('exit', (code) => fail(new Error(`The app exited (${code}) before it started: ${output.slice(-2000)}`)))
})
try {
  let page
  for (const deadline = Date.now() + 60000; !page; await new Promise((r) => setTimeout(r, 250))) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('index.html'))
    if (!page && Date.now() > deadline) throw new Error('The app window did not open')
  }
  page.on('pageerror', (error) => console.error('renderer error:', error.message))
  await page.setViewportSize({ width: WIDTH, height: HEIGHT })
  await page.waitForFunction(() => Boolean(window.api))
  const api = async (fn, arg) => {
    const result = await page.evaluate(fn, arg)
    if (!result.ok) throw new Error(JSON.stringify(result.error))
    return result.data
  }
  const info = await api(() => window.api.app.getInfo())
  if (!info.userDataPath.startsWith(state)) throw new Error('The app is not using isolated data; refusing to continue.')
  const want = (name) => !only || only.has(name)
  const shot = async (name, settle = 600) => {
    await page.mouse.move(WIDTH - 4, HEIGHT - 4)
    await page.waitForTimeout(settle)
    const file = join(rawDir, `${name}.png`)
    await page.screenshot({ path: file })
    captured.push(name)
    console.log(`captured ${name}`)
  }
  const go = async (hash, ready) => {
    await page.evaluate((h) => { location.hash = h }, hash)
    await page.reload()
    await ready()
    await page.waitForTimeout(300)
  }

  // --- First-run wizard, before setup is complete.
  if (want('first-run')) {
    await page.getByRole('heading').first().waitFor()
    await shot('first-run', 900)
  }
  await api(() => window.api.setup.complete())

  // --- Placeholder proxy keys (never valid, never used: nothing is launched through a proxy).
  const providers = await api(() => window.api.proxy.providers())
  const dataimpulse = providers.find((p) => p.id === 'dataimpulse') ?? providers[0]
  const products = dataimpulse.capabilities.products
  const product = products.find((p) => p.key === 'residential') ?? products[0]
  await api((input) => window.api.security.saveCredentials(input), {
    providerId: dataimpulse.id,
    pool: product.key,
    host: dataimpulse.capabilities.defaults.host,
    port: dataimpulse.capabilities.defaults.port,
    username: 'demo-user',
    password: 'demo-password',
    sessionTemplate: null,
  })
  await api(() => window.api.settings.update({ defaultFormUrl: 'https://staging.example.com/quote' }))

  // --- Saved profiles.
  const profileInput = (overrides) => ({
    engine: 'chromium', deviceType: 'desktop', devicePreset: 'windows-desktop', viewportWidth: 1920, viewportHeight: 1080, userAgent: null,
    locale: 'en-US', timezone: 'America/Chicago', proxyMode: 'sticky', stickySessionId: 'demo' + Math.random().toString(36).slice(2, 8), formUrlOverride: null, notes: '',
    proxyPool: product.key, target: null, stickyTtlMinutes: 30, ephemeral: false, ...overrides,
  })
  const target = (mode, stateName, stateCode, city = null, zip = null) => ({ mode, country: 'us', state: stateName, stateCode, city, zip })
  const profiles = []
  for (const input of [
    profileInput({ name: 'Austin quote form · iPhone', engine: 'webkit', deviceType: 'mobile', devicePreset: 'iphone-15-pro', viewportWidth: 393, viewportHeight: 659, formUrlOverride: 'https://staging.example.com/quote', target: target('city', 'Texas', 'TX', 'Austin'), notes: 'Mobile consent wording check' }),
    profileInput({ name: 'New Jersey landing · Galaxy', deviceType: 'mobile', devicePreset: 'galaxy-s23', viewportWidth: 360, viewportHeight: 780, timezone: 'America/New_York', formUrlOverride: 'https://staging.example.com/nj', target: target('state', 'New Jersey', 'NJ') }),
    profileInput({ name: 'Checkout · Windows desktop', formUrlOverride: 'https://staging.example.com/checkout', target: target('zip', 'California', 'CA', 'Los Angeles', '90012'), timezone: 'America/Los_Angeles' }),
    profileInput({ name: 'Demo quote form', proxyMode: 'none', stickySessionId: null, notes: 'Local demo page for QA automation' }),
  ]) profiles.push(await api((value) => window.api.profiles.create(value), input))

  // --- Run history (demo rows; documentation-range IPs; a real screenshot of the demo form).
  const screenshotDir = (await api(() => window.api.settings.get())).screenshotDir
  await mkdir(screenshotDir, { recursive: true })
  const runIds = []
  {
    const browser = await chromium.launch()
    const mobile = await browser.newPage({ viewport: { width: 393, height: 659 }, deviceScaleFactor: 2 })
    await mobile.goto(origin)
    const formShot = join(screenshotDir, 'demo-run-1.png')
    await mobile.screenshot({ path: formShot })
    await browser.close()
    const db = new DatabaseSync(join(info.dataPath, 'proxy-qa.sqlite'))
    try {
      const insert = db.prepare(`INSERT INTO test_runs (id, profile_id, profile_name, engine, device_preset, public_ip, country, region, city, postal_code, proxy_session_id,
        form_url, final_url, started_at, ended_at, status, notes, http_status, screenshot_path, lead_id, certificate_id, error_message, pool, provider, target_json, targeting_string, target_match)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      const network = db.prepare('INSERT INTO network_entries (id, run_id, method, url, status, resource_type, request_time, response_time, duration_ms, extracted_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      const rows = [
        [profiles[0], 'webkit', 'iphone-15-pro', '203.0.113.24', 'US', 'Texas', 'Austin', '78701', target('city', 'Texas', 'TX', 'Austin'), 'match', 'success', 200, formShot, 'LD-48213', 'TF-7f3a9c'],
        [profiles[1], 'chromium', 'galaxy-s23', '198.51.100.73', 'US', 'New Jersey', 'Newark', '07102', target('state', 'New Jersey', 'NJ'), 'match', 'success', 200, null, null, null],
        [profiles[2], 'chromium', 'windows-desktop', '192.0.2.145', 'US', 'California', 'Los Angeles', '90012', target('zip', 'California', 'CA', 'Los Angeles', '90012'), 'match', 'success', 200, null, null, null],
        [profiles[0], 'webkit', 'iphone-15-pro', '203.0.113.88', 'US', 'Texas', 'Round Rock', '78664', target('city', 'Texas', 'TX', 'Austin'), 'partial', 'success', 200, null, null, null],
        [profiles[2], 'firefox', 'windows-desktop', '192.0.2.61', 'US', 'California', 'Pasadena', '91101', target('zip', 'California', 'CA', 'Los Angeles', '90012'), 'partial', 'failed', 503, null, null, null],
        [profiles[1], 'chromium', 'pixel-8', '198.51.100.12', 'US', 'New Jersey', 'Jersey City', '07302', target('state', 'New Jersey', 'NJ'), 'match', 'success', 200, null, null, null],
      ]
      rows.forEach(([profile, engine, device, ip, country, region, city, zip, goal, match, status, http, screenshot, lead, cert], i) => {
        const id = randomUUID(), started = new Date(Date.UTC(2026, 9, 10, 9, 0, 0) - i * 47 * 60000), ended = new Date(started.getTime() + (4 + i) * 60000)
        const url = profile.formUrlOverride ?? 'https://staging.example.com/quote'
        const label = goal.mode === 'state' ? `${goal.state} (${goal.stateCode})` : goal.mode === 'city' ? `${goal.city}, ${goal.stateCode}` : `${goal.zip} — ${goal.city}, ${goal.stateCode}`
        insert.run(id, profile.id, profile.name, engine, device, ip, country, region, city, zip, `demo${1000 + i}`, url, `${url}?step=thanks`, started.toISOString(), ended.toISOString(), status,
          '', http, screenshot, lead, cert, status === 'failed' ? 'Form returned HTTP 503 Service Unavailable' : null, product.key, dataimpulse.id, JSON.stringify(goal), label, match)
        runIds.push(id)
        if (i === 0) {
          const t = started.getTime()
          const requests = [
            ['GET', url, 200, 'document', 0, 412, '{}'],
            ['GET', 'https://staging.example.com/assets/app.js', 200, 'script', 380, 96, '{}'],
            ['GET', 'https://staging.example.com/assets/app.css', 200, 'stylesheet', 390, 71, '{}'],
            ['POST', 'https://staging.example.com/api/consent', 200, 'fetch', 61000, 188, JSON.stringify({ certificateId: 'TF-7f3a9c' })],
            ['POST', 'https://staging.example.com/api/leads', 201, 'fetch', 63000, 244, JSON.stringify({ leadId: 'LD-48213' })],
            ['GET', `${url}?step=thanks`, 200, 'document', 63400, 305, '{}'],
          ]
          for (const [method, href, code, type, at, duration, ids] of requests)
            network.run(randomUUID(), id, method, href, code, type, new Date(t + at).toISOString(), new Date(t + at + duration).toISOString(), duration, ids)
        }
      })
    } finally {
      db.close()
    }
  }

  // --- Site access token (placeholder secret).
  await api((input) => window.api.siteAccess.save(input), {
    name: 'Staging WAF allowlist',
    origins: ['https://staging.example.com'],
    headerName: 'X-QA-Access',
    headerValue: 'demo-token-not-a-real-secret-0000',
    enabled: true,
  }).catch((error) => console.warn('site access token not saved:', error.message))

  // --- Launch page.
  const launchReady = () => page.getByRole('heading', { name: 'Launch', exact: true }).waitFor()
  await go('#/launch', launchReady)
  await page.getByRole('combobox', { name: 'Start URL', exact: true }).fill('https://staging.example.com/quote')
  await page.keyboard.press('Escape')
  if (want('launch-device-picker')) {
    await page.locator('button').filter({ hasText: 'Windows · Chrome' }).first().click()
    await page.waitForTimeout(500)
    await shot('launch-device-picker')
    await page.getByPlaceholder(/Search brand, model/).fill('iphone 15 pro')
    await page.waitForTimeout(400)
    await page.keyboard.press('Enter')
  } else {
    await page.locator('button').filter({ hasText: 'Windows · Chrome' }).first().click()
    await page.getByPlaceholder(/Search brand, model/).fill('iphone 15 pro')
    await page.waitForTimeout(400)
    await page.keyboard.press('Enter')
  }
  await page.waitForTimeout(400)
  await page.locator('button').filter({ hasText: /^.*Version \d+/ }).first().click()
  await page.waitForTimeout(500)
  if (want('launch-browser-picker')) await shot('launch-browser-picker')
  await page.getByText(/^WebKit/).first().click()
  await page.waitForTimeout(400)
  await page.getByText('City', { exact: true }).first().click()
  await page.getByPlaceholder(/Search cities/).click()
  await page.keyboard.type('Austin', { delay: 40 })
  await page.waitForTimeout(700)
  if (want('launch-location-picker')) await shot('launch-location-picker')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(800)
  if (want('launch')) await shot('launch', 1000)

  // --- History and run detail.
  if (want('history')) {
    await go('#/history', () => page.getByRole('heading', { name: 'History', exact: true }).waitFor())
    await shot('history')
  }
  if (want('run-detail')) {
    await go(`#/history/${runIds[0]}`, () => page.locator('#run-leadId[value="LD-48213"]').waitFor())
    await shot('run-detail', 1000)
  }

  // --- Profiles.
  if (want('profiles')) {
    await go('#/profiles', () => page.getByRole('heading', { name: 'Browser Profiles', exact: true }).waitFor())
    await shot('profiles')
  }
  if (want('profile-editor')) {
    await go(`#/profiles/${profiles[0].id}`, () => page.getByRole('heading').first().waitFor())
    await shot('profile-editor', 900)
  }

  // --- Settings.
  if (want('settings-general')) {
    await go('#/settings/general', () => page.locator('main h1').first().waitFor())
    await shot('settings-general')
  }
  if (want('settings-browsers')) {
    await go('#/settings/browsers', () => page.locator('main h1').first().waitFor())
    await shot('settings-browsers', 1200)
  }
  if (want('proxy-keys')) {
    await go('#/settings/advanced', () => page.getByText('Security health').first().waitFor())
    await shot('proxy-keys')
  }
  if (want('site-access-tokens')) {
    await go('#/settings/advanced', () => page.getByText('Security health').first().waitFor())
    await page.getByText('Proxy keys', { exact: true }).first().click()
    await page.getByText('Site access tokens', { exact: true }).first().click()
    await page.getByText('Staging WAF allowlist').first().waitFor()
    await shot('site-access-tokens')
  }
  if (want('settings-about')) {
    await go('#/settings/about', () => page.locator('main h1').first().waitFor())
    await shot('settings-about')
  }

  // --- QA automation: a scenario, a 2 browser × 3 device matrix on the local demo form.
  const scenario = await api((input) => window.api.qa.saveScenario(input), {
    name: 'Solar quote form: consent and accessibility',
    profileId: profiles[3].id,
    startUrl: `${origin}/quote`,
    allowedOrigins: [origin],
    variables: { name: 'Test Lead', phone: '555-0100', zip: '78701' },
    steps: [
      { action: 'checkConsentCheckbox', checkboxSelector: '#consent' },
      { action: 'fill', selector: '#full-name', value: '{{name}}' },
      { action: 'fill', selector: '#phone', value: '{{phone}}' },
      { action: 'fill', selector: '#zip', value: '{{zip}}' },
      { action: 'check', selector: '#consent' },
      { action: 'checkConsent', blockSelector: '#disclosure', approvedText: DISCLOSURE, wordingMatch: 'exact', nearSelector: '#submit', continueOnFailure: true },
      { action: 'checkAccessibility', continueOnFailure: true },
      { action: 'click', selector: '#submit' },
      { action: 'assertText', selector: '#result', value: 'Thanks' },
    ],
  })
  const automationReady = () => page.getByRole('heading', { name: 'QA automation', exact: true }).waitFor()
  if (want('automation-scenario') || want('automation-steps')) {
    await go('#/automation', automationReady)
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
    await page.waitForTimeout(800)
    await shot('automation-scenario')
    await page.getByText('Test steps', { exact: true }).first().evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await shot('automation-steps')
  }
  if (want('qa-results') || want('check-evidence')) {
    const batch = await api((id) => window.api.qa.start({ scenarioId: id, engines: ['chromium', 'webkit'], devices: ['windows-desktop', 'iphone-15-pro', 'galaxy-s23'], targets: [], concurrency: 2, retries: 0 }), scenario.id)
    const deadline = Date.now() + 240000
    for (;;) {
      const snapshot = await api(() => window.api.qa.snapshot())
      const current = snapshot.batches.find((b) => b.id === batch.id)
      if (current?.endedAt) { console.log(`matrix ${current.status}: ${current.cases.map((c) => `${c.engine}/${c.device}=${c.status}`).join(', ')}`); break }
      if (Date.now() > deadline) throw new Error('QA matrix timed out')
      await page.waitForTimeout(500)
    }
    await go('#/automation', automationReady)
    await page.getByRole('tab', { name: 'Results', exact: true }).click()
    await page.getByRole('heading', { name: scenario.name, exact: true }).first().waitFor()
    if (want('qa-results')) await shot('qa-results')
    if (want('check-evidence')) {
      const failing = page.locator('tbody tr').filter({ hasText: 'failed' }).first()
      await failing.locator('summary').click()
      await failing.locator('ol').waitFor()
      await failing.evaluate((el) => el.scrollIntoView({ block: 'start' }))
      await page.mouse.wheel(0, -40)
      await shot('check-evidence')
    }
  }
  for (const [name, tab] of [['automation-suites', 'Suites & environments'], ['automation-schedules', 'Schedules'], ['automation-data', 'Data controls']]) {
    if (!want(name)) continue
    await go('#/automation', automationReady)
    await page.getByRole('tab', { name: tab, exact: true }).click()
    await shot(name)
  }
} finally {
  await browser.close().catch(() => undefined)
  app.kill()
  await new Promise((done) => (app.exitCode === null ? app.once('exit', done) : done()))
  await new Promise((done) => server.close(done))
  await rm(state, { recursive: true, force: true }).catch(() => undefined)
}

// --- Convert to WebP: the full-size image and a 720 px copy for small screens.
const sizes = {}
for (const name of captured) {
  const raw = join(rawDir, `${name}.png`)
  await sharp(raw).webp({ quality: 82, effort: 6 }).toFile(join(imagesDir, `${name}.webp`))
  await sharp(raw).resize({ width: SMALL }).webp({ quality: 80, effort: 6 }).toFile(join(imagesDir, `${name}-${SMALL}.webp`))
  sizes[name] = { width: WIDTH, height: HEIGHT }
}
await writeFile(join(rawDir, 'captured.json'), `${JSON.stringify(sizes, null, 2)}\n`)
console.log(`\n${captured.length} screenshot(s) written to ${imagesDir}`)

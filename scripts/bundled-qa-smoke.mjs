#!/usr/bin/env node
/* global process, console, URL, setTimeout, clearTimeout */
/**
 * Runs the QA command-line runner against the browsers the AppImage actually ships
 * (build/browsers/linux: full Chromium, no "chromium headless shell") on the sample form in
 * examples/ci. A headless QA run that needs the headless shell fails here before it reaches users.
 *
 * Usage: npm run build && node scripts/bundled-qa-smoke.mjs [browsers-dir]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const browsers = resolve(process.argv[2] ?? join(ROOT, 'build', 'browsers', 'linux'))
const cli = join(ROOT, 'out', 'main', 'qa-cli.js')
const fail = (message) => {
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::error title=Bundled browsers QA smoke::${message.replace(/%/g, '%25').replace(/\r?\n/g, '%0A')}`)
  console.error(`BUNDLED QA SMOKE FAILED: ${message}`)
  process.exit(1)
}
if (!existsSync(cli)) fail(`${cli} is missing; run "npm run build" first.`)
if (!existsSync(browsers)) fail(`${browsers} is missing; run "node scripts/bundle-browsers.mjs --platform linux" first.`)
console.log(`Browsers under test: ${readdirSync(browsers).join(', ')}`)

const page = readFileSync(join(ROOT, 'examples', 'ci', 'site', 'index.html'))
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html')
  res.end(page)
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`
const work = mkdtempSync(join(tmpdir(), 'bundled-qa-smoke-'))
try {
  // The sample manifest targets http://127.0.0.1:8080; point it at this server.
  const manifest = readFileSync(join(ROOT, 'examples', 'ci', 'scenario.json'), 'utf8').replaceAll('http://127.0.0.1:8080', origin)
  writeFileSync(join(work, 'scenario.json'), manifest)
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers }
  delete env.ELECTRON_RUN_AS_NODE
  // Asynchronous on purpose: the sample site is served by this process and must keep answering.
  const child = spawn(process.execPath, [cli, '--config', join(work, 'scenario.json'), '--output', join(work, 'out')], { env, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill('SIGTERM'), 180000)
  const run = await new Promise((done) => child.once('exit', (status, signal) => done({ status, signal })))
  clearTimeout(timer)
  if (run.status !== 0) {
    const results = existsSync(join(work, 'out', 'results.json')) ? readFileSync(join(work, 'out', 'results.json'), 'utf8') : ''
    const reason = /"error":\s*"([^"]{1,400})/.exec(results)?.[1] ?? `exit code ${run.status ?? run.signal}`
    fail(`QA run with the bundled browsers failed: ${reason}`)
  }
  console.log(`BUNDLED QA SMOKE PASSED: a headless QA run works with ${new URL(`file://${browsers}`).pathname}`)
} finally {
  server.close()
  rmSync(work, { recursive: true, force: true })
}

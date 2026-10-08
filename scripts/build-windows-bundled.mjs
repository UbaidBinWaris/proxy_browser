#!/usr/bin/env node
/**
 * Build the Windows portable EXE WITH the three Playwright browsers inside
 * (`npm run build:windows:bundled`).
 *
 *   1. node scripts/bundle-browsers.mjs --platform win64   (downloads the
 *      Windows builds into build/browsers/win64; cached across runs)
 *   2. npm run build
 *   3. electron-builder --win --x64 --config electron-builder.config.mjs with
 *      PROXY_QA_BUNDLE_BROWSERS=1, which adds build/browsers/win64 as the
 *      `playwright-browsers` extra resource.
 *
 * Trade-off: electron-builder's portable target re-extracts its whole payload
 * to %TEMP% on every launch, so this variant starts 30–90 s slower than the
 * slim default (`npm run build:windows`), which provisions browsers once on
 * first run instead. Runs on Windows natively or on Linux with wine.
 * Exits non-zero as soon as any step fails.
 */
/* global process */
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'
const npmCmd = isWindows ? 'npm.cmd' : 'npm'
const npxCmd = isWindows ? 'npx.cmd' : 'npx'

function log(message) {
  process.stdout.write(`\n==> ${message}\n`)
}

function run(cmd, args, extraEnv = {}) {
  process.stdout.write(`$ ${[cmd, ...args].join(' ')}\n`)
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: isWindows, env: { ...process.env, ...extraEnv } })
  if (result.error) {
    process.stderr.write(`\nERROR: ${cmd} could not be started: ${result.error.message}\n`)
    process.exit(1)
  }
  if (result.status !== 0) {
    process.stderr.write(`\nERROR: "${[cmd, ...args].join(' ')}" exited with code ${result.status ?? 'unknown'}.\n`)
    process.exit(result.status ?? 1)
  }
}

log('Bundling Windows Playwright browsers (build/browsers/win64)')
run(process.execPath, [join(ROOT, 'scripts', 'bundle-browsers.mjs'), '--platform', 'win64'])

log('Building main, preload and renderer')
run(npmCmd, ['run', 'build'])

log('Packaging the bundled Windows portable EXE (PROXY_QA_BUNDLE_BROWSERS=1)')
run(npxCmd, ['electron-builder', '--win', '--x64', '--config', 'electron-builder.config.mjs'], { PROXY_QA_BUNDLE_BROWSERS: '1' })

process.stdout.write(
  '\nBundled Windows build complete. Note: the portable EXE extracts its full payload (now including ~400 MB of browsers) to %TEMP% on every launch, so expect a 30–90 s start-up; use `npm run build:windows` for the slim variant.\n',
)

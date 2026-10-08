#!/usr/bin/env node
/**
 * Provisions the Playwright browsers (Chromium, Firefox, WebKit) for development.
 *
 * Runs `node node_modules/playwright-core/cli.js install chromium firefox webkit`.
 * Honours PLAYWRIGHT_BROWSERS_PATH when set; otherwise Playwright's default cache
 * (~/.cache/ms-playwright on Linux) is used. Exits non-zero when the installer fails.
 *
 * This fills the DEVELOPMENT cache only. To ship browsers inside the packaged
 * app use scripts/bundle-browsers.mjs (build/browsers/<platform>), which
 * `npm run build:linux` and `npm run build:windows:bundled` run for you.
 *
 * Usage: node scripts/install-browsers.mjs [chromium|firefox|webkit ...]
 */
/* global process */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'node_modules', 'playwright-core', 'cli.js')
const ALL_ENGINES = ['chromium', 'firefox', 'webkit']

function defaultBrowsersPath() {
  switch (process.platform) {
    case 'linux':
      return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'ms-playwright')
    case 'darwin':
      return join(homedir(), 'Library', 'Caches', 'ms-playwright')
    case 'win32':
      return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'ms-playwright')
    default:
      return join(homedir(), '.cache', 'ms-playwright')
  }
}

function parseEngines(argv) {
  const requested = argv.filter((a) => !a.startsWith('-'))
  if (requested.length === 0) return ALL_ENGINES
  const unknown = requested.filter((e) => !ALL_ENGINES.includes(e))
  if (unknown.length > 0) {
    process.stderr.write(`Unknown browser engine(s): ${unknown.join(', ')}. Valid values: ${ALL_ENGINES.join(', ')}\n`)
    process.exit(2)
  }
  return requested
}

function printLinuxHint() {
  process.stderr.write(
    [
      '',
      'Linux hint: the download itself rarely fails; what usually fails is launching',
      'Firefox/WebKit afterwards because shared libraries are missing.',
      '',
      '  Debian/Ubuntu:  npx playwright-core install-deps',
      '  Arch Linux:     install-deps targets apt and does not work on Arch. Install the',
      '                  pacman equivalents listed in README.md (nss, atk, at-spi2-core,',
      '                  libdrm, libxkbcommon, mesa, alsa-lib, gtk3, libxcomposite,',
      '                  libxdamage, libxrandr, pango, cairo, woff2, libepoxy, gstreamer,',
      '                  gst-plugins-base, gst-plugins-good, libwebp, enchant, libsecret,',
      '                  hyphen, flite) and verify with:',
      "                  ldd <browsers-path>/webkit-*/minibrowser-gtk/MiniBrowser | grep 'not found'",
      '',
    ].join('\n'),
  )
}

function main() {
  if (!existsSync(CLI)) {
    process.stderr.write(`playwright-core CLI not found at ${CLI}.\nRun "npm install" first.\n`)
    process.exit(1)
  }

  const engines = parseEngines(process.argv.slice(2))
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH
    ? resolve(process.env.PLAYWRIGHT_BROWSERS_PATH)
    : defaultBrowsersPath()
  const source = process.env.PLAYWRIGHT_BROWSERS_PATH ? 'PLAYWRIGHT_BROWSERS_PATH' : 'Playwright default cache'

  process.stdout.write(`Installing Playwright browsers: ${engines.join(', ')}\n`)
  process.stdout.write(`Destination (${source}): ${browsersPath}\n\n`)

  const result = spawnSync(process.execPath, [CLI, 'install', ...engines], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath },
  })

  if (result.error) {
    process.stderr.write(`Failed to start the Playwright installer: ${result.error.message}\n`)
    process.exit(1)
  }
  if (result.status !== 0) {
    process.stderr.write(`\nPlaywright installer exited with code ${result.status ?? 'unknown'}.\n`)
    if (process.platform === 'linux') printLinuxHint()
    process.exit(result.status ?? 1)
  }

  process.stdout.write(`\nBrowsers installed in ${browsersPath}\n`)
  if (process.platform === 'linux') {
    process.stdout.write('If Firefox or WebKit fail to launch, see the Arch/Linux dependency notes in README.md.\n')
  }
  process.stdout.write('This is the development cache. Packaged builds bundle their own browsers via scripts/bundle-browsers.mjs.\n')
}

main()

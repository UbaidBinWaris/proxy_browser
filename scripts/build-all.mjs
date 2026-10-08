#!/usr/bin/env node
/**
 * Cross-platform build orchestrator (`npm run build:all`).
 *
 *   Linux host:   npm run build:linux (bundles the Playwright browsers and the
 *                 WebKit host libraries into the AppImage), then the Windows
 *                 build via local wine (npx electron-builder --win --x64) or,
 *                 when wine is absent, via Docker (electronuserland/builder:wine).
 *                 Fails loudly when neither is available.
 *   Windows host: npm run build:windows.
 *
 * Windows ships as a single SLIM portable EXE (no installer, browsers
 * provisioned on first run); `npm run build:windows:bundled` is the bundled variant.
 *
 * Prints every artifact found in ./release, then "BUILD COMPLETE" followed by
 * the expected artifact paths only when every requested artifact exists.
 * Otherwise prints the missing ones and exits 1.
 */
/* global process */
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE_DIR = join(ROOT, 'release')
const DOCKER_IMAGE = 'electronuserland/builder:wine'
const NODE_MODULES_VOLUME = 'proxy-qa-win-node-modules'

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const VERSION = pkg.version
const PRODUCT = 'Proxy-QA-Browser'

/** Expected artifact file names, derived from electron-builder.config.mjs (AppImage + portable EXE only). */
const ARTIFACTS = {
  linux: [`${PRODUCT}-${VERSION}-x86_64.AppImage`],
  windows: [`${PRODUCT}-${VERSION}-Windows-x64.exe`],
}

/** Host caches shared with the Docker container. Created before any `docker run`. */
const HOST_CACHE = join(homedir(), '.cache')
const ELECTRON_CACHE = process.env.ELECTRON_CACHE || join(HOST_CACHE, 'electron')
const BUILDER_CACHE = process.env.ELECTRON_BUILDER_CACHE || join(HOST_CACHE, 'electron-builder')

const isWindows = process.platform === 'win32'
const npmCmd = isWindows ? 'npm.cmd' : 'npm'
const npxCmd = isWindows ? 'npx.cmd' : 'npx'

function log(message) {
  process.stdout.write(`\n==> ${message}\n`)
}

function fail(message) {
  process.stderr.write(`\nERROR: ${message}\n`)
  process.exit(1)
}

function run(cmd, args, options = {}) {
  process.stdout.write(`$ ${[cmd, ...args].join(' ')}\n`)
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: isWindows, ...options })
  if (result.error) throw new Error(`${cmd} could not be started: ${result.error.message}`)
  return result.status ?? 1
}

function commandExists(cmd) {
  const probe = isWindows
    ? spawnSync('where', [cmd], { stdio: 'ignore', shell: true })
    : spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' })
  return probe.status === 0
}

function dockerDaemonAvailable() {
  if (!commandExists('docker')) return false
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
}

/** Enforce package.json "engines.node" (e.g. ">=22.13") so failures are explicit, not cryptic. */
function assertNodeVersion() {
  const match = /^>=\s*(\d+)(?:\.(\d+))?/.exec(pkg.engines?.node ?? '')
  if (!match) return
  const [wantMajor, wantMinor] = [Number(match[1]), Number(match[2] ?? 0)]
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < wantMajor || (major === wantMajor && minor < wantMinor)) {
    fail(`Node.js ${pkg.engines.node} is required (found ${process.version}). See package.json "engines".`)
  }
  process.stdout.write(`node ${process.version} OK\n`)
}

/**
 * A directory left root-owned by an earlier Docker run makes electron-builder
 * fail with EACCES half-way through. Check up front and say how to fix it.
 */
function assertWritable(dir) {
  if (!existsSync(dir)) return
  try {
    accessSync(dir, constants.W_OK)
  } catch {
    const user = userInfo().username
    fail(
      `${dir} is not writable by ${user}. An earlier Docker build probably left it root-owned.\n` +
        `Fix: sudo chown -R "$USER:$USER" ~/.cache/electron ~/.cache/electron-builder release`,
    )
  }
}

function preflight() {
  log('Checking prerequisites')
  assertNodeVersion()
  if (!isWindows) {
    // mkdir BEFORE any docker run: Docker would otherwise create missing
    // bind-mount sources itself, as root.
    mkdirSync(ELECTRON_CACHE, { recursive: true })
    mkdirSync(BUILDER_CACHE, { recursive: true })
    assertWritable(ELECTRON_CACHE)
    assertWritable(BUILDER_CACHE)
    assertWritable(RELEASE_DIR)
    process.stdout.write('caches writable OK\n')
  }
}

export function buildWindowsWithDocker() {
  const uid = process.getuid ? process.getuid() : 0
  const gid = process.getgid ? process.getgid() : 0

  // The named volume keeps the container's Linux/Wine node_modules separate from
  // the host's. It is created root-owned, so hand it to the host uid first.
  const chownStatus = run('docker', [
    'run',
    '--rm',
    '--user',
    '0:0',
    '-v',
    `${NODE_MODULES_VOLUME}:/project/node_modules`,
    DOCKER_IMAGE,
    'chown',
    `${uid}:${gid}`,
    '/project/node_modules',
  ])
  if (chownStatus !== 0) return chownStatus

  // HOME must be writable for npm and for wine's prefix, so it points at a
  // per-build tmpfs inside the container rather than root's home.
  // `npm ci --ignore-scripts` skips electron's own postinstall: the Linux
  // Electron binary is not needed in the container, electron-builder fetches
  // the Windows zip from the shared cache instead.
  const containerHome = '/tmp/builder-home'
  return run('docker', [
    'run',
    '--rm',
    '--user',
    `${uid}:${gid}`,
    '-e',
    `HOME=${containerHome}`,
    '-e',
    `WINEPREFIX=${containerHome}/.wine`,
    '-e',
    `ELECTRON_CACHE=${containerHome}/.cache/electron`,
    '-e',
    `ELECTRON_BUILDER_CACHE=${containerHome}/.cache/electron-builder`,
    ...['PROXY_QA_SIGNED_RELEASE', 'PROXY_QA_UPDATE_FEED', 'PROXY_QA_UPDATE_PUBLIC_KEY', 'CSC_LINK', 'CSC_KEY_PASSWORD']
      .filter((name) => process.env[name])
      .flatMap((name) => ['-e', name]),
    '--tmpfs',
    `${containerHome}:exec,uid=${uid},gid=${gid},size=4g`,
    '-v',
    `${ROOT}:/project`,
    '-v',
    `${NODE_MODULES_VOLUME}:/project/node_modules`,
    '-v',
    `${ELECTRON_CACHE}:${containerHome}/.cache/electron`,
    '-v',
    `${BUILDER_CACHE}:${containerHome}/.cache/electron-builder`,
    '-w',
    '/project',
    DOCKER_IMAGE,
    '/bin/bash',
    '-c',
    'npm ci --ignore-scripts && npm run build && npx electron-builder --win --x64 --config electron-builder.config.mjs',
  ])
}

function printNoWindowsToolchain() {
  process.stderr.write(
    [
      '',
      'Cannot build the Windows portable EXE on this Linux host.',
      'electron-builder needs wine to produce the portable .exe target.',
      'Install ONE of the following and re-run `npm run build:all`:',
      '',
      '  Option A - Docker (recommended, no system wine needed):',
      '    Arch:    sudo pacman -S docker && sudo systemctl enable --now docker',
      '             sudo usermod -aG docker "$USER"   # then log out and back in',
      '    Debian:  sudo apt install docker.io && sudo systemctl enable --now docker',
      `    The build then runs inside ${DOCKER_IMAGE} with your uid/gid.`,
      '',
      '  Option B - Local wine + mono:',
      '    Arch:    sudo pacman -S wine mono',
      '    Debian:  sudo apt install wine64 mono-devel',
      '    Then `npx electron-builder --win --x64` runs directly on the host.',
      '',
    ].join('\n'),
  )
}

function listRelease() {
  if (!existsSync(RELEASE_DIR)) return []
  return readdirSync(RELEASE_DIR)
    .filter((name) => /\.(AppImage|exe)$/i.test(name))
    .map((name) => ({ name, size: statSync(join(RELEASE_DIR, name)).size }))
}

function formatSize(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function main() {
  const requested = []
  let failed = false

  if (process.platform !== 'win32' && process.platform !== 'linux') {
    fail(`Unsupported build host: ${process.platform}. Use a Linux or Windows machine.`)
  }

  preflight()

  if (isWindows) {
    log('Building Windows portable EXE (native)')
    requested.push(...ARTIFACTS.windows)
    if (run(npmCmd, ['run', 'build:windows']) !== 0) failed = true
  } else {
    log('Building Linux AppImage (self-contained: browsers + WebKit host libraries bundled)')
    requested.push(...ARTIFACTS.linux)
    if (run(npmCmd, ['run', 'build:linux']) !== 0) failed = true

    log('Building Windows portable EXE (slim)')
    requested.push(...ARTIFACTS.windows)
    if (commandExists('wine')) {
      process.stdout.write('wine found locally: running electron-builder directly.\n')
      if (run(npxCmd, ['electron-builder', '--win', '--x64', '--config', 'electron-builder.config.mjs']) !== 0)
        failed = true
    } else if (dockerDaemonAvailable()) {
      process.stdout.write(`wine not found: building inside ${DOCKER_IMAGE}.\n`)
      if (buildWindowsWithDocker() !== 0) failed = true
    } else {
      printNoWindowsToolchain()
      failed = true
    }
  }

  log('Artifacts in ./release')
  const found = listRelease()
  if (found.length === 0) process.stdout.write('(none)\n')
  for (const file of found) process.stdout.write(`  ${file.name}  ${formatSize(file.size)}\n`)

  const missing = requested.filter((name) => !existsSync(join(RELEASE_DIR, name)))
  if (missing.length > 0) {
    process.stderr.write('\nMissing expected artifacts:\n')
    for (const name of missing) process.stderr.write(`  release/${name}\n`)
  }

  if (failed || missing.length > 0) {
    process.stderr.write(
      `\nBUILD INCOMPLETE: ${failed ? 'a build step failed' : 'all steps ran'}; ${missing.length} of ${requested.length} expected artifacts missing.\n`,
    )
    process.exit(1)
  }

  process.stdout.write('\nBUILD COMPLETE\n')
  for (const name of requested) process.stdout.write(`  release/${name}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()

#!/usr/bin/env node
/**
 * Bundle the Playwright browsers (and, for Linux, the Ubuntu host libraries
 * WebKit needs) so a packaged build is self-contained.
 *
 *   node scripts/bundle-browsers.mjs --platform linux|win64 [--webkit-libs] [--force]
 *
 * - Revisions come from node_modules/playwright-core/browsers.json, so the
 *   bundle always matches the playwright-core version in package.json.
 * - Output: build/browsers/<platform>/ (fed to electron-builder as the
 *   `playwright-browsers` extra resource). Engines whose
 *   <name>-<revision>/INSTALLATION_COMPLETE marker already exists are skipped
 *   unless --force is given, so re-runs are cheap and offline.
 * - win64 can be bundled from a Linux host: Playwright's installer honours
 *   PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=win64 and downloads the Windows builds.
 * - chromium_headless_shell-* is deleted afterwards: the app launches headed
 *   browsers only and the shell costs ~100 MB.
 * - --webkit-libs (Linux only): downloads libicu74, libflite1 and libxml2
 *   (2.9.x) from archive.ubuntu.com, extracts just their shared libraries
 *   flat into build/webkit-libs/linux/ (fed to electron-builder as the
 *   `webkit-libs` extra resource), verifies every soname Playwright's WebKit
 *   needs on non-Ubuntu hosts is present and writes THIRD-PARTY-NOTICES.txt.
 *   Needs `ar` and `tar` (with zstd support) on PATH.
 *
 * Exit codes: 0 ok · 1 download/extraction/verification failure · 2 usage error.
 * The dev cache (~/.cache/ms-playwright) is untouched; use
 * scripts/install-browsers.mjs for that.
 */
/* global process, fetch, AbortSignal */
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLAYWRIGHT_DIR = join(ROOT, 'node_modules', 'playwright-core')
const CLI = join(PLAYWRIGHT_DIR, 'cli.js')
const BROWSERS_JSON = join(PLAYWRIGHT_DIR, 'browsers.json')
const BROWSERS_OUT = join(ROOT, 'build', 'browsers')
const WEBKIT_LIBS_OUT = join(ROOT, 'build', 'webkit-libs', 'linux')
/** Downloaded .debs are cached next to (not inside) the resource directory so they never ship. */
const WEBKIT_LIBS_DEB_CACHE = join(ROOT, 'build', 'webkit-libs', 'downloads')

const ENGINES = ['chromium', 'firefox', 'webkit']
const PLATFORMS = ['linux', 'win64']
const INSTALL_MARKER = 'INSTALLATION_COMPLETE'
const HEADLESS_SHELL_PREFIX = 'chromium_headless_shell-'
const DEB_LIB_DIR = './usr/lib/x86_64-linux-gnu'
const FETCH_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Ubuntu packages providing what Playwright's WebKit (built on Ubuntu 24.04)
 * links against and non-Ubuntu distributions (Arch included) do not ship:
 * ICU 74, the flite 2.2 voice libraries and the legacy libxml2.so.2.
 * libjxl.so.0.8 and libbacktrace.so.0 are already inside the WebKit bundle.
 */
const WEBKIT_LIBS = [
  {
    package: 'libicu74',
    source: 'icu',
    pool: 'http://archive.ubuntu.com/ubuntu/pool/main/i/icu/',
    pattern: /^libicu74_[^"'\s]+_amd64\.deb$/,
    fallback: 'libicu74_74.2-1ubuntu3.1_amd64.deb',
    licence: 'Unicode/ICU licence (Unicode-3.0)',
    homepage: 'https://icu.unicode.org/',
  },
  {
    package: 'libflite1',
    source: 'flite',
    pool: 'http://archive.ubuntu.com/ubuntu/pool/universe/f/flite/',
    pattern: /^libflite1_2\.2[^"'\s]*_amd64\.deb$/,
    fallback: 'libflite1_2.2-7build1_amd64.deb',
    licence: 'BSD-style (Flite, Carnegie Mellon University)',
    homepage: 'http://www.festvox.org/flite/',
  },
  {
    package: 'libxml2',
    source: 'libxml2',
    pool: 'http://archive.ubuntu.com/ubuntu/pool/main/libx/libxml2/',
    pattern: /^libxml2_2\.9\.14[^"'\s]*_amd64\.deb$/,
    fallback: 'libxml2_2.9.14+dfsg-1.3ubuntu3.9_amd64.deb',
    licence: 'MIT',
    homepage: 'https://gitlab.gnome.org/GNOME/libxml2',
  },
]

/** Every soname that resolved only from the Ubuntu .debs when WebKit 2359 was ldd-checked on Arch. */
const REQUIRED_SONAMES = [
  'libicuuc.so.74',
  'libicui18n.so.74',
  'libicudata.so.74',
  'libflite.so.1',
  'libflite_usenglish.so.1',
  'libflite_cmulex.so.1',
  'libflite_cmu_grapheme_lang.so.1',
  'libflite_cmu_grapheme_lex.so.1',
  'libflite_cmu_indic_lang.so.1',
  'libflite_cmu_indic_lex.so.1',
  'libflite_cmu_time_awb.so.1',
  'libflite_cmu_us_awb.so.1',
  'libflite_cmu_us_kal.so.1',
  'libflite_cmu_us_kal16.so.1',
  'libflite_cmu_us_rms.so.1',
  'libflite_cmu_us_slt.so.1',
  'libxml2.so.2',
]

function log(message) {
  process.stdout.write(`${message}\n`)
}

function fail(message, code = 1) {
  process.stderr.write(`\nERROR: ${message}\n`)
  process.exit(code)
}

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`)
  process.stderr.write('Usage: node scripts/bundle-browsers.mjs --platform linux|win64 [--webkit-libs] [--force]\n')
  process.exit(2)
}

function parseArgs(argv) {
  const options = { platform: null, webkitLibs: false, force: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--platform') {
      options.platform = argv[++i] ?? null
    } else if (arg.startsWith('--platform=')) {
      options.platform = arg.slice('--platform='.length)
    } else if (arg === '--webkit-libs') {
      options.webkitLibs = true
    } else if (arg === '--force') {
      options.force = true
    } else if (arg === '--help' || arg === '-h') {
      usage()
    } else {
      usage(`Unknown argument: ${arg}`)
    }
  }
  if (!options.platform) usage('--platform is required.')
  if (!PLATFORMS.includes(options.platform)) usage(`Unknown platform "${options.platform}". Valid values: ${PLATFORMS.join(', ')}`)
  if (options.webkitLibs && options.platform !== 'linux') usage('--webkit-libs applies to --platform linux only.')
  return options
}

function formatSize(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function dirSize(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) total += dirSize(full)
    else if (entry.isFile()) total += statSync(full).size
  }
  return total
}

// --- Browsers ------------------------------------------------------------------

function readRevisions() {
  if (!existsSync(CLI) || !existsSync(BROWSERS_JSON)) {
    fail(`playwright-core not found at ${PLAYWRIGHT_DIR}. Run "npm install" first.`)
  }
  const json = JSON.parse(readFileSync(BROWSERS_JSON, 'utf8'))
  const revisions = {}
  for (const engine of ENGINES) {
    const entry = json.browsers.find((b) => b.name === engine)
    if (!entry) fail(`browsers.json has no entry for ${engine}.`)
    revisions[engine] = entry.revision
  }
  return revisions
}

function installerEnv(platform, target) {
  const env = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: target,
    PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS: '1',
  }
  if (platform === 'win64') env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = 'win64'
  else delete env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE
  return env
}

function bundleBrowsers({ platform, force }) {
  const revisions = readRevisions()
  const target = join(BROWSERS_OUT, platform)
  mkdirSync(target, { recursive: true })

  log(`Playwright browser bundle for ${platform}`)
  log(`  revisions: ${ENGINES.map((e) => `${e} ${revisions[e]}`).join(', ')}`)
  log(`  target:    ${target}`)

  const missing = []
  for (const engine of ENGINES) {
    const dir = join(target, `${engine}-${revisions[engine]}`)
    const complete = existsSync(join(dir, INSTALL_MARKER))
    if (complete && !force) {
      log(`  ${engine}: already bundled (${basename(dir)}/${INSTALL_MARKER})`)
      continue
    }
    if (complete && force) {
      log(`  ${engine}: --force, removing ${basename(dir)}`)
      rmSync(dir, { recursive: true, force: true })
    }
    missing.push(engine)
  }

  if (missing.length > 0) {
    log(`\nInstalling ${missing.join(', ')} with playwright-core (${platform})…\n`)
    const result = spawnSync(process.execPath, [CLI, 'install', ...missing], {
      cwd: ROOT,
      stdio: 'inherit',
      env: installerEnv(platform, target),
    })
    if (result.error) fail(`Could not start the Playwright installer: ${result.error.message}`)
    if (result.status !== 0) fail(`Playwright installer exited with code ${result.status ?? 'unknown'} while installing ${missing.join(', ')} for ${platform}.`)
  }

  for (const engine of ENGINES) {
    const marker = join(target, `${engine}-${revisions[engine]}`, INSTALL_MARKER)
    if (!existsSync(marker)) fail(`${engine} is not complete after installation: ${marker} is missing.`)
  }

  for (const name of readdirSync(target)) {
    if (!name.startsWith(HEADLESS_SHELL_PREFIX)) continue
    rmSync(join(target, name), { recursive: true, force: true })
    log(`  removed ${name} (headless shell is not used by the app)`)
  }

  log(`\nBrowser bundle ready: ${target} (${formatSize(dirSize(target))})`)
  return target
}

// --- WebKit host libraries -----------------------------------------------------

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  return response.text()
}

async function fetchToFile(url, filePath) {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(filePath))
}

/** Newest matching .deb file name from an Ubuntu pool directory listing, or the hard-coded fallback. */
async function pickDebFileName(lib) {
  try {
    const html = await fetchText(lib.pool)
    const names = [...html.matchAll(/href="([^"]+\.deb)"/g)].map((m) => m[1]).filter((name) => lib.pattern.test(name))
    if (names.length > 0) {
      names.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      return { name: names[names.length - 1], fromListing: true }
    }
    log(`  ${lib.package}: no match in the pool listing, using fallback ${lib.fallback}`)
  } catch (err) {
    log(`  ${lib.package}: pool listing unavailable (${err instanceof Error ? err.message : String(err)}), using fallback ${lib.fallback}`)
  }
  return { name: lib.fallback, fromListing: false }
}

function debVersion(fileName, pkg) {
  const match = new RegExp(`^${pkg}_(.+)_amd64\\.deb$`).exec(fileName)
  return match ? match[1] : 'unknown'
}

function runTool(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  if (result.error) throw new Error(`${cmd} could not be started: ${result.error.message}. Install binutils/tar.`)
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${result.status}: ${result.stderr.trim()}`)
  return result.stdout
}

/** Extract ./usr/lib/x86_64-linux-gnu/*.so* from a .deb into a fresh temp directory; returns that lib directory. */
function extractDebLibs(debPath, workDir) {
  const members = runTool('ar', ['t', debPath], workDir).split('\n').map((l) => l.trim())
  const data = members.find((m) => /^data\.tar(\.(zst|xz|gz|bz2))?$/.test(m))
  if (!data) throw new Error(`${basename(debPath)} has no data.tar member (found: ${members.filter(Boolean).join(', ')})`)
  runTool('ar', ['x', debPath, data], workDir)
  const extractDir = join(workDir, 'x')
  mkdirSync(extractDir, { recursive: true })
  const compression = data.endsWith('.zst') ? ['--zstd'] : data.endsWith('.xz') ? ['--xz'] : data.endsWith('.gz') ? ['--gzip'] : data.endsWith('.bz2') ? ['--bzip2'] : []
  runTool('tar', [...compression, '-xf', join(workDir, data), '-C', extractDir, '--wildcards', `${DEB_LIB_DIR}/*.so*`], workDir)
  const libDir = join(extractDir, DEB_LIB_DIR)
  if (!existsSync(libDir)) throw new Error(`${basename(debPath)} contains no ${DEB_LIB_DIR}/*.so* files`)
  return libDir
}

/** Copy every *.so* entry flat into `target`, keeping relative symlinks (soname → real file) intact. */
function flattenLibs(libDir, target) {
  const copied = []
  const entries = readdirSync(libDir).filter((name) => /\.so(\.|$)/.test(name)).sort()
  // Real files first so that symlinks never dangle, even transiently.
  const ordered = [...entries.filter((n) => !lstatSync(join(libDir, n)).isSymbolicLink()), ...entries.filter((n) => lstatSync(join(libDir, n)).isSymbolicLink())]
  for (const name of ordered) {
    const src = join(libDir, name)
    const dest = join(target, name)
    rmSync(dest, { force: true })
    const stat = lstatSync(src)
    if (stat.isSymbolicLink()) {
      // Ubuntu links are relative within the same directory (libicuuc.so.74 -> libicuuc.so.74.2).
      const linkTarget = basename(readlinkSync(src))
      symlinkSync(linkTarget, dest)
    } else if (stat.isFile()) {
      copyFileSync(src, dest)
    } else {
      continue
    }
    copied.push(name)
  }
  return copied
}

function verifySonames(target) {
  const missing = []
  const dangling = []
  for (const soname of REQUIRED_SONAMES) {
    const full = join(target, soname)
    if (!existsSync(full) && !safeLstat(full)) {
      missing.push(soname)
      continue
    }
    try {
      if (!statSync(full).isFile()) missing.push(soname)
    } catch {
      dangling.push(soname)
    }
  }
  if (missing.length > 0 || dangling.length > 0) {
    const parts = []
    if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`)
    if (dangling.length > 0) parts.push(`dangling symlinks: ${dangling.join(', ')}`)
    throw new Error(`WebKit host libraries incomplete in ${target} (${parts.join('; ')})`)
  }
}

function safeLstat(file) {
  try {
    return lstatSync(file)
  } catch {
    return null
  }
}

function writeNotices(target, downloads) {
  const lines = [
    'THIRD-PARTY NOTICES — WebKit host libraries',
    '',
    "Playwright's Linux WebKit build is compiled on Ubuntu 24.04 and links against",
    'shared libraries that some distributions do not ship (ICU 74, the flite 2.2',
    'voice libraries, libxml2 2.9). Proxy QA Browser redistributes the unmodified',
    'binaries from the following Ubuntu packages in this directory (webkit-libs) and',
    'adds it to LD_LIBRARY_PATH for WebKit browser processes only. Each package is',
    'governed by its own licence; the full licence texts are available from the',
    'Ubuntu source packages and the upstream projects listed below.',
    '',
  ]
  for (const d of downloads) {
    lines.push(
      `Package:  ${d.package}`,
      `Version:  ${d.version}`,
      `Source:   ${d.url}${d.fromListing ? '' : '  (hard-coded fallback file name)'}`,
      `Upstream: ${d.homepage}`,
      `Licence:  ${d.licence}`,
      `Files:    ${d.files.join(', ')}`,
      '',
    )
  }
  lines.push(`Generated by scripts/bundle-browsers.mjs on ${new Date().toISOString()}.`, '')
  writeFileSync(join(target, 'THIRD-PARTY-NOTICES.txt'), lines.join('\n'))
}

async function bundleWebkitLibs() {
  log('\nWebKit host libraries (Ubuntu .debs → build/webkit-libs/linux)')
  for (const tool of ['ar', 'tar']) {
    const probe = spawnSync(tool, ['--version'], { stdio: 'ignore' })
    if (probe.error) fail(`"${tool}" is required to extract .deb packages but was not found on PATH.`)
  }
  mkdirSync(WEBKIT_LIBS_OUT, { recursive: true })
  mkdirSync(WEBKIT_LIBS_DEB_CACHE, { recursive: true })
  const workRoot = mkdtempSync(join(tmpdir(), 'proxy-qa-webkit-libs-'))
  const downloads = []
  try {
    for (const lib of WEBKIT_LIBS) {
      const picked = await pickDebFileName(lib)
      const url = `${lib.pool}${picked.name}`
      const debPath = join(WEBKIT_LIBS_DEB_CACHE, picked.name)
      if (existsSync(debPath) && statSync(debPath).size > 0) {
        log(`  ${lib.package}: using cached ${picked.name}`)
      } else {
        log(`  ${lib.package}: downloading ${url}`)
        await fetchToFile(url, debPath)
      }
      const head = readFileSync(debPath).subarray(0, 8).toString('latin1')
      if (head !== '!<arch>\n') throw new Error(`${picked.name} is not a Debian archive (bad magic). Delete it and retry.`)
      const workDir = join(workRoot, lib.package)
      mkdirSync(workDir, { recursive: true })
      const libDir = extractDebLibs(debPath, workDir)
      const files = flattenLibs(libDir, WEBKIT_LIBS_OUT)
      log(`  ${lib.package}: ${files.length} entries → ${WEBKIT_LIBS_OUT}`)
      downloads.push({ package: lib.package, version: debVersion(picked.name, lib.package), url, fromListing: picked.fromListing, licence: lib.licence, homepage: lib.homepage, files })
    }
    verifySonames(WEBKIT_LIBS_OUT)
    writeNotices(WEBKIT_LIBS_OUT, downloads)
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  } finally {
    rmSync(workRoot, { recursive: true, force: true })
  }
  log(`  verified ${REQUIRED_SONAMES.length} required sonames; notices written to THIRD-PARTY-NOTICES.txt`)
  log(`WebKit host libraries ready: ${WEBKIT_LIBS_OUT} (${formatSize(dirSize(WEBKIT_LIBS_OUT))})`)
}

// --- Main ----------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2))
  bundleBrowsers(options)
  if (options.webkitLibs) await bundleWebkitLibs()
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)))

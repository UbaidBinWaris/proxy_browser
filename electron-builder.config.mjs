/**
 * electron-builder configuration (replaces electron-builder.yml).
 *
 * It is a module rather than YAML so the self-contained bundle can be wired
 * conditionally:
 *
 * - Linux (AppImage) ships all three Playwright browsers from
 *   build/browsers/linux as the `playwright-browsers` resource and the Ubuntu
 *   shared libraries WebKit needs on non-Ubuntu hosts from
 *   build/webkit-libs/linux as `webkit-libs`. Both are produced by
 *   `node scripts/bundle-browsers.mjs --platform linux --webkit-libs`
 *   (`npm run build:linux` runs it first). An AppImage is mounted, not
 *   extracted, so the ~1 GB of browsers costs nothing at start-up.
 * - Windows (portable EXE) stays slim by default: the portable target
 *   re-extracts its whole payload to %TEMP% on EVERY launch, so bundling the
 *   browsers would add 30–90 s per start. Set PROXY_QA_BUNDLE_BROWSERS=1
 *   (`npm run build:windows:bundled`) to ship build/browsers/win64 anyway.
 * - macOS (DMG + ZIP, arm64 and x64 built separately) is slim like Windows:
 *   the browsers download into <userData>/data/browsers on first run.
 *   Signing and notarization are enabled only by complete Apple credential sets
 *   in the environment (scripts/mac-signing.mjs); otherwise the build is
 *   ad-hoc signed and Gatekeeper asks the user to allow it.
 *
 * The app picks the bundled directory up at runtime through
 * src/main/browser/browsers-path.ts (env → bundled → provisioned → dev cache).
 */
/* global process */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { macSigning } from './scripts/mac-signing.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
/**
 * Update smoke builds only (scripts/update-smoke.mjs): a throwaway publisher key, their own version and
 * output folder. Refused for signed releases, so a production build can never trust a test key, and an
 * output folder is required, so test artifacts never land in release/.
 */
const testKeyFile = process.env.PROXY_QA_TEST_PUBLIC_KEY_FILE?.trim() || null
const testOutput = process.env.PROXY_QA_TEST_OUTPUT?.trim() || null
const testVersion = process.env.PROXY_QA_TEST_VERSION?.trim() || null
if ((testKeyFile || testOutput || testVersion) && !(testKeyFile && testOutput))
  throw new Error('Update smoke builds need both PROXY_QA_TEST_PUBLIC_KEY_FILE and PROXY_QA_TEST_OUTPUT.')
if (testKeyFile && process.env.PROXY_QA_SIGNED_RELEASE === '1')
  throw new Error('A signed release cannot embed a test publisher key.')
if (testVersion && !/^\d+\.\d+\.\d+$/.test(testVersion)) throw new Error('PROXY_QA_TEST_VERSION must be major.minor.patch.')

const publicKeyPath = testKeyFile ?? join(ROOT, 'resources', 'updates', 'public-key.pem')
const packageVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const version = testVersion ?? packageVersion
const releaseNotes = JSON.parse(readFileSync(join(ROOT, 'resources', 'release-notes.json'), 'utf8'))
const notes = releaseNotes[version] ?? releaseNotes[packageVersion] ?? []

const BUNDLE_WINDOWS_BROWSERS = process.env.PROXY_QA_BUNDLE_BROWSERS === '1'

/**
 * Windows code signing through Azure Trusted Signing, enabled only when all four values are set
 * (CI passes them from repository secrets). Authentication uses AZURE_TENANT_ID, AZURE_CLIENT_ID and
 * AZURE_CLIENT_SECRET, read by electron-builder itself. See docs/SERVER-DEPLOYMENT.md → Windows code signing.
 */
const azureSigningValues = {
  endpoint: process.env.PROXY_QA_AZURE_SIGN_ENDPOINT?.trim(),
  codeSigningAccountName: process.env.PROXY_QA_AZURE_SIGN_ACCOUNT?.trim(),
  certificateProfileName: process.env.PROXY_QA_AZURE_SIGN_PROFILE?.trim(),
  publisherName: process.env.PROXY_QA_AZURE_SIGN_PUBLISHER?.trim(),
}
const azureSigningSet = Object.values(azureSigningValues).filter(Boolean).length
if (azureSigningSet > 0 && azureSigningSet < 4)
  throw new Error('Azure Trusted Signing needs PROXY_QA_AZURE_SIGN_ENDPOINT, _ACCOUNT, _PROFILE and _PUBLISHER together.')
if (azureSigningSet === 4 && testKeyFile) throw new Error('Update smoke builds are never signed.')
const azureSignOptions = azureSigningSet === 4 ? azureSigningValues : null

// Whole argv (not sliced): argv[0]/argv[1] are the node/CLI paths and can never equal a flag.
const argv = process.argv
const platformFlag = (long, short) => argv.some((a) => a === long || a === short || a.startsWith(`${long}=`))
// electron-builder's aliases: --mac/-m/--macos/-o, --win/-w/--windows, --linux/-l.
const macFlag = platformFlag('--mac', '-m') || platformFlag('--macos', '-o')
const anyPlatformFlag = platformFlag('--linux', '-l') || platformFlag('--win', '-w') || platformFlag('--windows', '-w') || macFlag
const buildingLinux = platformFlag('--linux', '-l') || (!anyPlatformFlag && process.platform === 'linux')
const buildingMac = macFlag || (!anyPlatformFlag && process.platform === 'darwin')

/**
 * Apple credentials are validated only for macOS builds (a Linux or Windows build never reads them);
 * a partial set is refused there. See scripts/mac-signing.mjs and docs/DISTRIBUTION.md → macOS.
 */
const macSigningSettings = buildingMac
  ? macSigning(process.env, { signedRelease: process.env.PROXY_QA_SIGNED_RELEASE === '1', testBuild: Boolean(testKeyFile) })
  : macSigning({})
if (buildingMac)
  process.stderr.write(
    `macOS signing: ${macSigningSettings.mode}${macSigningSettings.notarization ? ` (notarization: ${macSigningSettings.notarization})` : ''}\n`,
  )

/**
 * An extraResources entry that is included only when its source directory
 * exists. A missing Linux bundle produces a slim AppImage (browsers are then
 * provisioned into <userData>/data/browsers on first run) and a loud warning,
 * rather than a failed build.
 */
function optionalResource(from, to, hint) {
  if (existsSync(join(ROOT, from))) return [{ from, to }]
  if (buildingLinux) process.stderr.write(`WARNING: ${from} is missing — ${to} will not be bundled. ${hint}\n`)
  return []
}

/**
 * Bundled location dataset (GeoNames US postal codes, CC BY 4.0 — see
 * resources/geonames/ATTRIBUTION.md), read at runtime from
 * <resources>/geonames by src/main/locations. Shipped on every platform.
 */
const geonamesResource = { from: 'resources/geonames', to: 'geonames' }

/** Window icon for Linux (BrowserWindow `icon`, resolved by src/main/windows/app-icon.ts). */
const appIconResource = { from: 'build/icons/icon.png', to: 'icon.png' }

const linuxExtraResources = [
  geonamesResource,
  appIconResource,
  ...optionalResource(
    'build/browsers/linux',
    'playwright-browsers',
    'Run: node scripts/bundle-browsers.mjs --platform linux --webkit-libs',
  ),
  ...optionalResource(
    'build/webkit-libs/linux',
    'webkit-libs',
    'Run: node scripts/bundle-browsers.mjs --platform linux --webkit-libs',
  ),
]

const windowsExtraResources = [
  geonamesResource,
  ...(BUNDLE_WINDOWS_BROWSERS ? [{ from: 'build/browsers/win64', to: 'playwright-browsers' }] : []),
]

if (BUNDLE_WINDOWS_BROWSERS && !existsSync(join(ROOT, 'build/browsers/win64'))) {
  throw new Error(
    'PROXY_QA_BUNDLE_BROWSERS=1 but build/browsers/win64 is missing. Run: node scripts/bundle-browsers.mjs --platform win64',
  )
}

/** @type {import('electron-builder').Configuration} */
const config = {
  appId: 'com.ubaidbinwaris.proxy-qa-browser',
  productName: 'Proxy-QA-Browser',
  copyright: 'Copyright © 2026 Ubaid Bin Waris',
  directories: {
    output: testOutput ?? 'release',
    buildResources: 'build',
  },
  files: ['out/**/*', 'package.json', '!**/*.map'],
  asar: true,
  // playwright-core must live on the real filesystem: it spawns browser processes
  // and its installer CLI runs as a child Node process, neither of which can run
  // from inside app.asar.
  asarUnpack: ['node_modules/playwright-core/**', '**/*.node'],
  npmRebuild: false,
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  linux: {
    syncDesktopName: true,
    target: [{ target: 'AppImage', arch: ['x64'] }],
    category: 'Development',
    synopsis: 'QA browser for authorized form testing through isolated profiles and proxy exit IPs',
    // electron-builder >= 26 takes [Desktop Entry] keys under `desktop.entry`.
    desktop: {
      entry: {
        Name: 'Proxy QA Browser',
        Comment: 'Launch isolated Chromium, Firefox and WebKit QA profiles through residential proxy exit IPs',
      },
    },
    // One 512 px PNG (electron-builder derives the size set); build/icons also holds the SVG sources.
    icon: 'build/icons/icon.png',
    artifactName: '${productName}-${version}-x86_64.${ext}',
    executableName: 'proxy-qa-browser',
    extraResources: linuxExtraResources,
  },
  // Windows ships as a single portable EXE only (no installer). The portable
  // target self-extracts to %TEMP% on every launch; all user data stays in
  // %APPDATA%\proxy-qa-browser (vault, database, browsers) and the vault key in
  // %LOCALAPPDATA%\ProxyQABrowser\keys.
  win: {
    target: [{ target: 'portable', arch: ['x64'] }],
    icon: 'build/icons/icon.ico',
    artifactName: '${productName}-${version}-Windows-${arch}.${ext}',
    extraResources: windowsExtraResources,
    ...(azureSignOptions ? { azureSignOptions } : {}),
  },
  portable: {
    artifactName: '${productName}-${version}-Windows-x64.${ext}',
  },
  // macOS: a DMG (drag to Applications) and a ZIP per architecture. Separate arm64/x64 builds rather
  // than one universal app: Playwright downloads per-architecture browsers anyway, and each download
  // stays half the size. Browsers are provisioned on first run, as on Windows.
  mac: {
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    category: 'public.app-category.developer-tools',
    icon: 'build/icons/icon.icns',
    artifactName: '${productName}-${version}-macOS-${arch}.${ext}',
    darkModeSupport: true,
    // Electron 38+ supports macOS 12 (Monterey) and later.
    minimumSystemVersion: '12.0',
    extraResources: [geonamesResource],
    ...macSigningSettings.options,
  },
  dmg: {
    artifactName: '${productName}-${version}-macOS-${arch}.${ext}',
  },
  publish: null,
  ...(process.env.PROXY_QA_SIGNED_RELEASE === '1' ? { forceCodeSigning: true } : {}),
  extraMetadata: {
    ...(testVersion ? { version: testVersion } : {}),
    ...(buildingLinux ? { desktopName: 'com.ubaidbinwaris.proxy-qa-browser.desktop' } : {}),
    qaReleaseNotes: notes,
    ...(existsSync(publicKeyPath) ? { qaOfflineUpdates: { publicKey: readFileSync(publicKeyPath, 'utf8') } } : {}),
    ...(existsSync(publicKeyPath)
      ? { qaUpdates: { feedUrl: process.env.PROXY_QA_UPDATE_FEED || 'https://proxybrowser.ubaidbinwaris.com/api/updates/stable', publicKey: readFileSync(publicKeyPath, 'utf8') } }
      : {}),
  },
}

export default config

import { spawnSync } from 'node:child_process'
import type { SpawnSyncReturns } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '..')
const SCRIPTS = join(ROOT, 'scripts')
const BUILDER_CONFIG = join(ROOT, 'electron-builder.config.mjs')

interface ExtraResource {
  from: string
  to: string
}

interface BuilderConfig {
  productName: string
  asar: boolean
  asarUnpack: string[]
  npmRebuild: boolean
  publish: null
  linux: {
    target: Array<{ target: string; arch: string[] }>
    artifactName: string
    executableName: string
    icon: string
    extraResources: ExtraResource[]
  }
  win: {
    target: Array<{ target: string; arch: string[] }>
    artifactName: string
    icon: string
    extraResources?: ExtraResource[]
  }
  portable: { artifactName: string }
  mac: {
    target: Array<{ target: string; arch: string[] }>
    category: string
    icon: string
    artifactName: string
    minimumSystemVersion: string
    extraResources: ExtraResource[]
    identity?: string | null
    hardenedRuntime: boolean
    notarize: boolean
    entitlements?: string
    entitlementsInherit?: string
    gatekeeperAssess?: boolean
  }
  dmg: { artifactName: string }
}

/** Every Apple/certificate variable blanked, so a developer's or runner's own environment cannot leak in. */
const APPLE_VARS = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'APPLE_KEYCHAIN',
  'APPLE_KEYCHAIN_PROFILE',
  'PROXY_QA_SIGNED_RELEASE',
  'PROXY_QA_TEST_PUBLIC_KEY_FILE',
  'PROXY_QA_TEST_OUTPUT',
  'PROXY_QA_TEST_VERSION',
]
function appleEnv(values: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(APPLE_VARS.map((name) => [name, ''])), ...values }
}
const CERTIFICATE = { CSC_LINK: '/secure/developer-id.p12', CSC_KEY_PASSWORD: 'p12-password' }
const API_KEY = { APPLE_API_KEY: '/secure/AuthKey_ABC.p8', APPLE_API_KEY_ID: 'ABC123', APPLE_API_ISSUER: '00000000-0000-0000-0000-000000000000' }
const APPLE_ID = { APPLE_ID: 'release@example.test', APPLE_APP_SPECIFIC_PASSWORD: 'abcd-efgh-ijkl-mnop', APPLE_TEAM_ID: 'TEAM123456' }

function node(args: string[], env: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } })
}

/** Load the builder config in a child process so PROXY_QA_BUNDLE_BROWSERS and argv can be controlled. */
function loadBuilderConfig(env: NodeJS.ProcessEnv = {}, argv: string[] = ['--linux']): BuilderConfig {
  const script = `import(${JSON.stringify(pathToFileURL(BUILDER_CONFIG).href)}).then((m) => process.stdout.write(JSON.stringify(m.default)))`
  // `--` keeps the electron-builder flags out of Node's own option parser.
  const result = node(['--input-type=module', '-e', script, '--', ...argv], env)
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout) as BuilderConfig
}

describe('scripts syntax', () => {
  it.each([
    'install-browsers.mjs',
    'bundle-browsers.mjs',
    'build-windows-bundled.mjs',
    'build-all.mjs',
    'make-icons.mjs',
    'mac-signing.mjs',
    'macos-smoke.mjs',
    'release-asset.mjs',
  ])('%s parses with node --check', (file) => {
    const result = node(['--check', join(SCRIPTS, file)])
    expect(result.status, result.stderr).toBe(0)
  })

  it('build-all.sh parses with bash -n', () => {
    const result = spawnSync('bash', ['-n', join(SCRIPTS, 'build-all.sh')], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
  })

  it('build-all.sh uses strict mode and never calls sudo', () => {
    const source = readFileSync(join(SCRIPTS, 'build-all.sh'), 'utf8')
    expect(source).toContain('set -euo pipefail')
    // sudo may appear inside quoted hint strings or comments but is never executed.
    const executable = source
      .split('\n')
      .map((line) => line.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/#.*$/, ''))
      .join('\n')
    expect(executable).not.toMatch(/\bsudo\b/)
    expect(source).toContain('--user "$UID_GID"')
    expect(source).toContain('NODE_MODULES_VOLUME="proxy-qa-win-node-modules"')
    expect(source).toContain('-v "${NODE_MODULES_VOLUME}:/project/node_modules"')
  })

  it('build-all.sh expects exactly the AppImage and the portable EXE, bundled Linux + slim Windows', () => {
    const source = readFileSync(join(SCRIPTS, 'build-all.sh'), 'utf8')
    expect(source).toContain('EXPECTED=("$APPIMAGE" "$PORTABLE_EXE")')
    expect(source).not.toMatch(/SETUP_EXE|-Setup-/)
    expect(source).toContain('npm run build:linux')
    expect(source).toContain('npx electron-builder --win --x64 --config electron-builder.config.mjs')
    expect(source).not.toContain('PROXY_QA_BUNDLE_BROWSERS=1')
  })
})

describe('install-browsers.mjs', () => {
  it('rejects unknown engines with exit code 2', () => {
    const result = node([join(SCRIPTS, 'install-browsers.mjs'), 'netscape'])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('Unknown browser engine(s): netscape')
  })

  it('points at the bundle script for packaged builds', () => {
    expect(readFileSync(join(SCRIPTS, 'install-browsers.mjs'), 'utf8')).toContain('scripts/bundle-browsers.mjs')
  })
})

describe('bundle-browsers.mjs', () => {
  const script = join(SCRIPTS, 'bundle-browsers.mjs')

  it('requires --platform linux|win64 (exit code 2 on usage errors)', () => {
    const missing = node([script])
    expect(missing.status).toBe(2)
    expect(missing.stderr).toContain('--platform is required')

    const unknown = node([script, '--platform', 'beos'])
    expect(unknown.status).toBe(2)
    expect(unknown.stderr).toContain('Unknown platform "beos"')

    const stray = node([script, '--platform', 'linux', '--bogus'])
    expect(stray.status).toBe(2)
    expect(stray.stderr).toContain('Unknown argument: --bogus')
  })

  it('explicitly skips macOS (browsers download on first run) without touching build/browsers', () => {
    for (const platform of ['mac', 'macos', 'darwin']) {
      const result = node([script, '--platform', platform])
      expect(result.status, platform).toBe(0)
      expect(result.stdout).toContain('macOS builds do not bundle browsers')
    }
    expect(existsSync(join(ROOT, 'build', 'browsers', 'mac'))).toBe(false)
    const withLibs = node([script, '--platform', 'darwin', '--webkit-libs'])
    expect(withLibs.status).toBe(2)
    expect(withLibs.stderr).toContain('--webkit-libs applies to --platform linux only')
  })

  it('accepts --webkit-libs for linux only', () => {
    const result = node([script, '--platform', 'win64', '--webkit-libs'])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('--webkit-libs applies to --platform linux only')
  })

  it('targets build/browsers/<platform>, removes the headless shell and verifies the WebKit sonames', () => {
    const source = readFileSync(script, 'utf8')
    expect(source).toContain("join(ROOT, 'build', 'browsers')")
    expect(source).toContain("join(ROOT, 'build', 'webkit-libs', 'linux')")
    expect(source).toContain("PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = 'win64'")
    expect(source).toContain("PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS: '1'")
    expect(source).toContain("'chromium_headless_shell-'")
    for (const soname of [
      'libicuuc.so.74',
      'libicui18n.so.74',
      'libicudata.so.74',
      'libflite.so.1',
      'libflite_usenglish.so.1',
      'libflite_cmulex.so.1',
      'libxml2.so.2',
    ]) {
      expect(source).toContain(`'${soname}'`)
    }
    expect(source).toContain('THIRD-PARTY-NOTICES.txt')
    expect(source).toContain('libicu74_74.2-1ubuntu3.1_amd64.deb')
    expect(source).toContain('libflite1_2.2-7build1_amd64.deb')
    expect(source).toContain('libxml2_2.9.14+dfsg-1.3ubuntu3.9_amd64.deb')
  })

  it('is ignored by git together with the WebKit libs', () => {
    const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
    expect(gitignore).toContain('build/browsers/')
    expect(gitignore).toContain('build/webkit-libs/')
  })
})

describe('electron-builder.config.mjs packaging targets', () => {
  it('replaced electron-builder.yml', () => {
    expect(existsSync(BUILDER_CONFIG)).toBe(true)
    expect(existsSync(join(ROOT, 'electron-builder.yml'))).toBe(false)
  })

  it('ships Windows as a portable EXE only (no NSIS installer)', () => {
    // An obsolete installer flag must not bring the removed setup EXE back.
    const config = loadBuilderConfig({ PROXY_QA_INSTALLER: '1' }, ['--win'])
    expect(config.win.target).toEqual([{ target: 'portable', arch: ['x64'] }])
    expect(JSON.stringify(config)).not.toMatch(/\bnsis\b/)
    expect(JSON.stringify(config)).not.toMatch(/-Setup-/)
    expect(config.portable.artifactName).toBe('${productName}-${version}-Windows-x64.${ext}')
  })

  it('ships Linux as an AppImage with the bundled browsers and WebKit libs as extra resources', () => {
    const config = loadBuilderConfig()
    expect(config.linux.target).toEqual([{ target: 'AppImage', arch: ['x64'] }])
    expect(config.linux.artifactName).toBe('${productName}-${version}-x86_64.${ext}')
    expect(config.linux.executableName).toBe('proxy-qa-browser')
    const source = readFileSync(BUILDER_CONFIG, 'utf8')
    expect(source).toMatch(/optionalResource\(\s*'build\/browsers\/linux',\s*'playwright-browsers'/)
    expect(source).toMatch(/optionalResource\(\s*'build\/webkit-libs\/linux',\s*'webkit-libs'/)
    expect(config.linux.extraResources).toContainEqual({ from: 'resources/geonames', to: 'geonames' })
    // Entries are present whenever the bundle directories exist on this machine.
    for (const [from, to] of [
      ['build/browsers/linux', 'playwright-browsers'],
      ['build/webkit-libs/linux', 'webkit-libs'],
    ] as const) {
      const present = config.linux.extraResources.some((r) => r.from === from && r.to === to)
      expect(present).toBe(existsSync(join(ROOT, from)))
    }
  })

  it('uses the generated app icons: Linux 512 px PNG (also the window-icon resource) and the Windows multi-size ICO', () => {
    const config = loadBuilderConfig()
    expect(config.linux.icon).toBe('build/icons/icon.png')
    expect(config.linux.extraResources).toContainEqual({ from: 'build/icons/icon.png', to: 'icon.png' })
    expect(config.win.icon).toBe('build/icons/icon.ico')
    for (const file of [config.linux.icon, config.win.icon, 'build/icons/icon.svg', 'build/icons/icon-small.svg'])
      expect(existsSync(join(ROOT, file))).toBe(true)
  })

  it('bundles Windows browsers only when PROXY_QA_BUNDLE_BROWSERS=1', () => {
    // The location dataset ships on every platform; only the browsers are optional.
    const slim = loadBuilderConfig({ PROXY_QA_BUNDLE_BROWSERS: '' }, ['--win'])
    expect(slim.win.extraResources).toEqual([{ from: 'resources/geonames', to: 'geonames' }])
    const script = `import(${JSON.stringify(pathToFileURL(BUILDER_CONFIG).href)}).then((m) => process.stdout.write(JSON.stringify(m.default.win.extraResources ?? null)))`
    const bundled = node(['--input-type=module', '-e', script, '--', '--win'], { PROXY_QA_BUNDLE_BROWSERS: '1' })
    if (existsSync(join(ROOT, 'build', 'browsers', 'win64'))) {
      expect(bundled.status).toBe(0)
      expect(JSON.parse(bundled.stdout)).toEqual([
        { from: 'resources/geonames', to: 'geonames' },
        { from: 'build/browsers/win64', to: 'playwright-browsers' },
      ])
    } else {
      // Refuses to produce a "bundled" EXE without the bundle instead of silently shipping slim.
      expect(bundled.status).not.toBe(0)
      expect(bundled.stderr).toContain('build/browsers/win64 is missing')
    }
  })

  it('builds macOS as DMG + ZIP for arm64 and x64 with the generated ICNS, slim like Windows', () => {
    const config = loadBuilderConfig(appleEnv(), ['--mac'])
    expect(config.mac.target).toEqual([
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ])
    expect(config.mac.category).toBe('public.app-category.developer-tools')
    expect(config.mac.icon).toBe('build/icons/icon.icns')
    expect(existsSync(join(ROOT, config.mac.icon))).toBe(true)
    expect(config.mac.artifactName).toBe('${productName}-${version}-macOS-${arch}.${ext}')
    expect(config.dmg.artifactName).toBe(config.mac.artifactName)
    expect(config.mac.minimumSystemVersion).toBe('12.0')
    // No bundled browsers on macOS: they download into <userData>/data/browsers on first run.
    expect(config.mac.extraResources).toEqual([{ from: 'resources/geonames', to: 'geonames' }])
  })

  it('macOS without Apple credentials: ad-hoc signed, no hardened runtime, not notarized', () => {
    const config = loadBuilderConfig(appleEnv(), ['--mac', 'dir'])
    expect(config.mac).toMatchObject({ identity: '-', hardenedRuntime: false, notarize: false })
    expect(config.mac.entitlements).toBeUndefined()
  })

  it('macOS with a Developer ID certificate signs with the hardened runtime; notarizes only with a complete credential set', () => {
    const signed = loadBuilderConfig(appleEnv(CERTIFICATE), ['--mac'])
    expect(signed.mac).toMatchObject({ hardenedRuntime: true, notarize: false, gatekeeperAssess: false, entitlements: 'build/entitlements.mac.plist', entitlementsInherit: 'build/entitlements.mac.plist' })
    expect('identity' in signed.mac).toBe(false)
    for (const credentials of [API_KEY, APPLE_ID, { APPLE_KEYCHAIN: '/secure/notary.keychain-db', APPLE_KEYCHAIN_PROFILE: 'proxy-qa' }]) {
      const notarized = loadBuilderConfig(appleEnv({ ...CERTIFICATE, ...credentials }), ['--mac'])
      expect(notarized.mac).toMatchObject({ hardenedRuntime: true, notarize: true })
    }
    const entitlements = readFileSync(join(ROOT, 'build', 'entitlements.mac.plist'), 'utf8')
    for (const key of ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory', 'com.apple.security.network.client'])
      expect(entitlements).toContain(`<key>${key}</key>`)
    expect(entitlements).not.toContain('disable-library-validation')
  })

  it('refuses partial or contradictory Apple credentials for macOS builds (like the Azure signing values)', () => {
    const refused = (env: Record<string, string>, message: string, argv = ['--mac']): void => {
      const script = `import(${JSON.stringify(pathToFileURL(BUILDER_CONFIG).href)}).then(() => process.stdout.write('loaded'))`
      const result = node(['--input-type=module', '-e', script, '--', ...argv], appleEnv(env))
      expect(result.status, JSON.stringify(env)).not.toBe(0)
      expect(result.stderr).toContain(message)
    }
    refused({ CSC_LINK: CERTIFICATE.CSC_LINK }, 'macOS signing needs CSC_LINK and CSC_KEY_PASSWORD together')
    refused({ CSC_KEY_PASSWORD: 'x' }, 'macOS signing needs CSC_LINK and CSC_KEY_PASSWORD together', ['-m'])
    refused({ ...CERTIFICATE, APPLE_ID: APPLE_ID.APPLE_ID }, 'missing APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID')
    refused({ ...CERTIFICATE, APPLE_API_KEY: API_KEY.APPLE_API_KEY, APPLE_API_KEY_ID: 'ABC123' }, 'missing APPLE_API_ISSUER')
    refused({ ...CERTIFICATE, ...API_KEY, ...APPLE_ID }, 'Choose one notarization method')
    refused(API_KEY, 'Notarization needs a Developer ID Application certificate')
    refused({ PROXY_QA_SIGNED_RELEASE: '1' }, 'PROXY_QA_SIGNED_RELEASE=1 for macOS needs')
    refused({ ...CERTIFICATE, PROXY_QA_SIGNED_RELEASE: '1' }, 'PROXY_QA_SIGNED_RELEASE=1 for macOS needs')
    refused({ ...CERTIFICATE, PROXY_QA_TEST_PUBLIC_KEY_FILE: '/tmp/test.pem', PROXY_QA_TEST_OUTPUT: '/tmp/out' }, 'Update smoke builds are never signed')
    // A signed, notarized release is accepted.
    const release = loadBuilderConfig(appleEnv({ ...CERTIFICATE, ...API_KEY, PROXY_QA_SIGNED_RELEASE: '1' }), ['--mac'])
    expect(release.mac.notarize).toBe(true)
  })

  it('never reads Apple credentials for Linux or Windows builds', () => {
    const partial = appleEnv({ CSC_LINK: CERTIFICATE.CSC_LINK, APPLE_ID: APPLE_ID.APPLE_ID })
    expect(loadBuilderConfig(partial, ['--linux']).mac.identity).toBe('-')
    expect(loadBuilderConfig(partial, ['--win']).mac.identity).toBe('-')
  })

  it("passes electron-builder's own configuration schema for every platform and signing mode", () => {
    const validator = join(ROOT, 'node_modules', 'app-builder-lib', 'out', 'util', 'config', 'config.js')
    const script = [
      `const { createRequire } = await import('node:module')`,
      `const { validateConfiguration } = createRequire(${JSON.stringify(validator)})(${JSON.stringify(validator)})`,
      `const config = (await import(${JSON.stringify(pathToFileURL(BUILDER_CONFIG).href)})).default`,
      `await validateConfiguration(config, { isEnabled: false, add() {} })`,
      `process.stdout.write('valid')`,
    ].join('\n')
    for (const [argv, env] of [
      [['--linux'], appleEnv()],
      [['--win'], appleEnv()],
      [['--mac'], appleEnv()],
      [['--mac'], appleEnv({ ...CERTIFICATE, ...API_KEY })],
    ] as const) {
      const result = node(['--input-type=module', '-e', script, '--', ...argv], env)
      expect(result.status, `${argv.join(' ')}: ${result.stderr}`).toBe(0)
      expect(result.stdout).toBe('valid')
    }
  })

  it('keeps the asar/unpack/rebuild/publish settings from the YAML config', () => {
    const config = loadBuilderConfig()
    expect(config.productName).toBe('Proxy-QA-Browser')
    expect(config.asar).toBe(true)
    expect(config.asarUnpack).toEqual(['node_modules/playwright-core/**', '**/*.node'])
    expect(config.npmRebuild).toBe(false)
    expect(config.publish).toBeNull()
  })
})

describe('package.json build scripts', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }

  it('bundle Linux, keep Windows slim and offer a bundled Windows variant', () => {
    expect(pkg.scripts['build:linux']).toBe(
      'node scripts/bundle-browsers.mjs --platform linux --webkit-libs && npm run build && electron-builder --linux --x64 --config electron-builder.config.mjs',
    )
    expect(pkg.scripts['build:windows']).toBe(
      'npm run build && electron-builder --win --x64 --config electron-builder.config.mjs',
    )
    expect(pkg.scripts['build:windows:bundled']).toBe('node scripts/build-windows-bundled.mjs')
  })

  it('builds macOS DMG/ZIP for both architectures, or an unpacked .app for local testing', () => {
    expect(pkg.scripts['build:mac']).toBe('npm run build && electron-builder --mac --config electron-builder.config.mjs')
    expect(pkg.scripts['build:mac:dir']).toBe('npm run build && electron-builder --mac dir --config electron-builder.config.mjs')
  })

  it('build-windows-bundled.mjs bundles win64 first and sets PROXY_QA_BUNDLE_BROWSERS=1 for electron-builder', () => {
    const source = readFileSync(join(SCRIPTS, 'build-windows-bundled.mjs'), 'utf8')
    expect(source).toContain("'--platform', 'win64'")
    expect(source).toContain("PROXY_QA_BUNDLE_BROWSERS: '1'")
    expect(source).toContain("'--config', 'electron-builder.config.mjs'")
    expect(source).toContain('process.exit(result.status ?? 1)')
  })
})

describe('macOS CI', () => {
  // Normalised: Windows checks text files out with CRLF line endings.
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'macos.yml'), 'utf8').replace(/\r\n/g, '\n')

  it('runs on push to main, pull requests and manually, on macos-latest, with read-only permissions', () => {
    expect(workflow).toMatch(/on:\n\s+pull_request:\n\s+workflow_dispatch:\n\s+push:\n\s+branches: \[main\]/)
    expect(workflow).toContain('runs-on: macos-latest')
    expect(workflow).toMatch(/permissions:\n\s+contents: read/)
  })

  it('pins every action by full commit SHA, the same versions as the Linux workflow', () => {
    const linux = readFileSync(join(ROOT, '.github', 'workflows', 'linux.yml'), 'utf8')
    const uses = [...workflow.matchAll(/uses: (\S+)/g)].map((m) => m[1]!)
    expect(uses.length).toBeGreaterThanOrEqual(3)
    for (const action of uses) expect(action).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/)
    for (const action of uses.filter((a) => /^actions\/(checkout|setup-node)@/.test(a))) expect(linux).toContain(action)
  })

  it('verifies, builds unsigned apps for both architectures and smoke-tests the packaged app without secrets', () => {
    for (const step of ['npm ci', 'npm run typecheck', 'npm run lint', 'npm test', 'npm run build', 'node scripts/macos-smoke.mjs'])
      expect(workflow).toContain(step)
    expect(workflow).toContain('npx electron-builder --mac dmg zip --arm64 --config electron-builder.config.mjs')
    expect(workflow).toContain('npx electron-builder --mac zip --x64 --config electron-builder.config.mjs')
    expect(workflow).not.toMatch(/secrets\./)
    expect(workflow).not.toMatch(/CSC_LINK|APPLE_/)
  })

  it('publishes unsigned DMGs for both architectures, and the release waits for them', () => {
    const deploy = readFileSync(join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8').replace(/\r\n/g, '\n')
    const job = deploy.slice(deploy.indexOf('\n  macos:\n'), deploy.indexOf('\n  linux:\n'))
    expect(job).toContain('runs-on: macos-latest')
    expect(job).toContain('--mac dmg --arm64')
    expect(job).toContain('--mac dmg --x64')
    expect(job).toContain('node scripts/macos-smoke.mjs')
    // Unsigned until Apple credentials exist: no setting in the job may demand signing (comments may explain how).
    const settings = job.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')
    expect(settings).not.toMatch(/PROXY_QA_SIGNED_RELEASE|CSC_LINK|APPLE_API_KEY/)
    expect(deploy).toMatch(/needs: \[windows, update-smoke, macos, linux, website\]/)
    expect(deploy).toContain('{platform:"darwin",arch:"arm64",fileName:process.env.MAC_ARM64_FILE')
    expect(deploy).toContain('{platform:"darwin",arch:"x64",fileName:process.env.MAC_X64_FILE')
  })

  it('finds the unpacked .app electron-builder leaves for each architecture', async () => {
    const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { findAppBundle } = (await import(pathToFileURL(join(SCRIPTS, 'macos-smoke.mjs')).href)) as { findAppBundle(dir: string, arch: string): string | null }
    const release = mkdtempSync(join(tmpdir(), 'mac-release-'))
    try {
      expect(findAppBundle(release, 'arm64')).toBeNull()
      mkdirSync(join(release, 'mac-arm64', 'Proxy-QA-Browser.app'), { recursive: true })
      mkdirSync(join(release, 'mac', 'Proxy-QA-Browser.app'), { recursive: true })
      expect(findAppBundle(release, 'arm64')).toBe(join(release, 'mac-arm64', 'Proxy-QA-Browser.app'))
      expect(findAppBundle(release, 'x64')).toBe(join(release, 'mac', 'Proxy-QA-Browser.app'))
    } finally {
      rmSync(release, { recursive: true, force: true })
    }
  })
})

describe('build-all.mjs artifact names', () => {
  it('derives names from package.json version and the builder config patterns', () => {
    const version = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
    const source = readFileSync(join(SCRIPTS, 'build-all.mjs'), 'utf8')
    const config = loadBuilderConfig()

    expect(config.productName).toBe('Proxy-QA-Browser')
    expect(source).toContain("const PRODUCT = 'Proxy-QA-Browser'")
    expect(source).toContain('`${PRODUCT}-${VERSION}-x86_64.AppImage`')
    expect(source).toContain('`${PRODUCT}-${VERSION}-Windows-x64.exe`')
    expect(source).not.toMatch(/-Setup-/)
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('uses the bundled Linux build and the slim Windows build with the ESM config', () => {
    const source = readFileSync(join(SCRIPTS, 'build-all.mjs'), 'utf8')
    expect(source).toContain("['run', 'build:linux']")
    expect(source).toContain("['electron-builder', '--win', '--x64', '--config', 'electron-builder.config.mjs']")
    expect(source).toContain('npx electron-builder --win --x64 --config electron-builder.config.mjs')
    expect(source).not.toContain('PROXY_QA_BUNDLE_BROWSERS')
  })

  it('prints BUILD COMPLETE only when artifacts exist (guard present)', () => {
    const source = readFileSync(join(SCRIPTS, 'build-all.mjs'), 'utf8')
    expect(source).toContain("process.stdout.write('\\nBUILD COMPLETE\\n')")
    expect(source).toContain('if (failed || missing.length > 0)')
  })
})

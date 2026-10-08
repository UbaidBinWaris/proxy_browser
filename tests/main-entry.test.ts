/**
 * Build invariant for the Playwright browsers directory.
 *
 * playwright-core computes its registry directory from PLAYWRIGHT_BROWSERS_PATH
 * when the module is evaluated, and Rollup hoists static imports. The process
 * entry (src/main/index.ts) therefore has to set the env var and load the real
 * main module with a dynamic import, and it must not pull playwright-core in
 * through any static import of its own. Its static application modules (browser paths and relaunch environment)
 * must stay free of playwright-core.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '..')
const ENTRY = join(ROOT, 'src', 'main', 'index.ts')
const BROWSERS_PATH_MODULE = join(ROOT, 'src', 'main', 'browser', 'browsers-path.ts')
const VITE_CONFIG = join(ROOT, 'electron.vite.config.ts')

/** Drop block and line comments so documentation cannot trip the import checks. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** Static `import … from '<spec>'` / `import '<spec>'` specifiers, excluding `import type`. */
function staticImportSpecifiers(code: string): string[] {
  const specs: string[] = []
  const pattern = /^\s*import\s+(?!type\b)(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm
  for (const match of code.matchAll(pattern)) {
    if (match[1]) specs.push(match[1])
  }
  return specs
}

describe('src/main/index.ts (process entry)', () => {
  const source = readFileSync(ENTRY, 'utf8')
  const code = stripComments(source)
  const imports = staticImportSpecifiers(code)

  it('statically imports only Electron, paths and modules that do not load Playwright', () => {
    expect(imports.length).toBeGreaterThan(0)
    for (const spec of imports) {
      expect(['electron', 'node:path', './browser/browsers-path', './desktop/relaunch-env'], `unexpected static import "${spec}"`).toContain(spec)
    }
    expect(imports).toContain('./browser/browsers-path')
    const relaunch = stripComments(readFileSync(join(ROOT, 'src/main/desktop/relaunch-env.ts'), 'utf8'))
    expect(staticImportSpecifiers(relaunch)).toEqual([])
  })

  it('never imports or requires playwright-core, other ./browser/* modules or ./proxy/* (even dynamically)', () => {
    expect(code).not.toMatch(/playwright-core/)
    expect(code).not.toMatch(/['"]\.\/browser\/(?!browsers-path['"])/)
    expect(code).not.toMatch(/['"]\.\/proxy\//)
    expect(code).not.toMatch(/\brequire\(/)
    // The only dynamic import is the main module.
    const dynamicImports = [...code.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
    expect(dynamicImports).toEqual(['./main'])
  })

  it('resolves the browsers directory (env → bundled → provisioned → dev cache) and exports it before importing ./main', () => {
    expect(code).toMatch(/resolveBrowsersDir\(\{/)
    expect(code).toMatch(/envPath:\s*process\.env\.PLAYWRIGHT_BROWSERS_PATH/)
    expect(code).toMatch(/resourcesPath:\s*process\.resourcesPath/)
    expect(code).toMatch(/join\(app\.getPath\('userData'\),\s*'data',\s*'browsers'\)/)
    expect(code).toMatch(/isPackaged:\s*app\.isPackaged/)
    const envAssignment = code.indexOf('process.env.PLAYWRIGHT_BROWSERS_PATH =')
    const dynamicImport = code.search(/await import\(['"]\.\/main['"]\)/)
    expect(envAssignment).toBeGreaterThan(-1)
    expect(dynamicImport).toBeGreaterThan(envAssignment)
    // Only the bundled/provisioned decisions are exported: an env value already set wins and the
    // dev cache is left to playwright-core itself.
    expect(code).toMatch(/source === 'bundled' \|\| browsers\.source === 'provisioned'/)
  })

  it('exports the bundled WebKit libs directory and skips Playwright host validation when it exists', () => {
    expect(code).toMatch(/resolveWebkitLibsDir\(process\.resourcesPath\)/)
    expect(code).toMatch(/process\.env\[WEBKIT_LIBS_ENV\]\s*=/)
    expect(code).toMatch(/process\.env\.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS\s*=\s*'1'/)
    const skip = code.indexOf('PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS')
    expect(code.search(/await import\(['"]\.\/main['"]\)/)).toBeGreaterThan(skip)
  })

  it('reports a failed main-module load instead of dying silently', () => {
    expect(code).toContain('dialog.showErrorBox')
    expect(code).toContain('app.exit(1)')
  })
})

describe('src/main/browser/browsers-path.ts', () => {
  const code = stripComments(readFileSync(BROWSERS_PATH_MODULE, 'utf8'))
  const imports = staticImportSpecifiers(code)

  it('imports only Node built-ins and the shared types (never playwright-core or electron)', () => {
    expect(imports.length).toBeGreaterThan(0)
    for (const spec of imports) {
      expect(['node:fs', 'node:module', 'node:os', 'node:path', '@shared/types'], `unexpected static import "${spec}"`).toContain(spec)
    }
    expect(code).not.toMatch(/from ['"]playwright-core['"]/)
    expect(code).not.toMatch(/from ['"]electron['"]/)
    // browsers.json is read from disk via createRequire, which also resolves inside app.asar.
    expect(code).toMatch(/createRequire\(import\.meta\.url\)/)
    expect(code).toMatch(/resolve\('playwright-core\/package\.json'\)/)
  })
})

describe('electron.vite.config.ts', () => {
  it('points the main build input at src/main/index.ts', () => {
    const config = readFileSync(VITE_CONFIG, 'utf8')
    const mainSection = config.slice(config.indexOf('main:'), config.indexOf('preload:'))
    expect(mainSection).toMatch(/input:\s*\{\s*index:\s*resolve\(__dirname,\s*'src\/main\/index\.ts'\)/)
    expect(mainSection).not.toContain("'src/main/main.ts'")
  })

  it('emits the main chunk next to index.js (main.ts resolves ../preload and ../renderer from __dirname)', () => {
    const config = readFileSync(VITE_CONFIG, 'utf8')
    const mainSection = config.slice(config.indexOf('main:'), config.indexOf('preload:'))
    expect(mainSection).toMatch(/chunkFileNames:\s*'\[name\]-\[hash\]\.js'/)
  })

  it('keeps package.json "main" at out/main/index.js', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { main: string }
    expect(pkg.main).toBe('out/main/index.js')
  })
})

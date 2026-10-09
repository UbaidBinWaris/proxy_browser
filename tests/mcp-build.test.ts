/**
 * Build invariants of the headless entries (out/main/qa-cli.js, out/main/qa-mcp.js): no Electron
 * anywhere in their import graphs and only production dependencies, checked on the sources
 * always and on the build output when it exists (scripts/check-headless-entries.mjs also runs as
 * part of `npm run build`).
 */
import { existsSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '..')
const OUT = join(ROOT, 'out', 'main')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; scripts: Record<string, string> }
const DEPENDENCIES = Object.keys(pkg.dependencies)

const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** Runtime import specifiers of a TypeScript module (type-only imports and re-exports are erased). */
function runtimeSpecifiers(code: string): string[] {
  const specs: string[] = []
  const patterns = [
    /^\s*import\s+(?!type\b)(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm,
    /^\s*export\s+(?!type\b)(?:\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/gm,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) for (const match of code.matchAll(pattern)) specs.push(match[1]!)
  return specs
}

function resolveSource(from: string, spec: string): string | null {
  const base = spec.startsWith('@shared/') ? join(ROOT, 'src', 'shared', spec.slice('@shared/'.length)) : spec.startsWith('.') ? resolve(dirname(from), spec) : null
  if (!base) return null
  for (const candidate of [`${base}.ts`, join(base, 'index.ts'), base]) if (existsSync(candidate) && candidate.endsWith('.ts')) return candidate
  throw new Error(`Cannot resolve ${spec} from ${from}`)
}

/** Every bare package a source entry loads at runtime, following relative and @shared imports. */
function sourceGraph(entry: string): { files: number; packages: Set<string> } {
  const seen = new Set<string>()
  const packages = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.shift()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const spec of runtimeSpecifiers(stripComments(readFileSync(file, 'utf8')))) {
      const local = resolveSource(file, spec)
      if (local) queue.push(local)
      else if (!spec.startsWith('node:') && !builtinModules.includes(spec.split('/')[0]!)) packages.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!)
    }
  }
  return { files: seen.size, packages }
}

describe('headless entries', () => {
  it('builds qa-mcp beside qa-cli', () => {
    const config = readFileSync(join(ROOT, 'electron.vite.config.ts'), 'utf8')
    expect(config).toMatch(/'qa-cli': resolve\(__dirname, 'src\/main\/qa\/cli\.ts'\)/)
    expect(config).toMatch(/'qa-mcp': resolve\(__dirname, 'src\/main\/mcp\/server\.ts'\)/)
    expect(pkg.scripts.build).toContain('scripts/check-headless-entries.mjs')
  })

  it('pins the MCP SDK to an exact version', () => {
    expect(pkg.dependencies['@modelcontextprotocol/sdk']).toMatch(/^\d+\.\d+\.\d+$/)
  })

  for (const entry of ['src/main/mcp/server.ts', 'src/main/qa/cli.ts']) {
    it(`${entry} loads no Electron and only production dependencies (source graph)`, () => {
      const { files, packages } = sourceGraph(join(ROOT, entry))
      expect(files).toBeGreaterThan(10)
      expect([...packages].filter((name) => name === 'electron' || name.startsWith('@electron/'))).toEqual([])
      for (const name of packages) expect(DEPENDENCIES, `${entry} imports ${name}`).toContain(name)
    })
  }

  it.skipIf(!existsSync(join(OUT, 'qa-mcp.js')))('the built qa-cli.js and qa-mcp.js load no Electron (build output)', async () => {
    const check = (await import(pathToFileURL(join(ROOT, 'scripts', 'check-headless-entries.mjs')).href)) as {
      checkEntry(outDir: string, entry: string, dependencies: string[]): string[]
      entryImports(outDir: string, entry: string): { files: string[]; bare: string[] }
    }
    expect(check.checkEntry(OUT, 'qa-cli.js', DEPENDENCIES)).toEqual([])
    expect(check.checkEntry(OUT, 'qa-mcp.js', DEPENDENCIES)).toEqual([])
    expect(check.entryImports(OUT, 'qa-mcp.js').bare).toEqual(expect.arrayContaining(['@modelcontextprotocol/sdk/server/stdio.js']))
    // The desktop entry is the negative control: its graph does load Electron.
    expect(check.checkEntry(OUT, 'index.js', DEPENDENCIES).join('\n')).toMatch(/imports electron/)
  })
})

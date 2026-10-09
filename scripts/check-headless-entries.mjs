#!/usr/bin/env node
/* global process */
/**
 * Build check: the headless entries out/main/qa-cli.js and out/main/qa-mcp.js run under plain
 * Node (CI runner image, MCP clients), so neither they nor any chunk they load may import
 * Electron, and every package they import must be a production dependency (the runner image
 * installs only those). Runs after `electron-vite build` (npm run build).
 *
 * Usage: node scripts/check-headless-entries.mjs [outDir]   (default: out/main)
 */
import { existsSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HEADLESS_ENTRIES = ['qa-cli.js', 'qa-mcp.js']

const IMPORT_PATTERNS = [
  /\bimport\s*(?:[\w*{}\s,$]+?\s*from\s*)?["']([^"']+)["']/g,
  /\bexport\s*(?:\*|\{[^}]*\})\s*from\s*["']([^"']+)["']/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
]

/** Package name of a bare specifier ("@scope/pkg/sub" → "@scope/pkg"). */
export function packageName(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

const isBuiltin = (specifier) => specifier.startsWith('node:') || builtinModules.includes(specifier.split('/')[0])

/** Walk the chunk graph of one built entry: the files it loads and the bare specifiers they import. */
export function entryImports(outDir, entry) {
  const files = []
  const bare = new Set()
  const queue = [resolve(outDir, entry)]
  while (queue.length > 0) {
    const file = queue.shift()
    if (files.includes(file)) continue
    files.push(file)
    const code = readFileSync(file, 'utf8')
    for (const pattern of IMPORT_PATTERNS)
      for (const match of code.matchAll(pattern)) {
        const specifier = match[1]
        if (specifier.startsWith('.')) queue.push(resolve(dirname(file), specifier))
        else bare.add(specifier)
      }
  }
  return { files, bare: [...bare].sort() }
}

/** Problems with one entry: Electron imports and packages that are not production dependencies. */
export function checkEntry(outDir, entry, dependencies) {
  const { bare } = entryImports(outDir, entry)
  const problems = []
  for (const specifier of bare) {
    if (isBuiltin(specifier)) continue
    const name = packageName(specifier)
    if (name === 'electron' || name.startsWith('@electron/')) problems.push(`${entry} imports ${specifier} (headless entries must not load Electron)`)
    else if (!dependencies.includes(name)) problems.push(`${entry} imports ${specifier}, which is not a production dependency`)
  }
  return problems
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const outDir = resolve(process.argv[2] ?? join(root, 'out', 'main'))
  const dependencies = Object.keys(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies ?? {})
  const problems = []
  for (const entry of HEADLESS_ENTRIES) {
    if (!existsSync(join(outDir, entry))) problems.push(`${entry} is missing from ${outDir}`)
    else problems.push(...checkEntry(outDir, entry, dependencies))
  }
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`check-headless-entries: ${problem}\n`)
    process.exit(1)
  }
  process.stdout.write(`check-headless-entries: ${HEADLESS_ENTRIES.join(', ')} load no Electron and only production dependencies\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()

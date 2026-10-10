/* global process, URL, console */
/**
 * Copies the website documentation into app/webapp/content/ (generated, gitignored):
 *   docs/site/manifest.json      -> content/manifest.json (+ per page: last commit date from git, images used)
 *   docs/site/<slug>.md          -> content/docs/<slug>.md
 *   docs/site/**\/*.{png,jpg,…}   -> public/docs-assets/… (images referenced by the docs)
 *                                   + content/images.json (width and height of each PNG/WebP/GIF image)
 *   resources/release-notes.json -> content/release-notes.json
 *   NOTICE                       -> content/NOTICE.txt (shown on the licences page)
 *
 * The manifest is validated first (unique slugs, every page file present, each page title equal to the
 * file's first `# ` heading, every relative image a page references exists); any problem fails the sync with a non-zero exit code. `--allow-missing`
 * (local development only, never CI) tolerates absent page files: they are dropped from the copied manifest.
 *
 * Usage: node scripts/sync-docs.mjs [--allow-missing] [--root <repo>] [--out <webapp dir>]
 */
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const RESERVED_SLUGS = new Set(['search'])
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif)$/i

/** Width and height of a PNG, GIF or WebP image, or null for other formats. */
export function imageSize(bytes) {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  if (bytes.length >= 10 && bytes.subarray(0, 3).toString('latin1') === 'GIF') return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
  if (bytes.length >= 30 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    const chunk = bytes.subarray(12, 16).toString('latin1')
    if (chunk === 'VP8X') return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) }
    if (chunk === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
    if (chunk === 'VP8L') {
      const b = bytes.subarray(21, 25)
      return { width: 1 + (((b[1] & 0x3f) << 8) | b[0]), height: 1 + (((b[3] & 0xf) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6)) }
    }
  }
  return null
}

/** Relative image paths (from docs/site) a page references with `![alt](path)`, outside fenced code blocks. */
export function imageReferences(markdown) {
  const refs = [], prose = markdown.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, '')
  for (const match of prose.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const target = match[1]
    if (!/^[a-z][a-z0-9+.-]*:|^\/|^#/i.test(target)) refs.push(target.replace(/^\.\//, ''))
  }
  return refs
}

/** The first ATX level-1 heading outside fenced code blocks, or null. */
export function firstHeading(markdown) {
  let fence = null
  for (const line of markdown.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (marker) {
      if (!fence) fence = marker[1][0]
      else if (marker[1][0] === fence) fence = null
      continue
    }
    if (fence) continue
    const heading = /^ {0,3}# +(.+?)(?: +#+)? *$/.exec(line)
    if (heading) return heading[1].trim()
  }
  return null
}

/**
 * Validates the manifest shape and every page against its Markdown file.
 * `readPage(slug)` returns the file contents or null when the file does not exist; `imageExists(path)`
 * tells whether a referenced image (relative to docs/site) exists.
 * Returns { manifest (only present pages), missing: string[], errors: string[] }.
 */
export async function validateManifest(raw, readPage, imageExists = async () => true) {
  const errors = [], missing = [], seen = new Set()
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sections) || raw.sections.length === 0) return { manifest: { sections: [] }, missing, errors: ['manifest.json must contain a non-empty "sections" array'] }
  const sections = []
  for (const [i, section] of raw.sections.entries()) {
    if (!section || typeof section.title !== 'string' || !section.title.trim()) errors.push(`sections[${i}] needs a "title"`)
    if (!Array.isArray(section?.pages) || section.pages.length === 0) { errors.push(`sections[${i}] needs a non-empty "pages" array`); continue }
    const pages = []
    for (const [j, page] of section.pages.entries()) {
      const where = `sections[${i}].pages[${j}]`
      if (!page || typeof page.slug !== 'string' || !SLUG.test(page.slug)) { errors.push(`${where}: "slug" must be lowercase words joined by hyphens`); continue }
      if (seen.has(page.slug)) { errors.push(`${where}: duplicate slug "${page.slug}"`); continue }
      // Website routes under /docs that a page would shadow (src/app/docs/search/page.tsx).
      if (RESERVED_SLUGS.has(page.slug)) { errors.push(`${where}: slug "${page.slug}" is reserved by the website (/docs/${page.slug})`); continue }
      seen.add(page.slug)
      if (typeof page.title !== 'string' || !page.title.trim()) errors.push(`${where} (${page.slug}): "title" is required`)
      if (page.description !== undefined && typeof page.description !== 'string') errors.push(`${where} (${page.slug}): "description" must be a string`)
      const markdown = await readPage(page.slug)
      if (markdown === null) { missing.push(page.slug); continue }
      const heading = firstHeading(markdown)
      if (heading === null) errors.push(`${page.slug}.md: no "# " heading found`)
      else if (heading !== page.title) errors.push(`${page.slug}.md: first heading "${heading}" does not match manifest title "${page.title}"`)
      for (const image of imageReferences(markdown)) if (!(await imageExists(image))) errors.push(`${page.slug}.md: image "${image}" does not exist in docs/site`)
      pages.push({ slug: page.slug, title: page.title, ...(page.description ? { description: page.description } : {}) })
    }
    if (pages.length) sections.push({ title: section.title, pages })
  }
  return { manifest: { sections }, missing, errors }
}

/** ISO date of the last commit that touched a file, or null outside a git checkout (or for untracked files). */
export function lastCommitDate(root, path) {
  try {
    const date = execFileSync('git', ['log', '-1', '--format=%cI', '--', path], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return date || null
  } catch {
    return null
  }
}

async function readOptional(path) {
  try { return await readFile(path, 'utf8') } catch (error) { if (error?.code === 'ENOENT') return null; throw error }
}

async function imagesIn(dir, base = dir) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch (error) { if (error?.code === 'ENOENT') return []; throw error }
  const found = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...await imagesIn(path, base))
    else if (entry.isFile() && IMAGE.test(entry.name)) found.push(relative(base, path))
  }
  return found
}

/** Validates and copies; throws an Error listing every problem. Returns a short summary. */
export async function syncDocs({ root, out, allowMissing = false }) {
  const site = join(root, 'docs', 'site')
  const rawManifest = await readOptional(join(site, 'manifest.json'))
  if (rawManifest === null) throw new Error(`Missing ${join(site, 'manifest.json')}`)
  let parsed
  try { parsed = JSON.parse(rawManifest) } catch (error) { throw new Error(`docs/site/manifest.json is not valid JSON: ${error.message}`, { cause: error }) }
  const exists = path => readFile(join(site, path)).then(() => true, () => false)
  const { manifest, missing, errors } = await validateManifest(parsed, slug => readOptional(join(site, `${slug}.md`)), image => exists(image))
  if (missing.length && !allowMissing) errors.push(...missing.map(slug => `docs/site/${slug}.md is listed in manifest.json but does not exist`))
  if (errors.length) throw new Error(`Documentation sync failed:\n  - ${errors.join('\n  - ')}`)
  const notes = await readOptional(join(root, 'resources', 'release-notes.json'))
  if (notes === null) throw new Error('Missing resources/release-notes.json')
  JSON.parse(notes)
  const notice = await readOptional(join(root, 'NOTICE'))
  if (notice === null) throw new Error('Missing NOTICE')

  const content = join(out, 'content'), docs = join(content, 'docs'), assets = join(out, 'public', 'docs-assets')
  await rm(content, { recursive: true, force: true })
  await rm(assets, { recursive: true, force: true })
  await mkdir(docs, { recursive: true })
  for (const page of manifest.sections.flatMap(s => s.pages)) await copyFile(join(site, `${page.slug}.md`), join(docs, `${page.slug}.md`))
  const images = await imagesIn(site)
  const sizes = {}
  for (const image of images) {
    await mkdir(dirname(join(assets, image)), { recursive: true })
    await copyFile(join(site, image), join(assets, image))
    const size = imageSize(await readFile(join(site, image)))
    if (size) sizes[image.split(/[\\/]/).join('/')] = size
  }
  await writeFile(join(content, 'images.json'), `${JSON.stringify(sizes, null, 2)}\n`)
  // For the sitemap: when each page last changed (git history; CI checks out full history) and which images it shows.
  for (const page of manifest.sections.flatMap(s => s.pages)) {
    const lastModified = lastCommitDate(root, join('docs', 'site', `${page.slug}.md`))
    if (lastModified) page.lastModified = lastModified
    const images = imageReferences(await readFile(join(site, `${page.slug}.md`), 'utf8'))
    if (images.length) page.images = [...new Set(images)]
  }
  await writeFile(join(content, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(content, 'release-notes.json'), notes)
  await writeFile(join(content, 'NOTICE.txt'), notice)
  return { pages: manifest.sections.reduce((n, s) => n + s.pages.length, 0), missing, images: images.length }
}

function argument(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(argument('--root') ?? fileURLToPath(new URL('../', import.meta.url)))
  const out = resolve(argument('--out') ?? join(root, 'app', 'webapp'))
  const allowMissing = process.argv.includes('--allow-missing')
  try {
    const result = await syncDocs({ root, out, allowMissing })
    if (result.missing.length) console.warn(`Warning (--allow-missing): ${result.missing.length} page(s) not written yet and left out: ${result.missing.join(', ')}`)
    process.stdout.write(`Website docs synchronized: ${result.pages} page(s), ${result.images} image(s), release notes and NOTICE.\n`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { allPages, findPage, loadDoc, neighbours, parseManifest } from '../src/lib/docs.ts'
import type { DocsManifest } from '../src/lib/docs.ts'

const script = resolve(import.meta.dirname, '../../../scripts/sync-docs.mjs')
let work: string
before(async () => { work = await mkdtemp(join(tmpdir(), 'proxy-docs-test-')) })
after(async () => { await rm(work, { recursive: true, force: true }) })

const manifest = { sections: [
  { title: 'Getting started', pages: [{ slug: 'introduction', title: 'Introduction', description: 'Start here.' }, { slug: 'install', title: 'Install' }] },
  { title: 'Reference', pages: [{ slug: 'faq', title: 'FAQ' }] },
] }

async function fixtureRepo(name: string, pages: Record<string, string>, data: unknown = manifest) {
  const root = join(work, name), out = join(root, 'web')
  await mkdir(join(root, 'docs', 'site', 'images'), { recursive: true }); await mkdir(join(root, 'resources'), { recursive: true }); await mkdir(out, { recursive: true })
  await writeFile(join(root, 'docs', 'site', 'manifest.json'), JSON.stringify(data))
  for (const [slug, body] of Object.entries(pages)) await writeFile(join(root, 'docs', 'site', `${slug}.md`), body)
  await writeFile(join(root, 'docs', 'site', 'images', 'shot.png'), 'png')
  await writeFile(join(root, 'resources', 'release-notes.json'), JSON.stringify({ '1.0.0': ['First'] }))
  await writeFile(join(root, 'NOTICE'), 'Proxy QA Browser\nCopyright 2026 Ubaid Bin Waris\n')
  return { root, out }
}
function sync(root: string, out: string, ...flags: string[]) {
  return spawnSync(process.execPath, [script, '--root', root, '--out', out, ...flags], { encoding: 'utf8' })
}

test('sync copies docs, images, release notes and NOTICE when the manifest is valid', async () => {
  const { root, out } = await fixtureRepo('valid', { introduction: '# Introduction\n\nHello.', install: '```md\n# Not a heading\n```\n\n# Install\n', faq: '# FAQ\n' })
  const result = sync(root, out)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(await readFile(join(out, 'content', 'manifest.json'), 'utf8')), manifest)
  assert.equal(await readFile(join(out, 'content', 'docs', 'faq.md'), 'utf8'), '# FAQ\n')
  assert.equal(await readFile(join(out, 'public', 'docs-assets', 'images', 'shot.png'), 'utf8'), 'png')
  assert.ok((await readFile(join(out, 'content', 'NOTICE.txt'), 'utf8')).includes('Ubaid Bin Waris'))
  assert.deepEqual(JSON.parse(await readFile(join(out, 'content', 'release-notes.json'), 'utf8')), { '1.0.0': ['First'] })
})

test('a missing page fails the sync unless --allow-missing is given', async () => {
  const { root, out } = await fixtureRepo('missing', { introduction: '# Introduction\n', faq: '# FAQ\n' })
  const strict = sync(root, out)
  assert.equal(strict.status, 1)
  assert.match(strict.stderr, /docs\/site\/install\.md is listed in manifest\.json but does not exist/)
  const lenient = sync(root, out, '--allow-missing')
  assert.equal(lenient.status, 0, lenient.stderr)
  assert.match(lenient.stderr, /install/)
  const written = JSON.parse(await readFile(join(out, 'content', 'manifest.json'), 'utf8')) as DocsManifest
  assert.deepEqual(allPages(written).map(p => p.slug), ['introduction', 'faq'])
})

test('duplicate slugs, bad slugs and mismatched titles fail even with --allow-missing', async () => {
  const bad = { sections: [{ title: 'A', pages: [{ slug: 'introduction', title: 'Introduction' }, { slug: 'introduction', title: 'Again' }, { slug: 'Bad Slug', title: 'Bad' }, { slug: 'install', title: 'Install' }] }] }
  const { root, out } = await fixtureRepo('invalid', { introduction: '# Introduction\n', install: '# Installing\n' }, bad)
  const result = sync(root, out, '--allow-missing')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /duplicate slug "introduction"/)
  assert.match(result.stderr, /"slug" must be lowercase/)
  assert.match(result.stderr, /install\.md: first heading "Installing" does not match manifest title "Install"/)
})

test('navigation helpers give reading order across sections and handle unknown slugs', () => {
  const m = parseManifest(JSON.stringify(manifest))
  assert.deepEqual(neighbours(m, 'introduction'), { previous: null, next: { slug: 'install', title: 'Install' } })
  assert.deepEqual(neighbours(m, 'install'), { previous: { slug: 'introduction', title: 'Introduction', description: 'Start here.' }, next: { slug: 'faq', title: 'FAQ' } })
  assert.deepEqual(neighbours(m, 'faq'), { previous: { slug: 'install', title: 'Install' }, next: null })
  assert.deepEqual(neighbours(m, 'nope'), { previous: null, next: null })
  assert.equal(findPage(m, 'nope'), null)
  assert.equal(findPage(m, 'faq')?.section, 'Reference')
})

test('loadDoc renders a synced page and returns null for unknown or malformed slugs', async () => {
  const { root, out } = await fixtureRepo('render', { introduction: '# Introduction\n\nSee [install](install.md).\n\n## Next', install: '# Install\n', faq: '# FAQ\n' })
  assert.equal(sync(root, out).status, 0)
  const previous = process.env.CONTENT_DIR; process.env.CONTENT_DIR = join(out, 'content')
  try {
    const doc = await loadDoc('introduction')
    assert.ok(doc)
    assert.equal(doc.title, 'Introduction')
    assert.ok(doc.html.includes('<a href="/docs/install">install</a>'))
    assert.deepEqual(doc.headings.map(h => h.id), ['next'])
    assert.equal(await loadDoc('unknown'), null)
    assert.equal(await loadDoc('../manifest'), null)
  } finally { if (previous === undefined) delete process.env.CONTENT_DIR; else process.env.CONTENT_DIR = previous }
})

test('a docs page cannot take a slug reserved by a website route', async () => {
  // The script is plain JavaScript without type declarations: import it by URL with an explicit shape.
  const { validateManifest } = (await import(pathToFileURL(script).href)) as {
    validateManifest(raw: unknown, readPage: (slug: string) => Promise<string | null>): Promise<{ errors: string[] }>
  }
  const manifest = { sections: [{ title: 'S', pages: [{ slug: 'search', title: 'Search' }] }] }
  const result = await validateManifest(manifest, async () => '# Search\n')
  assert.ok(result.errors.some((message: string) => /reserved by the website/.test(message)), JSON.stringify(result))
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { NextRequest } from 'next/server'
import { metadata as notFound } from '../src/app/not-found.tsx'
import robots from '../src/app/robots.ts'
import { metadata as privacy } from '../src/app/privacy/page.tsx'
import { metadata as security } from '../src/app/security/page.tsx'
import { renderMarkdown } from '../src/lib/markdown.ts'
import { downloadResponse } from '../src/lib/releases.ts'
import { SITE_URL } from '../src/lib/site.ts'
import { USE_CASES } from '../src/lib/use-cases.ts'
import { proxy } from '../src/proxy.ts'

const app = resolve(import.meta.dirname, '../src/app')

/** Runs `body` with the given environment variables, restoring the previous values afterwards (tests share one process). */
async function withEnv(values: Record<string, string>, body: () => Promise<void>) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  Object.assign(process.env, values)
  try { await body() } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
}

test('robots.txt allows the site, keeps crawlers out of /api/ and lists the sitemap', () => {
  const result = robots()
  assert.deepEqual(result.rules, [{ userAgent: '*', allow: '/', disallow: ['/api/'] }])
  assert.equal(result.sitemap, `${SITE_URL}/sitemap.xml`)
  assert.equal(result.host, undefined, 'host is not a standard robots.txt directive')
  assert.ok(!JSON.stringify(result.rules).includes('/admin'), '/admin must stay crawlable so its noindex meta is seen')
})

test('release downloads are served with X-Robots-Tag: noindex', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proxy-seo-release-')), keys = generateKeyPairSync('ed25519'), version = '2.0.0'
  try {
    const assets = (['win32', 'linux'] as const).map(platform => { const bytes = Buffer.from(`seo-${platform}`); return { platform, arch: 'x64', fileName: `Proxy-QA-Browser-${version}-${platform === 'win32' ? 'Windows-x64.exe' : 'x86_64.AppImage'}`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), bytes } })
    const data = { format: 1, appId: 'com.ubaidbinwaris.proxy-qa-browser', version, releasedAt: '2026-10-10T10:00:00.000Z', notes: ['Test release'], assets: assets.map(({ bytes: _bytes, ...a }) => a) }
    const online = { version, releasedAt: data.releasedAt, notes: data.notes, assets: data.assets.map(a => ({ ...a, url: `${SITE_URL}/api/download/${version}/${a.fileName}` })) }
    const envelope = (payload: unknown) => { const value = JSON.stringify(payload); return JSON.stringify({ payload: value, signature: sign(null, Buffer.from(value), keys.privateKey).toString('base64') }) }
    const folder = join(root, 'releases', version); await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'Proxy-QA-Browser-Update.json'), envelope(data)); await writeFile(join(folder, 'update.json'), envelope(online))
    for (const a of assets) await writeFile(join(folder, a.fileName), a.bytes)
    await writeFile(join(root, 'public.pem'), keys.publicKey.export({ type: 'spki', format: 'pem' }))
    await withEnv({ RELEASE_ROOT: root, RELEASE_PUBLIC_KEY_FILE: join(root, 'public.pem'), SITE_URL }, async () => {
      const name = assets[0]!.fileName, url = `${SITE_URL}/api/download/${version}/${name}`
      const full = await downloadResponse(new Request(url), version, name); assert.equal(full.headers.get('x-robots-tag'), 'noindex'); assert.equal(await full.text(), 'seo-win32')
      const partial = await downloadResponse(new Request(url, { headers: { range: 'bytes=0-2' } }), version, name); assert.equal(partial.status, 206); assert.equal(partial.headers.get('x-robots-tag'), 'noindex'); await partial.text()
      const head = await downloadResponse(new Request(url), version, name, true); assert.equal(head.headers.get('x-robots-tag'), 'noindex')
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('the root layout sets no canonical, so pages without their own (404s, /admin) do not point at the home page', async () => {
  const layout = await readFile(join(app, 'layout.tsx'), 'utf8'), home = await readFile(join(app, 'page.tsx'), 'utf8')
  assert.ok(!/alternates|canonical/.test(layout), 'layout.tsx must not set alternates')
  assert.ok(!/icon: '\/favicon\.ico'/.test(layout), 'app/favicon.ico is linked automatically')
  assert.ok(layout.includes("locale: 'en_US'"))
  assert.ok(home.includes("alternates: { canonical: '/' }"), 'the home page sets its own canonical')
})

test('the not-found page leaves the noindex robots tag to Next.js (one tag, not two) and inherits no index, follow', () => {
  assert.equal(notFound.robots, null)
})

test('heading anchors add no "#" text to the heading', () => {
  const { html } = renderMarkdown('# Title\n\n## Proxy credentials\n\n### Step 2: Run `qa`', { stripTitle: true })
  assert.ok(html.includes('<h2 id="proxy-credentials">Proxy credentials<a class="heading-anchor" href="#proxy-credentials" aria-label="Link to section: Proxy credentials"></a></h2>'), html)
  assert.ok(!/>#</.test(html), html)
  const headingText = [...html.matchAll(/<h[2-6][^>]*>(.*?)<\/h[2-6]>/g)].map(m => m[1]!.replace(/<[^>]*>/g, ''))
  assert.deepEqual(headingText, ['Proxy credentials', 'Step 2: Run qa'])
})

test('privacy and security meta descriptions are 120 to 158 characters', () => {
  for (const [name, metadata] of [['privacy', privacy], ['security', security]] as const) {
    const description = String(metadata.description)
    assert.ok(description.length >= 120 && description.length <= 158, `${name}: ${description.length} characters`)
    assert.equal(metadata.openGraph?.description, description)
  }
})

test('the proxy rewrites unknown docs and use-case slugs to the not-found route and keeps the CSP nonce', async () => {
  const content = await mkdtemp(join(tmpdir(), 'proxy-seo-content-'))
  try {
    await writeFile(join(content, 'manifest.json'), JSON.stringify({ sections: [{ title: 'Getting started', pages: [{ slug: 'introduction', title: 'Introduction' }, { slug: 'install', title: 'Install' }] }] }))
    await withEnv({ CONTENT_DIR: content }, async () => {
      const run = async (path: string) => { const response = await proxy(new NextRequest(`${SITE_URL}${path}`)); return { rewrite: response.headers.get('x-middleware-rewrite'), csp: response.headers.get('content-security-policy') ?? '', cache: response.headers.get('cache-control') } }
      for (const path of ['/docs/nope', '/docs/Introduction', '/use-cases/nope']) {
        const { rewrite, csp, cache } = await run(path)
        assert.equal(rewrite, `${SITE_URL}/404`, path); assert.match(csp, /script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/, path); assert.equal(cache, 'private, no-store')
      }
      for (const path of ['/', '/docs', '/docs/introduction', '/docs/install', '/docs/search', '/use-cases', `/use-cases/${USE_CASES[0]!.slug}`, '/privacy', '/nope']) {
        const { rewrite, csp } = await run(path)
        assert.equal(rewrite, null, path); assert.match(csp, /'nonce-/, path)
      }
    })
    // Without synced docs the docs page decides (and fails loudly), rather than every docs URL becoming a 404.
    await withEnv({ CONTENT_DIR: join(content, 'missing') }, async () => { assert.equal((await proxy(new NextRequest(`${SITE_URL}/docs/install`))).headers.get('x-middleware-rewrite'), null) })
  } finally { await rm(content, { recursive: true, force: true }) }
})

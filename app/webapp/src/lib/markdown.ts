import { posix } from 'node:path'
import { Marked, Renderer } from 'marked'
import type { Tokens } from 'marked'
import { REPO_BLOB_URL } from './site.ts'

export type Heading = { depth: number; text: string; id: string }
export type RenderedMarkdown = { html: string; headings: Heading[] }
export type RenderOptions = {
  /** Slugs of published docs pages; relative links to `<slug>.md` become `/docs/<slug>`. */
  docSlugs?: ReadonlySet<string>
  /** Repository directory the Markdown file lives in, for resolving relative links (default `docs/site`). */
  sourceDir?: string
  /** Drop the first level-1 heading (the page renders its own title). */
  stripTitle?: boolean
  /** Width and height of docs images by path relative to docs/site (content/images.json), for layout without shifts. */
  images?: Readonly<Record<string, ImageSize>>
}
export type ImageSize = { width: number; height: number }

/** Width of the smaller copy of a docs screenshot (`<name>-720.webp`), offered in srcset when it exists. */
export const DOC_IMAGE_SMALL_WIDTH = 720

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, c => ENTITIES[c]!) }
function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|#39|nbsp);/gi, (_, e: string) => {
    const lower = e.toLowerCase()
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16))
    if (lower.startsWith('#')) return String.fromCodePoint(Number(lower.slice(1)))
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ' } as Record<string, string>)[lower] ?? ''
  })
}
function stripTags(html: string): string { return decodeEntities(html.replace(/<[^>]*>/g, '')) }

/** GitHub-style heading ids: lowercase, punctuation removed, spaces to hyphens, duplicates suffixed -1, -2… */
export function createSlugger(): (text: string) => string {
  const occurrences = new Map<string, number>()
  return (text: string) => {
    const base = text.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-') || 'section'
    let id = base
    while (occurrences.has(id)) { const n = occurrences.get(base)! + 1; occurrences.set(base, n); id = `${base}-${n}` }
    occurrences.set(id, 0)
    return id
  }
}

type Target = { href: string; external: boolean } | null

/** Resolves a Markdown link target to a safe URL, or null when it must not be rendered as a link. */
export function resolveHref(raw: string, options: RenderOptions = {}): Target {
  const href = raw.trim()
  if (!href) return null
  if (href.startsWith('#')) return { href, external: false }
  if (/^https?:\/\//i.test(href)) return { href, external: true }
  if (/^mailto:/i.test(href)) return { href, external: false }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return null // javascript:, data:, protocol-relative…
  if (href.startsWith('/')) return { href, external: false }
  const [path = '', hash = ''] = href.split(/(?=#)/, 2)
  const sourceDir = options.sourceDir ?? 'docs/site'
  const resolved = posix.normalize(posix.join(sourceDir, path))
  if (resolved.startsWith('..')) return null
  const page = /^docs\/site\/([a-z0-9-]+)\.md$/.exec(resolved)
  if (page && options.docSlugs?.has(page[1]!)) return { href: `/docs/${page[1]}${hash}`, external: false }
  return { href: `${REPO_BLOB_URL}/${resolved}${hash}`, external: true }
}

/** Path of a docs image relative to docs/site, or null when it is not a local docs image. */
function imagePath(raw: string, options: RenderOptions): string | null {
  const href = raw.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('/')) return null
  const resolved = posix.normalize(posix.join(options.sourceDir ?? 'docs/site', href))
  return resolved.startsWith('docs/site/') ? resolved.slice('docs/site/'.length) : null
}

/** <img> for a docs image: explicit size when known, and a srcset with the 720 px copy when there is one. */
function imageTag(path: string, alt: string, options: RenderOptions): string {
  const size = options.images?.[path]
  const small = path.replace(/\.(webp|png|jpe?g)$/i, `-${DOC_IMAGE_SMALL_WIDTH}.$1`)
  const smallSize = small !== path ? options.images?.[small] : undefined
  const srcset = size && smallSize && smallSize.width < size.width
    ? ` srcset="/docs-assets/${escapeHtml(small)} ${smallSize.width}w, /docs-assets/${escapeHtml(path)} ${size.width}w" sizes="(max-width: 760px) 100vw, 640px"`
    : ''
  const dimensions = size ? ` width="${size.width}" height="${size.height}"` : ''
  return `<img src="/docs-assets/${escapeHtml(path)}" alt="${escapeHtml(alt)}"${dimensions}${srcset} loading="lazy" decoding="async">`
}

/**
 * Renders trusted-but-not-blindly-trusted Markdown to static HTML: raw HTML is shown as text, headings get
 * GitHub-style ids and anchor links, links are restricted to safe schemes, external links get
 * rel="noopener noreferrer", and tables are wrapped for horizontal scrolling. Never emits scripts.
 */
export function renderMarkdown(source: string, options: RenderOptions = {}): RenderedMarkdown {
  const slug = createSlugger(), headings: Heading[] = []
  let titleStripped = !options.stripTitle
  const renderer = new Renderer()
  renderer.html = ({ text }: Tokens.HTML | Tokens.Tag) => escapeHtml(text)
  renderer.heading = function ({ tokens, depth }: Tokens.Heading) {
    if (!titleStripped && depth === 1) { titleStripped = true; return '' }
    const level = depth === 1 ? 2 : depth
    const inner = this.parser.parseInline(tokens), text = stripTags(inner).trim(), id = slug(text)
    headings.push({ depth: level, text, id })
    return `<h${level} id="${escapeHtml(id)}">${inner}<a class="heading-anchor" href="#${escapeHtml(id)}" aria-label="Link to section: ${escapeHtml(text)}">#</a></h${level}>\n`
  }
  renderer.link = function ({ href, title, tokens }: Tokens.Link) {
    const inner = this.parser.parseInline(tokens), target = resolveHref(href, options)
    if (!target) return inner
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
    return target.external
      ? `<a href="${escapeHtml(target.href)}"${titleAttr} rel="noopener noreferrer" class="external">${inner}</a>`
      : `<a href="${escapeHtml(target.href)}"${titleAttr}>${inner}</a>`
  }
  renderer.image = ({ href, title, text }: Tokens.Image) => {
    const path = imagePath(href, options)
    if (!path) {
      const target = resolveHref(href, options)
      return target ? `<a href="${escapeHtml(target.href)}" rel="noopener noreferrer" class="external">${escapeHtml(text || 'Image')}</a>` : escapeHtml(text)
    }
    return imageTag(path, text, options).replace(/>$/, `${title ? ` title="${escapeHtml(title)}"` : ''}>`)
  }
  // An image alone in its paragraph is a figure: the title becomes the caption and the image links to the full size.
  renderer.paragraph = function ({ tokens }: Tokens.Paragraph) {
    const content = tokens.filter(t => !(t.type === 'text' && !t.raw.trim()))
    const only = content.length === 1 && content[0]!.type === 'image' ? content[0] as Tokens.Image : null
    const path = only ? imagePath(only.href, options) : null
    if (!only || !path) return `<p>${this.parser.parseInline(tokens)}</p>\n`
    const caption = only.title ? `<figcaption>${escapeHtml(only.title)}</figcaption>` : ''
    return `<figure class="doc-figure"><a href="/docs-assets/${escapeHtml(path)}" aria-label="Open full-size image: ${escapeHtml(only.text || only.title || 'screenshot')}">${imageTag(path, only.text, options)}</a>${caption}</figure>\n`
  }
  renderer.code = ({ text, lang }: Tokens.Code) => {
    const language = (lang ?? '').match(/^[\w+-]+/)?.[0]
    const label = language ? `<span class="code-lang">${escapeHtml(language)}</span>` : ''
    return `<div class="code-block">${label}<pre tabindex="0"><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${escapeHtml(text.replace(/\n$/, ''))}</code></pre></div>\n`
  }
  renderer.table = function (token: Tokens.Table) { return `<div class="table-wrap" tabindex="0">${Renderer.prototype.table.call(this, token)}</div>\n` }
  const marked = new Marked({ gfm: true, breaks: false, async: false, renderer })
  const html = marked.parse(source.replace(/^\uFEFF/, ''), { async: false }) as string
  return { html, headings }
}

/** Plain text of the first paragraph (used as a fallback meta description). */
export function firstParagraph(source: string): string {
  const token = new Marked().lexer(source).find(t => t.type === 'paragraph') as Tokens.Paragraph | undefined
  return token ? stripTags(new Marked().parseInline(token.text, { async: false }) as string).replace(/\s+/g, ' ').trim() : ''
}

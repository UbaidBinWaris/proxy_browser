import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { DocsNav } from '@/components/DocsNav'
import { JsonLd } from '@/components/JsonLd'
import { Prose, Toc } from '@/components/Prose'
import { allPages, loadDoc, loadManifest, longDate, neighbours } from '@/lib/docs'
import { breadcrumbList, docArticle, pageMetadata } from '@/lib/seo'
import { DOCS_EDIT_URL } from '@/lib/site'

type Props = { params: Promise<{ slug: string }> }

export async function generateStaticParams(): Promise<{ slug: string }[]> {
  return allPages(await loadManifest()).map(page => ({ slug: page.slug }))
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const doc = await loadDoc((await params).slug)
  // Resolving the 404 here (before streaming starts) lets the not-found page render on the server.
  if (!doc) notFound()
  return pageMetadata({
    // The search-result title can be more descriptive than the on-page heading (docs/site/manifest.json "seoTitle").
    title: doc.seoTitle ?? doc.title,
    description: doc.description,
    path: `/docs/${doc.slug}`,
    image: { url: `/og/${doc.slug}`, width: 1200, height: 630, alt: `${doc.title}: Proxy QA Browser documentation` },
    article: { section: doc.section, ...(doc.datePublished ? { publishedTime: doc.datePublished } : {}), ...(doc.lastModified ? { modifiedTime: doc.lastModified } : {}) },
  })
}

export default async function DocPage({ params }: Props) {
  const { slug } = await params
  const doc = await loadDoc(slug)
  if (!doc) notFound()
  const manifest = await loadManifest(), { previous, next } = neighbours(manifest, slug)
  return <div className="docs-shell">
    <JsonLd data={docArticle(doc)} />
    <JsonLd data={breadcrumbList([{ name: 'Home', path: '/' }, { name: 'Documentation', path: '/docs' }, { name: doc.title, path: `/docs/${slug}` }])} />
    <DocsNav manifest={manifest} current={slug} />
    <article className="docs-article">
      <header className="page-header">
        <span className="eyebrow">{doc.section.toUpperCase()}</span>
        <h1>{doc.title}</h1>
        {doc.description ? <p className="page-lead">{doc.description}</p> : null}
        {/* The same value as the structured data's dateModified. */}
        {doc.lastModified ? <p className="doc-updated">Last updated <time dateTime={doc.lastModified}>{longDate(doc.lastModified)}</time></p> : null}
      </header>
      <Toc headings={doc.headings} className="toc-inline" />
      <Prose html={doc.html} />
      <footer className="docs-footer">
        <a className="edit-link" href={`${DOCS_EDIT_URL}/${slug}.md`} rel="noopener noreferrer">Edit this page on GitHub <span aria-hidden="true">↗</span></a>
        {previous || next ? <nav className="pager" aria-label="Previous and next pages">
          {previous ? <a className="pager-previous" href={`/docs/${previous.slug}`} rel="prev"><small>← Previous</small><strong>{previous.title}</strong></a> : null}
          {next ? <a className="pager-next" href={`/docs/${next.slug}`} rel="next"><small>Next →</small><strong>{next.title}</strong></a> : null}
        </nav> : null}
      </footer>
    </article>
    <Toc headings={doc.headings} className="toc-side" />
  </div>
}

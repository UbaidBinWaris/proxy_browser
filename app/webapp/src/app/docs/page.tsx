import type { Metadata } from 'next'
import { loadManifest } from '@/lib/docs'
import { pageMetadata } from '@/lib/seo'
import { REPO_URL } from '@/lib/site'

export const metadata: Metadata = pageMetadata({ title: 'Documentation', description: 'Install, configure and use Proxy QA Browser: browsers, proxy providers, locations, QA automation, the CI runner, the MCP server and the developer guide.', path: '/docs' })

export default async function DocsIndex() {
  const manifest = await loadManifest()
  return <>
    <header className="page-header">
      <span className="eyebrow">DOCUMENTATION</span>
      <h1>Learn Proxy QA Browser.</h1>
      <p className="page-lead">Everything from the first download to scenario matrices in CI. New here? Start with the <a className="quiet-link" href={`/docs/${manifest.sections[0]?.pages[0]?.slug ?? ''}`}>{manifest.sections[0]?.pages[0]?.title ?? 'introduction'}</a>.</p>
    </header>
    {manifest.sections.length
      ? <div className="docs-index">{manifest.sections.map((section, i) => <section className="docs-card" key={section.title} aria-labelledby={`section-${i}`}>
          <h2 id={`section-${i}`}>{section.title}</h2>
          <ul>{section.pages.map(page => <li key={page.slug}><a href={`/docs/${page.slug}`}>{page.title}</a>{page.description ? <p>{page.description}</p> : null}</li>)}</ul>
        </section>)}</div>
      : <div className="docs-empty"><p>The documentation is being written. Until it is published, read the <a className="quiet-link" href={`${REPO_URL}#readme`} rel="noopener noreferrer">README on GitHub</a>.</p></div>}
  </>
}

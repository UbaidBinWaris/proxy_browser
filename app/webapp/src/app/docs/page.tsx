import type { Metadata } from 'next'
import { DocsSearchForm } from '@/components/DocsSearchForm'
import { JsonLd } from '@/components/JsonLd'
import { loadManifest } from '@/lib/docs'
import { pageBreadcrumbs, pageMetadata } from '@/lib/seo'
import { REPO_URL } from '@/lib/site'
import { USE_CASES_PATH, findUseCase, useCasePath } from '@/lib/use-cases'

export const metadata: Metadata = pageMetadata({ title: 'Documentation and setup guides', description: 'Guides for Proxy QA Browser: install, launch through location-checked exit IPs, emulate devices, record QA scenarios, run checks in CI and use the MCP server.', path: '/docs' })

/** Task-based entry points in the lead, one link per use-case page; a page that is not published yet is left out. */
const TASK_LINKS = [
  { slug: 'location-testing', label: 'test from different locations' },
  { slug: 'tcpa-consent-testing', label: 'TCPA consent testing' },
  { slug: 'device-testing', label: 'device testing' },
]

export default async function DocsIndex() {
  const manifest = await loadManifest()
  const tasks = TASK_LINKS.filter(link => findUseCase(link.slug))
  return <>
    <JsonLd data={pageBreadcrumbs('Documentation', '/docs')} />
    <header className="page-header">
      <span className="eyebrow">DOCUMENTATION</span>
      <h1>Proxy QA Browser documentation</h1>
      <p className="page-lead">Everything from the first download to scenario matrices in CI. New here? Start with the <a className="faq-link" href={`/docs/${manifest.sections[0]?.pages[0]?.slug ?? ''}`}>{manifest.sections[0]?.pages[0]?.title ?? 'introduction'}</a>, or pick a task: {tasks.map(link => <span key={link.slug}><a className="faq-link" href={useCasePath(link.slug)}>{link.label}</a>, </span>)}or <a className="faq-link" href={USE_CASES_PATH}>see all use cases</a>.</p>
      {manifest.sections.length ? <DocsSearchForm id="docs-search-landing" variant="large" /> : null}
    </header>
    {manifest.sections.length
      ? <div className="docs-index">{manifest.sections.map((section, i) => <section className="docs-card" key={section.title} aria-labelledby={`section-${i}`}>
          <h2 id={`section-${i}`}>{section.title}</h2>
          <ul>{section.pages.map(page => <li key={page.slug}><a href={`/docs/${page.slug}`}>{page.title}</a>{page.description ? <p>{page.description}</p> : null}</li>)}</ul>
        </section>)}</div>
      : <div className="docs-empty"><p>The documentation is being written. Until it is published, read the <a className="quiet-link" href={`${REPO_URL}#readme`} rel="noopener noreferrer">README on GitHub</a>.</p></div>}
  </>
}

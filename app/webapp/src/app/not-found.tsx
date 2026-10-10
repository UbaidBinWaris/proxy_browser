import type { Metadata } from 'next'
import { DocsSearchForm } from '@/components/DocsSearchForm'

export const metadata: Metadata = { title: 'Page not found', robots: { index: false } }

export default function NotFound() {
  return <section className="not-found">
    <span className="eyebrow">404</span>
    <h1>This page could not be found.</h1>
    <p className="page-lead">The link may be out of date, or the page may have moved. Search the documentation, browse it, or head back to the download page.</p>
    <DocsSearchForm id="not-found-search" variant="large" />
    <div className="hero-actions"><a className="button" href="/docs">Browse the docs <span aria-hidden="true">→</span></a><a className="quiet-link" href="/">Back to home</a></div>
  </section>
}

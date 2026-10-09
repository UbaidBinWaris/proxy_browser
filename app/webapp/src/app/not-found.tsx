import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Page not found', robots: { index: false } }

export default function NotFound() {
  return <section className="not-found">
    <span className="eyebrow">404</span>
    <h1>This page could not be found.</h1>
    <p className="page-lead">The link may be out of date, or the page may have moved. Try the documentation or head back to the download page.</p>
    <div className="hero-actions"><a className="button primary" href="/docs">Browse the docs <span aria-hidden="true">→</span></a><a className="quiet-link" href="/">Back to home</a></div>
  </section>
}

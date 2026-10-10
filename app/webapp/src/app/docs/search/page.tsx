import type { Metadata } from 'next'
import { DocsNav } from '@/components/DocsNav'
import { DocsSearchForm } from '@/components/DocsSearchForm'
import { loadManifest } from '@/lib/docs'
import { loadSearchIndex, MAX_QUERY_LENGTH, MAX_TERMS, MIN_QUERY_LENGTH, parseQuery, popularPages, search } from '@/lib/docs-search'
import type { PopularPage, SearchResult } from '@/lib/docs-search'

type Props = { searchParams: Promise<{ q?: string | string[] }> }

const EXAMPLES = ['sticky sessions', 'open anyway', 'QA_PROVIDER', 'PROXY_AUTH_FAILED']
const searchHref = (q: string) => `/docs/search?q=${encodeURIComponent(q)}`

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const { text } = parseQuery((await searchParams).q)
  return {
    title: text ? `Search: ${text}` : 'Search the docs',
    description: 'Search the Proxy QA Browser documentation.',
    alternates: { canonical: '/docs/search' },
    // Result pages are endless and thin: keep them out of search engines (and out of the sitemap).
    robots: { index: false, follow: true },
  }
}

function PopularPages({ pages }: { pages: PopularPage[] }) {
  if (!pages.length) return null
  return <>
    <h3 className="docs-search-subtitle">Popular pages</h3>
    <ul className="docs-search-popular">{pages.map(page => <li key={page.slug}><a href={`/docs/${page.slug}`}>{page.title}{page.description ? <small>{page.description}</small> : null}</a></li>)}</ul>
  </>
}

function Examples() {
  return <p className="docs-search-examples">Search by topic, setting, error code or variable name, for example {EXAMPLES.map((q, i) => <span key={q}>
    {i ? (i === EXAMPLES.length - 1 ? ' or ' : ', ') : null}<a href={searchHref(q)}>{q}</a>
  </span>)}.</p>
}

function Hit({ result }: { result: SearchResult }) {
  return <li>
    <h2><a href={result.href}>
      {result.sectionTitle ? <>{result.pageTitle}<span className="docs-search-sep" aria-hidden="true">›</span><span className="visually-hidden">, section: </span>{result.sectionTitle}</> : result.pageTitle}
    </a></h2>
    <p className="docs-search-path">{result.section} · {result.href}</p>
    {/* snippetHtml is escaped text with <mark> around matches (see highlight in docs-search.ts). */}
    {result.snippetHtml ? <p className="docs-search-snippet" dangerouslySetInnerHTML={{ __html: result.snippetHtml }} /> : null}
  </li>
}

export default async function DocsSearchPage({ searchParams }: Props) {
  const [{ q }, index, manifest] = await Promise.all([searchParams, loadSearchIndex(), loadManifest()])
  const { query, results, total, suggestions } = search(index, q)
  const popular = popularPages(manifest)
  const resultWord = total === 1 ? 'result' : 'results'

  return <div className="docs-shell">
    <DocsNav manifest={manifest} search={false} />
    <div className="docs-article docs-search-page">
      <header className="page-header">
        <span className="eyebrow">DOCUMENTATION</span>
        <h1>Search the docs</h1>
        <DocsSearchForm id="docs-search-page" variant="large" defaultValue={query.text} />
        {query.shortened ? <p className="docs-search-notice">Your search was shortened to the first {MAX_QUERY_LENGTH} characters.</p> : null}
        {query.termsDropped ? <p className="docs-search-notice">Only the first {MAX_TERMS} words were used.</p> : null}
        {query.status === 'ok' && results.length
          ? <p className="docs-search-summary" id="docs-search-summary">{total} {resultWord} for “<strong>{query.text}</strong>”{total > results.length ? `, showing the best ${results.length}` : ''}</p>
          : null}
      </header>

      {query.status !== 'ok'
        ? <section className="docs-search-empty" aria-labelledby="docs-search-empty-title">
            <h2 id="docs-search-empty-title">{query.status === 'too-short' ? `Type at least ${MIN_QUERY_LENGTH} letters or digits` : 'What are you looking for?'}</h2>
            <Examples />
            <PopularPages pages={popular} />
          </section>
        : results.length
          ? <ol className="docs-search-results" aria-labelledby="docs-search-summary">{results.map(result => <Hit key={result.slug} result={result} />)}</ol>
          : <section className="docs-search-empty" aria-labelledby="docs-search-empty-title">
              <h2 id="docs-search-empty-title">No results for “{query.text}”</h2>
              <ul className="docs-search-tips">
                <li>Check the spelling, or use fewer or more general words. Every word must appear on the page.</li>
                <li>Search for the exact name of a setting, error code or environment variable.</li>
              </ul>
              {suggestions.length
                ? <p className="docs-search-suggestions">Search for one word instead: {suggestions.map((term, i) => <span key={term}>{i ? ', ' : null}<a href={searchHref(term)}>{term}</a></span>)}.</p>
                : null}
              <PopularPages pages={popular} />
              <p className="docs-search-browse"><a className="quiet-link" href="/docs">Browse all documentation <span aria-hidden="true">→</span></a></p>
            </section>}
    </div>
  </div>
}

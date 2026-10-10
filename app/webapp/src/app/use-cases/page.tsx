import type { Metadata } from 'next'
import { JsonLd } from '@/components/JsonLd'
import { screenshotSrcSet } from '@/lib/home'
import { breadcrumbList, pageMetadata } from '@/lib/seo'
import { SITE_URL } from '@/lib/site'
import { USE_CASES, USE_CASES_PATH, useCasePath } from '@/lib/use-cases'

export const metadata: Metadata = pageMetadata({ title: 'Use cases: test your own sites and forms', description: 'Guides to testing your own sites and forms: location and geo-blocking tests, TCPA consent checks, device and cross-browser testing, and test recording.', path: USE_CASES_PATH })

export default function UseCasesIndex() {
  const itemList = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: USE_CASES.map((useCase, i) => ({ '@type': 'ListItem', position: i + 1, name: useCase.navLabel, url: `${SITE_URL}${useCasePath(useCase.slug)}` })),
  }
  return <>
    <JsonLd data={breadcrumbList([{ name: 'Home', path: '/' }, { name: 'Use cases', path: USE_CASES_PATH }])} />
    <JsonLd data={itemList} />
    <header className="page-header">
      <span className="eyebrow">USE CASES</span>
      <h1>What you can test with Proxy QA Browser.</h1>
      <p className="page-lead">Guides for testing sites and forms you own or are contracted to test: what the app checks, how to set it up and the evidence each run records.</p>
    </header>
    <ul className="use-case-index">{USE_CASES.map(useCase => <li key={useCase.slug} className="use-case-card">
      <img src={useCase.screenshot.src} srcSet={screenshotSrcSet(useCase.screenshot)} sizes="(max-width: 760px) 100vw, 50vw" width={useCase.screenshot.width} height={useCase.screenshot.height} alt="" loading="lazy" decoding="async" />
      <span className="eyebrow">{useCase.eyebrow}</span>
      <h2><a href={useCasePath(useCase.slug)}>{useCase.navLabel}</a></h2>
      <p>{useCase.description}</p>
      <span className="quiet-link" aria-hidden="true">Read the guide <span>→</span></span>
    </li>)}</ul>
  </>
}

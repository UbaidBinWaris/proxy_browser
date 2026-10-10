import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { JsonLd } from '@/components/JsonLd'
import { findPage, loadManifest } from '@/lib/docs'
import { screenshotSrcSet } from '@/lib/home'
import { DEFAULT_SOCIAL_IMAGE, breadcrumbList, faqPage, pageMetadata, useCaseWebPage } from '@/lib/seo'
import { REPO_URL, SITE_NAME } from '@/lib/site'
import { USE_CASES, USE_CASES_PATH, findUseCase, inlineParts, structuredFaqs, useCaseImagePath, useCasePath } from '@/lib/use-cases'

type Props = { params: Promise<{ slug: string }> }

export function generateStaticParams(): { slug: string }[] {
  return USE_CASES.map(useCase => ({ slug: useCase.slug }))
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const useCase = findUseCase((await params).slug)
  // Resolving the 404 here (before streaming starts) lets the not-found page render on the server.
  if (!useCase) notFound()
  return pageMetadata({
    title: useCase.title,
    description: useCase.description,
    path: useCasePath(useCase.slug),
    image: { ...DEFAULT_SOCIAL_IMAGE, url: useCaseImagePath(useCase.slug), alt: `${SITE_NAME} use case: ${useCase.title}` },
  })
}

const docHref = (slug: string) => `/docs/${slug}`

/** Text with `[anchor](/path)` links (see src/lib/use-cases.ts) rendered as links. */
function Inline({ text }: Readonly<{ text: string }>) {
  return <>{inlineParts(text).map((part, i) => typeof part === 'string' ? part : <a key={i} href={part.href}>{part.label}</a>)}</>
}

export default async function UseCasePage({ params }: Props) {
  const useCase = findUseCase((await params).slug)
  if (!useCase) notFound()
  // Only adds the docs descriptions to the related links; without synced docs the links keep their labels.
  const manifest = await loadManifest().catch(() => null)
  const { screenshot } = useCase
  const docsHref = docHref(useCase.docLinks[0]?.slug ?? 'introduction')
  const ownFaqs = structuredFaqs(useCase)
  return <>
    <JsonLd data={breadcrumbList([{ name: 'Home', path: '/' }, { name: 'Use cases', path: USE_CASES_PATH }, { name: useCase.navLabel, path: useCasePath(useCase.slug) }])} />
    <JsonLd data={useCaseWebPage(useCase)} />
    {ownFaqs.length ? <JsonLd data={faqPage(ownFaqs)} /> : null}
    <header className="page-header use-case-header">
      <nav className="use-case-breadcrumb" aria-label="Breadcrumb">
        <ol><li><a href="/">Home</a></li><li><a href={USE_CASES_PATH}>Use cases</a></li><li aria-current="page">{useCase.navLabel}</li></ol>
      </nav>
      <span className="eyebrow">{useCase.eyebrow}</span>
      <h1>{useCase.h1}</h1>
      <p className="page-lead"><Inline text={useCase.lead} /></p>
      <div className="hero-actions">
        <a className="button primary" href="/#download">Download free <span aria-hidden="true">↓</span></a>
        <a className="button" href={docsHref}>Read the docs <span aria-hidden="true">→</span></a>
      </div>
    </header>
    <figure className="shot shot-hero use-case-shot">
      <img src={screenshot.src} srcSet={screenshotSrcSet(screenshot)} sizes="(max-width: 1440px) 100vw, 1296px" width={screenshot.width} height={screenshot.height} alt={screenshot.alt} fetchPriority="high" decoding="async" />
      <figcaption>{screenshot.caption}</figcaption>
    </figure>
    <div className="use-case-sections">{useCase.sections.map((section, i) => <section key={section.heading} className="use-case-section" aria-labelledby={`use-case-section-${i}`}>
      <h2 id={`use-case-section-${i}`}>{section.heading}</h2>
      <div>
        <p><Inline text={section.text} /></p>
        {section.points?.length ? <ul>{section.points.map(point => <li key={point}><Inline text={point} /></li>)}</ul> : null}
        {section.note ? <p className="use-case-note"><Inline text={section.note} /></p> : null}
      </div>
    </section>)}</div>
    {useCase.steps.length ? <section className="how use-case-steps" aria-labelledby="steps-title">
      <div><span className="eyebrow">STEP BY STEP</span><h2 id="steps-title">How it works.</h2><p>Every step and setting is covered in the documentation linked below.</p><a className="quiet-link" href={docsHref}>Read the docs <span aria-hidden="true">→</span></a></div>
      <ol>{useCase.steps.map((step, i) => <li key={step.title}><span aria-hidden="true">{String(i + 1).padStart(2, '0')}</span><div><h3>{step.title}</h3><p><Inline text={step.text} /></p></div></li>)}</ol>
    </section> : null}
    {useCase.faqs.length ? <section className="faq section use-case-faq" aria-labelledby="faq-title">
      <span className="eyebrow">GOOD TO KNOW</span>
      <h2 id="faq-title">Common questions.</h2>
      {useCase.faqs.map(faq => <details key={faq.question}><summary>{faq.question}<span aria-hidden="true">+</span></summary><p>{faq.answer}{faq.link ? <> <a className="faq-link" href={faq.link.href}>{faq.link.label}</a></> : null}</p></details>)}
    </section> : null}
    {useCase.docLinks.length ? <section className="use-case-related" aria-labelledby="related-title">
      <span className="eyebrow">DOCUMENTATION</span>
      <h2 id="related-title">Read more in the docs.</h2>
      <ul className="use-case-doc-links">{useCase.docLinks.map(link => {
        const page = manifest ? findPage(manifest, link.slug) : null
        return <li key={link.slug}><a href={docHref(link.slug)}><strong>{link.label}</strong>{page?.description ? <small>{page.description}</small> : null}</a></li>
      })}</ul>
    </section> : null}
    <section className="home-cta" aria-labelledby="cta-title">
      <h2 id="cta-title">Try it on your own site.</h2>
      <p>Free and open source, for Windows, Linux and macOS. Use it on sites you own or are contracted to test.</p>
      <div className="hero-actions">
        <a className="button primary" href="/#download">Download free <span aria-hidden="true">↓</span></a>
        <a className="button" href={REPO_URL} rel="noopener noreferrer">View source on GitHub <span aria-hidden="true">↗</span><span className="visually-hidden"> (external site)</span></a>
      </div>
    </section>
  </>
}

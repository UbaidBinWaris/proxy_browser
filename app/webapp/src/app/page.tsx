import type { Metadata } from 'next'
import { headers } from 'next/headers'
import Downloads from '@/components/Downloads'
import { JsonLd } from '@/components/JsonLd'
import { REPO_URL } from '@/lib/site'
import { currentRelease } from '@/lib/releases'
import { OS_LABELS, detectOs, recommendedPlatform } from '@/lib/downloads'
import { FAQS, FEATURES, GALLERY_SCREENSHOTS, HERO_SCREENSHOT, MORE_USE_CASE_LINKS, STEPS, USE_CASES, screenshotSrcSet } from '@/lib/home'
import { faqPage, homeGraph } from '@/lib/seo'
import { findUseCase, useCasePath } from '@/lib/use-cases'
export const dynamic = 'force-dynamic'
export const metadata: Metadata = { alternates: { canonical: '/' } }

const docHref = (slug: string) => `/docs/${slug}`

export default async function Home() {
  const [release, requestHeaders] = await Promise.all([currentRelease().catch(() => null), headers()])
  // The page is rendered per request (CSP nonce), so the download highlight comes from the request itself.
  const visitorOs = detectOs(requestHeaders.get('user-agent'))
  const desktop = recommendedPlatform(visitorOs) !== null
  // Use-case pages that are not published yet are not linked.
  const moreUseCases = MORE_USE_CASE_LINKS.filter(link => findUseCase(link.slug))
  return <>
    <JsonLd data={homeGraph(release)} />
    {/* Separate from the graph on purpose: Google no longer shows FAQ rich results, so this serves Bing and AI answer engines. */}
    <JsonLd data={faqPage(FAQS)} />
    <section className="home-hero" aria-labelledby="hero-title">
      <div className="home-hero-copy">
        <span className="pill"><span className="status-dot" /> FREE &amp; OPEN SOURCE · WINDOWS · LINUX · MACOS</span>
        <h1 id="hero-title">Test your web forms by location, device and browser.</h1>
        <p className="hero-description">A desktop QA browser for testing your own website and forms. Launch directly, or through your own proxy plan with an exit IP in the country, US state, city or ZIP you pick, checked before the window opens. Use emulated phone, tablet and desktop presets in Chromium, WebKit or your installed Chrome, Edge, Brave and Opera, and desktop presets in Firefox. Free and open source.</p>
        <div className="hero-actions">
          <a className="button primary" href="#download">{desktop ? `Download for ${OS_LABELS[visitorOs]}` : 'Download free'} <span aria-hidden="true">↓</span></a>
          <a className="button" href="/docs/introduction">Read the docs <span aria-hidden="true">→</span></a>
        </div>
        <ul className="home-hero-points" aria-label="Highlights">
          <li>Apache-2.0, free for commercial use</li>
          <li>No account, no telemetry</li>
          <li>Proxy keys encrypted on your device</li>
        </ul>
      </div>
      <figure className="shot shot-hero">
        <img src={HERO_SCREENSHOT.src} srcSet={screenshotSrcSet(HERO_SCREENSHOT)} sizes="(max-width: 1440px) 100vw, 1296px" width={HERO_SCREENSHOT.width} height={HERO_SCREENSHOT.height} alt={HERO_SCREENSHOT.alt} fetchPriority="high" decoding="async" />
        <figcaption>{HERO_SCREENSHOT.caption}</figcaption>
      </figure>
    </section>
    <div className="engine-strip home-engines">
      <span>BUNDLED</span>
      <div><strong>Chromium</strong><i/><strong>Firefox</strong><i/><strong>WebKit</strong></div>
      <span>INSTALLED</span>
      <div className="home-engines-installed"><strong>Chrome</strong><i/><strong>Edge</strong><i/><strong>Brave</strong><i/><strong>Opera</strong></div>
    </div>
    <section id="features" className="section" aria-labelledby="features-title">
      <div className="section-heading"><div><span className="eyebrow">WHAT YOU GET</span><h2 id="features-title">Everything a form test needs,{' '}<br />on your own machine.</h2></div><p>A free, open-source website testing tool that runs on your computer: manual sessions when you want to look, automation when you want to repeat, and evidence either way.</p></div>
      <ul className="home-features">{FEATURES.map(feature => <li key={feature.title} className="home-feature">
        <h3>{feature.title}</h3>
        <p>{feature.text}</p>
        <a className="quiet-link" href={docHref(feature.docSlug)}>{feature.linkLabel}<span className="visually-hidden"> documentation</span> <span aria-hidden="true">→</span></a>
      </li>)}</ul>
    </section>
    <section className="section home-gallery" aria-labelledby="gallery-title">
      <div className="section-heading"><div><span className="eyebrow">THE APP</span><h2 id="gallery-title">Evidence you can act on.</h2></div><p>Real screenshots from a demo run against a local test form: two engines, three devices, one consent problem that only shows up on phones.</p></div>
      <div className="home-gallery-grid">{GALLERY_SCREENSHOTS.map(shot => <figure key={shot.src} className="shot">
        <a href={shot.src} aria-label={`Open full-size screenshot: ${shot.caption}`}><img src={shot.src} srcSet={screenshotSrcSet(shot)} sizes="(max-width: 760px) 100vw, 50vw" width={shot.width} height={shot.height} alt={shot.alt} loading="lazy" decoding="async" /></a>
        <figcaption>{shot.caption}</figcaption>
      </figure>)}</div>
    </section>
    <section id="use-cases" className="section" aria-labelledby="use-cases-title">
      <div className="section-heading"><div><span className="eyebrow">USE CASES</span><h2 id="use-cases-title">Built for QA of{' '}<br />forms you own.</h2></div><p>For QA engineers, testers and developers checking lead forms, sign-up flows and landing pages before and after release.</p></div>
      <div className="home-use-cases">{USE_CASES.map(useCase => {
        const page = useCase.useCaseSlug ? findUseCase(useCase.useCaseSlug) : null
        return <article key={useCase.title} className="home-use-case">
          <h3>{useCase.title}</h3>
          <p>{useCase.text}</p>
          <ul>{useCase.points.map(point => <li key={point}>{point}</li>)}</ul>
          <div className="home-use-case-links">
            {page ? <a className="quiet-link" href={useCasePath(page.slug)}>Use case: {page.navLabel} <span aria-hidden="true">→</span></a> : null}
            <a className="quiet-link" href={docHref(useCase.docSlug)}>{useCase.linkLabel} <span aria-hidden="true">→</span></a>
          </div>
        </article>
      })}</div>
      {moreUseCases.length ? <p className="home-use-case-links page-meta"><span>More use cases:</span>{moreUseCases.map(link => <a key={link.slug} className="faq-link" href={useCasePath(link.slug)}>{link.label}</a>)}</p> : null}
    </section>
    <section id="how-it-works" className="how section" aria-labelledby="how-title">
      <div><span className="eyebrow">HOW IT WORKS</span><h2 id="how-title">From download{' '}<br />to your first test.</h2><p>Set it up once. Your profiles, scenarios and keys are kept across updates.</p><a className="quiet-link" href="#download">Find your download <span aria-hidden="true">→</span></a></div>
      <ol>{STEPS.map((step, i) => <li key={step.title}><span aria-hidden="true">{String(i + 1).padStart(2, '0')}</span><div><h3>{step.title}</h3><p>{step.text}</p></div></li>)}</ol>
    </section>
    <Downloads initialRelease={release} visitorOs={visitorOs} />
    <section className="faq section" aria-labelledby="faq-title">
      <span className="eyebrow">GOOD TO KNOW</span>
      <h2 id="faq-title">Questions before you start.</h2>
      {FAQS.map(faq => <details key={faq.question}><summary>{faq.question}<span aria-hidden="true">+</span></summary><p>{faq.answer}{faq.link ? <> <a className="faq-link" href={faq.link.href}>{faq.link.label}</a></> : null}</p></details>)}
      <p className="page-meta">More answers, from installed-browser profiles to running several browsers at once, are in the <a className="faq-link" href="/docs/faq">documentation FAQ</a>.</p>
    </section>
    <section className="home-cta" aria-labelledby="cta-title">
      <h2 id="cta-title">Test your next release where your visitors are.</h2>
      <p>Free and open source, for Windows, Linux and macOS. Use it on sites you own or are contracted to test.</p>
      <div className="hero-actions">
        <a className="button primary" href="#download">Download Proxy QA Browser <span aria-hidden="true">↓</span></a>
        <a className="button" href={REPO_URL} rel="noopener noreferrer">View source on GitHub <span aria-hidden="true">↗</span><span className="visually-hidden"> (external site)</span></a>
      </div>
    </section>
  </>
}

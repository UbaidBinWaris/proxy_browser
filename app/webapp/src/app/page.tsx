import type { Metadata } from 'next'
import type { ReactElement } from 'react'
import { headers } from 'next/headers'
import Downloads from '@/components/Downloads'
import { JsonLd } from '@/components/JsonLd'
import { REPO_URL } from '@/lib/site'
import { currentRelease } from '@/lib/releases'
import { OS_LABELS, detectOs, recommendedPlatform } from '@/lib/downloads'
import type { HomeGalleryCard } from '@/lib/home'
import { FAQS, FEATURES, GALLERY_CARDS, GALLERY_SCREENSHOTS, HERO_SCREENSHOT, MORE_USE_CASE_LINKS, STEPS, USE_CASES, screenshotSrcSet } from '@/lib/home'
import { faqPage, homeGraph } from '@/lib/seo'
import { findUseCase, useCasePath } from '@/lib/use-cases'
export const dynamic = 'force-dynamic'
export const metadata: Metadata = { alternates: { canonical: '/' } }

const docHref = (slug: string) => `/docs/${slug}`

/** Line icons of the gallery cards (24 px grid, drawn in currentColor); decorative, so hidden from assistive tech. */
const CARD_ICONS: Record<HomeGalleryCard['icon'], ReactElement> = {
  devices: <><rect x="2" y="4" width="13" height="10" rx="1.5" /><path d="M5.5 18h6M8.5 14v4" /><rect x="17" y="7" width="5" height="12" rx="1.25" /><path d="M19 16.5h1" /></>,
  browsers: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M6.5 6.5h.01M9.5 6.5h.01M12.5 6.5h.01" /><path d="M8 14h8M8 17h5" /></>,
  vault: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3M12 14.5v2.5" /></>,
}

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
        <p className="hero-description">A desktop QA browser for your own site. Launch directly or through your own proxy plan from a US state, city or ZIP, then emulate phones and tablets in Chromium, WebKit, Chrome, Edge, Brave or Opera.</p>
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
        <div className="shot-hero-window">
          <div className="shot-hero-bar" aria-hidden="true"><span /><span /><span /></div>
          {/* Rendered width (globals.css, Hero): the shell content width minus the frame (4px or 8px padding + 1px border per side); 800px column at most from 761px; 55% of the tracks (content - 48px gap) from 1101px. */}
          <img src={HERO_SCREENSHOT.src} srcSet={screenshotSrcSet(HERO_SCREENSHOT)} sizes="(max-width: 760px) calc(100vw - 54px), (max-width: 870px) calc(100vw - 88px), (max-width: 1100px) 782px, (max-width: 1440px) calc(55vw - 124px), 668px" width={HERO_SCREENSHOT.width} height={HERO_SCREENSHOT.height} alt={HERO_SCREENSHOT.alt} fetchPriority="high" decoding="async" />
        </div>
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
      <div className="section-heading"><div><span className="eyebrow">THE APP</span><h2 id="gallery-title">Evidence you can act on.</h2></div><p>Real screenshots from a demo run against a local test form: one launch, then two engines and three devices with a consent problem that only shows up on phones.</p></div>
      <div className="home-gallery-rows">{GALLERY_SCREENSHOTS.map(shot => <article key={shot.src} className="home-gallery-row">
        <div className="home-gallery-text">
          <h3>{shot.title}</h3>
          <p>{shot.text}</p>
          <ul>{shot.points.map(point => <li key={point}>{point}</li>)}</ul>
          <a className="quiet-link" href={docHref(shot.docSlug)}>{shot.linkLabel}<span className="visually-hidden"> documentation</span> <span aria-hidden="true">→</span></a>
        </div>
        {/* Not a link, so the visual order (image first on phones, alternating sides on desktop) never differs from the focus order. Rendered width: globals.css, Gallery. */}
        <figure className="shot">
          <img src={shot.src} srcSet={screenshotSrcSet(shot)} sizes="(max-width: 760px) calc(100vw - 44px), (max-width: 1000px) calc(100vw - 70px), (max-width: 1100px) calc(60vw - 76px), (max-width: 1440px) calc(60vw - 120px), 744px" width={shot.width} height={shot.height} alt={shot.alt} loading="lazy" decoding="async" />
        </figure>
      </article>)}</div>
      <p className="eyebrow home-gallery-more">MORE IN THE APP</p>
      <ul className="home-gallery-cards">{GALLERY_CARDS.map(card => <li key={card.title} className="home-gallery-card">
        <span className="home-gallery-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{CARD_ICONS[card.icon]}</svg></span>
        <h3>{card.title}</h3>
        <p>{card.text}</p>
        <a className="quiet-link" href={docHref(card.docSlug)}>{card.linkLabel}<span className="visually-hidden"> documentation</span> <span aria-hidden="true">→</span></a>
      </li>)}</ul>
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

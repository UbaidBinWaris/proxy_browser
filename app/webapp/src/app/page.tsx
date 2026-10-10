import type { Metadata } from 'next'
import { headers } from 'next/headers'
import Downloads from '@/components/Downloads'
import { JsonLd } from '@/components/JsonLd'
import { LICENSE_URL, OWNER, REPO_URL, SITE_DESCRIPTION, SITE_NAME, SITE_URL } from '@/lib/site'
import { currentRelease } from '@/lib/releases'
import { OS_LABELS, detectOs, recommendedPlatform } from '@/lib/downloads'
import { FAQS, FEATURES, GALLERY_SCREENSHOTS, HERO_SCREENSHOT, STEPS, USE_CASES, screenshotSrcSet } from '@/lib/home'
export const dynamic = 'force-dynamic'
export const metadata: Metadata = { alternates: { canonical: '/' } }

const docHref = (slug: string) => `/docs/${slug}`

export default async function Home() {
  const [release, requestHeaders] = await Promise.all([currentRelease().catch(() => null), headers()])
  // The page is rendered per request (CSP nonce), so the download highlight comes from the request itself.
  const visitorOs = detectOs(requestHeaders.get('user-agent'))
  const desktop = recommendedPlatform(visitorOs) !== null
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: SITE_NAME,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Windows 10, Windows 11, Linux, macOS 12+',
    isAccessibleForFree: true,
    license: LICENSE_URL,
    codeRepository: REPO_URL,
    screenshot: `${SITE_URL}${HERO_SCREENSHOT.src}`,
    featureList: FEATURES.map(feature => feature.title),
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    author: { '@type': 'Person', name: OWNER.name, url: OWNER.website, sameAs: [OWNER.github, OWNER.linkedin] },
    ...(release ? { softwareVersion: release.version, datePublished: release.releasedAt, downloadUrl: `${SITE_URL}/#download` } : {}),
  }
  const faqData = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQS.map(faq => ({ '@type': 'Question', name: faq.question, acceptedAnswer: { '@type': 'Answer', text: faq.answer } })),
  }
  return <>
    <JsonLd data={structuredData} />
    <JsonLd data={faqData} />
    <section className="home-hero" aria-labelledby="hero-title">
      <div className="home-hero-copy">
        <span className="pill"><span className="status-dot" /> FREE &amp; OPEN SOURCE · WINDOWS · LINUX · MACOS</span>
        <h1 id="hero-title">Test your forms from real locations, devices and browsers.</h1>
        <p className="hero-description">A desktop QA browser for your own sites. Launch through a verified exit IP in the US state, city or ZIP you pick, on any of 226 device presets, in Chromium, Firefox and WebKit or your installed Chrome, Edge, Brave, Opera and Vivaldi. Free and open source.</p>
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
        <img src={HERO_SCREENSHOT.src} srcSet={screenshotSrcSet(HERO_SCREENSHOT)} sizes="(max-width: 760px) 100vw, 720px" width={HERO_SCREENSHOT.width} height={HERO_SCREENSHOT.height} alt={HERO_SCREENSHOT.alt} fetchPriority="high" decoding="async" />
        <figcaption>{HERO_SCREENSHOT.caption}</figcaption>
      </figure>
    </section>
    <div className="engine-strip home-engines">
      <span>BUNDLED</span>
      <div><strong>Chromium</strong><i/><strong>Firefox</strong><i/><strong>WebKit</strong></div>
      <span>INSTALLED</span>
      <div className="home-engines-installed"><strong>Chrome</strong><i/><strong>Edge</strong><i/><strong>Brave</strong><i/><strong>Opera</strong><i/><strong>Vivaldi</strong></div>
    </div>
    <section id="features" className="section" aria-labelledby="features-title">
      <div className="section-heading"><div><span className="eyebrow">WHAT YOU GET</span><h2 id="features-title">Everything a form test needs,<br />on your own machine.</h2></div><p>Manual sessions when you want to look, automation when you want to repeat, and evidence either way.</p></div>
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
      <div className="section-heading"><div><span className="eyebrow">USE CASES</span><h2 id="use-cases-title">Built for QA of<br />forms you own.</h2></div><p>For QA engineers, testers and developers checking lead forms, sign-up flows and landing pages before and after release.</p></div>
      <div className="home-use-cases">{USE_CASES.map(useCase => <article key={useCase.title} className="home-use-case">
        <h3>{useCase.title}</h3>
        <p>{useCase.text}</p>
        <ul>{useCase.points.map(point => <li key={point}>{point}</li>)}</ul>
        <a className="quiet-link" href={docHref(useCase.docSlug)}>{useCase.linkLabel} <span aria-hidden="true">→</span></a>
      </article>)}</div>
    </section>
    <section id="how-it-works" className="how section" aria-labelledby="how-title">
      <div><span className="eyebrow">HOW IT WORKS</span><h2 id="how-title">From download<br />to your first test.</h2><p>Set it up once. Your profiles, scenarios and keys are kept across updates.</p><a className="quiet-link" href="#download">Find your download <span aria-hidden="true">→</span></a></div>
      <ol>{STEPS.map((step, i) => <li key={step.title}><span aria-hidden="true">{String(i + 1).padStart(2, '0')}</span><div><h3>{step.title}</h3><p>{step.text}</p></div></li>)}</ol>
    </section>
    <Downloads initialRelease={release} visitorOs={visitorOs} />
    <section className="faq section" aria-labelledby="faq-title">
      <span className="eyebrow">GOOD TO KNOW</span>
      <h2 id="faq-title">Questions before you start.</h2>
      {FAQS.map(faq => <details key={faq.question}><summary>{faq.question}<span aria-hidden="true">+</span></summary><p>{faq.answer}{faq.link ? <> <a className="faq-link" href={faq.link.href}>{faq.link.label}</a></> : null}</p></details>)}
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

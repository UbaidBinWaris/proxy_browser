import type { Metadata } from 'next'
import type { ReactElement } from 'react'
import { headers } from 'next/headers'
import { Inline } from '@/components/Inline'
import { JsonLd } from '@/components/JsonLd'
import { DOWNLOAD_PATH, FAQ_PATH, REPO_URL } from '@/lib/site'
import { currentRelease } from '@/lib/releases'
import { OS_LABELS, detectOs, recommendedPlatform } from '@/lib/downloads'
import type { HomeFeature } from '@/lib/home'
import { FEATURES, GALLERY_SCREENSHOTS, HERO_SCREENSHOT, STEPS, screenshotSrcSet } from '@/lib/home'
import { homeFaqs } from '@/lib/faq'
import { homeGraph } from '@/lib/seo'
import { USE_CASES, USE_CASES_PATH, useCasePath } from '@/lib/use-cases'
export const dynamic = 'force-dynamic'
export const metadata: Metadata = { alternates: { canonical: '/' } }

const docHref = (slug: string) => `/docs/${slug}`

/** Line icons of the features (24 px grid, drawn in currentColor); decorative, so hidden from assistive tech. */
const FEATURE_ICONS: Record<HomeFeature['icon'], ReactElement> = {
  location: <><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.5" /></>,
  devices: <><rect x="2" y="4" width="13" height="10" rx="1.5" /><path d="M5.5 18h6M8.5 14v4" /><rect x="17" y="7" width="5" height="12" rx="1.25" /><path d="M19 16.5h1" /></>,
  browsers: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M6.5 6.5h.01M9.5 6.5h.01M12.5 6.5h.01" /><path d="M8 14h8M8 17h5" /></>,
  automation: <><circle cx="12" cy="12" r="9" /><path d="M10 8.5v7l5.5-3.5z" /></>,
  checks: <><path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z" /><path d="M9 12l2 2 4-4" /></>,
  vault: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3M12 14.5v2.5" /></>,
}

export default async function Home() {
  const [release, requestHeaders] = await Promise.all([currentRelease().catch(() => null), headers()])
  // The page is rendered per request (CSP nonce), so the download highlight comes from the request itself.
  const visitorOs = detectOs(requestHeaders.get('user-agent'))
  const desktop = recommendedPlatform(visitorOs) !== null
  const downloadLabel = desktop ? `Download for ${OS_LABELS[visitorOs]}` : 'Download free'
  return <>
    <JsonLd data={homeGraph(release)} />
    <section className="home-hero" aria-labelledby="hero-title">
      <div className="home-hero-copy">
        <span className="pill"><span className="status-dot" /> FREE &amp; OPEN SOURCE · WINDOWS · LINUX · MACOS</span>
        <h1 id="hero-title">Test your web forms by location, device and browser.</h1>
        <p className="hero-description">A desktop QA browser for your own site. Launch directly or through your own proxy plan from a US state, city or ZIP, then emulate phones and tablets in Chromium, WebKit, Chrome, Edge, Brave or Opera.</p>
        <div className="hero-actions">
          <a className="button primary" href={DOWNLOAD_PATH}>{downloadLabel} <span aria-hidden="true">↓</span></a>
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
        <span className="home-feature-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{FEATURE_ICONS[feature.icon]}</svg></span>
        <h3>{feature.title}</h3>
        <p>{feature.text}</p>
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
    </section>
    <section id="use-cases" className="section" aria-labelledby="use-cases-title">
      <div className="section-heading"><div><span className="eyebrow">USE CASES</span><h2 id="use-cases-title">Built for QA of{' '}<br />forms you own.</h2></div><p>For QA engineers, testers and developers checking lead forms, sign-up flows and landing pages before and after release.</p></div>
      <ul className="home-use-cases">{USE_CASES.map(useCase => <li key={useCase.slug}>
        <a className="home-use-case" href={useCasePath(useCase.slug)}>
          <h3>{useCase.navLabel}</h3>
          <p>{useCase.summary}</p>
          <span className="quiet-link" aria-hidden="true">Read the guide <span>→</span></span>
        </a>
      </li>)}</ul>
      <p className="page-meta home-use-case-all"><a className="faq-link" href={USE_CASES_PATH}>All use cases, with screenshots</a></p>
    </section>
    <section id="how-it-works" className="how section" aria-labelledby="how-title">
      <div><span className="eyebrow">HOW IT WORKS</span><h2 id="how-title">From download{' '}<br />to your first test.</h2><p>Set it up once. Your profiles, scenarios and keys are kept across updates.</p><a className="quiet-link" href={DOWNLOAD_PATH}>Find your download <span aria-hidden="true">→</span></a></div>
      <ol>{STEPS.map((step, i) => <li key={step.title}><span aria-hidden="true">{String(i + 1).padStart(2, '0')}</span><div><h3>{step.title}</h3><p>{step.text}</p></div></li>)}</ol>
    </section>
    {/* The desktop app opens this anchor (the home page with the download hash) for macOS updates, so it stays. */}
    <section id="download" className="home-download" aria-labelledby="download-title">
      <div>
        <span className="eyebrow">DOWNLOAD</span>
        <h2 id="download-title">Free for Windows, Linux and macOS.</h2>
        <p>{release ? `Version ${release.version}: a` : 'A'} portable EXE for Windows 10 and 11, an AppImage for x86-64 Linux, and DMGs for Apple silicon and Intel Macs, each with its SHA-256 checksum.</p>
      </div>
      <div className="hero-actions">
        <a className="button primary" href={DOWNLOAD_PATH}>{downloadLabel} <span aria-hidden="true">↓</span></a>
        <a className="button" href="/changelog">What&apos;s new <span aria-hidden="true">→</span></a>
      </div>
    </section>
    <section className="faq section" aria-labelledby="faq-title">
      <span className="eyebrow">GOOD TO KNOW</span>
      <h2 id="faq-title">Questions before you start.</h2>
      {homeFaqs().map(faq => <details key={faq.id}><summary>{faq.question}<span aria-hidden="true">+</span></summary>{faq.answer.map(paragraph => <p key={paragraph}><Inline text={paragraph} /></p>)}</details>)}
      <p className="page-meta">More answers, in chapters from proxies to privacy, are on the <a className="faq-link" href={FAQ_PATH}>FAQ page</a>.</p>
    </section>
    <section className="home-cta" aria-labelledby="cta-title">
      <h2 id="cta-title">Test your next release where your visitors are.</h2>
      <p>Free and open source, for Windows, Linux and macOS. Use it on sites you own or are contracted to test.</p>
      <div className="hero-actions">
        <a className="button primary" href={DOWNLOAD_PATH}>Download Proxy QA Browser <span aria-hidden="true">↓</span></a>
        <a className="button" href={REPO_URL} rel="noopener noreferrer">View source on GitHub <span aria-hidden="true">↗</span><span className="visually-hidden"> (external site)</span></a>
      </div>
    </section>
  </>
}

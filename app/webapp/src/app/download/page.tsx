import type { Metadata } from 'next'
import { headers } from 'next/headers'
import Downloads from '@/components/Downloads'
import { JsonLd } from '@/components/JsonLd'
import { OS_LABELS, detectOs, recommendedPlatform } from '@/lib/downloads'
import { currentRelease } from '@/lib/releases'
import { SCHEMA_IDS, pageBreadcrumbs, pageMetadata } from '@/lib/seo'
import { DOWNLOAD_PATH, FAQ_PATH, REPO_URL, SITE_URL } from '@/lib/site'

// Rendered per request: the recommended download comes from the visitor's User-Agent, the release from the signed feed.
export const dynamic = 'force-dynamic'
export const metadata: Metadata = pageMetadata({
  title: 'Download for Windows, Linux and macOS',
  description: 'Download Proxy QA Browser free: a portable EXE for Windows 10 and 11, a Linux AppImage and DMGs for Apple silicon and Intel Macs, with SHA-256 checksums.',
  path: DOWNLOAD_PATH,
})

const VERIFY = [
  { system: 'Windows (PowerShell)', command: 'Get-FileHash .\\Proxy-QA-Browser-*-Windows-x64.exe -Algorithm SHA256' },
  { system: 'Linux', command: 'sha256sum Proxy-QA-Browser-*-x86_64.AppImage' },
  { system: 'macOS', command: 'shasum -a 256 Proxy-QA-Browser-*-macOS-*.dmg' },
]

const NEXT_STEPS = [
  { href: '/docs/first-run', title: 'First run', text: 'The set-up wizard: bundled browsers, optional proxy keys and a tour of the main window.' },
  { href: '/docs/launching', title: 'Launch your first test', text: 'Pick a browser, a device and, with your own proxy plan, a location, then connect.' },
  { href: '/use-cases', title: 'Use cases', text: 'Location, consent, device, cross-browser and visual regression testing, step by step.' },
]

export default async function DownloadPage() {
  const [release, requestHeaders] = await Promise.all([currentRelease().catch(() => null), headers()])
  const visitorOs = detectOs(requestHeaders.get('user-agent'))
  const recommended = recommendedPlatform(visitorOs) !== null
  return <>
    <JsonLd data={pageBreadcrumbs('Download', DOWNLOAD_PATH)} />
    <JsonLd data={{ '@context': 'https://schema.org', '@type': 'WebPage', url: `${SITE_URL}${DOWNLOAD_PATH}`, name: 'Download Proxy QA Browser', inLanguage: 'en', isPartOf: { '@id': SCHEMA_IDS.website }, about: { '@id': SCHEMA_IDS.software } }} />
    <header className="page-header download-header">
      <span className="eyebrow">DOWNLOAD · FREE AND OPEN SOURCE</span>
      <h1>Download Proxy QA Browser.</h1>
      <p className="page-lead">One file per system, with no account and no installer wizard{release ? `: version ${release.version}` : ''}. {recommended ? `The ${OS_LABELS[visitorOs]} download is listed first; the others stay below.` : 'Pick the file for the computer you will test on.'} Every file comes with its SHA-256 checksum.</p>
    </header>
    <h2 className="download-cards-title">Choose your system</h2>
    <Downloads initialRelease={release} visitorOs={visitorOs} heading={false} />
    <section className="download-info section" aria-labelledby="verify-title">
      <div>
        <h2 id="verify-title">Check the download.</h2>
        <p>Compare the SHA-256 checksum shown under the file with the one your system computes. If they differ, delete the file and download it again. Updates installed by the app are also verified with the publisher&apos;s Ed25519 signature; see <a className="faq-link" href="/docs/updates">Updates</a>.</p>
      </div>
      <ul className="download-verify">{VERIFY.map(item => <li key={item.system}><strong>{item.system}</strong><code>{item.command}</code></li>)}</ul>
    </section>
    <section className="download-info section" aria-labelledby="next-title">
      <div>
        <h2 id="next-title">After you download.</h2>
        <p>Your profiles, scenarios and encrypted keys stay on your computer and are kept across updates. The <a className="faq-link" href="/docs/install">install guide</a> covers moving and uninstalling, and the <a className="faq-link" href={FAQ_PATH}>FAQ</a> answers common questions.</p>
      </div>
      <ul className="use-case-doc-links">{NEXT_STEPS.map(step => <li key={step.href}><a href={step.href}><strong>{step.title}</strong><small>{step.text}</small></a></li>)}</ul>
    </section>
    <p className="page-meta download-meta">Earlier versions and their notes are in the <a className="faq-link" href="/changelog">changelog</a>. Prefer to build it yourself? The <a className="faq-link" href={REPO_URL} rel="noopener noreferrer">source code</a> is on GitHub under the Apache License 2.0.</p>
  </>
}

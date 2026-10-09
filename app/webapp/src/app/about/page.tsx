import type { Metadata } from 'next'
import { pageMetadata } from '@/lib/seo'
import { LICENSE_URL, OWNER, REPO_BLOB_URL, REPO_URL } from '@/lib/site'

export const metadata: Metadata = pageMetadata({ title: `Built by ${OWNER.name}`, description: `Proxy QA Browser is a free, open-source, privacy-first QA browser created and maintained by ${OWNER.name}, an independent AI systems and full-stack engineer.`, path: '/about' })

const contacts = [
  { label: 'Website', detail: 'ubaidbinwaris.com', href: OWNER.website },
  { label: 'GitHub', detail: 'github.com/UbaidBinWaris', href: OWNER.github },
  { label: 'LinkedIn', detail: 'linkedin.com/in/ubaidbinwaris', href: OWNER.linkedin },
  { label: 'Email', detail: OWNER.email, href: `mailto:${OWNER.email}` },
]

export default function About() {
  return <>
    <header className="page-header">
      <span className="eyebrow">ABOUT THE PROJECT</span>
      <h1>Built by {OWNER.name}.</h1>
      <p className="page-lead">Proxy QA Browser is an independent open-source project, created, owned and maintained by {OWNER.name}, and free for everyone.</p>
    </header>
    <div className="about-grid">
      <div className="prose">
        <h2 id="the-developer">The developer</h2>
        <p>{OWNER.name} is an independent developer based in {OWNER.location}, working as an AI systems and full-stack engineer. He builds practical tools for people who test and ship web products.</p>
        <h2 id="the-mission">The mission</h2>
        <p>Testing your own forms across browsers, devices and locations should not need expensive tools, an account or sending your data to someone else. Proxy QA Browser aims to be a <strong>free, open-source, privacy-first QA browser for everyone</strong>:</p>
        <ul>
          <li><strong>Free</strong>, with no paid tiers, licence keys or sign-in.</li>
          <li><strong>Open source</strong> under the <a href={LICENSE_URL} rel="noopener noreferrer">Apache License 2.0</a>, so you can read, audit, change and redistribute it.</li>
          <li><strong>Private by design</strong>: no telemetry, and your profiles, results and encrypted credentials stay on your device. See the <a href="/privacy">privacy policy</a>.</li>
          <li><strong>Honest</strong>: built for authorized testing, with exit-IP verification instead of guesswork, and no features for evading other people&apos;s protections. See the <a href="/acceptable-use">acceptable use policy</a>.</li>
        </ul>
        <h2 id="contribute">Contribute</h2>
        <p>Bug reports, documentation fixes and pull requests are welcome. Read <a href={`${REPO_BLOB_URL}/CONTRIBUTING.md`} rel="noopener noreferrer">CONTRIBUTING.md</a> for the development setup and project scope, open an <a href={`${REPO_URL}/issues`} rel="noopener noreferrer">issue on GitHub</a>, or improve any documentation page with its &ldquo;Edit this page on GitHub&rdquo; link. Security problems go through the <a href="/security">security policy</a> instead.</p>
        <p>There is nothing to buy and no sponsorship is needed. The most helpful support is to use the app responsibly, report what breaks, and share it with people who could use it.</p>
      </div>
      <aside className="contact-card" aria-labelledby="contact-heading">
        <h2 id="contact-heading">Get in touch</h2>
        <ul>{contacts.map(c => <li key={c.label}><a href={c.href} rel={c.href.startsWith('http') ? 'noopener noreferrer' : undefined}>{c.label}<span>{c.detail}</span></a></li>)}</ul>
        <p className="page-meta">Project source: <a className="quiet-link" href={REPO_URL} rel="noopener noreferrer">UbaidBinWaris/proxy_browser</a></p>
      </aside>
    </div>
  </>
}

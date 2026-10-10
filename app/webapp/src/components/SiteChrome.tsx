import { LEGAL_LINKS, OWNER, REPO_URL } from '@/lib/site'
import type { SiteLink } from '@/lib/site'
import { USE_CASES, USE_CASES_PATH, useCasePath } from '@/lib/use-cases'

const MAIN_LINKS: SiteLink[] = [
  { href: '/#features', label: 'Features' },
  { href: '/use-cases', label: 'Use cases' },
  { href: '/docs', label: 'Docs' },
  { href: '/changelog', label: 'Changelog' },
  { href: REPO_URL, label: 'GitHub', external: true },
]

function NavLink({ link, className }: { link: SiteLink; className?: string }) {
  return link.external
    ? <a className={['external', className].filter(Boolean).join(' ')} href={link.href} rel="noopener noreferrer">{link.label}<span aria-hidden="true"> ↗</span><span className="visually-hidden"> (external site)</span></a>
    : <a className={className} href={link.href}>{link.label}</a>
}

export function SiteHeader() {
  return <header className="site-header">
    <a className="brand" href="/" aria-label="Proxy QA Browser home"><img src="/brand/logo.svg" width="38" height="38" alt="" /><span>Proxy QA<span className="brand-light"> Browser</span></span></a>
    <nav className="main-nav" aria-label="Main">
      {MAIN_LINKS.map(link => <NavLink key={link.href} link={link} />)}
      <a className="nav-download" href="/#download">Download <span aria-hidden="true">↓</span></a>
    </nav>
    <details className="mobile-nav">
      <summary><span className="menu-icon" aria-hidden="true">☰</span> Menu</summary>
      <nav aria-label="Main">
        {MAIN_LINKS.map(link => <NavLink key={link.href} link={link} />)}
        <a href="/#download">Download</a>
      </nav>
    </details>
  </header>
}

export function SiteFooter() {
  const year = new Date().getFullYear()
  return <footer className="site-footer">
    <div className="footer-about">
      <a className="brand" href="/"><img src="/brand/logo.svg" width="28" height="28" alt="" /><span>Proxy QA Browser</span></a>
      <p>A free, open-source desktop workspace for authorized browser testing of your own sites.</p>
    </div>
    <nav className="footer-columns" aria-label="Footer">
      <div><h2 className="footer-heading">Product</h2><ul><li><a href="/#download">Download</a></li><li><a href={USE_CASES_PATH}>Use cases</a></li>{USE_CASES.map(useCase => <li key={useCase.slug}><a href={useCasePath(useCase.slug)}>{useCase.navLabel}</a></li>)}<li><a href="/docs">Docs</a></li><li><a href="/changelog">Changelog</a></li></ul></div>
      <div><h2 className="footer-heading">Legal</h2><ul>{LEGAL_LINKS.map(link => <li key={link.href}><a href={link.href}>{link.label}</a></li>)}</ul></div>
      <div><h2 className="footer-heading">Developer</h2><ul><li><a href="/about">Built by {OWNER.name}</a></li><li><NavLink link={{ href: REPO_URL, label: 'GitHub', external: true }} /></li><li><a className="external" href={OWNER.website} rel="noopener noreferrer">Website<span aria-hidden="true"> ↗</span></a></li></ul></div>
    </nav>
    <p className="footer-line">Free and open source for everyone · Apache-2.0 · © {year} {OWNER.name}</p>
  </footer>
}

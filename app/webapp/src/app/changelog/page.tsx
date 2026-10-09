import type { Metadata } from 'next'
import { loadChangelog } from '@/lib/changelog'
import { pageMetadata } from '@/lib/seo'
import { REPO_URL } from '@/lib/site'

export const metadata: Metadata = pageMetadata({ title: 'Changelog', description: 'What changed in each Proxy QA Browser release, newest first.', path: '/changelog' })

export default async function Changelog() {
  const entries = await loadChangelog()
  return <>
    <header className="page-header">
      <span className="eyebrow">RELEASES</span>
      <h1>Changelog</h1>
      <p className="page-lead">What&apos;s new in each release, newest first. The desktop app shows the same notes in <strong>Settings → App &amp; updates</strong>.</p>
    </header>
    <div className="changelog">
      {entries.map((entry, i) => <section className="release" key={entry.version} aria-labelledby={entry.id}>
        <h2 id={entry.id}><a href={`#${entry.id}`}>Version {entry.version}</a>{i === 0 ? <span className="latest">LATEST</span> : null}</h2>
        <ul>{entry.notes.map(note => <li key={note}>{note}</li>)}</ul>
      </section>)}
      <p className="page-meta">Full history: <a className="quiet-link" href={`${REPO_URL}/commits/main`} rel="noopener noreferrer">commits on GitHub</a></p>
    </div>
  </>
}

import type { ReactNode } from 'react'
import { renderMarkdown } from '@/lib/markdown'
import { legalBreadcrumbs } from '@/lib/seo'
import { POLICY_DATE, POLICY_DATE_LABEL } from '@/lib/site'
import { JsonLd } from './JsonLd'
import { Prose, Toc } from './Prose'

/** Shared shell for the project's policies: breadcrumbs, title, effective date, contents list and Markdown body. */
export function LegalPage({ eyebrow, title, lead, markdown, note, children }: { eyebrow: string; title: string; lead: string; markdown: string; note?: ReactNode; children?: ReactNode }) {
  const { html, headings } = renderMarkdown(markdown), breadcrumbs = legalBreadcrumbs(title)
  return <>
    {breadcrumbs ? <JsonLd data={breadcrumbs} /> : null}
    <header className="page-header">
      <span className="eyebrow">{eyebrow}</span>
      <h1>{title}</h1>
      <p className="page-lead">{lead}</p>
      <p className="page-meta">Effective <time dateTime={POLICY_DATE}>{POLICY_DATE_LABEL}</time> · Last updated <time dateTime={POLICY_DATE}>{POLICY_DATE_LABEL}</time></p>
    </header>
    <div className="legal-shell">
      <div>
        {note ? <aside className="legal-note" aria-label="Note">{note}</aside> : null}
        <Prose html={html} />
        {children}
      </div>
      <Toc headings={headings} className="legal-toc" title="Contents" />
    </div>
  </>
}

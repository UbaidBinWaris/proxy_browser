import type { Heading } from '@/lib/markdown'

/** Server-rendered Markdown output. The HTML comes from renderMarkdown, which escapes raw HTML and emits no scripts. */
export function Prose({ html }: { html: string }) {
  return <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
}

export function Toc({ headings, className, title = 'On this page' }: { headings: Heading[]; className: string; title?: string }) {
  const items = headings.filter(h => h.depth === 2)
  if (!items.length) return null
  return <nav className={`toc ${className}`} aria-label={title}>
    <p className="toc-title">{title}</p>
    <ul>{items.map(h => <li key={h.id}><a href={`#${h.id}`}>{h.text}</a></li>)}</ul>
  </nav>
}

import { DocsSearchForm } from '@/components/DocsSearchForm'
import type { DocsManifest } from '@/lib/docs'

function Sections({ manifest, current }: { manifest: DocsManifest; current?: string }) {
  return manifest.sections.map(section => <div className="docs-nav-section" key={section.title}>
    <p className="docs-nav-title">{section.title}</p>
    <ul>{section.pages.map(page => <li key={page.slug}><a href={`/docs/${page.slug}`} aria-current={page.slug === current ? 'page' : undefined}>{page.title}</a></li>)}</ul>
  </div>)
}

/**
 * Desktop sidebar plus a <details> menu for narrow screens (no client JavaScript); CSS shows one of them.
 * Each variant carries its own search box unless the page already has one (`search={false}`).
 */
export function DocsNav({ manifest, current, search = true }: { manifest: DocsManifest; current?: string; search?: boolean }) {
  return <>
    <aside className="docs-sidebar">
      {search ? <DocsSearchForm id="docs-search-sidebar" /> : null}
      <nav aria-label="Documentation"><Sections manifest={manifest} current={current} /></nav>
    </aside>
    {search ? <DocsSearchForm id="docs-search-mobile" className="docs-search-mobile" /> : null}
    <details className="docs-mobile-nav"><summary>Documentation menu</summary><nav aria-label="Documentation"><Sections manifest={manifest} current={current} /></nav></details>
  </>
}

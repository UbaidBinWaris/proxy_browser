import type { DocsManifest } from '@/lib/docs'

function Sections({ manifest, current }: { manifest: DocsManifest; current?: string }) {
  return manifest.sections.map(section => <div className="docs-nav-section" key={section.title}>
    <p className="docs-nav-title">{section.title}</p>
    <ul>{section.pages.map(page => <li key={page.slug}><a href={`/docs/${page.slug}`} aria-current={page.slug === current ? 'page' : undefined}>{page.title}</a></li>)}</ul>
  </div>)
}

/** Desktop sidebar plus a <details> menu for narrow screens (no client JavaScript); CSS shows one of them. */
export function DocsNav({ manifest, current }: { manifest: DocsManifest; current?: string }) {
  return <>
    <aside className="docs-sidebar"><nav aria-label="Documentation"><Sections manifest={manifest} current={current} /></nav></aside>
    <details className="docs-mobile-nav"><summary>Documentation menu</summary><nav aria-label="Documentation"><Sections manifest={manifest} current={current} /></nav></details>
  </>
}

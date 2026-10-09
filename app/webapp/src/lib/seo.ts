import type { Metadata, MetadataRoute } from 'next'
import { SITE_NAME, SITE_URL, STATIC_PAGES } from './site.ts'

/** Per-page metadata with canonical URL and matching Open Graph / Twitter fields. */
export function pageMetadata({ title, description, path }: { title: string; description: string; path: string }): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { type: 'website', siteName: SITE_NAME, title: `${title} | ${SITE_NAME}`, description, url: path, images: [{ url: '/opengraph-image', width: 1200, height: 630, alt: `${SITE_NAME}: free, open-source QA browser` }] },
    twitter: { card: 'summary_large_image', title: `${title} | ${SITE_NAME}`, description, images: ['/opengraph-image'] },
  }
}

export function sitemapEntries(docSlugs: string[]): MetadataRoute.Sitemap {
  return [
    ...STATIC_PAGES.map(page => ({ url: `${SITE_URL}${page.path === '/' ? '' : page.path}`, changeFrequency: 'monthly' as const, priority: page.priority })),
    ...docSlugs.map(slug => ({ url: `${SITE_URL}/docs/${slug}`, changeFrequency: 'monthly' as const, priority: 0.7 })),
  ]
}

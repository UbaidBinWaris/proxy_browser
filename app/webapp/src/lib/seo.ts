import type { Metadata, MetadataRoute } from 'next'
import type { ManifestPage } from './docs.ts'
import { LEGAL_LINKS, OWNER, POLICY_DATE, SITE_NAME, SITE_URL, STATIC_PAGES } from './site.ts'

export type SocialImage = { url: string; alt: string; width: number; height: number }
export const DEFAULT_SOCIAL_IMAGE: SocialImage = { url: '/opengraph-image', width: 1200, height: 630, alt: `${SITE_NAME}: free, open-source QA browser` }

/**
 * Per-page metadata with canonical URL and matching Open Graph / Twitter fields. Pass `article` for docs pages:
 * Open Graph type "article" with the page's last change and section.
 */
export function pageMetadata({ title, description, path, image = DEFAULT_SOCIAL_IMAGE, article }: {
  title: string
  description: string
  path: string
  image?: SocialImage
  article?: { modifiedTime?: string; section?: string }
}): Metadata {
  const social = `${title} | ${SITE_NAME}`
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: article
      ? { type: 'article', siteName: SITE_NAME, title: social, description, url: path, images: [image], authors: [OWNER.website], ...(article.modifiedTime ? { modifiedTime: article.modifiedTime } : {}), ...(article.section ? { section: article.section } : {}) }
      : { type: 'website', siteName: SITE_NAME, title: social, description, url: path, images: [image] },
    twitter: { card: 'summary_large_image', title: social, description, images: [image.url] },
  }
}

const absolute = (path: string) => `${SITE_URL}${path === '/' ? '' : path}`
const docImage = (path: string) => `${SITE_URL}/docs-assets/${path}`

/**
 * Sitemap: static pages, then every docs page with its last commit date and the screenshots it shows
 * (Google's image sitemap extension). The home page and the docs index change whenever the docs do.
 */
export function sitemapEntries(docPages: Pick<ManifestPage, 'slug' | 'lastModified' | 'images'>[], homeImages: string[] = []): MetadataRoute.Sitemap {
  const newest = docPages.map(page => page.lastModified).filter((date): date is string => Boolean(date)).sort((a, b) => Date.parse(b) - Date.parse(a))[0]
  const legal = new Set(LEGAL_LINKS.map(link => link.href))
  const staticDate = (path: string): string | undefined => {
    if (legal.has(path)) return POLICY_DATE
    return path === '/' || path === '/docs' ? newest : undefined
  }
  return [
    ...STATIC_PAGES.map(page => ({
      url: absolute(page.path),
      changeFrequency: 'monthly' as const,
      priority: page.priority,
      ...(staticDate(page.path) ? { lastModified: staticDate(page.path) } : {}),
      ...(page.path === '/' && homeImages.length ? { images: homeImages.map(src => absolute(src)) } : {}),
    })),
    ...docPages.map(page => ({
      url: `${SITE_URL}/docs/${page.slug}`,
      changeFrequency: 'monthly' as const,
      priority: 0.7,
      ...(page.lastModified ? { lastModified: page.lastModified } : {}),
      ...(page.images?.length ? { images: page.images.map(docImage) } : {}),
    })),
  ]
}

const author = { '@type': 'Person', name: OWNER.name, url: OWNER.website, sameAs: [OWNER.github, OWNER.linkedin] }

/** schema.org BreadcrumbList from the site root down to the current page. */
export function breadcrumbList(items: { name: string; path: string }[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({ '@type': 'ListItem', position: i + 1, name: item.name, item: absolute(item.path) })),
  }
}

/** schema.org TechArticle for a docs page; the first screenshot it shows doubles as its image. */
export function docArticle(doc: Pick<ManifestPage, 'slug' | 'title' | 'lastModified' | 'images'> & { description: string; section: string }): Record<string, unknown> {
  const url = `${SITE_URL}/docs/${doc.slug}`
  return {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: doc.title,
    description: doc.description,
    url,
    mainEntityOfPage: url,
    articleSection: doc.section,
    inLanguage: 'en',
    image: doc.images?.length ? doc.images.map(docImage) : [`${SITE_URL}/og/${doc.slug}`],
    ...(doc.lastModified ? { dateModified: doc.lastModified } : {}),
    author,
    publisher: author,
    isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: SITE_URL },
    about: { '@type': 'SoftwareApplication', name: SITE_NAME, applicationCategory: 'DeveloperApplication', operatingSystem: 'Windows, Linux, macOS' },
  }
}

/** schema.org WebSite: lets search engines show the site name instead of the domain. */
export function webSite(description: string): Record<string, unknown> {
  return { '@context': 'https://schema.org', '@type': 'WebSite', name: SITE_NAME, url: `${SITE_URL}/`, description, inLanguage: 'en', publisher: author }
}

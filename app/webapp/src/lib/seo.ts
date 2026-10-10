import type { Metadata, MetadataRoute } from 'next'
import type { ManifestPage } from './docs.ts'
import { FEATURES, GALLERY_SCREENSHOTS, HERO_SCREENSHOT } from './home.ts'
import type { HomeScreenshot } from './home.ts'
import { LEGAL_LINKS, OWNER, POLICY_DATE, REPO_URL, SITE_DESCRIPTION, SITE_NAME, SITE_URL, STATIC_PAGES } from './site.ts'
import { USE_CASES, USE_CASES_PATH, useCasePath } from './use-cases.ts'
import type { UseCase, UseCaseFaq } from './use-cases.ts'

export type SocialImage = { url: string; alt: string; width: number; height: number }
export const DEFAULT_SOCIAL_IMAGE: SocialImage = { url: '/opengraph-image', width: 1200, height: 630, alt: `${SITE_NAME}: free, open-source QA browser` }

/** Last content change of the about page and of the use-case pages (ISO dates, for the sitemap); update with their copy. */
export const ABOUT_DATE = '2026-10-10'
export const USE_CASES_DATE = '2026-10-10'

/**
 * Per-page metadata with canonical URL and matching Open Graph / Twitter fields. Pass `article` for docs pages:
 * Open Graph type "article" with the page's first and last change and section.
 */
export function pageMetadata({ title, description, path, image = DEFAULT_SOCIAL_IMAGE, article }: {
  title: string
  description: string
  path: string
  image?: SocialImage
  article?: { publishedTime?: string; modifiedTime?: string; section?: string }
}): Metadata {
  const social = `${title} | ${SITE_NAME}`
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: article
      ? { type: 'article', locale: 'en_US', siteName: SITE_NAME, title: social, description, url: path, images: [image], authors: [OWNER.website], ...(article.publishedTime ? { publishedTime: article.publishedTime } : {}), ...(article.modifiedTime ? { modifiedTime: article.modifiedTime } : {}), ...(article.section ? { section: article.section } : {}) }
      : { type: 'website', locale: 'en_US', siteName: SITE_NAME, title: social, description, url: path, images: [image] },
    twitter: { card: 'summary_large_image', title: social, description, images: [{ url: image.url, alt: image.alt }] },
  }
}

const absolute = (path: string) => `${SITE_URL}${path === '/' ? '' : path}`
const docImage = (path: string) => `${SITE_URL}/docs-assets/${path}`

/**
 * Sitemap: static pages, the use-case pages with their screenshot, then every docs page with its last commit
 * date and the screenshots it shows (Google's image sitemap extension). The home page and the docs index
 * change whenever the docs do.
 */
export function sitemapEntries(docPages: Pick<ManifestPage, 'slug' | 'lastModified' | 'images'>[], homeImages: string[] = []): MetadataRoute.Sitemap {
  const newest = docPages.map(page => page.lastModified).filter((date): date is string => Boolean(date)).sort((a, b) => Date.parse(b) - Date.parse(a))[0]
  const legal = new Set(LEGAL_LINKS.map(link => link.href))
  const staticDate = (path: string): string | undefined => {
    if (legal.has(path)) return POLICY_DATE
    if (path === '/about') return ABOUT_DATE
    if (path === USE_CASES_PATH) return USE_CASES_DATE
    // No date for /changelog: release-notes.json lists versions without release dates.
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
    ...USE_CASES.map(useCase => ({
      url: absolute(useCasePath(useCase.slug)),
      lastModified: USE_CASES_DATE,
      changeFrequency: 'monthly' as const,
      priority: 0.8,
      images: [absolute(useCase.screenshot.src)],
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

/** Stable @ids of the site's structured-data nodes: every page refers to the same site, app, source code and owner. */
export const SCHEMA_IDS = {
  website: `${SITE_URL}/#website`,
  webpage: `${SITE_URL}/#webpage`,
  software: `${SITE_URL}/#software`,
  source: `${SITE_URL}/#source`,
  person: `${SITE_URL}/about#person`,
} as const
const APACHE_LICENSE = 'https://www.apache.org/licenses/LICENSE-2.0'
const person = { '@type': 'Person', '@id': SCHEMA_IDS.person, name: OWNER.name, url: OWNER.website, sameAs: [OWNER.github, OWNER.linkedin] }
/** Author and publisher of docs and use-case pages: the Person node by @id, with the name and URL Google reads from an author. */
const author = { '@type': 'Person', '@id': SCHEMA_IDS.person, name: OWNER.name, url: OWNER.website }
const imageObject = (shot: Pick<HomeScreenshot, 'src' | 'width' | 'height' | 'caption'>) => ({ '@type': 'ImageObject', url: absolute(shot.src), width: shot.width, height: shot.height, caption: shot.caption })

/**
 * The home page's structured data as one @graph: the site, the home page, the app, its source code and its owner.
 * Other pages refer to these nodes by @id. Version and dateModified follow the current release, when there is one.
 */
export function homeGraph(release: { version: string; releasedAt: string } | null): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', '@id': SCHEMA_IDS.website, url: SITE_URL, name: SITE_NAME, description: SITE_DESCRIPTION, inLanguage: 'en', publisher: { '@id': SCHEMA_IDS.person } },
      { '@type': 'WebPage', '@id': SCHEMA_IDS.webpage, url: SITE_URL, description: SITE_DESCRIPTION, inLanguage: 'en', isPartOf: { '@id': SCHEMA_IDS.website }, about: { '@id': SCHEMA_IDS.software }, primaryImageOfPage: imageObject(HERO_SCREENSHOT) },
      {
        '@type': 'SoftwareApplication',
        '@id': SCHEMA_IDS.software,
        name: SITE_NAME,
        description: SITE_DESCRIPTION,
        url: SITE_URL,
        image: absolute(HERO_SCREENSHOT.src),
        screenshot: [HERO_SCREENSHOT, ...GALLERY_SCREENSHOTS].map(shot => absolute(shot.src)),
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Windows 10, Windows 11, Linux, macOS 12+',
        // As documented in docs/site/install.md.
        softwareRequirements: 'Windows 10/11 x64; Linux x86-64 with glibc 2.25+ (bundled WebKit needs glibc 2.38+); macOS 12+',
        releaseNotes: absolute('/changelog'),
        isAccessibleForFree: true,
        license: APACHE_LICENSE,
        featureList: FEATURES.map(feature => feature.title),
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        author: { '@id': SCHEMA_IDS.person },
        sameAs: [REPO_URL],
        ...(release ? { softwareVersion: release.version, dateModified: release.releasedAt, downloadUrl: `${SITE_URL}/#download` } : {}),
      },
      { '@type': 'SoftwareSourceCode', '@id': SCHEMA_IDS.source, name: `${SITE_NAME} source code`, codeRepository: REPO_URL, license: APACHE_LICENSE, programmingLanguage: 'TypeScript', targetProduct: { '@id': SCHEMA_IDS.software }, author: { '@id': SCHEMA_IDS.person } },
      person,
    ],
  }
}

/** schema.org ProfilePage for /about: the owner's Person node (same @id as everywhere else) as its main entity. */
export function profilePage({ description, bio }: { description: string; bio: string }): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    url: absolute('/about'),
    description,
    inLanguage: 'en',
    dateModified: ABOUT_DATE,
    isPartOf: { '@id': SCHEMA_IDS.website },
    mainEntity: { ...person, description: bio },
  }
}

/** schema.org BreadcrumbList from the site root down to the current page. */
export function breadcrumbList(items: { name: string; path: string }[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({ '@type': 'ListItem', position: i + 1, name: item.name, item: absolute(item.path) })),
  }
}
/** Breadcrumbs of a top-level page: Home > name. */
export function pageBreadcrumbs(name: string, path: string): Record<string, unknown> {
  return breadcrumbList([{ name: 'Home', path: '/' }, { name, path }])
}
/** Breadcrumbs of a policy page (Home > title). Its path comes from the legal links, whose labels start the page titles. */
export function legalBreadcrumbs(title: string): Record<string, unknown> | null {
  const link = LEGAL_LINKS.find(l => title.startsWith(l.label))
  return link ? pageBreadcrumbs(title, link.href) : null
}

/** schema.org TechArticle for a docs page; the first screenshot it shows doubles as its image. */
export function docArticle(doc: Pick<ManifestPage, 'slug' | 'title' | 'datePublished' | 'lastModified' | 'images'> & { description: string; section: string }): Record<string, unknown> {
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
    ...(doc.datePublished ? { datePublished: doc.datePublished } : {}),
    ...(doc.lastModified ? { dateModified: doc.lastModified } : {}),
    author,
    publisher: author,
    isPartOf: { '@id': SCHEMA_IDS.website },
    about: { '@id': SCHEMA_IDS.software },
  }
}

/** schema.org WebPage for a use-case landing page: about the app, with its screenshot as the primary image. */
export function useCaseWebPage(useCase: Pick<UseCase, 'slug' | 'title' | 'description' | 'h1' | 'screenshot' | 'primaryKeyword' | 'secondaryKeywords'>): Record<string, unknown> {
  const url = absolute(useCasePath(useCase.slug))
  return {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: useCase.title,
    headline: useCase.h1,
    description: useCase.description,
    url,
    inLanguage: 'en',
    keywords: [useCase.primaryKeyword, ...useCase.secondaryKeywords].join(', '),
    primaryImageOfPage: imageObject(useCase.screenshot),
    dateModified: USE_CASES_DATE,
    isPartOf: { '@id': SCHEMA_IDS.website },
    about: { '@id': SCHEMA_IDS.software },
    author,
    publisher: author,
  }
}

/** schema.org FAQPage from question and answer pairs (the answer text only, without the link). */
export function faqPage(faqs: Pick<UseCaseFaq, 'question' | 'answer'>[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(faq => ({ '@type': 'Question', name: faq.question, acceptedAnswer: { '@type': 'Answer', text: faq.answer } })),
  }
}

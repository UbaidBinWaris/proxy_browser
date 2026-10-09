import type { MetadataRoute } from 'next'
import { allPages, loadManifest } from '@/lib/docs'
import { sitemapEntries } from '@/lib/seo'

export const dynamic = 'force-dynamic'
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return sitemapEntries(allPages(await loadManifest()).map(page => page.slug))
}

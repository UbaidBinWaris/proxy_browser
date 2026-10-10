import type { MetadataRoute } from 'next'
import { allPages, loadManifest } from '@/lib/docs'
import { GALLERY_SCREENSHOTS, HERO_SCREENSHOT } from '@/lib/home'
import { sitemapEntries } from '@/lib/seo'

export const dynamic = 'force-dynamic'
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return sitemapEntries(allPages(await loadManifest()), [HERO_SCREENSHOT, ...GALLERY_SCREENSHOTS].map(shot => shot.src))
}

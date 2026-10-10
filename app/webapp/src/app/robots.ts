import type { MetadataRoute } from 'next'
import { SITE_URL } from '@/lib/site'

// /api/ holds the release downloads, update feed and admin API. /admin stays crawlable so its noindex meta is seen.
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: '*', allow: '/', disallow: ['/api/'] }], sitemap: `${SITE_URL}/sitemap.xml` }
}

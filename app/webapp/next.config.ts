import type { NextConfig } from 'next'

/**
 * Screenshots were served from /screenshots/ until 2026-10-10, when they moved to the docs images
 * (/docs-assets/images/), some under a new name. Search engines indexed the old URLs from the image sitemap and
 * still request them, so each one redirects permanently to the same picture, full size and 720 px copy.
 */
export const MOVED_SCREENSHOTS: Record<string, string> = {
  'consent-check-evidence': 'check-evidence',
  'launch-device-picker': 'launch-device-picker',
  'launch-location-picker': 'launch-location-picker',
  'proxy-keys-providers': 'proxy-keys',
  'qa-matrix-results': 'qa-results',
}
const screenshotRedirects = Object.entries(MOVED_SCREENSHOTS).flatMap(([from, to]) =>
  ['', '-720'].map(size => ({ source: `/screenshots/${from}${size}.webp`, destination: `/docs-assets/images/${to}${size}.webp`, permanent: true })),
)

const config: NextConfig = {
  turbopack: { root: process.cwd() },
  poweredByHeader: false,
  reactStrictMode: true,
  images: { unoptimized: true },
  async redirects() {
    // The FAQ moved from the docs to its own page. Browsers keep the #fragment across the redirect, and every question
    // kept its heading id, so /docs/faq#is-there-a-mac-version still lands on its answer.
    return [{ source: '/docs/faq', destination: '/faq', permanent: true }, ...screenshotRedirects]
  },
  async headers() {
    // Docs screenshots and brand files keep their names across releases, so they are cached for a day, not immutable.
    const assetCache = [{ key: 'Cache-Control', value: 'public, max-age=86400, stale-while-revalidate=604800' }]
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ] }, { source: '/docs-assets/:path*', headers: assetCache }, { source: '/brand/:path*', headers: assetCache }]
  },
}
export default config

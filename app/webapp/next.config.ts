import type { NextConfig } from 'next'

const config: NextConfig = {
  turbopack: { root: process.cwd() },
  poweredByHeader: false,
  reactStrictMode: true,
  images: { unoptimized: true },
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

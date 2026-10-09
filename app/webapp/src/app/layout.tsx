import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import { SiteFooter, SiteHeader } from '@/components/SiteChrome'
import { OWNER, SITE_DESCRIPTION, SITE_NAME, SITE_URL } from '@/lib/site'
import './globals.css'
// Every page is rendered per request so Next.js can apply the CSP nonce from src/proxy.ts.
export const dynamic = 'force-dynamic'
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: `${SITE_NAME} — Free, open-source QA browser for Windows, Linux and macOS`, template: `%s | ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  authors: [{ name: OWNER.name, url: OWNER.website }],
  creator: OWNER.name,
  alternates: { canonical: '/' },
  openGraph: { type: 'website', siteName: SITE_NAME, title: `${SITE_NAME} — Free, open-source QA browser`, description: SITE_DESCRIPTION, url: '/', locale: 'en' },
  twitter: { card: 'summary_large_image', title: `${SITE_NAME} — Free, open-source QA browser`, description: SITE_DESCRIPTION },
  robots: { index: true, follow: true },
  icons: { icon: '/favicon.ico', apple: '/brand/icon.png' },
}
export const viewport: Viewport = { themeColor: '#fbfaf7', colorScheme: 'light' }
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body><a className="skip-link" href="#main">Skip to content</a><div className="site-shell"><SiteHeader /><main id="main">{children}</main><SiteFooter /></div></body></html>
}

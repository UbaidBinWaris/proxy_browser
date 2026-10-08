import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import './globals.css'
export const dynamic = 'force-dynamic'
export const metadata: Metadata = {
  metadataBase: new URL('https://proxybrowser.ubaidbinwaris.com'),
  title: 'Proxy QA Browser — Your testing workspace, ready to go',
  description: 'Download Proxy QA Browser for Windows and Linux. Isolated browser profiles, your own proxies, repeatable tests, and verified updates in one desktop app.',
  icons: { icon: '/favicon.ico', apple: '/brand/icon.png' },
}
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body><div className="site-shell"><header className="site-header"><a className="brand" href="/" aria-label="Proxy QA Browser home"><img src="/brand/logo.svg" width="38" height="38" alt="" /><span>Proxy QA<span className="brand-light"> Browser</span></span></a><nav aria-label="Main navigation"><a href="/#features">Features</a><a href="/#how-it-works">How it works</a><a className="nav-download" href="/#download">Get the browser <span aria-hidden="true">↗</span></a></nav></header>{children}<footer><a className="brand" href="/"><img src="/brand/logo.svg" width="28" height="28" alt="" /><span>Proxy QA Browser</span></a><p>A focused workspace for authorized browser testing.</p><div><a href="/privacy">Privacy</a><a href="/#download">Downloads</a><span>© {new Date().getFullYear()}</span></div></footer></div></body></html>
}

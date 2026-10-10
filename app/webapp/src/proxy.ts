import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function proxy(request: NextRequest) {
  const nonce = randomBytes(16).toString('base64')
  const policy = ["default-src 'self'", `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`, "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"].join('; ')
  const headers = new Headers(request.headers)
  headers.set('x-nonce', nonce)
  headers.set('Content-Security-Policy', policy)
  const response = NextResponse.next({ request: { headers } })
  response.headers.set('Content-Security-Policy', policy)
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}
// Pages get a per-request nonce; static files, metadata images and security.txt keep their own cache headers.
export const config = { matcher: ['/((?!api|_next/static|_next/image|favicon.ico|brand|docs-assets|og/|.well-known|llms.txt|robots.txt|sitemap.xml|opengraph-image).*)'] }

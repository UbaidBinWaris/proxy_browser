import { securityTxt } from '@/lib/security-txt'

export const dynamic = 'force-dynamic'
export function GET(): Response {
  return new Response(securityTxt(), { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } })
}

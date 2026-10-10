import { loadDoc } from '@/lib/docs'
import { socialCard } from '@/lib/social-card'

/** Social preview of one docs page (/og/<slug>): its section, title and description headline. */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const doc = await loadDoc((await params).slug)
  if (!doc) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })
  const image = await socialCard({ eyebrow: `Documentation · ${doc.section}`, lines: [doc.title], footer: ['proxybrowser.ubaidbinwaris.com/docs', 'Free & open source'] })
  image.headers.set('Cache-Control', 'public, max-age=3600')
  return image
}

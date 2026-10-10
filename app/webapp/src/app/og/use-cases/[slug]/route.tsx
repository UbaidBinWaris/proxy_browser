import { socialCard } from '@/lib/social-card'
import { findUseCase } from '@/lib/use-cases'

/** Splits a title at the space nearest its middle: the card's headline line and its accent-coloured second line. */
function headline(title: string): [string, string?] {
  const words = title.split(' ')
  if (words.length < 3) return [title]
  let split = 1
  for (let i = 2; i < words.length; i++) {
    const gap = (n: number) => Math.abs(words.slice(0, n).join(' ').length - words.slice(n).join(' ').length)
    if (gap(i) < gap(split)) split = i
  }
  return [words.slice(0, split).join(' '), words.slice(split).join(' ')]
}

/** Social preview of one use-case page (/og/use-cases/<slug>): its name and search title. Unknown slugs are a 404. */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const useCase = findUseCase((await params).slug)
  if (!useCase) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })
  const image = await socialCard({ eyebrow: `Use case · ${useCase.navLabel}`, lines: headline(useCase.title), footer: ['proxybrowser.ubaidbinwaris.com/use-cases', 'Open source'] })
  image.headers.set('Cache-Control', 'public, max-age=3600')
  return image
}

import { currentRelease, errorResponse, newer, versionSchema } from '@/lib/releases'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  try {
    const release = await currentRelease(), current = new URL(request.url).searchParams.get('current')
    if (current) versionSchema.parse(current)
    return Response.json({ release, updateAvailable: !!release && (!current || newer(release.version, current)) }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) { return errorResponse(e) }
}

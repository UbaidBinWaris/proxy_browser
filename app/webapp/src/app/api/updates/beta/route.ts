import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { currentRelease, errorResponse, ReleaseError, storeRoot } from '@/lib/releases'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function GET() {
  try {
    const release = await currentRelease('beta')
    if (!release) throw new ReleaseError(404, 'No beta release is published yet.')
    return new Response(await readFile(join(storeRoot(), 'releases', release.version, 'update.json'), 'utf8'), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    })
  } catch (error) { return errorResponse(error) }
}

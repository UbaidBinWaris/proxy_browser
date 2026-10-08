import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { currentRelease, errorResponse, ReleaseError, storeRoot } from '@/lib/releases'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function GET() {
  try {
    const release = await currentRelease()
    if (!release) throw new ReleaseError(404, 'No release is published yet.')
    return new Response(await readFile(join(storeRoot(), 'releases', release.version, 'update.json'), 'utf8'), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
  } catch (e) { return errorResponse(e) }
}

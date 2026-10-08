import { authorize, boundedJson, currentRelease, errorResponse, publishRelease } from '@/lib/releases'
import { z } from 'zod'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  try { authorize(request); return Response.json({ release: await currentRelease() }, { headers: { 'Cache-Control': 'no-store' } }) } catch (e) { return errorResponse(e) }
}
export async function POST(request: Request) {
  try {
    authorize(request)
    const data = z.object({ usb: z.unknown(), online: z.unknown() }).parse(await boundedJson(request))
    return Response.json({ release: await publishRelease(data.usb, data.online) }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) { return errorResponse(e) }
}

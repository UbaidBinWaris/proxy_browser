import { authorize, errorResponse, uploadAsset } from '@/lib/releases'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function PUT(request: Request, context: { params: Promise<{ version: string; file: string }> }) {
  try { authorize(request); const p = await context.params; return Response.json(await uploadAsset(p.version, p.file, request), { headers: { 'Cache-Control': 'no-store' } }) } catch (e) { return errorResponse(e) }
}

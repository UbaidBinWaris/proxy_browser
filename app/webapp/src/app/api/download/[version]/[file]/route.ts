import { downloadResponse, errorResponse } from '@/lib/releases'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ version: string; file: string }> }
export async function GET(request: Request, context: Context) {
  try { const p = await context.params; return await downloadResponse(request, p.version, p.file) } catch (e) { return errorResponse(e) }
}
export async function HEAD(request: Request, context: Context) {
  try { const p = await context.params; return await downloadResponse(request, p.version, p.file, true) } catch (e) { return errorResponse(e) }
}

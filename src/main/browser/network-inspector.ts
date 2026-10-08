/**
 * Network inspector: records every request of a browser context as a
 * NetworkEntry and extracts lead / certificate identifiers from JSON responses.
 */
import type { BrowserContext, Request } from 'playwright-core'
import type { NetworkEntry, TestRun } from '@shared/types'
import type { Logger, NetworkRepository } from '../contracts'
import { redactUrl } from '../security/data-privacy'

const SCOPE = 'network'
const MAX_JSON_BODY_BYTES = 512 * 1024
const ID_KEYS = ['leadId', 'lead_id', 'certificateId', 'certificate_id'] as const
type IdKey = (typeof ID_KEYS)[number]

export interface NetworkInspectorOptions {
  context: BrowserContext
  runId: string
  network: NetworkRepository
  logger: Logger
  onEntry: (entry: NetworkEntry) => void
  /** Called when a response carried a lead/certificate id the run does not have yet. */
  onIdsExtracted: (patch: Pick<Partial<TestRun>, 'leadId' | 'certificateId'>) => void
}

interface PendingRequest {
  entry: NetworkEntry
  startedAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function idValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/** Pick known id keys from the top level, or one level down (e.g. `data.leadId`). */
export function extractIds(payload: unknown): Record<string, string> {
  const found: Record<string, string> = {}
  if (!isRecord(payload)) return found
  const scan = (obj: Record<string, unknown>): void => {
    for (const key of ID_KEYS) {
      const value = idValue(obj[key])
      if (value && !(key in found)) found[key] = value
    }
  }
  scan(payload)
  for (const nested of Object.values(payload)) {
    if (isRecord(nested)) scan(nested)
  }
  return found
}

export function runPatchFromIds(ids: Record<string, string>): Pick<Partial<TestRun>, 'leadId' | 'certificateId'> {
  const pick = (...keys: IdKey[]): string | undefined => keys.map((k) => ids[k]).find((v) => v !== undefined)
  const patch: Pick<Partial<TestRun>, 'leadId' | 'certificateId'> = {}
  const leadId = pick('leadId', 'lead_id')
  const certificateId = pick('certificateId', 'certificate_id')
  if (leadId) patch.leadId = leadId
  if (certificateId) patch.certificateId = certificateId
  return patch
}

function isJsonContentType(headers: Record<string, string>): boolean {
  const type = headers['content-type'] ?? ''
  return /\bapplication\/([\w.+-]*\+)?json\b/i.test(type)
}

function declaredLength(headers: Record<string, string>): number | null {
  const raw = headers['content-length']
  if (raw === undefined) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** Attach listeners; returns a detach function. */
export function attachNetworkInspector(opts: NetworkInspectorOptions): () => void {
  const { context, runId, network, logger, onEntry, onIdsExtracted } = opts
  const pending = new Map<Request, PendingRequest>()

  const onRequest = (request: Request): void => {
    try {
      const entry = network.insert({
        runId,
        method: request.method(),
        url: redactUrl(request.url()),
        status: null,
        resourceType: request.resourceType(),
        requestTime: new Date().toISOString(),
        responseTime: null,
        durationMs: null,
        extractedIds: {},
      })
      pending.set(request, { entry, startedAt: Date.now() })
      onEntry(entry)
    } catch (err) {
      logger.warn(SCOPE, `Could not record request: ${err instanceof Error ? err.message : String(err)}`, { runId })
    }
  }

  const finish = (request: Request, status: number | null, extractedIds: Record<string, string>): void => {
    const tracked = pending.get(request)
    if (!tracked) return
    pending.delete(request)
    const now = Date.now()
    const completed: NetworkEntry = {
      ...tracked.entry,
      status,
      responseTime: new Date(now).toISOString(),
      durationMs: now - tracked.startedAt,
      extractedIds,
    }
    try {
      network.complete(completed.id, {
        status: completed.status,
        responseTime: completed.responseTime,
        durationMs: completed.durationMs,
        extractedIds: completed.extractedIds,
      })
    } catch (err) {
      logger.warn(SCOPE, `Could not complete request record: ${err instanceof Error ? err.message : String(err)}`, {
        runId,
      })
    }
    onEntry(completed)
    const patch = runPatchFromIds(extractedIds)
    if (patch.leadId || patch.certificateId) onIdsExtracted(patch)
  }

  const readJsonIds = async (request: Request): Promise<Record<string, string>> => {
    const response = await request.response()
    if (!response) return {}
    const headers = await response.allHeaders()
    if (!isJsonContentType(headers)) return {}
    const length = declaredLength(headers)
    if (length !== null && length > MAX_JSON_BODY_BYTES) return {}
    const body = await response.body()
    if (body.byteLength > MAX_JSON_BODY_BYTES) return {}
    return extractIds(JSON.parse(body.toString('utf8')))
  }

  const onRequestFinished = (request: Request): void => {
    void (async () => {
      let status: number | null = null
      let ids: Record<string, string> = {}
      try {
        const response = await request.response()
        status = response?.status() ?? null
        ids = await readJsonIds(request)
      } catch {
        // Bodies are unavailable for redirects, aborted navigations and non-JSON payloads; ignore.
      }
      finish(request, status, ids)
    })()
  }

  const onRequestFailed = (request: Request): void => {
    finish(request, null, {})
  }

  context.on('request', onRequest)
  context.on('requestfinished', onRequestFinished)
  context.on('requestfailed', onRequestFailed)

  return () => {
    context.off('request', onRequest)
    context.off('requestfinished', onRequestFinished)
    context.off('requestfailed', onRequestFailed)
    pending.clear()
  }
}

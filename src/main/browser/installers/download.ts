/**
 * HTTPS downloads for the installers: redirects are followed, the body is
 * streamed straight to disk (never buffered whole), bytes are counted for
 * progress and hashed (SHA-256) on the fly, and the result is checked against
 * the expected size and digest when the vendor publishes them.
 *
 * `fetch` is injectable so tests serve fixtures without a network.
 */
import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

/** Anything smaller cannot be a browser package; it is an error page or a truncated transfer. */
export const MIN_PACKAGE_BYTES = 1024 * 1024
export const USER_AGENT = 'ProxyQABrowser-installer (+https://github.com/UbaidBinWaris/proxy_browser)'

export class DownloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DownloadError'
  }
}

function describeFetchFailure(url: string, err: unknown): DownloadError {
  const reason = err instanceof Error ? (err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message) : String(err)
  return new DownloadError(`Could not reach ${new URL(url).host} (${reason}). Check your internet connection and try again.`)
}

async function get(url: string, fetchImpl: FetchFn, signal: AbortSignal | undefined, accept: string): Promise<Response> {
  let response: Response
  try {
    response = await fetchImpl(url, { redirect: 'follow', headers: { 'user-agent': USER_AGENT, accept }, ...(signal ? { signal } : {}) })
  } catch (err) {
    if (signal?.aborted) throw new DownloadError('The download was cancelled.')
    throw describeFetchFailure(url, err)
  }
  if (!response.ok) throw new DownloadError(`${new URL(url).host} answered HTTP ${response.status} for ${url}.`)
  return response
}

export async function fetchText(url: string, fetchImpl: FetchFn, signal?: AbortSignal): Promise<string> {
  return (await get(url, fetchImpl, signal, 'text/html,text/plain,*/*')).text()
}

export async function fetchJson(url: string, fetchImpl: FetchFn, signal?: AbortSignal): Promise<unknown> {
  return (await get(url, fetchImpl, signal, 'application/json')).json() as Promise<unknown>
}

export interface DownloadOptions {
  url: string
  destination: string
  fetchImpl: FetchFn
  signal?: AbortSignal
  /** Called as bytes arrive; `total` is null when the server sent no Content-Length. */
  onProgress?: (received: number, total: number | null) => void
  /** Exact size published by the vendor (e.g. the GitHub release asset size). */
  expectedSize?: number | null
  /** Lower-case hex SHA-256 published by the vendor. */
  expectedSha256?: string | null
  minBytes?: number
  maxBytes?: number
}

export interface DownloadResult {
  bytes: number
  sha256: string
}

/** Stream `url` to `destination`; the partial file is removed on any failure. */
export async function downloadToFile(options: DownloadOptions): Promise<DownloadResult> {
  const { url, destination, fetchImpl, signal, onProgress } = options
  mkdirSync(path.dirname(destination), { recursive: true })
  const response = await get(url, fetchImpl, signal, 'application/octet-stream,*/*')
  if (!response.body) throw new DownloadError(`${new URL(url).host} sent an empty response for ${url}.`)
  // With a content-encoding, Content-Length counts the encoded bytes while fetch hands over decoded ones.
  const encoded = (response.headers.get('content-encoding') ?? 'identity').toLowerCase() !== 'identity'
  const header = encoded ? Number.NaN : Number(response.headers.get('content-length'))
  const total = Number.isFinite(header) && header > 0 ? header : (options.expectedSize ?? null)

  const hash = createHash('sha256')
  let received = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length
      if (options.maxBytes !== undefined && received > options.maxBytes) { callback(new DownloadError('Download exceeds the permitted size.')); return }
      hash.update(chunk)
      onProgress?.(received, total)
      callback(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), meter, createWriteStream(destination))
  } catch (err) {
    rmSync(destination, { force: true })
    if (signal?.aborted) throw new DownloadError('The download was cancelled.')
    throw describeFetchFailure(url, err)
  }

  const sha256 = hash.digest('hex')
  const fail = (message: string): never => {
    rmSync(destination, { force: true })
    throw new DownloadError(message)
  }
  const minBytes = options.minBytes ?? MIN_PACKAGE_BYTES
  if (received < minBytes) fail(`The download from ${new URL(url).host} is only ${received} bytes — not a browser package. Try again later.`)
  if (total !== null && received !== total) fail(`The download from ${new URL(url).host} is incomplete (${received} of ${total} bytes). Try again.`)
  if (options.expectedSize && received !== options.expectedSize) fail(`The download is ${received} bytes but the vendor lists ${options.expectedSize}. Try again.`)
  if (options.expectedSha256 && sha256 !== options.expectedSha256.toLowerCase()) fail('The download does not match the SHA-256 checksum published by the vendor. Try again.')
  return { bytes: received, sha256 }
}

/** "42.0 MB" style size for progress lines. */
export function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

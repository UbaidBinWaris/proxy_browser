/**
 * File uploads to site access origins.
 *
 * Tokenized requests are performed by the app (`route.fetch`, so redirects never carry the header).
 * For a classic multipart form post, Chromium (file-backed inputs) and WebKit leave the bytes of files
 * chosen from disk out of the request body Playwright exposes; re-sending it would upload empty files.
 * On token-listed origins only, a page script hands each file the user picks in `<input type=file>` to
 * the app as soon as it is chosen (a Playwright binding, bounded in size), and the terminal route
 * refills empty file parts from that cache (security/multipart-files.ts).
 *
 * Pushed, not pulled: reading from the page while its navigation is paused in the route would deadlock.
 * Only frames whose origin is token-listed may push, so other frames cannot plant bytes, and files are
 * never read on any other site; the page itself could already read the files it was given.
 */
import type { BrowserContext } from 'playwright-core'

export const FILE_CAPTURE_BINDING = '__proxyQaSiteAccessFile'
/** Per file and in total: larger files are not kept, and such uploads are blocked rather than sent empty. */
export const FILE_CAPTURE_MAX_FILE_BYTES = 25 * 1024 * 1024
export const FILE_CAPTURE_MAX_TOTAL_BYTES = 50 * 1024 * 1024
/** How long a request waits for a file that was chosen but is still being read. */
export const FILE_CAPTURE_WAIT_MS = 5000

/** Init-script source: announce each chosen file, then send its bytes (token-listed origins only). */
export function fileCaptureScript(origins: readonly string[]): string {
  const config = JSON.stringify({ binding: FILE_CAPTURE_BINDING, origins, maxFile: FILE_CAPTURE_MAX_FILE_BYTES })
  return `(() => {
  const config = ${config}
  if (!config.origins.includes(location.origin) || window.__proxyQaFileCaptureInstalled) return
  Object.defineProperty(window, '__proxyQaFileCaptureInstalled', { value: true })
  const send = (...args) => { const binding = window[config.binding]; if (typeof binding === 'function') binding(...args).catch(() => {}) }
  const toBase64 = (buffer) => {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(at, at + 0x8000))
    return btoa(binary)
  }
  window.addEventListener('change', (event) => {
    const input = event.target
    if (!(input instanceof HTMLInputElement) || input.type !== 'file' || !input.files) return
    for (const file of input.files) {
      if (file.size > config.maxFile) { send('skip', file.name, file.size); continue }
      send('announce', file.name, file.size)
      file.arrayBuffer().then((buffer) => send('data', file.name, file.size, toBase64(buffer)), () => send('skip', file.name, file.size))
    }
  }, true)
})()`
}

interface Entry {
  size: number
  bytes: Buffer | null
  ready: Promise<void>
  settle: () => void
}

export interface FileCapture {
  /** The kept bytes of `names` chosen on `origin`; waits for files still being read (bounded). Missing names are absent. */
  files(origin: string, names: readonly string[], waitMs?: number): Promise<Map<string, Buffer>>
}

/** Install the binding and page script on a context; `origins` are the token-listed origins. */
export async function installFileCapture(context: BrowserContext, origins: ReadonlySet<string>): Promise<FileCapture> {
  const entries = new Map<string, Entry>() // `${origin}\n${name}`, oldest first
  let total = 0
  const keyOf = (origin: string, name: string): string => `${origin}\n${name}`
  const drop = (key: string): void => {
    const entry = entries.get(key)
    if (!entry) return
    total -= entry.bytes?.length ?? 0
    entries.delete(key)
    entry.settle()
  }

  await context.exposeBinding(FILE_CAPTURE_BINDING, (source, op: unknown, name: unknown, size: unknown, data: unknown) => {
    let origin: string
    try {
      origin = new URL(source.frame.url()).origin
    } catch {
      return
    }
    if (!origins.has(origin) || typeof name !== 'string' || name.length === 0 || name.length > 255 || typeof size !== 'number') return
    const key = keyOf(origin, name)
    if (op === 'announce') {
      drop(key)
      let settle = (): void => undefined
      const ready = new Promise<void>((resolve) => (settle = resolve))
      entries.set(key, { size, bytes: null, ready, settle })
    } else if (op === 'data' && typeof data === 'string') {
      const entry = entries.get(key)
      const bytes = Buffer.from(data, 'base64')
      if (!entry || bytes.length !== size || size > FILE_CAPTURE_MAX_FILE_BYTES) return drop(key)
      while (total + bytes.length > FILE_CAPTURE_MAX_TOTAL_BYTES && entries.size > 0) drop(entries.keys().next().value as string)
      entry.bytes = bytes
      total += bytes.length
      entry.settle()
    } else if (op === 'skip') drop(key)
  })
  await context.addInitScript({ content: fileCaptureScript([...origins]) })

  return {
    async files(origin, names, waitMs = FILE_CAPTURE_WAIT_MS) {
      const pending = names.map((name) => entries.get(keyOf(origin, name))?.ready).filter((ready) => ready !== undefined)
      if (pending.length) await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, waitMs))])
      const found = new Map<string, Buffer>()
      for (const name of names) {
        const bytes = entries.get(keyOf(origin, name))?.bytes
        if (bytes) found.set(name, bytes)
      }
      return found
    },
  }
}

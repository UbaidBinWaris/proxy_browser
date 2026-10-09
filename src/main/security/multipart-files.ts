/**
 * Restores file contents in intercepted multipart form posts. Shared by the QA navigation guard
 * (fixtures) and site access tokens (files the user picked, see site-access/file-capture.ts).
 *
 * The navigation guard performs document requests itself (`route.fetch`, so every redirect hop is
 * checked). For a classic `<form enctype="multipart/form-data">` post, Chromium (file-backed inputs)
 * and WebKit leave the bytes of chosen files out of the request body Playwright sees, so re-sending
 * that body would upload empty files. During a run every uploaded file is one of the scenario's own
 * fixtures, so a file part that arrives empty is refilled with the fixture of the same file name.
 * Nothing else changes: same URL, same headers (Playwright recomputes the length), no new data.
 */

/** The boundary of a multipart/form-data Content-Type, or null. */
export function multipartBoundary(contentType: string | undefined): string | null {
  const match = /^\s*multipart\/form-data\s*;(?:.*;)?\s*boundary=(?:"([^"]{1,70})"|([^;\s]{1,70}))/i.exec(contentType ?? '')
  return match ? (match[1] ?? match[2] ?? null) : null
}

const CRLF = Buffer.from('\r\n')
const HEADER_END = Buffer.from('\r\n\r\n')

/**
 * The body with empty file parts refilled from `fixtures` (file name → bytes), or null when nothing
 * needed restoring (not multipart, no empty file part with a known name, or an unexpected layout).
 */
export function restoreMultipartFiles(
  contentType: string | undefined,
  body: Buffer | null,
  fixtures: ReadonlyMap<string, Buffer>,
): Buffer | null {
  const boundary = multipartBoundary(contentType)
  if (!boundary || !body || fixtures.size === 0) return null
  const delimiter = Buffer.from(`--${boundary}`)
  const positions: number[] = []
  for (let at = body.indexOf(delimiter); at !== -1; at = body.indexOf(delimiter, at + delimiter.length)) positions.push(at)
  if (positions.length < 2) return null
  const out: Buffer[] = [body.subarray(0, positions[0])]
  let changed = false
  for (const [index, start] of positions.entries()) {
    const end = positions[index + 1] ?? body.length
    const segment = body.subarray(start + delimiter.length, end)
    out.push(delimiter)
    const headerEnd = segment.indexOf(HEADER_END)
    // The closing delimiter ("--") and anything malformed are kept byte for byte.
    if (index === positions.length - 1 || !segment.subarray(0, 2).equals(CRLF) || headerEnd === -1) {
      out.push(segment)
      continue
    }
    const headers = segment.subarray(2, headerEnd).toString('latin1')
    const content = segment.subarray(headerEnd + HEADER_END.length, segment.length - CRLF.length)
    const name = /;\s*filename="([^"]*)"/i.exec(headers)?.[1]
    const fixture = name !== undefined ? fixtures.get(name) : undefined
    if (fixture && fixture.length > 0 && content.length === 0 && segment.subarray(segment.length - 2).equals(CRLF)) {
      out.push(segment.subarray(0, headerEnd + HEADER_END.length), fixture, CRLF)
      changed = true
    } else out.push(segment)
  }
  return changed ? Buffer.concat(out) : null
}

/** File names of parts that carry a file name but arrived with no content (the bytes the browser left out). */
export function emptyFileParts(contentType: string | undefined, body: Buffer | null): string[] {
  const boundary = multipartBoundary(contentType)
  if (!boundary || !body) return []
  const delimiter = Buffer.from(`--${boundary}`)
  const names: string[] = []
  const positions: number[] = []
  for (let at = body.indexOf(delimiter); at !== -1; at = body.indexOf(delimiter, at + delimiter.length)) positions.push(at)
  for (const [index, start] of positions.entries()) {
    if (index === positions.length - 1) break
    const segment = body.subarray(start + delimiter.length, positions[index + 1])
    const headerEnd = segment.indexOf(HEADER_END)
    if (!segment.subarray(0, 2).equals(CRLF) || headerEnd === -1) continue
    const name = /;\s*filename="([^"]+)"/i.exec(segment.subarray(2, headerEnd).toString('latin1'))?.[1]
    const content = segment.subarray(headerEnd + HEADER_END.length, segment.length - CRLF.length)
    if (name && content.length === 0) names.push(name)
  }
  return names
}

/// <reference lib="dom" />
/**
 * Content-Security-Policy bootstrap for the renderer.
 *
 * Why not a static `<meta http-equiv="Content-Security-Policy">` in index.html?
 * In `npm run dev`, @vitejs/plugin-react injects an inline React Fast Refresh preamble
 * `<script type="module">` into the HTML and the Vite client opens a WebSocket for HMR.
 * A strict static meta policy (no 'unsafe-inline', connect-src 'self') blocks both and
 * breaks hot reload. The production policy must stay strict, though.
 *
 * So index.html carries the two policies as plain `<meta name="csp-production">` /
 * `<meta name="csp-development">` tags and this module appends the matching
 * `<meta http-equiv="Content-Security-Policy">` as the very first thing the entry module does.
 * Chromium enforces a CSP meta element at the moment it is inserted into <head>: it governs
 * every resource loaded afterwards (dynamic imports, images, fetch/XHR, WebSockets, inline
 * scripts/styles). The only things loaded before this runs are the entry script and the
 * stylesheet referenced by index.html, both `'self'`.
 *
 * In development the main process additionally applies the same relaxed policy as an HTTP
 * header on the Vite dev server responses; in production (file://) this meta tag is the
 * effective policy.
 */

export type CspMode = 'production' | 'development'

export const CSP_SOURCE_META_NAME: Record<CspMode, string> = {
  production: 'csp-production',
  development: 'csp-development',
}

export interface InstallCspResult {
  /** The policy string that is now enforced, or null when nothing was installed. */
  policy: string | null
  reason: 'installed' | 'already-present' | 'source-missing'
}

/** Read the policy for `mode` from index.html's source meta tag and enforce it. Idempotent. */
export function installContentSecurityPolicy(doc: Document, mode: CspMode): InstallCspResult {
  const existing = doc.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy" i]')
  if (existing) return { policy: existing.content, reason: 'already-present' }

  const source = doc.querySelector<HTMLMetaElement>(`meta[name="${CSP_SOURCE_META_NAME[mode]}"]`)
  const policy = source?.content.trim() ?? ''
  if (policy === '') return { policy: null, reason: 'source-missing' }

  const meta = doc.createElement('meta')
  meta.httpEquiv = 'Content-Security-Policy'
  meta.content = policy
  doc.head.appendChild(meta)
  return { policy, reason: 'installed' }
}

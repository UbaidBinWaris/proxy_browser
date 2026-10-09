import { headers } from 'next/headers'

/**
 * Structured data. application/ld+json is not executed, but the CSP still governs inline <script> elements,
 * so the element carries the per-request nonce set by src/proxy.ts.
 */
export async function JsonLd({ data }: { data: Record<string, unknown> }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined
  return <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }} />
}

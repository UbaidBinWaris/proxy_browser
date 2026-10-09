/**
 * Pure redirect decision logic shared by the QA navigation guard (src/main/qa/navigation.ts) and the
 * site access adapter (src/main/security/redirects.ts). Real-browser behaviour is covered by
 * tests/qa-redirects-browser.test.ts.
 */
import { describe, expect, it } from 'vitest'
import {
  decideDocumentRedirect,
  isRedirectStatus,
  MAX_DOCUMENT_REDIRECTS,
  redirectKey,
  redirectTrampoline,
  REDIRECTS_DISABLED_MESSAGE,
  resolveRedirectTarget,
  trampolineResponse,
} from '../src/main/security/redirects'
import type { DocumentRedirectInput } from '../src/main/security/redirects'
import { redirectTrampoline as reexported } from '../src/main/site-access/attach'
import { ScenarioInputSchema } from '../src/shared/qa'

const A = 'https://forms.example.com'
const B = 'https://thanks.example.net'
const decide = (overrides: Partial<DocumentRedirectInput>) =>
  decideDocumentRedirect({ status: 302, location: '/next', requestUrl: `${A}/start`, method: 'GET', allowedOrigins: [A], hops: 0, ...overrides })

describe('resolveRedirectTarget', () => {
  it('resolves relative, root-relative, protocol-relative and absolute locations against the answering URL', () => {
    expect(resolveRedirectTarget('form', `${A}/start/here?x=1`)?.href).toBe(`${A}/start/form`)
    expect(resolveRedirectTarget('/form?a=1#top', `${A}/start`)?.href).toBe(`${A}/form?a=1#top`)
    expect(resolveRedirectTarget('//thanks.example.net/ok', `${A}/start`)?.href).toBe(`${B}/ok`)
    expect(resolveRedirectTarget(`${B}/ok`, `${A}/start`)?.href).toBe(`${B}/ok`)
    expect(resolveRedirectTarget('?step=2', `${A}/start`)?.href).toBe(`${A}/start?step=2`)
  })

  it('refuses non-web and unparsable targets', () => {
    expect(resolveRedirectTarget('javascript:alert(1)', `${A}/start`)).toBeNull()
    expect(resolveRedirectTarget('data:text/html,hi', `${A}/start`)).toBeNull()
    expect(resolveRedirectTarget('file:///etc/passwd', `${A}/start`)).toBeNull()
    expect(resolveRedirectTarget('http://[::1', `${A}/start`)).toBeNull()
  })
})

describe('decideDocumentRedirect', () => {
  it('follows a relative same-origin redirect as a fresh navigation', () => {
    const decision = decide({ location: 'form' })
    expect(decision.kind).toBe('navigate')
    expect(decision.kind === 'navigate' && decision.target.href).toBe(`${A}/form`)
  })

  it('follows a redirect to another approved origin', () => {
    const decision = decide({ status: 301, location: `${B}/ok`, allowedOrigins: [A, B] })
    expect(decision).toMatchObject({ kind: 'navigate' })
  })

  it('blocks a redirect to an unapproved origin and names only that origin', () => {
    const decision = decide({ location: `${B}/ok?token=secret` })
    expect(decision).toMatchObject({ kind: 'block', reason: 'unapproved-origin' })
    expect(decision.kind === 'block' && decision.message).toBe(`Navigation to an unapproved origin (${B}) was blocked (HTTP 302 redirect).`)
    expect(decision.kind === 'block' && decision.message).not.toContain('secret')
  })

  it('treats another port or scheme as another origin: http→https is followed only when both are approved', () => {
    const http = 'http://forms.example.com'
    expect(decide({ status: 301, requestUrl: `${http}/start`, location: `${A}/start`, allowedOrigins: [http] })).toMatchObject({
      kind: 'block',
      reason: 'unapproved-origin',
    })
    expect(decide({ status: 301, requestUrl: `${http}/start`, location: `${A}/start`, allowedOrigins: [http, A] })).toMatchObject({ kind: 'navigate' })
    expect(decide({ status: 308, requestUrl: `${http}/start`, location: `${A}/start`, allowedOrigins: [http, A] })).toMatchObject({ kind: 'navigate' })
    expect(decide({ location: 'https://forms.example.com:8443/x' })).toMatchObject({ kind: 'block', reason: 'unapproved-origin' })
  })

  it('stops a chain at the hop limit (loops)', () => {
    expect(decide({ hops: MAX_DOCUMENT_REDIRECTS - 1 })).toMatchObject({ kind: 'navigate' })
    const stopped = decide({ hops: MAX_DOCUMENT_REDIRECTS, location: '/start' })
    expect(stopped).toMatchObject({ kind: 'block', reason: 'hop-limit' })
    expect(stopped.kind === 'block' && stopped.message).toContain(`${MAX_DOCUMENT_REDIRECTS} HTTP redirects`)
    expect(decide({ hops: 2, maxRedirects: 2 })).toMatchObject({ kind: 'block', reason: 'hop-limit' })
  })

  it('turns 301/302/303 of a POST into a GET navigation (browser semantics)', () => {
    for (const status of [301, 302, 303]) expect(decide({ status, method: 'POST', location: `${B}/thanks`, allowedOrigins: [A, B] })).toMatchObject({ kind: 'navigate' })
  })

  it('replays a 307/308 POST within the same origin and blocks it across origins, even approved ones', () => {
    for (const status of [307, 308]) {
      expect(decide({ status, method: 'POST', location: '/submit/' })).toMatchObject({ kind: 'replay' })
      const cross = decide({ status, method: 'POST', location: `${B}/submit`, allowedOrigins: [A, B] })
      expect(cross).toMatchObject({ kind: 'block', reason: 'cross-origin-method' })
      expect(cross.kind === 'block' && cross.message).toContain(`${status} redirect of a POST`)
      // GET keeps being a plain navigation.
      expect(decide({ status, location: `${B}/x`, allowedOrigins: [A, B] })).toMatchObject({ kind: 'navigate' })
    }
  })

  it('blocks invalid and non-web locations', () => {
    expect(decide({ location: 'javascript:alert(1)' })).toMatchObject({ kind: 'block', reason: 'invalid-location', target: null })
  })

  it('blocks every redirect when following is turned off', () => {
    expect(decide({ followRedirects: false })).toMatchObject({ kind: 'block', reason: 'disabled', message: REDIRECTS_DISABLED_MESSAGE })
    expect(decide({ followRedirects: true })).toMatchObject({ kind: 'navigate' })
  })
})

describe('shared redirect helpers', () => {
  it('recognises only redirect statuses that carry a Location to follow', () => {
    expect([301, 302, 303, 307, 308].every(isRedirectStatus)).toBe(true)
    expect([200, 300, 304, 305, 306, 400].some(isRedirectStatus)).toBe(false)
  })

  it('keys follow-up navigations without the fragment', () => {
    expect(redirectKey(`${A}/form#top`)).toBe(`${A}/form`)
    expect(redirectKey(new URL(`${A}/form?a=1`))).toBe(`${A}/form?a=1`)
  })

  it('serves an uncached, escaped trampoline; site access re-exports the same helper', () => {
    const response = trampolineResponse(`${A}/a?b="</script>`)
    expect(response).toMatchObject({ status: 200, headers: { 'cache-control': 'no-store' } })
    expect(response.body).not.toContain('"</script>')
    expect(reexported).toBe(redirectTrampoline)
  })
})

describe('followRedirects scenario option', () => {
  const base = { name: 'x', profileId: 'p', startUrl: `${A}/`, allowedOrigins: [A], steps: [{ action: 'assertVisible', selector: 'h1' }] }

  it('is optional: scenarios saved before it parse unchanged (absent means follow)', () => {
    const parsed = ScenarioInputSchema.parse(base)
    expect('followRedirects' in parsed).toBe(false)
  })

  it('accepts true/false and rejects other values', () => {
    expect(ScenarioInputSchema.parse({ ...base, followRedirects: false }).followRedirects).toBe(false)
    expect(ScenarioInputSchema.parse({ ...base, followRedirects: true }).followRedirects).toBe(true)
    expect(ScenarioInputSchema.safeParse({ ...base, followRedirects: 'yes' }).success).toBe(false)
  })
})

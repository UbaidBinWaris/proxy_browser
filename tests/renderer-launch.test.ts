import { describe, expect, it } from 'vitest'
import type { AppError, BrowserSession, IpInfo, TestRun } from '../src/shared/types'
import {
  connectionKindFor,
  deriveLaunchSteps,
  failedStepFor,
  isBrowserWindowOpen,
  sessionLabelFor,
  stepLabel,
} from '../src/renderer/src/lib/launch'
import { buildOutcomePatch, hasOutcomeChanges, isUserAssignableStatus, outcomeFormFrom, syncOutcomeForm } from '../src/renderer/src/lib/runForm'
import type { OutcomeField } from '../src/renderer/src/lib/runForm'
import { installContentSecurityPolicy } from '../src/renderer/src/lib/csp'
import { errorLabel } from '../src/renderer/src/lib/result'
import { isZodJitless } from '../src/renderer/src/lib/zod-config'
import { ProfileInputSchema } from '../src/shared/types'

const ip: IpInfo = {
  ip: '203.0.113.7',
  country: 'United States',
  countryCode: 'US',
  region: 'Texas',
  city: 'Austin',
  postalCode: '78701',
  isp: 'Example ISP',
  asn: 'AS64500',
  latencyMs: 120,
  provider: 'ip-api',
  checkedAt: '2026-01-01T00:00:00.000Z',
}

function session(overrides: Partial<BrowserSession> = {}): BrowserSession {
  return {
    id: 's1',
    runId: 'r1',
    profileId: 'p1',
    profileName: 'Profile',
    engine: 'chromium',
    devicePreset: 'windows-desktop',
    provider: 'dataimpulse',
    proxyPool: 'residential',
    target: null,
    targetingString: null,
    targetMatch: null,
    status: 'starting',
    statusDetail: 'Validating profile…',
    ip: null,
    locationAttempts: 1,
    locationMaxAttempts: 1,
    locationWarning: null,
    proxySessionId: null,
    currentUrl: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    error: null,
    browserPid: null,
    lastHeartbeatAt: null,
    ...overrides,
  }
}

const err = (code: AppError['code'] | string, message = 'boom'): AppError => ({ code: code as AppError['code'], message })

const states = (s: BrowserSession, before?: BrowserSession['status']) => deriveLaunchSteps(s, { statusBeforeError: before }).map((step) => step.state)

describe('connection kind and session label', () => {
  it('derives direct / sticky / rotating from the profile mode and never calls an unknown mode "rotating"', () => {
    expect(connectionKindFor('none', null)).toBe('direct')
    expect(connectionKindFor('sticky', 'profile-x')).toBe('sticky')
    expect(connectionKindFor('rotating', null)).toBe('rotating')
    expect(connectionKindFor(null, 'profile-x')).toBe('sticky')
    expect(connectionKindFor(undefined, null)).toBe('unknown')
    expect(sessionLabelFor('direct', null)).toBe('none')
    expect(sessionLabelFor('rotating', null)).toBe('rotating')
    expect(sessionLabelFor('sticky', 'profile-x')).toBe('profile-x')
    expect(sessionLabelFor('unknown', null)).toBe('—')
  })

  it('labels the second step differently for direct runs', () => {
    expect(stepLabel('verifying', 'direct')).toBe('Checking exit IP')
    expect(stepLabel('verifying', 'sticky')).toBe('Verifying proxy')
  })
})

describe('launch steps while in progress', () => {
  it('walks Validating → Verifying → Launching → Open with exactly one active step', () => {
    expect(states(session({ status: 'starting' }))).toEqual(['active', 'pending', 'pending', 'pending'])
    expect(states(session({ status: 'verifying-proxy' }))).toEqual(['done', 'active', 'pending', 'pending'])
    expect(states(session({ status: 'launching', ip }))).toEqual(['done', 'done', 'active', 'pending'])
    expect(states(session({ status: 'open', ip }))).toEqual(['done', 'done', 'done', 'done'])
    expect(states(session({ status: 'closing', ip }))).toEqual(['done', 'done', 'done', 'done'])
    expect(states(session({ status: 'closed', ip }))).toEqual(['done', 'done', 'done', 'done'])
  })
})

describe('launch steps on failure', () => {
  it('marks only the step that was in progress as failed; earlier stay done, later stay pending', () => {
    const proxyFail = session({ status: 'error', error: err('PROXY_AUTH_FAILED') })
    expect(failedStepFor(proxyFail, 'verifying-proxy')).toBe('verifying')
    expect(states(proxyFail, 'verifying-proxy')).toEqual(['done', 'failed', 'pending', 'pending'])

    const launchFail = session({ status: 'error', ip, error: err('BROWSER_MISSING') })
    expect(states(launchFail, 'launching')).toEqual(['done', 'done', 'failed', 'pending'])

    const navFail = session({ status: 'error', ip, error: err('SITE_TIMEOUT') })
    expect(states(navFail, 'launching')).toEqual(['done', 'done', 'done', 'failed'])

    const validationFail = session({ status: 'error', error: err('INVALID_PROFILE') })
    expect(states(validationFail, 'starting')).toEqual(['failed', 'pending', 'pending', 'pending'])
  })

  it('attributes the forthcoming SITE_HTTP_ERROR code to the Open step and labels it', () => {
    const httpFail = session({ status: 'error', ip, currentUrl: 'https://example.com/form', error: err('SITE_HTTP_ERROR', 'HTTP 503') })
    expect(failedStepFor(httpFail)).toBe('open')
    expect(isBrowserWindowOpen(httpFail)).toBe(true)
    expect(errorLabel('SITE_HTTP_ERROR')).toBe('Site returned an HTTP error')
  })

  it('tells proxy-ish codes raised during navigation apart from verification failures', () => {
    const dnsDuringNav = session({ status: 'error', ip, error: err('DNS_FAILURE') })
    expect(failedStepFor(dnsDuringNav, 'launching')).toBe('open')
    expect(failedStepFor(dnsDuringNav)).toBe('open') // ip known → proxy phase already succeeded
    const dnsDuringVerify = session({ status: 'error', error: err('DNS_FAILURE') })
    expect(failedStepFor(dnsDuringVerify)).toBe('verifying')
    expect(failedStepFor(dnsDuringVerify, 'verifying-proxy')).toBe('verifying')
  })

  it('falls back to the pre-error status and progress signals for generic codes', () => {
    const internalWhileLaunching = session({ status: 'error', ip, error: err('INTERNAL') })
    expect(failedStepFor(internalWhileLaunching, 'launching')).toBe('launching')
    expect(failedStepFor(session({ status: 'error', ip, currentUrl: 'https://x', error: err('INTERNAL') }), 'launching')).toBe('open')
    expect(failedStepFor(session({ status: 'error', error: err('INTERNAL') }))).toBe('verifying')
    expect(failedStepFor(session({ status: 'error', ip, error: err('INTERNAL') }))).toBe('launching')
    expect(failedStepFor(session({ status: 'error', error: err('INTERNAL') }), 'open')).toBe('open')
  })

  it('reports an open browser window only for open sessions and navigation-phase failures', () => {
    expect(isBrowserWindowOpen(session({ status: 'open', ip }))).toBe(true)
    expect(isBrowserWindowOpen(session({ status: 'launching', ip }))).toBe(false)
    expect(isBrowserWindowOpen(session({ status: 'error', ip, error: err('SSL_ERROR') }))).toBe(true)
    expect(isBrowserWindowOpen(session({ status: 'error', error: err('PROXY_TIMEOUT') }))).toBe(false)
    expect(isBrowserWindowOpen(session({ status: 'error', ip, error: err('BROWSER_LAUNCH_FAILED') }))).toBe(false)
    expect(isBrowserWindowOpen(null)).toBe(false)
  })
})

describe('error labels', () => {
  it('humanises codes it has never seen instead of crashing', () => {
    expect(errorLabel('PROXY_AUTH_FAILED')).toBe('Proxy authentication failed')
    expect(errorLabel('SOME_FUTURE_CODE')).toBe('Some future code')
    expect(errorLabel('')).toBe('Error')
  })
})

describe('outcome form dirty tracking', () => {
  const run: TestRun = {
    id: 'r1',
    profileId: 'p1',
    profileName: 'Profile',
    engine: 'chromium',
    devicePreset: 'windows-desktop',
    proxyPool: 'residential',
    provider: 'dataimpulse',
    target: null,
    targetingString: null,
    targetMatch: null,
    publicIp: null,
    country: null,
    region: null,
    city: null,
    postalCode: null,
    locationAttempts: 1,
    locationMaxAttempts: 1,
    locationWarning: null,
    proxySessionId: null,
    formUrl: 'https://example.com/',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    status: 'running',
    notes: '',
    httpStatus: null,
    finalUrl: null,
    screenshotPath: null,
    leadId: null,
    certificateId: null,
    errorMessage: null,
  }

  it('only sends fields the user edited, so a notes edit cannot overwrite an auto-extracted id', () => {
    const form = { ...outcomeFormFrom(run), notes: 'looks fine' }
    const dirty: ReadonlySet<OutcomeField> = new Set(['notes'])
    // Meanwhile the main process extracted a lead id and pushed a run-update.
    const updated: TestRun = { ...run, leadId: 'L-42', certificateId: 'C-7' }
    const synced = syncOutcomeForm(form, updated, dirty)
    expect(synced.leadId).toBe('L-42')
    expect(synced.certificateId).toBe('C-7')
    expect(synced.notes).toBe('looks fine')
    const patch = buildOutcomePatch(updated, synced, dirty)
    expect(patch).toEqual({ notes: 'looks fine' })
    expect(hasOutcomeChanges(patch)).toBe(true)
  })

  it('keeps a dirty id field while syncing everything else, and normalises blanks to null', () => {
    const form = { ...outcomeFormFrom(run), leadId: '  typed-by-user ' }
    const dirty: ReadonlySet<OutcomeField> = new Set(['leadId'])
    const updated: TestRun = { ...run, leadId: 'auto', status: 'success', notes: 'server notes' }
    const synced = syncOutcomeForm(form, updated, dirty)
    expect(synced.leadId).toBe('  typed-by-user ')
    expect(synced.status).toBe('success')
    expect(synced.notes).toBe('server notes')
    expect(buildOutcomePatch(updated, synced, dirty)).toEqual({ leadId: 'typed-by-user' })
    expect(buildOutcomePatch({ ...updated, leadId: 'x' }, { ...synced, leadId: '   ' }, dirty)).toEqual({ leadId: null })
  })

  it('produces an empty patch when dirty fields equal the run again', () => {
    const form = { ...outcomeFormFrom(run), status: 'failed' as const }
    const dirty: ReadonlySet<OutcomeField> = new Set(['status'])
    expect(buildOutcomePatch(run, form, dirty)).toEqual({ status: 'failed' })
    expect(hasOutcomeChanges(buildOutcomePatch({ ...run, status: 'failed' }, form, dirty))).toBe(false)
    expect(hasOutcomeChanges(buildOutcomePatch(run, { ...form, leadId: 'ignored' }, new Set()))).toBe(false)
  })

  it('never writes a status the tester may not assign (running / aborted belong to the main process)', () => {
    const dirty: ReadonlySet<OutcomeField> = new Set(['status'])
    expect(buildOutcomePatch({ ...run, status: 'success' }, { ...outcomeFormFrom(run), status: 'running' }, dirty)).toEqual({})
    expect(buildOutcomePatch({ ...run, status: 'success' }, { ...outcomeFormFrom(run), status: 'aborted' }, dirty)).toEqual({})
    expect(isUserAssignableStatus('success')).toBe(true)
    expect(isUserAssignableStatus('failed')).toBe(true)
    expect(isUserAssignableStatus('running')).toBe(false)
    expect(isUserAssignableStatus('aborted')).toBe(false)
  })
})

describe('zod renderer configuration', () => {
  it('runs Zod in jitless mode so the strict CSP never sees an eval probe, and schemas still parse', () => {
    expect(isZodJitless()).toBe(true)
    const parsed = ProfileInputSchema.safeParse({
      name: 'CSP safe',
      engine: 'chromium',
      deviceType: 'desktop',
      devicePreset: 'windows-desktop',
      viewportWidth: 1920,
      viewportHeight: 1080,
      userAgent: null,
      locale: 'en-US',
      timezone: 'UTC',
      proxyMode: 'none',
      stickySessionId: null,
      formUrlOverride: null,
      notes: '',
    })
    expect(parsed.success).toBe(true)
  })
})

describe('content security policy bootstrap', () => {
  interface FakeMeta {
    tagName: string
    httpEquiv: string
    content: string
    getAttribute(name: string): string | null
  }

  function fakeDocument(sources: Record<string, string>, existing: string | null = null): { doc: Document; appended: FakeMeta[] } {
    const appended: FakeMeta[] = []
    const makeMeta = (name: string | null, content: string, httpEquiv = ''): FakeMeta => ({
      tagName: 'META',
      httpEquiv,
      content,
      getAttribute: (attr) => (attr === 'name' ? name : attr === 'http-equiv' ? httpEquiv || null : null),
    })
    const sourceMetas = Object.entries(sources).map(([name, content]) => makeMeta(name, content))
    const existingMeta = existing ? makeMeta(null, existing, 'Content-Security-Policy') : null
    const doc = {
      head: { appendChild: (node: FakeMeta) => appended.push(node) },
      querySelector: (selector: string) => {
        if (selector.startsWith('meta[http-equiv')) return existingMeta ?? appended.find((m) => m.httpEquiv === 'Content-Security-Policy') ?? null
        const match = /meta\[name="([^"]+)"\]/.exec(selector)
        return match ? (sourceMetas.find((m) => m.getAttribute('name') === match[1]) ?? null) : null
      },
      createElement: () => makeMeta(null, ''),
    }
    return { doc: doc as unknown as Document, appended }
  }

  const strict = "default-src 'self'; connect-src 'self'"
  const relaxed = "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:*"

  it('installs the production policy from the source meta tag and is idempotent', () => {
    const { doc, appended } = fakeDocument({ 'csp-production': strict, 'csp-development': relaxed })
    expect(installContentSecurityPolicy(doc, 'production')).toEqual({ policy: strict, reason: 'installed' })
    expect(appended).toHaveLength(1)
    expect(appended[0]?.httpEquiv).toBe('Content-Security-Policy')
    expect(appended[0]?.content).toBe(strict)
    expect(installContentSecurityPolicy(doc, 'production')).toEqual({ policy: strict, reason: 'already-present' })
    expect(appended).toHaveLength(1)
  })

  it('installs the relaxed policy in development and reports a missing source', () => {
    const { doc, appended } = fakeDocument({ 'csp-production': strict, 'csp-development': relaxed })
    expect(installContentSecurityPolicy(doc, 'development').policy).toBe(relaxed)
    expect(appended[0]?.content).toContain("'unsafe-inline'")
    expect(appended[0]?.content).toContain('ws://localhost:*')
    const missing = fakeDocument({})
    expect(installContentSecurityPolicy(missing.doc, 'production')).toEqual({ policy: null, reason: 'source-missing' })
    expect(missing.appended).toHaveLength(0)
  })

  it('never weakens an already enforced policy', () => {
    const { doc, appended } = fakeDocument({ 'csp-development': relaxed }, strict)
    expect(installContentSecurityPolicy(doc, 'development')).toEqual({ policy: strict, reason: 'already-present' })
    expect(appended).toHaveLength(0)
  })
})

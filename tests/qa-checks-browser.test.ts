/**
 * Compliance, accessibility and performance checks against local fixture pages in real browsers.
 * Third-party scripts (TrustedForm, Jornaya) are fake fixtures fulfilled by a test route, so no request
 * leaves the machine.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, firefox, webkit } from 'playwright-core'
import type { Browser, BrowserContext, BrowserType } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ScenarioInputSchema } from '../src/shared/qa'
import type { QaExecution } from '../src/shared/qa'
import { executeScenario } from '../src/main/qa/executor'
import { resolveScenario } from '../src/main/qa/variables'

const CONSENT =
  'By clicking Get my quote, I agree that Example Insurance and its partners may call and text me at the number provided, including by autodialer and prerecorded messages. Consent is not a condition of purchase.'

const page = (body: string, head = ''): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture</title>${head}<style>body{margin:0;font:16px/1.4 sans-serif;color:#111;background:#fff}form{padding:16px;max-width:600px}</style></head><body><main><h1>Quote form</h1>${body}</main></body></html>`
const form = (consent: string, extra = ''): string =>
  page(
    `<form onsubmit="return false"><label for="phone">Phone</label> <input id="phone" type="tel"><p><input id="agree" type="checkbox"> <label for="agree">I agree to the terms below</label></p>${consent}<button id="submit" type="submit">Get my quote</button>${extra}</form>`,
  )
const consentP = (style = 'font-size:14px', text = CONSENT): string => `<p id="consent" style="${style}">${text}</p>`

const PAGES: Record<string, string> = {
  '/ok': form(consentP()),
  '/small': form(consentP('font-size:9px')),
  '/low-contrast': form(consentP('font-size:14px;color:#bbbbbb')),
  // White text in a 60% black overlay over a dark page: alpha blending gives sufficient contrast.
  '/alpha': page(
    `<div style="background:#222;padding:16px"><div style="background:rgba(0,0,0,0.6);padding:8px">${consentP('font-size:14px;color:#ffffff;margin:0')}</div></div><button id="submit">Get my quote</button>`,
  ),
  '/display-none': form(consentP('font-size:14px;display:none')),
  '/offscreen': form(consentP('font-size:14px;position:absolute;left:-9999px;top:0;width:300px')),
  '/covered': form(
    consentP(),
    '<div id="overlay" style="position:fixed;inset:0;background:#fff;z-index:10">Special offer!</div>',
  ),
  '/gradient': form(`<div style="background:linear-gradient(#fff,#eee)">${consentP()}</div>`),
  '/far': form(`${consentP()}<div style="height:1500px"></div>`).replace('<button id="submit" type="submit">Get my quote</button>', '').replace('</form>', '<button id="submit">Get my quote</button></form>'),
  '/reworded': form(consentP('font-size:14px', CONSENT.replace('call and text me', 'contact me'))),
  '/prechecked': form(consentP()).replace('<input id="agree" type="checkbox">', '<input id="agree" type="checkbox" checked>'),
  '/unlabelled': form(consentP()).replace('<label for="agree">I agree to the terms below</label>', ''),
  '/trustedform': form(
    consentP(),
    '<script src="https://api.trustedform.com/trustedform.js?field=xxTrustedFormCertUrl&use_tagged_consent=true"></script>',
  ),
  '/trustedform-broken': form(consentP(), '<script src="https://api.trustedform.com/trustedform.js?broken=1"></script>'),
  '/no-scripts': form(consentP()),
  '/jornaya': form(
    consentP(),
    '<input id="leadid_token" name="universal_leadid" type="hidden" value=""><script id="LeadiDscript" type="text/javascript">(function(){var s=document.createElement("script");s.id="LeadiDscript_campaign";s.type="text/javascript";s.async=true;s.src="//create.lidstatic.com/campaign/0123abcd-fixture.js?snippet_version=2";var l=document.getElementById("LeadiDscript");l.parentNode.insertBefore(s,l);})();</script>',
  ),
  '/a11y-missing-label': page('<form><input id="email" type="email"><button>Send</button></form>'),
  '/a11y-ok': page('<form><label for="email">Email</label><input id="email" type="email"><button>Send</button></form>'),
  '/perf': page(
    `<img id="hero" src="/slow.png" width="400" height="200" alt="Hero"><p id="text">Fast page</p><script>setTimeout(function(){var end=Date.now()+120;while(Date.now()<end){}},50);setTimeout(function(){var d=document.createElement('div');d.style.height='120px';d.textContent='Late banner';document.querySelector('main').prepend(d)},200)</script>`,
  ),
}
// 1×1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

const TRUSTEDFORM_FAKE = `(function(){var i=document.createElement('input');i.type='hidden';i.name='xxTrustedFormCertUrl';i.id='xxTrustedFormCertUrl_0';i.value='https://cert.trustedform.com/0123456789abcdef0123456789abcdef01234567';(document.querySelector('form')||document.body).appendChild(i);})();`
const TRUSTEDFORM_BROKEN = `(function(){var i=document.createElement('input');i.type='hidden';i.name='xxTrustedFormCertUrl';i.value='';document.body.appendChild(i);})();`
const JORNAYA_FAKE = `document.getElementById('leadid_token').value='0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9';window.LeadiD={token:'fixture'};`

function installed(type: BrowserType): boolean {
  try {
    return existsSync(type.executablePath())
  } catch {
    return false
  }
}
const ENGINES: Array<[string, BrowserType]> = [
  ['chromium', chromium],
  ['firefox', firefox],
  ['webkit', webkit],
]
if (!installed(chromium) && process.env.QA_REQUIRE_BROWSER_TESTS === '1')
  throw new Error('Chromium is required for QA integration tests. Install it before running CI.')

let url = ''
let externalHits = 0
const server = createServer((req, res) => {
  if (req.url === '/slow.png') {
    setTimeout(() => {
      res.setHeader('Content-Type', 'image/png')
      res.end(PNG)
    }, 300)
    return
  }
  const html = PAGES[req.url ?? '']
  res.statusCode = html ? 200 : 404
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(html ?? '<h1>Not found</h1>')
})
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** Fake vendor scripts; anything else to a third-party host is refused and counted. */
async function fakeVendors(context: BrowserContext): Promise<void> {
  await context.route(
    (target) => !target.href.startsWith(url),
    async (route) => {
      const target = new URL(route.request().url())
      const body =
        target.hostname === 'api.trustedform.com'
          ? target.searchParams.has('broken')
            ? TRUSTEDFORM_BROKEN
            : TRUSTEDFORM_FAKE
          : target.hostname === 'create.lidstatic.com'
            ? JORNAYA_FAKE
            : null
      if (body === null) {
        externalHits++
        await route.abort('blockedbyclient')
        return
      }
      await route.fulfill({ status: 200, contentType: 'application/javascript', body })
    },
  )
}

describe.each(ENGINES)('QA checks in a real browser (%s)', (name, type) => {
  let browser: Browser | null = null
  let dir = ''
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), `qa-checks-${name}-`))
    if (!installed(type)) return
    try {
      browser = await type.launch({ headless: true })
    } catch {
      browser = null
    }
  })
  afterAll(async () => {
    await browser?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })
  let counter = 0
  const run = async (path: string, steps: unknown[], extra: Record<string, unknown> = {}): Promise<QaExecution> => {
    const context = await browser!.newContext({ serviceWorkers: 'block', viewport: { width: 800, height: 600 } })
    try {
      await fakeVendors(context)
      return await executeScenario(
        context,
        // Resolved like the service does, so {{variables}} in check fields are substituted.
        resolveScenario(
          ScenarioInputSchema.parse({
            name: 'Checks',
            profileId: 'test',
            startUrl: `${url}${path}`,
            allowedOrigins: [url],
            timeoutMs: 3000,
            steps,
            ...extra,
          }),
        ),
        join(dir, `${++counter}`),
        new AbortController().signal,
      )
    } finally {
      await context.close()
    }
  }
  const consent = (overrides: Record<string, unknown> = {}) => ({
    action: 'checkConsent',
    blockSelector: '#consent',
    approvedText: CONSENT,
    nearSelector: '#submit',
    ...overrides,
  })
  const it_ = (title: string, fn: () => Promise<void>) => it(title, async (ctx) => {
    if (!browser) ctx.skip()
    await fn()
  })

  it_('passes a visible, approved, legible consent disclosure near the submit button', async () => {
    const result = await run('/ok', [consent()])
    expect(result.status, JSON.stringify(result.steps[0]?.check?.assertions)).toBe('passed')
    const check = result.steps[0]!.check!
    expect(check.status).toBe('passed')
    expect(check.consent?.minFontPx).toBe(14)
    expect(check.consent?.minContrastRatio).toBeGreaterThan(15)
    expect(check.consent?.distancePx).toBeLessThan(200)
    expect(check.headline).toMatch(/^consent ok/)
  })
  it_('finds the block by its text when no selector is given', async () => {
    const result = await run('/ok', [{ action: 'checkConsent', blockText: 'Consent is not a condition of purchase' }])
    expect(result.status).toBe('passed')
  })
  it_('fails 9px disclosure text and reports the size', async () => {
    const result = await run('/small', [consent()])
    expect(result.status).toBe('failed')
    expect(result.steps[0]!.check!.headline).toBe('consent font 9px')
    expect(result.steps[0]!.error).toMatch(/Font size 9px is below 10px/)
  })
  it_('fails low-contrast text', async () => {
    const check = (await run('/low-contrast', [consent()])).steps[0]!.check!
    expect(check.status).toBe('failed')
    expect(check.consent!.minContrastRatio).toBeLessThan(2)
    expect(check.headline).toMatch(/^consent contrast 1\.\d\d:1$/)
  })
  it_('blends semi-transparent backgrounds before measuring contrast', async () => {
    const check = (await run('/alpha', [consent({ nearSelector: undefined })])).steps[0]!.check!
    expect(check.status, JSON.stringify(check.assertions)).toBe('passed')
    // #fff on rgba(0,0,0,.6) over #222 → about rgb(14,14,14): ~19:1.
    expect(check.consent!.minContrastRatio).toBeGreaterThan(17)
  })
  it_('fails a display:none disclosure', async () => {
    const check = (await run('/display-none', [consent()])).steps[0]!.check!
    expect(check.status).toBe('failed')
    expect(check.consent!.hiddenReasons[0]).toMatch(/display:none/)
    expect(check.headline).toBe('consent hidden (display:none)')
  })
  it_('fails an offscreen disclosure', async () => {
    const check = (await run('/offscreen', [consent({ nearSelector: undefined })])).steps[0]!.check!
    expect(check.status).toBe('failed')
    expect(check.consent!.hiddenReasons.join(' ')).toMatch(/offscreen/)
  })
  it_('fails a disclosure covered by another element', async () => {
    const check = (await run('/covered', [consent({ nearSelector: undefined })])).steps[0]!.check!
    expect(check.status).toBe('failed')
    expect(check.consent!.hiddenReasons.join(' ')).toMatch(/covered by div#overlay/)
  })
  it_('warns, without failing, when a background gradient prevents a contrast measurement', async () => {
    const result = await run('/gradient', [consent()])
    expect(result.status).toBe('passed')
    const check = result.steps[0]!.check!
    expect(check.status).toBe('warning')
    expect(check.consent!.contrastMeasurable).toBe(false)
    expect(check.assertions.find((item) => item.status === 'warning')?.message).toMatch(/not measurable/)
  })
  it_('fails a disclosure too far from the submit button', async () => {
    const check = (await run('/far', [consent({ maxDistancePx: 100 })])).steps[0]!.check!
    expect(check.status).toBe('failed')
    expect(check.consent!.distancePx).toBeGreaterThan(1000)
  })
  it_('reports a word-level diff when the wording differs, and resolves {{variables}} in the approved text', async () => {
    const result = await run('/reworded', [consent({ approvedText: CONSENT.replace('Example Insurance', '{{brand}}') })], {
      variables: { brand: 'Example Insurance' },
    })
    // executeScenario takes a resolved scenario; resolve it like the service does.
    expect(result.status).toBe('failed')
    const check = result.steps[0]!.check!
    expect(check.consent!.wordingDiff).toBeDefined()
    expect(check.message).toMatch(/\[-call and text-\] \{\+contact\+\}/)
  })
  it_('fails a pre-checked or unlabelled consent checkbox and passes a correct one', async () => {
    expect((await run('/ok', [{ action: 'checkConsentCheckbox', checkboxSelector: '#agree' }])).status).toBe('passed')
    const prechecked = (await run('/prechecked', [{ action: 'checkConsentCheckbox', checkboxSelector: '#agree' }])).steps[0]!.check!
    expect(prechecked.status).toBe('failed')
    expect(prechecked.headline).toBe('consent checkbox pre-checked')
    const unlabelled = (await run('/unlabelled', [{ action: 'checkConsentCheckbox', checkboxSelector: '#agree' }])).steps[0]!.check!
    expect(unlabelled.headline).toBe('consent checkbox unlabeled')
  })
  it_('continues after a failed check with continueOnFailure and still fails the case', async () => {
    const result = await run('/prechecked', [
      { action: 'checkConsentCheckbox', checkboxSelector: '#agree', continueOnFailure: true },
      consent(),
    ])
    expect(result.status).toBe('failed')
    expect(result.steps.map((step) => step.status)).toEqual(['failed', 'passed'])
  })
  it_('detects the TrustedForm and Jornaya fixtures and fails when missing or not populated', async () => {
    const tf = await run('/trustedform', [{ action: 'checkScriptLoaded', preset: 'trustedform' }])
    expect(tf.status, JSON.stringify(tf.steps[0]?.check)).toBe('passed')
    expect(tf.steps[0]!.check!.script).toMatchObject({ loaded: true, inputPopulated: true })
    expect(JSON.stringify(tf)).not.toContain('0123456789abcdef0123456789abcdef01234567')
    const broken = (await run('/trustedform-broken', [{ action: 'checkScriptLoaded', preset: 'trustedform' }])).steps[0]!.check!
    expect(broken.status).toBe('failed')
    expect(broken.headline).toBe('TrustedForm input empty')
    const missing = (await run('/no-scripts', [{ action: 'checkScriptLoaded', preset: 'trustedform' }])).steps[0]!.check!
    expect(missing.headline).toBe('TrustedForm not loaded')
    const jornaya = await run('/jornaya', [{ action: 'checkScriptLoaded', preset: 'jornaya' }])
    expect(jornaya.status, JSON.stringify(jornaya.steps[0]?.check)).toBe('passed')
    const custom = await run('/jornaya', [
      { action: 'checkScriptLoaded', preset: 'custom', scriptUrl: '*lidstatic.com/campaign/*', globalName: 'LeadiD.token' },
    ])
    expect(custom.status).toBe('passed')
    expect((await run('/trustedform', [{ action: 'checkScriptLoaded', preset: 'jornaya' }])).status).toBe('failed')
    expect(externalHits).toBe(0)
  })
  it_('runs axe-core, fails a missing form label and records the evidence', async () => {
    const result = await run('/a11y-missing-label', [{ action: 'checkAccessibility' }])
    expect(result.status).toBe('failed')
    const evidence = result.steps[0]!.check!.accessibility!
    const label = evidence.violations.find((violation) => violation.id === 'label')
    expect(label).toMatchObject({ impact: 'critical', nodeCount: 1, targets: ['#email'] })
    expect(evidence.axeVersion).toBe('4.13.0')
    const ok = await run('/a11y-ok', [{ action: 'checkAccessibility' }])
    expect(ok.status, ok.steps[0]?.check?.message).toBe('passed')
    // Below the threshold: recorded, not failing.
    const lenient = await run('/a11y-missing-label', [{ action: 'checkAccessibility', failOn: 'critical', tags: ['best-practice'] }])
    expect(lenient.steps[0]!.check!.accessibility!.violations.some((violation) => violation.id === 'label')).toBe(false)
  })
  it_('records performance metrics and fails an exceeded budget', async () => {
    const result = await run('/perf', [{ action: 'checkPerformance', budgets: { loadMs: 60000 }, settleMs: 300 }])
    expect(result.status, JSON.stringify(result.steps[0]?.check)).toBe('passed')
    const metrics = result.steps[0]!.check!.performance!.metrics
    // WebKit reports responseStart 0 for intercepted documents, so its TTFB is unavailable rather than 0.
    if (name === 'webkit') expect(result.steps[0]!.check!.performance!.unavailable).toContain('ttfbMs')
    else expect(metrics.ttfbMs).toBeGreaterThan(0)
    expect(metrics.domContentLoadedMs).toBeGreaterThan(0)
    expect(metrics.loadMs).toBeGreaterThanOrEqual(250)
    if (name === 'chromium') {
      expect(metrics.lcpMs).toBeGreaterThan(0)
      expect(metrics.cls).toBeGreaterThan(0)
      expect(metrics.tbtMs).toBeGreaterThanOrEqual(50)
    }
    const over = await run('/perf', [{ action: 'checkPerformance', budgets: { loadMs: 1, domContentLoadedMs: 60000 }, settleMs: 0 }])
    expect(over.status).toBe('failed')
    expect(over.steps[0]!.check!.headline).toMatch(/^Load [\d,]+ ms > 1 ms$/)
  })
  it_('applies network throttling on Chromium and records that other engines do not support it', async () => {
    const result = await run('/perf', [{ action: 'checkPerformance', budgets: {}, settleMs: 0 }], { networkProfile: 'fast-3g' })
    const performance = result.steps[0]!.check!.performance!
    expect(performance.networkProfile).toBe('fast-3g')
    if (name === 'chromium') {
      expect(performance.throttling).toBe('applied')
      expect(result.notes?.[0]).toMatch(/fast-3g applied/)
      // The image goes through the emulated network (563 ms latency); the unthrottled page loads in ~300 ms.
      const baseline = await run('/perf', [{ action: 'checkPerformance', budgets: {}, settleMs: 0 }])
      expect(performance.metrics.loadMs! - baseline.steps[0]!.check!.performance!.metrics.loadMs!).toBeGreaterThan(200)
    } else {
      expect(performance.throttling).toBe(`not supported on ${name}`)
      expect(result.steps[0]!.check!.status).toBe('warning')
      expect(result.notes?.[0]).toMatch(/not supported/)
    }
  })
})

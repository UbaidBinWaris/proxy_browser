import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, firefox, webkit } from 'playwright-core'
import type { Browser } from 'playwright-core'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ScenarioInputSchema } from '../src/shared/qa'
import type { QaStep } from '../src/shared/qa'
import { executeScenario } from '../src/main/qa/executor'

for (const [name, type] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]] as const) {
  const available = existsSync(type.executablePath())
  if (!available && (process.env.QA_REQUIRE_DEMO_BROWSERS?.split(',').includes(name) || name === 'chromium' && process.env.QA_REQUIRE_BROWSER_TESTS === '1'))
    throw new Error(`${name} is required for strict form integration tests.`)
  describe.skipIf(!available)(`Strict form execution in ${name}`, () => {
    let browser: Browser, dir: string, origin: string
    let submissions = 0
    const server = createServer((req, res) => {
      if (req.url === '/submit') { submissions++; res.end('confirmed'); return }
      if (req.url === '/missing.js') { res.writeHead(404); res.end(); return }
      if (req.url === '/broken.js') { req.socket.destroy(); return }
      const status = req.url === '/blocked' ? 403 : req.url === '/rate-limited' ? 429 : req.url === '/unavailable' ? 503 : 200
      res.writeHead(status, { 'content-type': 'text/html' })
      const extra = req.url === '/startup-error' ? '<script>console.error("private@example.test"); throw new Error("initialization failed")</script>'
        : req.url === '/script404' ? '<script src="/missing.js"></script>'
          : req.url === '/network-error' ? '<script src="/broken.js"></script>' : ''
      res.end(`<!doctype html><html><body><form id="native"></form><input type="email" id="email" form="native" ${req.url === '/invalid-submit' ? 'required' : ''}><textarea id="notes"></textarea><div contenteditable="true" id="editable"></div>
        <select id="plan"><option value="a">A</option><option value="b">B</option></select><input id="agree" type="checkbox">
        <button id="submit" type="${req.url === '/invalid-submit' ? 'submit' : 'button'}" form="native">Submit</button><button id="error">Script error</button><button id="popup">Unapproved popup</button><div id="result"></div>
        <script>
          document.querySelector('#submit').onclick = () => fetch('/submit', {method: 'POST'}).then(() => ${req.url === '/lost-confirmation' ? 'undefined' : "document.querySelector('#result').textContent = 'Submission confirmed'"});
          document.querySelector('#error').onclick = () => { throw new Error('submit handler failed') };
          document.querySelector('#popup').onclick = () => window.open('http://unapproved.invalid/');
          ${req.url === '/reset-input' ? "document.querySelector('#email').oninput = e => e.target.value = ''" : ''};
          ${req.url === '/reset-select' ? "document.querySelector('#plan').onchange = e => e.target.value = 'a'" : ''};
          window.formInitialized = true;
        </script>${extra}</body></html>`)
    })
    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'qa-strict-'))
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      browser = await type.launch({ headless: true, ...(name === 'chromium' ? { channel: 'chromium' } : {}) })
    })
    beforeEach(() => { submissions = 0 })
    afterAll(async () => {
      await browser?.close()
      await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })
      if (dir) rmSync(dir, { recursive: true, force: true })
    })
    const run = async (path: string, steps: QaStep[], strict = true) => {
      const context = await browser.newContext({ serviceWorkers: 'block' })
      try {
        return await executeScenario(context, ScenarioInputSchema.parse({ name: 'Strict', profileId: 'test',
          startUrl: origin + path, allowedOrigins: [origin], steps: strict
            ? [...steps, { action: 'assertText', selector: '#result', value: 'Submission confirmed' }] : steps,
          strict, timeoutMs: 1000 }),
        mkdtempSync(join(dir, 'case-')), new AbortController().signal)
      } finally { await context.close() }
    }
    const submit: QaStep = { action: 'click', selector: '#submit' }
    it('runs normal page scripts, verifies input/textarea/contenteditable/select/checkbox changes and confirms one submission', async () => {
      const result = await run('/', [
        { action: 'fill', selector: '#email', value: 'private@example.test' },
        { action: 'fill', selector: '#notes', value: 'Two\nlines' },
        { action: 'fill', selector: '#editable', value: 'Content' },
        { action: 'select', selector: '#plan', value: 'b' },
        { action: 'check', selector: '#agree' }, { action: 'uncheck', selector: '#agree' },
        submit, { action: 'assertText', selector: '#result', value: 'Submission confirmed' },
      ])
      expect(result.status, JSON.stringify(result)).toBe('passed')
      expect(result.errors).toEqual([])
      expect(result.failedRequests).toEqual([])
      expect(submissions).toBe(1)
      expect(JSON.stringify(result)).not.toContain('private@example.test')
    })
    it.each(['/blocked', '/rate-limited', '/unavailable', '/startup-error', '/script404', '/network-error'])('stops before submitting when initialization fails at %s', async (path) => {
      const result = await run(path, [{ action: 'fill', selector: '#email', value: 'private@example.test' }, submit])
      expect(result.status).toBe('failed')
      expect(result.steps.every((step) => step.action !== 'click')).toBe(true)
      expect(submissions).toBe(0)
      expect(JSON.stringify(result)).not.toContain('private@example.test')
      expect(result.errors.length + result.failedRequests.length).toBeGreaterThan(0)
    })
    it('stops after a field handler discards the expected value, without exposing its contents', async () => {
      const result = await run('/reset-input', [{ action: 'fill', selector: '#email', value: 'private@example.test' }, submit])
      expect(result.status).toBe('failed')
      expect(result.steps).toHaveLength(1)
      expect(result.steps[0]?.error).toContain('did not retain the expected value')
      expect(submissions).toBe(0)
      expect(JSON.stringify(result)).not.toContain('private@example.test')
    })
    it('stops after a select handler changes the requested choice', async () => {
      const result = await run('/reset-select', [{ action: 'select', selector: '#plan', value: 'b' }, submit])
      expect(result.status).toBe('failed')
      expect(result.steps).toHaveLength(1)
      expect(submissions).toBe(0)
    })
    it('rejects browser-invalid field values before submitting', async () => {
      const result = await run('/', [{ action: 'fill', selector: '#email', value: 'invalid-email' }, submit])
      expect(result.status).toBe('failed')
      expect(result.steps[0]?.error).toContain('browser validation errors')
      expect(submissions).toBe(0)
    })
    it('checks native form validation before clicking a submit button', async () => {
      const result = await run('/invalid-submit', [submit])
      expect(result.status).toBe('failed')
      expect(result.steps[0]?.error).toContain('submission was stopped')
      expect(submissions).toBe(0)
    })
    it('stops when an action throws a script error instead of running the next submission', async () => {
      const result = await run('/', [{ action: 'click', selector: '#error' }, submit])
      expect(result.status).toBe('failed')
      expect(result.steps).toHaveLength(1)
      expect(result.steps[0]?.status).toBe('failed')
      expect(submissions).toBe(0)
    })
    it('stops after a blocked popup even when strict mode is off', async () => {
      const result = await run('/', [{ action: 'click', selector: '#popup' }, submit], false)
      expect(result.status).toBe('failed')
      expect(result.steps).toHaveLength(1)
      expect(submissions).toBe(0)
    })
    it('does not heal a missing field selector in strict mode', async () => {
      const result = await run('/', [{ action: 'fill', selector: '#missing', value: 'private@example.test', fallbacks: [{ kind: 'css', value: '#email' }] }, submit])
      expect(result.status).toBe('failed')
      expect(result.steps[0]?.healed).toBeUndefined()
      expect(submissions).toBe(0)
    })
    it('overrides continue-on-failure checks before a later submission', async () => {
      const result = await run('/', [{ action: 'checkConsentCheckbox', checkboxSelector: '#agree', continueOnFailure: true }, submit])
      // This checkbox has no label, so the consent check fails.
      expect(result.status).toBe('failed')
      expect(result.steps).toHaveLength(1)
      expect(submissions).toBe(0)
    })
    it('fails when the submission reached the server but its confirmation never appeared, without sending it again', async () => {
      const result = await run('/lost-confirmation', [submit])
      expect(result.status).toBe('failed')
      expect(result.steps.at(-1)?.action).toBe('assertText')
      expect(result.steps.at(-1)?.status).toBe('failed')
      expect(submissions).toBe(1)
    })
  })
}

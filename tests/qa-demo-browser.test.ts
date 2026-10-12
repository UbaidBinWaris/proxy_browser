import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium, firefox, webkit } from 'playwright-core'
import type { Browser } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEMO_ORIGIN, DEMO_URL } from '../src/shared/demo'
import { prepareDemo } from '../src/main/qa/demo'
import { attachDemoPage } from '../src/main/qa/demo-page'
import { executeScenario } from '../src/main/qa/executor'
import { attachRecorder } from '../src/main/qa/recorder'
import type { QaRecording } from '../src/shared/qa'
import { ScenarioInputSchema } from '../src/shared/qa'
import { openDatabase } from '../src/main/database'
import { createLogger } from '../src/main/logging/logger'
import { createProfileManager } from '../src/main/browser/profile-manager'

const required = new Set((process.env.QA_REQUIRE_DEMO_BROWSERS ?? '').split(','))
for (const [name, type] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]] as const) {
  const available = existsSync(type.executablePath())
  if (!available && (required.has(name) || name === 'chromium' && process.env.QA_REQUIRE_BROWSER_TESTS === '1'))
    throw new Error(`${name} is required for bundled-demo integration tests.`)
  describe.skipIf(!available)(`Bundled demo in ${name}`, () => {
    let browser: Browser, dir: string
    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'qa-demo-browser-'))
      browser = await type.launch({ headless: true, ...(name === 'chromium' ? { channel: 'chromium' } : {}) })
    })
    afterAll(async () => { await browser?.close(); if (dir) rmSync(dir, { recursive: true, force: true }) })
    it('replays the bundled scenario, captures evidence, and reports a changed expectation as a failure', async () => {
      const db = openDatabase(':memory:', { defaultScreenshotDir: dir, env: {} })
      try {
        const profiles = createProfileManager({ repo: db.profiles, logger: createLogger({ repo: db.logs, fileDir: join(dir, 'logs') }) })
        const scenario = prepareDemo(db.qa!, profiles, 'default', 'chromium')
        const context = await browser.newContext({ serviceWorkers: 'block' })
        try {
          const result = await executeScenario(context, scenario, join(dir, 'pass'), new AbortController().signal)
          expect(result.status, JSON.stringify(result)).toBe('passed')
          expect(result.steps).toHaveLength(7)
          expect(result.steps.every((step) => step.screenshot && existsSync(step.screenshot))).toBe(true)
        } finally { await context.close() }
        const failing = await browser.newContext({ serviceWorkers: 'block' })
        try {
          const result = await executeScenario(failing, { ...scenario, timeoutMs: 1000,
            steps: [{ action: 'assertText', selector: '#result', value: 'Incorrect expected text' }] }, join(dir, 'fail'), new AbortController().signal)
          expect(result.status).toBe('failed')
        } finally { await failing.close() }
      } finally { db.close() }
    })
    it('records real form interactions on the locally fulfilled page', async () => {
      const context = await browser.newContext({ serviceWorkers: 'block' })
      const recording: QaRecording = { id: 'demo', status: 'recording', steps: [], warnings: [] }
      try {
        await attachDemoPage(context)
        await attachRecorder(context, [DEMO_ORIGIN], recording)
        const page = await context.newPage()
        await page.goto(DEMO_URL)
        await page.getByLabel('Full name').fill('Demo User')
        await page.getByLabel('Email', { exact: true }).fill('demo@example.test')
        // The recorder deliberately ignores scripted change events from selectOption.
        await page.getByLabel('Plan', { exact: true }).focus()
        await page.getByLabel('Plan', { exact: true }).press('ArrowDown')
        await page.getByLabel('Plan', { exact: true }).press('Enter')
        await page.getByLabel('I agree to the demo terms').check()
        await page.getByRole('button', { name: 'Create demo account' }).click()
        await page.waitForFunction(() => document.querySelector('#result')?.textContent === 'Demo account ready.')
        await expect.poll(() => recording.steps.filter((step) => ['fill', 'select', 'check', 'click'].includes(step.action)).length).toBeGreaterThanOrEqual(5)
        expect(recording.steps).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'fill', selector: '#email', value: 'demo@example.test' })]))
        recording.status = 'stopped'
        const replay = await browser.newContext({ serviceWorkers: 'block' })
        try {
          const scenario = ScenarioInputSchema.parse({ name: 'Recorded demo', profileId: 'demo', startUrl: DEMO_URL,
            allowedOrigins: [DEMO_ORIGIN], steps: [...recording.steps, { action: 'assertText', selector: '#result', value: 'Demo account ready.' }] })
          const result = await executeScenario(replay, scenario, join(dir, 'recorded'), new AbortController().signal)
          expect(result.status, JSON.stringify(result)).toBe('passed')
        } finally { await replay.close() }
      } finally { await context.close() }
    })
  })
}

/**
 * Unit tests for real-world form support in QA scenarios: schema back-compat, upload fixtures
 * (validation limits, name sanitization, one-time reads, run-time files), frame and pop-up step
 * resolution, recorder capture logic, redirect evidence in reports, the editor's pure form logic and
 * the fixture-chooser IPC handler.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { IPC } from '../src/shared/ipc'
import { QaStepSchema, ScenarioInputSchema } from '../src/shared/qa'
import type { QaBatch, QaCase, QaRecording, QaScenario, QaStep } from '../src/shared/qa'
import {
  QA_FIXTURE_MAX_BYTES,
  QaFixtureSchema,
  QaFixturesSchema,
  base64ByteLength,
  fixtureMimeType,
  missingFixtureNames,
  sanitizeFixtureName,
} from '../src/shared/qa-fixtures'
import type { QaFixture } from '../src/shared/qa-fixtures'
import { formatFramePath, pageRefFor, pageRefIndex, parseFramePath, sameFramePath } from '../src/shared/qa-targets'
import { parseQaManifest } from '../src/main/qa/cli-manifest'
import { createFixtureFiles, readFixtureFile } from '../src/main/qa/fixtures'
import { frameNotLoadedMessage, judgeFrame, unapprovedFrameMessage } from '../src/main/qa/frames'
import { createPopupRegistry, popupTimeoutMessage } from '../src/main/qa/pages'
import {
  RECORDING_LIMIT_WARNING,
  UPLOAD_FIXTURE_WARNING,
  captureAction,
  captureNavigation,
  recordedPageIndex,
  unapprovedFrameOrigin,
} from '../src/main/qa/recorder-capture'
import { redirectLines } from '../src/main/qa/report-redirects'
import { exportBatch } from '../src/main/qa/reports'
import { isHealableStep } from '../src/main/qa/healing'
import { resolveScenario } from '../src/main/qa/variables'
import { qaHandlers } from '../src/main/ipc/qa'
import type { IpcDeps } from '../src/main/ipc/deps'
import { attachFixture, removeFixture, scenarioDraft, scenarioFormFields, supportsFrame } from '../src/renderer/src/lib/scenarioForm'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-forms-'))
  dirs.push(dir)
  return dir
}

const base64Of = (text: string): string => Buffer.from(text).toString('base64')
const fixture = (name: string, content = 'synthetic test file'): QaFixture => ({ name, data: base64Of(content) })
const bytesFixture = (name: string, bytes: number): QaFixture => ({ name, data: Buffer.alloc(bytes, 0x61).toString('base64') })

/** A scenario exactly as saved before frames, pop-ups, uploads, fixtures and followRedirects existed. */
const legacyScenario = {
  workspaceId: 'default',
  name: 'Legacy contact form',
  profileId: 'p1',
  gatewayId: null,
  startUrl: 'https://staging.example.test/contact',
  allowedOrigins: ['https://staging.example.test'],
  steps: [
    { action: 'fill', selector: '#email', value: 'qa@example.test', fallbacks: [{ kind: 'label', value: 'Email' }] },
    { action: 'click', selector: '#send' },
    { action: 'assertText', selector: '#done', value: 'Thanks' },
    { action: 'assertStatus', value: 200 },
  ],
  timeoutMs: 15000,
  maskSelectors: [],
  captureTrace: false,
}

describe('scenario schema back-compat and new steps', () => {
  it('parses a legacy scenario unchanged: no frame, fixtures, pop-up or redirect fields are added', () => {
    const parsed = ScenarioInputSchema.parse(legacyScenario)
    expect(parsed.fixtures).toBeUndefined()
    expect(parsed.followRedirects).toBeUndefined()
    expect(parsed.steps).toEqual(legacyScenario.steps)
    expect(parsed.steps.some((step) => 'frame' in step)).toBe(false)
  })

  it('keeps old CI manifests valid', () => {
    const manifest = parseQaManifest({
      scenario: { ...legacyScenario, id: 's1' },
      profile: {
        name: 'Base',
        engine: 'chromium',
        deviceType: 'desktop',
        devicePreset: 'linux-desktop',
        viewportWidth: 1280,
        viewportHeight: 800,
        userAgent: null,
        locale: 'en-US',
        timezone: 'UTC',
        proxyMode: 'none',
        stickySessionId: null,
        formUrlOverride: null,
        notes: '',
      },
    })
    expect('scenario' in manifest && manifest.scenario.steps).toHaveLength(4)
  })

  it('accepts frame paths on action steps only, within depth and syntax limits', () => {
    expect(QaStepSchema.parse({ action: 'click', selector: '#pay', frame: ['iframe#checkout', 'iframe.card'] })).toMatchObject({
      frame: ['iframe#checkout', 'iframe.card'],
    })
    expect(QaStepSchema.safeParse({ action: 'click', selector: '#pay', frame: [] }).success).toBe(false)
    expect(QaStepSchema.safeParse({ action: 'click', selector: '#pay', frame: Array(6).fill('iframe') }).success).toBe(false)
    expect(QaStepSchema.safeParse({ action: 'click', selector: '#pay', frame: ['iframe >> iframe'] }).success).toBe(false)
    // Assertions do not take a frame: the key is dropped like any unknown key.
    expect(QaStepSchema.parse({ action: 'assertVisible', selector: '#x', frame: ['iframe'] })).toEqual({ action: 'assertVisible', selector: '#x' })
  })

  it('validates switchPage references', () => {
    expect(QaStepSchema.parse({ action: 'switchPage', page: 'popup:3' })).toEqual({ action: 'switchPage', page: 'popup:3' })
    expect(QaStepSchema.parse({ action: 'switchPage', page: 'main' })).toEqual({ action: 'switchPage', page: 'main' })
    for (const page of ['popup:0', 'popup:10', 'popup:-1', 'tab:1', 'Main', ''])
      expect(QaStepSchema.safeParse({ action: 'switchPage', page }).success).toBe(false)
  })

  it('requires every upload fixture to be attached to the scenario', () => {
    const steps = [{ action: 'upload', selector: '#cv', fixtures: ['resume.pdf'] }, ...legacyScenario.steps]
    const missing = ScenarioInputSchema.safeParse({ ...legacyScenario, steps })
    expect(missing.success).toBe(false)
    expect(missing.error?.issues.map((issue) => issue.message)).toContain('Attach the upload fixture resume.pdf.')
    const attached = ScenarioInputSchema.parse({ ...legacyScenario, steps, fixtures: [fixture('resume.pdf')] })
    expect(attached.fixtures?.[0]?.name).toBe('resume.pdf')
    expect(missingFixtureNames(attached.steps, attached.fixtures)).toEqual([])
  })

  it('treats upload as a healable action and keeps frames through variable resolution', () => {
    const upload = QaStepSchema.parse({ action: 'upload', selector: '#cv', fixtures: ['cv.pdf'], frame: ['#apply'] })
    expect(isHealableStep(upload)).toBe(true)
    expect(isHealableStep(QaStepSchema.parse({ action: 'switchPage', page: 'main' }))).toBe(false)
    const resolved = resolveScenario(
      ScenarioInputSchema.parse({
        ...legacyScenario,
        variables: { field: '#email' },
        steps: [{ action: 'fill', selector: '{{field}}', value: 'x', frame: ['iframe#form'] }, { action: 'switchPage', page: 'popup:1' }],
      }),
    )
    expect(resolved.steps).toEqual([
      { action: 'fill', selector: '#email', value: 'x', frame: ['iframe#form'] },
      { action: 'switchPage', page: 'popup:1' },
    ])
  })
})

describe('upload fixture validation', () => {
  it('sanitizes file names to a plain name with an allowed, lowercase extension', () => {
    expect(sanitizeFixtureName('resume.pdf')).toBe('resume.pdf')
    expect(sanitizeFixtureName('My CV (final).PDF')).toBe('My_CV__final_.pdf')
    expect(sanitizeFixtureName('../../etc/passwd.txt')).toBe('passwd.txt')
    expect(sanitizeFixtureName('C:\\Users\\qa\\Desktop\\photo.JPG')).toBe('photo.jpg')
    expect(sanitizeFixtureName('.hidden.png')).toBe('hidden.png')
    expect(sanitizeFixtureName('a..b...csv')).toBe('a.b.csv')
    expect(sanitizeFixtureName('résumé.docx')).toBe('r_sum_.docx')
    expect(sanitizeFixtureName('.pdf')).toBeNull()
    for (const name of ['setup.exe', 'run.sh', 'page.html', 'icon.svg', 'archive.zip', 'script.js', 'noextension'])
      expect(sanitizeFixtureName(name)).toBeNull()
    const long = sanitizeFixtureName(`${'x'.repeat(300)}.pdf`)!
    expect(long).toHaveLength(100)
    expect(long.endsWith('.pdf')).toBe(true)
    // Truncation never leaves an invalid ".." before the extension.
    const dotted = sanitizeFixtureName(`${'a'.repeat(95)}.bbbbbbbb.pdf`)!
    expect(QaFixtureSchema.shape.name.safeParse(dotted).success).toBe(true)
  })

  it('sanitization is idempotent, and only sanitized names are valid stored names', () => {
    for (const raw of ['My CV.PDF', '../x.txt', 'ok-file_1.json', `${'y'.repeat(200)}.xlsx`]) {
      const once = sanitizeFixtureName(raw)!
      expect(sanitizeFixtureName(once)).toBe(once)
      expect(QaFixtureSchema.shape.name.safeParse(once).success).toBe(true)
    }
    for (const name of ['../x.txt', 'dir/x.txt', 'X.PDF', '.x.pdf', 'x.exe', 'a b.pdf'])
      expect(QaFixtureSchema.shape.name.safeParse(name).success).toBe(false)
  })

  it('derives MIME types from the allowed extensions', () => {
    expect(fixtureMimeType('a.pdf')).toBe('application/pdf')
    expect(fixtureMimeType('a.jpeg')).toBe('image/jpeg')
    expect(fixtureMimeType('a.exe')).toBeNull()
  })

  it('limits each fixture to 2 MB of valid base64', () => {
    expect(QaFixtureSchema.safeParse(bytesFixture('max.pdf', QA_FIXTURE_MAX_BYTES)).success).toBe(true)
    const over = QaFixtureSchema.safeParse(bytesFixture('over.pdf', QA_FIXTURE_MAX_BYTES + 1))
    expect(over.success).toBe(false)
    expect(over.error?.issues[0]?.message).toBe('Fixtures are limited to 2 MB each.')
    expect(QaFixtureSchema.safeParse({ name: 'a.txt', data: 'not base64!' }).success).toBe(false)
    expect(QaFixtureSchema.safeParse({ name: 'a.txt', data: 'abc' }).success).toBe(false)
    expect(QaFixtureSchema.safeParse({ name: 'empty.txt', data: '' }).success).toBe(true)
    expect(base64ByteLength(base64Of('hello'))).toBe(5)
    expect(base64ByteLength(base64Of('hell'))).toBe(4)
  })

  it('limits a scenario to 5 uniquely named fixtures and 6 MB in total', () => {
    const five = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'].map((name) => fixture(name))
    expect(QaFixturesSchema.safeParse(five).success).toBe(true)
    expect(QaFixturesSchema.safeParse([...five, fixture('f.txt')]).success).toBe(false)
    expect(QaFixturesSchema.safeParse([fixture('a.txt'), fixture('a.txt', 'other')]).error?.issues[0]?.message).toBe(
      'Fixture names must be unique.',
    )
    const heavy = ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf'].map((name) => bytesFixture(name, 1.6 * 1024 * 1024))
    expect(QaFixturesSchema.safeParse(heavy.slice(0, 3)).success).toBe(true)
    expect(QaFixturesSchema.safeParse(heavy).error?.issues[0]?.message).toBe('Upload fixtures are limited to 6 MB per scenario.')
  })

  it('reads a chosen file once into a sanitized fixture and refuses oversize, unsupported and non-regular files', async () => {
    const dir = tempDir()
    const file = join(dir, 'My CV.PDF')
    writeFileSync(file, '%PDF-1.4 synthetic')
    expect(await readFixtureFile(file)).toEqual({ name: 'My_CV.pdf', data: base64Of('%PDF-1.4 synthetic') })
    const big = join(dir, 'big.pdf')
    writeFileSync(big, Buffer.alloc(QA_FIXTURE_MAX_BYTES + 1))
    await expect(readFixtureFile(big)).rejects.toThrow('Upload fixtures are limited to 2 MB.')
    const exe = join(dir, 'tool.exe')
    writeFileSync(exe, 'MZ')
    await expect(readFixtureFile(exe)).rejects.toThrow('cannot be used as an upload fixture')
    const folder = join(dir, 'folder.pdf')
    mkdirSync(folder)
    await expect(readFixtureFile(folder)).rejects.toThrow('Choose a regular file.')
  })

  it('writes run-time fixture files privately inside the attempt folder and removes them', async () => {
    const dir = join(tempDir(), 'fixtures')
    const files = createFixtureFiles(dir, [fixture('resume.pdf', 'pdf bytes'), fixture('photo.png', 'png bytes')])
    const [first, again] = [...(await files.paths(['resume.pdf'])), ...(await files.paths(['resume.pdf']))]
    expect(first).toBe(join(dir, 'resume.pdf'))
    expect(again).toBe(first)
    expect(readFileSync(first!, 'utf8')).toBe('pdf bytes')
    if (process.platform !== 'win32') expect(statSync(first!).mode & 0o777).toBe(0o600)
    await expect(files.paths(['missing.pdf'])).rejects.toThrow('The upload fixture missing.pdf is not attached to this scenario.')
    await files.remove()
    expect(existsSync(dir)).toBe(false)
  })

  it('never writes outside the folder, even for a fixture that bypassed the schema', async () => {
    const root = tempDir()
    const dir = join(root, 'fixtures')
    const files = createFixtureFiles(dir, [{ name: '../escape.txt', data: base64Of('x') }])
    await expect(files.paths(['../escape.txt'])).rejects.toThrow()
    expect(existsSync(join(root, 'escape.txt'))).toBe(false)
  })

  it('does not follow a file planted at a fixture path', async () => {
    if (process.platform === 'win32') return
    const dir = join(tempDir(), 'fixtures')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'resume.pdf'), 'planted')
    chmodSync(join(dir, 'resume.pdf'), 0o644)
    const files = createFixtureFiles(dir, [fixture('resume.pdf', 'real')])
    await expect(files.paths(['resume.pdf'])).rejects.toThrow()
    expect(readFileSync(join(dir, 'resume.pdf'), 'utf8')).toBe('planted')
  })
})

describe('frame and pop-up step resolution', () => {
  const allowed = ['https://a.test', 'https://b.test']
  it('judges a frame by its document origin, falling back to the iframe src while it loads', () => {
    expect(judgeFrame('https://a.test/inner', 'https://a.test/inner', allowed)).toEqual({ status: 'approved' })
    expect(judgeFrame('https://b.test/pay', '', allowed)).toEqual({ status: 'approved' })
    expect(judgeFrame('https://evil.test/x', 'https://a.test/inner', allowed)).toEqual({ status: 'unapproved', origin: 'https://evil.test' })
    // Blocked by the guard: the frame shows an error page or stays blank; the src tells why.
    expect(judgeFrame('chrome-error://chromewebdata/', 'https://evil.test/x', allowed)).toEqual({ status: 'unapproved', origin: 'https://evil.test' })
    expect(judgeFrame('about:blank', 'https://evil.test/x', allowed)).toEqual({ status: 'unapproved', origin: 'https://evil.test' })
    // Approved src that has not committed yet.
    expect(judgeFrame('about:blank', 'https://a.test/inner', allowed)).toEqual({ status: 'not-loaded' })
    // srcdoc / script-written frames inherit the already-checked parent.
    expect(judgeFrame('about:srcdoc', '', allowed)).toEqual({ status: 'approved' })
    expect(judgeFrame('about:blank', '', allowed)).toEqual({ status: 'approved' })
    expect(judgeFrame('chrome-error://chromewebdata/', '', allowed)).toEqual({ status: 'not-loaded' })
  })

  it('explains frame failures', () => {
    expect(unapprovedFrameMessage('iframe#pay', 'https://evil.test')).toBe(
      'The frame iframe#pay is on an unapproved origin (https://evil.test), so steps cannot run inside it. Approve that origin only if it is your own test site.',
    )
    expect(frameNotLoadedMessage('#f')).toContain('did not load an approved page')
  })

  it('maps page references and frame path text', () => {
    expect(pageRefIndex('main')).toBe(0)
    expect(pageRefIndex('popup:4')).toBe(4)
    expect(pageRefFor(0)).toBe('main')
    expect(pageRefFor(2)).toBe('popup:2')
    expect(parseFramePath(' iframe#a >> iframe.b ')).toEqual(['iframe#a', 'iframe.b'])
    expect(parseFramePath('   ')).toBeUndefined()
    expect(formatFramePath(['iframe#a', 'iframe.b'])).toBe('iframe#a >> iframe.b')
    expect(formatFramePath(undefined)).toBe('')
    expect(sameFramePath(undefined, [])).toBe(true)
    expect(sameFramePath(['a'], ['b'])).toBe(false)
  })

  it('returns pop-ups in opening order, waiting for one that has not opened yet', async () => {
    const registry = createPopupRegistry<string>(2)
    const later = registry.get(2, 1000)
    registry.add('first')
    setTimeout(() => registry.add('second'), 20)
    expect(await later).toBe('second')
    expect(await registry.get(1, 10)).toBe('first')
    registry.add('third (beyond the limit)')
    expect(registry.count()).toBe(2)
    await expect(registry.get(3, 10)).rejects.toThrow('Use popup:1 to popup:2.')
  })

  it('times out or cancels a wait for a pop-up that never opens', async () => {
    const registry = createPopupRegistry<string>()
    await expect(registry.get(1, 30)).rejects.toThrow(popupTimeoutMessage(1, 30))
    const controller = new AbortController()
    const waiting = registry.get(1, 5000, controller.signal)
    controller.abort()
    await expect(waiting).rejects.toThrow()
  })
})

describe('recorder capture logic', () => {
  const recording = (): QaRecording => ({ id: 'r', status: 'recording', steps: [], warnings: [] })

  it('records frame actions with the recorder-computed path and ignores a frame path sent by the page', () => {
    const r = recording()
    captureAction(r, { action: 'fill', selector: '#name', value: 'A', frame: ['iframe#spoofed'] }, { pageIndex: 0, frame: ['iframe#checkout'] })
    captureAction(r, { action: 'fill', selector: '#name', value: 'Ada' }, { pageIndex: 0, frame: ['iframe#checkout'] })
    captureAction(r, { action: 'fill', selector: '#name', value: 'Main' }, { pageIndex: 0 })
    captureAction(r, { action: 'click', selector: '#send', frame: ['iframe#spoofed'] }, { pageIndex: 0 })
    expect(r.steps).toEqual([
      { action: 'fill', selector: '#name', value: 'Ada', frame: ['iframe#checkout'] },
      { action: 'fill', selector: '#name', value: 'Main' },
      { action: 'click', selector: '#send' },
    ])
  })

  it('inserts switchPage steps when actions move between the main page and pop-ups', () => {
    const r = recording()
    captureAction(r, { action: 'click', selector: '#open' }, { pageIndex: 0 })
    captureAction(r, { action: 'fill', selector: '#email', value: 'x' }, { pageIndex: 1 })
    captureAction(r, { action: 'click', selector: '#ok' }, { pageIndex: 1 })
    captureAction(r, { action: 'click', selector: '#done' }, { pageIndex: 0 })
    captureAction(r, { action: 'click', selector: '#more', page: 'popup:5' }, { pageIndex: 0 })
    expect(r.steps.map((step) => step.action + ('page' in step ? `:${step.page}` : ''))).toEqual([
      'click',
      'switchPage:popup:1',
      'fill',
      'click',
      'switchPage:main',
      'click',
      'click',
    ])
    expect(recordedPageIndex(r.steps)).toBe(0)
    captureAction(r, { action: 'click', selector: '#x' }, { pageIndex: 10 })
    expect(r.warnings).toEqual(['Actions in more than 9 pop-ups are not recorded.'])
  })

  it('records uploads by sanitized file name only and asks for the fixture', () => {
    const r = recording()
    captureAction(r, { action: 'upload', selector: '#cv', fixtures: ['C:\\fakepath\\My CV.PDF', 'My CV.PDF', 'tool.exe', 42] }, { pageIndex: 0 })
    expect(r.steps).toEqual([{ action: 'upload', selector: '#cv', fixtures: ['My_CV.pdf'] }])
    expect(r.warnings).toEqual([
      'A chosen file has a type that cannot be used as an upload fixture, so it was not recorded.',
      UPLOAD_FIXTURE_WARNING,
    ])
    captureAction(r, { action: 'upload', selector: '#other', fixtures: ['virus.exe'] }, { pageIndex: 0 })
    expect(r.steps).toHaveLength(1)
  })

  it('drops malformed events and non-action steps, and stops at the step limit', () => {
    const r = recording()
    for (const raw of [null, 'click', [], { action: 'assertText', selector: '#a', value: 'x' }, { action: 'goto', value: 'https://a.test' }, { action: 'click' }])
      captureAction(r, raw, { pageIndex: 0 })
    expect(r.steps).toEqual([])
    for (let index = 0; index < 105; index++) captureAction(r, { action: 'click', selector: `#b${index}` }, { pageIndex: 0 })
    expect(r.steps).toHaveLength(100)
    expect(r.warnings).toEqual([RECORDING_LIMIT_WARNING])
    r.status = 'stopped'
    r.steps.length = 0
    captureAction(r, { action: 'click', selector: '#late' }, { pageIndex: 0 })
    expect(r.steps).toEqual([])
  })

  it('records main-page navigations as goto, switching back to the main page first', () => {
    const r = recording()
    captureNavigation(r, 'https://a.test/typed')
    captureAction(r, { action: 'click', selector: '#open' }, { pageIndex: 0 })
    captureNavigation(r, 'https://a.test/after-click')
    captureAction(r, { action: 'fill', selector: '#q', value: 'x' }, { pageIndex: 1 })
    captureNavigation(r, 'https://a.test/script')
    expect(r.steps).toEqual([
      { action: 'goto', value: 'https://a.test/typed' },
      { action: 'click', selector: '#open' },
      { action: 'switchPage', page: 'popup:1' },
      { action: 'fill', selector: '#q', value: 'x' },
      { action: 'switchPage', page: 'main' },
      { action: 'goto', value: 'https://a.test/script' },
    ])
  })

  it('finds the first unapproved document in a frame chain', () => {
    const allowed = ['https://a.test']
    expect(unapprovedFrameOrigin(['https://a.test/inner', 'https://a.test/'], allowed)).toBeNull()
    expect(unapprovedFrameOrigin(['about:srcdoc', 'https://a.test/'], allowed)).toBeNull()
    expect(unapprovedFrameOrigin(['https://pay.test/card', 'https://a.test/'], allowed)).toBe('https://pay.test')
    expect(unapprovedFrameOrigin(['about:blank', 'https://pay.test/x', 'https://a.test/'], allowed)).toBe('https://pay.test')
  })
})

describe('redirect hops in reports', () => {
  const hop = { status: 302, from: 'https://a.test/start?x=1&y="2"', to: 'https://a.test/<form>' }
  const caseWithHops: QaCase = {
    id: '1',
    engine: 'chromium',
    device: 'linux-desktop',
    target: null,
    attempt: 1,
    status: 'failed',
    steps: [
      { index: 0, action: 'click', status: 'passed', durationMs: 1, redirects: [{ status: 303, from: 'https://a.test/submit', to: 'https://a.test/thanks' }] },
      { index: 1, action: 'goto', status: 'failed', durationMs: 1, error: 'goto failed', redirects: [{ status: 302, from: 'https://a.test/out', to: 'https://evil.test/', blocked: true }] },
    ],
    errors: [],
    failedRequests: [],
    finalUrl: 'https://a.test/thanks',
    durationMs: 10,
    redirects: [
      hop,
      { status: 303, from: 'https://a.test/submit', to: 'https://a.test/thanks' },
      { status: 302, from: 'https://a.test/out', to: 'https://evil.test/', blocked: true },
    ],
  }
  const batch: QaBatch = {
    id: 'b1',
    workspaceId: 'default',
    scenarioId: 's1',
    scenarioName: 'Redirects',
    status: 'failed',
    startedAt: '2026-10-09T00:00:00.000Z',
    endedAt: '2026-10-09T00:00:01.000Z',
    total: 1,
    completed: 1,
    cases: [caseWithHops],
    input: { scenarioId: 's1', engines: [], devices: [], targets: [], concurrency: 1, retries: 0 },
  }

  it('attributes hops to the start navigation and to steps, in run order', () => {
    expect(redirectLines(caseWithHops)).toEqual([
      { text: 'start: 302 https://a.test/start?x=1&y="2" → https://a.test/<form>', blocked: false },
      { text: 'step 1 (click): 303 https://a.test/submit → https://a.test/thanks', blocked: false },
      { text: 'step 2 (goto): 302 https://a.test/out → https://evil.test/ (blocked)', blocked: true },
    ])
    expect(redirectLines({ steps: [], redirects: undefined })).toEqual([])
  })

  it('lists escaped hops in the HTML report', () => {
    const html = exportBatch(batch, 'html').content
    expect(html).toContain('<li>Redirect start: 302 https://a.test/start?x=1&amp;y=&quot;2&quot; → https://a.test/&lt;form&gt;</li>')
    expect(html).toContain('<li class="failed">Redirect step 2 (goto): 302 https://a.test/out → https://evil.test/ (blocked)</li>')
    expect(html).not.toContain('<form>')
  })

  it('adds JUnit properties and system-out lines per hop', () => {
    const xml = exportBatch(batch, 'junit').content
    expect(xml).toContain('<property name="redirect" value="start: 302 https://a.test/start?x=1&amp;y=&quot;2&quot; → https://a.test/&lt;form&gt;"/>')
    expect(xml).toContain('<property name="redirect" value="step 1 (click): 303 https://a.test/submit → https://a.test/thanks"/>')
    expect(xml).toContain('Redirect step 2 (goto): 302 https://a.test/out → https://evil.test/ (blocked)</system-out>')
    const plain = exportBatch({ ...batch, cases: [{ ...caseWithHops, redirects: undefined, steps: [] }] }, 'junit').content
    expect(plain).not.toContain('redirect')
    expect(plain).not.toContain('<system-out>')
  })
})

describe('scenario editor form logic', () => {
  const saved: QaScenario = {
    ...ScenarioInputSchema.parse({ ...legacyScenario, followRedirects: false, healing: 'fail', visualKey: 'vk' }),
    id: 's1',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  }
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...savedInput } = saved

  it('keeps followRedirects: false through an editor round trip', () => {
    const fields = scenarioFormFields(saved)
    expect(fields.followRedirects).toBe(false)
    const draft = scenarioDraft(saved, saved.workspaceId, fields)
    expect(draft.followRedirects).toBe(false)
    // The editor always writes variables and datasets; every other saved field comes back as it was.
    expect(draft).toEqual({ ...savedInput, variables: {}, datasets: [] })
    expect(scenarioDraft(saved, saved.workspaceId, { ...fields, followRedirects: true }).followRedirects).toBe(true)
  })

  it('defaults follow redirects on for new and legacy scenarios', () => {
    expect(scenarioFormFields(null, 'p1')).toMatchObject({ followRedirects: true, profileId: 'p1', fixtures: [] })
    const legacy = { ...ScenarioInputSchema.parse(legacyScenario), id: 'old', createdAt: '', updatedAt: '' }
    expect(scenarioDraft(legacy, 'default', scenarioFormFields(legacy)).followRedirects).toBe(true)
  })

  it('keeps fixtures and upload steps through a round trip', () => {
    const withUpload: QaScenario = {
      ...saved,
      steps: [{ action: 'upload', selector: '#cv', fixtures: ['cv.pdf'], frame: ['iframe#apply'] }, ...saved.steps],
      fixtures: [fixture('cv.pdf')],
    }
    const draft = scenarioDraft(withUpload, saved.workspaceId, scenarioFormFields(withUpload))
    expect(draft.fixtures).toEqual([fixture('cv.pdf')])
    expect(draft.steps[0]).toEqual({ action: 'upload', selector: '#cv', fixtures: ['cv.pdf'], frame: ['iframe#apply'] })
    expect(() => scenarioDraft(withUpload, saved.workspaceId, { ...scenarioFormFields(withUpload), fixtures: [] })).toThrow(
      'Attach the upload fixture cv.pdf.',
    )
  })

  it('attaches a chosen file for a recorded name, renaming the steps that used it', () => {
    const steps: QaStep[] = [
      { action: 'upload', selector: '#cv', fixtures: ['My_CV.pdf'] },
      { action: 'upload', selector: '#photo', fixtures: ['photo.png'] },
    ]
    const change = attachFixture(steps, [], fixture('resume-2026.pdf'), 'My_CV.pdf')
    expect(change.ok && change.steps[0]).toEqual({ action: 'upload', selector: '#cv', fixtures: ['resume-2026.pdf'] })
    expect(change.ok && change.steps[1]).toBe(steps[1])
    expect(change.ok && change.fixtures.map((item) => item.name)).toEqual(['resume-2026.pdf'])
    const replaced = attachFixture(steps, [fixture('photo.png', 'old')], fixture('photo.png', 'new'))
    expect(replaced.ok && replaced.fixtures).toEqual([fixture('photo.png', 'new')])
    expect(replaced.ok && replaced.steps).toBe(steps)
    const full = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'].map((name) => fixture(name))
    expect(attachFixture(steps, full, fixture('f.txt'))).toEqual({ ok: false, error: 'Use at most 5 upload fixtures.' })
    expect(removeFixture(full, 'c.txt').map((item) => item.name)).toEqual(['a.txt', 'b.txt', 'd.txt', 'e.txt'])
  })

  it('offers a frame path for action steps only', () => {
    expect(supportsFrame({ action: 'upload', selector: '#a', fixtures: ['a.txt'] })).toBe(true)
    expect(supportsFrame({ action: 'fill', selector: '#a', value: '' })).toBe(true)
    expect(supportsFrame({ action: 'assertVisible', selector: '#a' })).toBe(false)
    expect(supportsFrame({ action: 'switchPage', page: 'main' })).toBe(false)
  })
})

describe('fixture chooser IPC', () => {
  const handler = (chooseFixture?: () => Promise<string | null>) =>
    qaHandlers({ files: { chooseBackup: async () => null, ...(chooseFixture ? { chooseFixture } : {}) } } as unknown as IpcDeps).find(
      (entry) => entry.channel === IPC.qa.chooseFixture,
    )!

  it('takes no arguments from the renderer and returns the chosen file as a fixture', async () => {
    const dir = tempDir()
    const file = join(dir, 'cover letter.txt')
    writeFileSync(file, 'synthetic cover letter')
    const spec = handler(async () => file)
    expect(spec.args.safeParse([]).success).toBe(true)
    expect(spec.args.safeParse(['/etc/passwd']).success).toBe(false)
    expect(await spec.run([] as never)).toEqual({ name: 'cover_letter.txt', data: base64Of('synthetic cover letter') })
  })

  it('returns null when the dialog is cancelled or unavailable', async () => {
    expect(await handler(async () => null).run([] as never)).toBeNull()
    expect(await handler().run([] as never)).toBeNull()
  })
})

describe('persistence', () => {
  it('stores followRedirects: false, frames, pop-up steps and fixtures, and a re-save from the editor keeps them', async () => {
    const { openDatabase } = await import('../src/main/database')
    const dir = tempDir()
    const db = openDatabase(':memory:', { defaultScreenshotDir: join(dir, 'screenshots'), env: {} })
    try {
      const store = db.qa!
      const saved = store.saveScenario(
        ScenarioInputSchema.parse({
          ...legacyScenario,
          followRedirects: false,
          fixtures: [fixture('cv.pdf')],
          steps: [
            { action: 'click', selector: '#open', frame: ['iframe#apply'] },
            { action: 'switchPage', page: 'popup:1' },
            { action: 'upload', selector: '#cv', fixtures: ['cv.pdf'] },
          ],
        }),
      )
      const loaded = store.scenario(saved.id)
      expect(loaded.followRedirects).toBe(false)
      expect(loaded.fixtures).toEqual([fixture('cv.pdf')])
      expect(loaded.steps[0]).toEqual({ action: 'click', selector: '#open', frame: ['iframe#apply'] })
      const again = store.saveScenario(scenarioDraft(loaded, loaded.workspaceId, scenarioFormFields(loaded)), loaded.id)
      expect(store.scenario(again.id)).toMatchObject({ followRedirects: false, fixtures: [fixture('cv.pdf')], steps: loaded.steps })
    } finally {
      db.close()
    }
  })
})

describe('multipart upload body restore', () => {
  const boundary = '----WebKitFormBoundaryAbC123'
  const type = `multipart/form-data; boundary=${boundary}`
  const part = (headers: string, content: string): string => `--${boundary}\r\n${headers}\r\n\r\n${content}\r\n`
  const body = (...parts: string[]): Buffer => Buffer.from(`${parts.join('')}--${boundary}--\r\n`)
  const fixtures = new Map([['resume.pdf', Buffer.from('%PDF synthetic')]])

  it('parses multipart boundaries', async () => {
    const { multipartBoundary } = await import('../src/main/qa/upload-body')
    expect(multipartBoundary(type)).toBe(boundary)
    expect(multipartBoundary('multipart/form-data; charset=utf-8; boundary="quoted b"')).toBe('quoted b')
    expect(multipartBoundary('application/x-www-form-urlencoded')).toBeNull()
    expect(multipartBoundary(undefined)).toBeNull()
  })

  it('refills only empty file parts whose file name is a scenario fixture', async () => {
    const { restoreMultipartFiles } = await import('../src/main/qa/upload-body')
    const original = body(
      part('Content-Disposition: form-data; name="name"', 'Ada'),
      part('Content-Disposition: form-data; name="cv"; filename="resume.pdf"\r\nContent-Type: application/pdf', ''),
      part('Content-Disposition: form-data; name="other"; filename="unknown.pdf"\r\nContent-Type: application/pdf', ''),
    )
    const restored = restoreMultipartFiles(type, original, fixtures)
    expect(restored?.toString()).toBe(
      body(
        part('Content-Disposition: form-data; name="name"', 'Ada'),
        part('Content-Disposition: form-data; name="cv"; filename="resume.pdf"\r\nContent-Type: application/pdf', '%PDF synthetic'),
        part('Content-Disposition: form-data; name="other"; filename="unknown.pdf"\r\nContent-Type: application/pdf', ''),
      ).toString(),
    )
  })

  it('leaves complete, non-multipart and unrelated bodies alone', async () => {
    const { restoreMultipartFiles } = await import('../src/main/qa/upload-body')
    const complete = body(part('Content-Disposition: form-data; name="cv"; filename="resume.pdf"', '%PDF synthetic'))
    expect(restoreMultipartFiles(type, complete, fixtures)).toBeNull()
    expect(restoreMultipartFiles('application/x-www-form-urlencoded', Buffer.from('a=1'), fixtures)).toBeNull()
    expect(restoreMultipartFiles(type, null, fixtures)).toBeNull()
    expect(restoreMultipartFiles(type, body(part('Content-Disposition: form-data; name="cv"; filename="resume.pdf"', '')), new Map())).toBeNull()
    expect(restoreMultipartFiles(type, Buffer.from('garbage without boundaries'), fixtures)).toBeNull()
  })
})

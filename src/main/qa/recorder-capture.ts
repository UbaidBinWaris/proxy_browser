/**
 * Pure recorder logic: turns an untrusted event from a recorded page into scenario steps.
 *
 * - The page's payload is validated step by step; a frame path is never taken from the page (the
 *   recorder computes it from Playwright's frame tree) and fallbacks are normalized one by one.
 * - Upload steps keep only sanitized file names; the operator attaches the fixture files in the editor.
 * - Actions in a pop-up are preceded by a `switchPage` step whenever the recorded page changes.
 * - Repeated typing in the same field (same page and frame) becomes one fill step; at most 100 steps.
 * Password fields and data-qa-sensitive fields are filtered out in the page script before anything is sent.
 */
import { QaStepSchema } from '@shared/qa'
import type { QaRecording, QaStep } from '@shared/qa'
import { QA_FIXTURE_MAX_FILES, sanitizeFixtureName } from '@shared/qa-fixtures'
import { QA_MAX_POPUPS, pageRefFor, pageRefIndex, sameFramePath } from '@shared/qa-targets'
import { isHealableStep, normalizeFallbacks } from './healing'

export const RECORDING_STEP_LIMIT = 100
export const RECORDING_WARNING_LIMIT = 20
export const RECORDING_LIMIT_WARNING = 'Recording reached the 100-step limit.'
export const RECORDING_START_WARNING =
  'Password fields and data-qa-sensitive fields are excluded. Add assertions after recording. Actions in frames and pop-ups on approved origins are recorded; frames from other origins are not. File uploads record only the file name: attach the fixture file in the editor.'
export const UPLOAD_FIXTURE_WARNING = 'Upload steps were recorded: attach each fixture file under Upload fixtures before saving.'

export interface CaptureSource {
  /** 0 = the main page, n = the n-th pop-up the recording context opened. */
  pageIndex: number
  /** Iframe selectors computed by the recorder (never by the page); absent for the page itself. */
  frame?: string[]
}

export function addRecordingWarning(recording: QaRecording, message: string): void {
  if (!recording.warnings.includes(message) && recording.warnings.length < RECORDING_WARNING_LIMIT)
    recording.warnings.push(message)
}

/** The page the recorded steps currently act on: the last switchPage step, else the main page. */
export function recordedPageIndex(steps: readonly QaStep[]): number {
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index]!
    if (step.action === 'switchPage') return pageRefIndex(step.page)
  }
  return 0
}

function push(recording: QaRecording, step: QaStep): boolean {
  if (recording.steps.length < RECORDING_STEP_LIMIT) {
    recording.steps.push(step)
    return true
  }
  addRecordingWarning(recording, RECORDING_LIMIT_WARNING)
  return false
}

/** Make `pageIndex` the recorded page (adding a switchPage step when it changes). */
function onPage(recording: QaRecording, pageIndex: number): boolean {
  if (recordedPageIndex(recording.steps) === pageIndex) return true
  return push(recording, { action: 'switchPage', page: pageRefFor(pageIndex) })
}

const asRecord = (raw: unknown): Record<string, unknown> =>
  raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}

/** Sanitized, unique fixture names of a recorded file chooser; unsupported types are reported and skipped. */
export function recordedFixtureNames(recording: QaRecording, raw: unknown): string[] {
  const names: string[] = []
  for (const name of Array.isArray(raw) ? raw.slice(0, QA_FIXTURE_MAX_FILES) : []) {
    if (typeof name !== 'string') continue
    const safe = sanitizeFixtureName(name)
    if (!safe) addRecordingWarning(recording, 'A chosen file has a type that cannot be used as an upload fixture, so it was not recorded.')
    else if (!names.includes(safe)) names.push(safe)
  }
  return names
}

export function captureAction(recording: QaRecording, raw: unknown, source: CaptureSource): void {
  if (recording.status !== 'recording') return
  if (!Number.isInteger(source.pageIndex) || source.pageIndex < 0) return
  if (source.pageIndex > QA_MAX_POPUPS) {
    addRecordingWarning(recording, `Actions in more than ${QA_MAX_POPUPS} pop-ups are not recorded.`)
    return
  }
  // The page may not choose the frame or page a step runs in.
  const { fallbacks: rawFallbacks, fixtures: rawFixtures, frame: _frame, page: _page, ...rest } = asRecord(raw)
  let candidate: Record<string, unknown> = rest
  if (rest.action === 'upload') {
    const fixtures = recordedFixtureNames(recording, rawFixtures)
    if (!fixtures.length) return
    candidate = { ...rest, fixtures }
  }
  const parsed = QaStepSchema.safeParse(source.frame?.length ? { ...candidate, frame: source.frame } : candidate)
  if (!parsed.success || !isHealableStep(parsed.data)) return
  const fallbacks = normalizeFallbacks(parsed.data.selector, rawFallbacks)
  const step: QaStep = fallbacks.length ? { ...parsed.data, fallbacks } : parsed.data
  if (!onPage(recording, source.pageIndex)) return
  const previous = recording.steps.at(-1)
  if (
    step.action === 'fill' &&
    previous?.action === 'fill' &&
    previous.selector === step.selector &&
    sameFramePath(previous.frame, step.frame)
  ) {
    recording.steps[recording.steps.length - 1] = step
    return
  }
  if (push(recording, step) && step.action === 'upload') addRecordingWarning(recording, UPLOAD_FIXTURE_WARNING)
}

/**
 * A main-page navigation the user caused without a recorded click (typed URL, script): becomes a goto
 * step with the redacted URL. Navigations right after a click or goto are that step's consequence.
 */
export function captureNavigation(recording: QaRecording, redactedUrl: string): void {
  if (recording.status !== 'recording') return
  if (['click', 'goto'].includes(recording.steps.at(-1)?.action ?? '')) return
  if (recording.steps.length >= RECORDING_STEP_LIMIT) return
  if (!onPage(recording, 0)) return
  push(recording, { action: 'goto', value: redactedUrl })
}

/**
 * The first document origin in a frame chain (the event's frame up to the top) that is not approved,
 * or null. about:blank / about:srcdoc documents inherit their parent's origin.
 */
export function unapprovedFrameOrigin(urls: readonly string[], allowedOrigins: readonly string[]): string | null {
  for (const url of urls) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      continue
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
    if (!allowedOrigins.includes(parsed.origin)) return parsed.origin
  }
  return null
}

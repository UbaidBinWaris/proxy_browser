import { randomUUID } from 'node:crypto'
import { ScenarioInputSchema } from '@shared/qa'
import type { QaRecording, ScenarioInput } from '@shared/qa'
import { QA_MAX_FRAME_DEPTH } from '@shared/qa-targets'
import type { BrowserContext, Frame, Page } from 'playwright-core'
import type { Profile, ProfileInput } from '@shared/types'
import type { ProfileManager } from '../contracts'
import { AppException } from '../contracts'
import { navigationGuard } from './navigation'
import { RECORDING_START_WARNING, addRecordingWarning, captureAction, captureNavigation, unapprovedFrameOrigin } from './recorder-capture'
import { resolveScenario } from './variables'
import { redactUrl } from '../security/data-privacy'

/** Runs in the PARENT document of a recorded frame: a stable selector for the iframe element. */
function iframeSelector(element: Element): string {
  const doc = element.ownerDocument
  const unique = (candidate: string): boolean => doc.querySelectorAll(candidate).length === 1
  const tag = element.localName
  if (element.id && unique(`#${CSS.escape(element.id)}`)) return `#${CSS.escape(element.id)}`
  for (const attribute of ['data-testid', 'name', 'title']) {
    const value = element.getAttribute(attribute)
    const candidate = `${tag}[${attribute}="${CSS.escape(value ?? '')}"]`
    if (value && unique(candidate)) return candidate
  }
  const parts: string[] = []
  let current: Element | null = element
  while (current) {
    const name = current.localName
    const siblings: Element[] = current.parentElement
      ? Array.from(current.parentElement.children).filter((item) => item.localName === name)
      : [current]
    parts.unshift(`${name}:nth-of-type(${siblings.indexOf(current) + 1})`)
    if (unique(parts.join(' > '))) break
    current = current.parentElement
  }
  return parts.join(' > ')
}

/** Iframe selectors from the top document down to `frame`, or null when nested too deeply. */
async function recordFramePath(frame: Frame): Promise<string[] | null> {
  const path: string[] = []
  for (let current = frame; current.parentFrame(); current = current.parentFrame()!) {
    if (path.length >= QA_MAX_FRAME_DEPTH) return null
    const element = await current.frameElement()
    try {
      path.unshift(await element.evaluate(iframeSelector))
    } finally {
      await element.dispose().catch(() => undefined)
    }
  }
  return path
}

/**
 * Only DOM recording is exposed to the site. It has no filesystem or app IPC access. Events from the
 * main page, its frames and its pop-ups are recorded when every document from the event's frame up
 * to the top is on an approved origin; the frame path and page come from Playwright, never the page.
 */
export async function attachRecorder(
  context: BrowserContext,
  allowedOrigins: string[],
  recording: QaRecording,
): Promise<void> {
  const binding = `qaRecord_${randomUUID().replaceAll('-', '')}`
  // In opening order: the recorder's main page first, then pop-ups (popup:1 …), as the executor numbers them.
  const pages: Page[] = []
  context.on('page', (opened) => pages.push(opened))
  const record = async (page: Page, frame: Frame, raw: unknown): Promise<void> => {
    if (recording.status !== 'recording') return
    const chain: Frame[] = []
    for (let current: Frame | null = frame; current; current = current.parentFrame()) chain.push(current)
    const top = chain.at(-1)!.url()
    if (!top.startsWith('http') || unapprovedFrameOrigin([top], allowedOrigins)) return
    const origin = unapprovedFrameOrigin(chain.map((item) => item.url()), allowedOrigins)
    if (origin) {
      addRecordingWarning(recording, `Actions inside a frame from an unapproved origin (${origin}) were not recorded.`)
      return
    }
    const path = frame === page.mainFrame() ? undefined : await recordFramePath(frame)
    if (path === null) {
      addRecordingWarning(recording, `Actions in frames nested more than ${QA_MAX_FRAME_DEPTH} levels deep were not recorded.`)
      return
    }
    captureAction(recording, raw, { pageIndex: pages.indexOf(page), ...(path ? { frame: path } : {}) })
  }
  // Events are handled one at a time so asynchronous frame lookups never reorder steps.
  let queue: Promise<void> = Promise.resolve()
  await context.exposeBinding(binding, ({ page, frame }, raw: unknown) => {
    queue = queue.then(() => record(page, frame, raw)).catch(() => undefined)
    return queue
  })
  await context.addInitScript(
    ({ binding }) => {
      // Listeners live on the window: a pop-up's first document reuses the window of its initial about:blank
      // page, and some engines do not run init scripts again for it. Install once per window.
      const installed = Symbol.for(binding)
      const flags = window as unknown as Record<symbol, boolean>
      if (flags[installed]) return
      flags[installed] = true
      const send = (step: unknown): void => {
        void (window as unknown as Record<string, (step: unknown) => Promise<void>>)[binding]!(step).catch(
          () => undefined,
        )
      }
      const path = (element: Element): string => {
        const parts: string[] = []
        let current: Element | null = element
        while (current) {
          const tag = current.localName
          const siblings: Element[] = current.parentElement
            ? Array.from(current.parentElement.children).filter((item) => item.localName === tag)
            : [current]
          parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`)
          const candidate = parts.join(' > ')
          if (document.querySelectorAll(candidate).length === 1) return candidate
          current = current.parentElement
        }
        return parts.join(' > ')
      }
      const selector = (element: Element): string => {
        if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1)
          return `#${CSS.escape(element.id)}`
        const testId = element.getAttribute('data-testid')
        if (testId) {
          const candidate = `[data-testid="${CSS.escape(testId)}"]`
          if (document.querySelectorAll(candidate).length === 1) return candidate
        }
        return path(element)
      }
      // Self-healing fallbacks. Only attributes, labels and button/link captions are read; never the value
      // of a text field. Password and data-qa-sensitive fields are excluded before this runs. Long values
      // are skipped rather than truncated, because a truncated value could never match exactly.
      const short = (text: string | null | undefined, max: number): string => {
        const value = (text ?? '').replace(/\s+/g, ' ').trim()
        return value.length <= max ? value : ''
      }
      const isButtonInput = (element: Element): element is HTMLInputElement =>
        element instanceof HTMLInputElement && ['submit', 'button', 'reset'].includes(element.type)
      const role = (element: Element): string => {
        const explicit = element.getAttribute('role')?.trim().split(/\s+/)[0]
        if (explicit) return explicit
        if (element instanceof HTMLButtonElement || isButtonInput(element)) return 'button'
        if (element instanceof HTMLAnchorElement && element.hasAttribute('href')) return 'link'
        if (element instanceof HTMLSelectElement) return element.multiple || element.size > 1 ? 'listbox' : 'combobox'
        if (element instanceof HTMLTextAreaElement) return 'textbox'
        if (element instanceof HTMLInputElement) {
          if (element.type === 'checkbox' || element.type === 'radio') return element.type
          if (['text', 'email', 'tel', 'url', 'search'].includes(element.type))
            return element.hasAttribute('list') ? 'combobox' : element.type === 'search' ? 'searchbox' : 'textbox'
        }
        return ''
      }
      const labelText = (element: Element): string => {
        const label = 'labels' in element ? (element as HTMLInputElement).labels?.[0] : undefined
        // A label wrapping a select or text area also contains option text, so it cannot match exactly.
        if (label && !label.querySelector('select, textarea, button')) return short(label.textContent, 200)
        return short(element.getAttribute('aria-label'), 200)
      }
      const caption = (element: Element): string =>
        isButtonInput(element) ? short(element.value, 80) : short(element.textContent, 80)
      const accessibleName = (element: Element): string => {
        const aria = short(element.getAttribute('aria-label'), 200)
        if (aria) return aria
        const labelledBy = element.getAttribute('aria-labelledby')
        if (labelledBy)
          return short(labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '), 200)
        const label = labelText(element)
        if (label) return label
        if (['button', 'link'].includes(role(element))) return caption(element)
        return short(element.getAttribute('title'), 200)
      }
      const fallbacks = (element: Element): unknown[] => {
        const found: Array<{ kind: string; value: string; name?: string }> = []
        for (const attribute of ['data-testid', 'data-test', 'data-qa']) {
          const value = short(element.getAttribute(attribute), 200)
          if (!value) continue
          found.push({ kind: 'testid', value, ...(attribute === 'data-testid' ? {} : { name: attribute }) })
          break
        }
        const elementRole = role(element)
        const name = accessibleName(element)
        if (elementRole && name) found.push({ kind: 'role', value: elementRole, name })
        const label = labelText(element)
        if (label) found.push({ kind: 'label', value: label })
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          const placeholder = short(element.getAttribute('placeholder'), 200)
          if (placeholder) found.push({ kind: 'placeholder', value: placeholder })
        }
        if (['button', 'link'].includes(elementRole)) {
          const text = caption(element)
          if (text) found.push({ kind: 'text', value: text })
        }
        found.push({ kind: 'css', value: path(element) })
        return found
      }
      window.addEventListener(
        'input',
        (event) => {
          const target = event.target
          if (!event.isTrusted || !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return
          if (
            target instanceof HTMLInputElement &&
            ['password', 'file', 'checkbox', 'radio', 'hidden'].includes(target.type)
          )
            return
          if (target.closest('[data-qa-sensitive]')) return
          send({ action: 'fill', selector: selector(target), value: target.value, fallbacks: fallbacks(target) })
        },
        true,
      )
      window.addEventListener(
        'change',
        (event) => {
          const target = event.target
          if (!event.isTrusted || !(target instanceof Element) || target.closest('[data-qa-sensitive]')) return
          if (target instanceof HTMLSelectElement && !target.multiple)
            send({ action: 'select', selector: selector(target), value: target.value, fallbacks: fallbacks(target) })
          // File chooser: only the chosen files' names (browsers never expose their paths); never the content.
          if (target instanceof HTMLInputElement && target.type === 'file' && target.files?.length)
            send({
              action: 'upload',
              selector: selector(target),
              fixtures: Array.from(target.files)
                .slice(0, 5)
                .map((file) => file.name),
              fallbacks: fallbacks(target),
            })
          if (target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(target.type))
            send({
              action: target.checked ? 'check' : 'uncheck',
              selector: selector(target),
              fallbacks: fallbacks(target),
            })
        },
        true,
      )
      window.addEventListener(
        'click',
        (event) => {
          if (!event.isTrusted || !(event.target instanceof Element)) return
          const target = event.target.closest(
            'button, a[href], [role="button"], input[type="submit"], input[type="button"]',
          )
          if (target && !target.closest('[data-qa-sensitive]'))
            send({ action: 'click', selector: selector(target), fallbacks: fallbacks(target) })
        },
        true,
      )
    },
    { binding },
  )
}

export function createRecorderManager(options: {
  profiles: ProfileManager
  open: (
    profile: Profile,
    scenario: ScenarioInput,
    signal: AbortSignal,
    headless: boolean,
  ) => Promise<{ context: BrowserContext; close: () => Promise<void> }>
}) {
  let state: QaRecording | null = null
  let close: (() => Promise<void>) | null = null
  let opening = false
  let openingController: AbortController | null = null
  const manager = {
    async start(raw: ScenarioInput): Promise<QaRecording> {
      if (opening || state?.status === 'recording')
        throw new AppException('SESSION_LIMIT', 'Stop the current recording first.')
      const scenario = resolveScenario(ScenarioInputSchema.parse(raw))
      const base = options.profiles.get(scenario.profileId)
      opening = true
      const controller = new AbortController()
      openingController = controller
      let temporary: Profile | undefined
      let session: Awaited<ReturnType<typeof options.open>> | undefined
      try {
        const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = base
        temporary = options.profiles.create({
          ...input,
          name: 'QA recorder',
          ephemeral: true,
          formUrlOverride: scenario.startUrl,
        } as ProfileInput)
        session = await options.open(temporary, scenario, controller.signal, false)
        controller.signal.throwIfAborted()
        state = {
          id: randomUUID(),
          status: 'recording',
          steps: [],
          warnings: [RECORDING_START_WARNING],
        }
        const recording = state
        const cleanup = async (): Promise<void> => {
          recording.status = 'stopped'
          controller.abort()
          await session!.close()
          if (temporary) {
            options.profiles.delete(temporary.id)
            temporary = undefined
          }
          close = null
        }
        close = cleanup
        await attachRecorder(session.context, scenario.allowedOrigins, recording)
        await session.context.route(
          '**/*',
          navigationGuard(scenario.allowedOrigins, scenario.timeoutMs, (message) => {
            addRecordingWarning(recording, message)
          }),
        )
        const page = await session.context.newPage()
        page.on('framenavigated', (frame) => {
          if (
            frame !== page.mainFrame() ||
            frame.url() === new URL(scenario.startUrl).href ||
            frame.url() === 'about:blank'
          )
            return
          const url = frame.url()
          if (!scenario.allowedOrigins.includes(new URL(url).origin)) return
          captureNavigation(recording, redactUrl(url))
        })
        page.on('close', () => {
          if (recording.status === 'recording') void cleanup().catch(() => undefined)
        })
        await page.goto(scenario.startUrl, { waitUntil: 'domcontentloaded', timeout: scenario.timeoutMs })
        return structuredClone(recording)
      } catch (err) {
        if (state) state.status = 'stopped'
        controller.abort()
        await session?.close().catch(() => undefined)
        if (temporary) options.profiles.delete(temporary.id)
        close = null
        throw err
      } finally {
        opening = false
        openingController = null
      }
    },
    isBusy(): boolean {
      return opening || state?.status === 'recording'
    },
    snapshot(): QaRecording | null {
      return state ? structuredClone(state) : null
    },
    async stop(): Promise<QaRecording | null> {
      openingController?.abort()
      await close?.()
      return manager.snapshot()
    },
    async dispose(): Promise<void> {
      await manager.stop()
    },
  }
  return manager
}
export type RecorderManager = ReturnType<typeof createRecorderManager>

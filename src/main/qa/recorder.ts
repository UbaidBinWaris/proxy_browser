import { randomUUID } from 'node:crypto'
import { QaStepSchema, ScenarioInputSchema } from '@shared/qa'
import type { QaRecording, QaStep, ScenarioInput } from '@shared/qa'
import type { BrowserContext } from 'playwright-core'
import type { Profile, ProfileInput } from '@shared/types'
import type { ProfileManager } from '../contracts'
import { AppException } from '../contracts'
import { navigationGuard } from './navigation'
import { isHealableStep, normalizeFallbacks } from './healing'
import { resolveScenario } from './variables'
import { redactUrl } from '../security/data-privacy'

/** Only DOM recording is exposed to the site. It has no filesystem or app IPC access. */
export async function attachRecorder(
  context: BrowserContext,
  allowedOrigins: string[],
  recording: QaRecording,
): Promise<void> {
  const binding = `qaRecord_${randomUUID().replaceAll('-', '')}`
  await context.exposeBinding(binding, ({ page, frame }, raw: unknown) => {
    if (
      recording.status !== 'recording' ||
      frame !== page.mainFrame() ||
      !allowedOrigins.includes(new URL(frame.url()).origin)
    )
      return
    // Fallbacks are validated one by one so a malformed candidate from the page never drops the step.
    const { fallbacks: rawFallbacks, ...rest } =
      raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : ({} as Record<string, unknown>)
    const parsed = QaStepSchema.safeParse(rest)
    if (!parsed.success || !isHealableStep(parsed.data)) return
    const fallbacks = normalizeFallbacks(parsed.data.selector, rawFallbacks)
    const step: QaStep = fallbacks.length ? { ...parsed.data, fallbacks } : parsed.data
    const previous = recording.steps.at(-1)
    if (step.action === 'fill' && previous?.action === 'fill' && previous.selector === step.selector) {
      recording.steps[recording.steps.length - 1] = step
      return
    }
    if (recording.steps.length < 100) recording.steps.push(step)
    else if (!recording.warnings.includes('Recording reached the 100-step limit.'))
      recording.warnings.push('Recording reached the 100-step limit.')
  })
  await context.addInitScript(
    ({ binding }) => {
      if (window.top !== window) return
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
      document.addEventListener(
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
      document.addEventListener(
        'change',
        (event) => {
          const target = event.target
          if (!event.isTrusted || !(target instanceof Element) || target.closest('[data-qa-sensitive]')) return
          if (target instanceof HTMLSelectElement && !target.multiple)
            send({ action: 'select', selector: selector(target), value: target.value, fallbacks: fallbacks(target) })
          if (target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(target.type))
            send({
              action: target.checked ? 'check' : 'uncheck',
              selector: selector(target),
              fallbacks: fallbacks(target),
            })
        },
        true,
      )
      document.addEventListener(
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
          warnings: [
            'Password fields and data-qa-sensitive fields are excluded. Add assertions after recording. Only the main page is recorded; frames and pop-ups need manual steps.',
          ],
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
            if (recording.warnings.length < 20) recording.warnings.push(message)
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
          if (
            recording.status === 'recording' &&
            !['click', 'goto'].includes(recording.steps.at(-1)?.action ?? '') &&
            recording.steps.length < 100
          )
            recording.steps.push({ action: 'goto', value: redactUrl(url) })
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

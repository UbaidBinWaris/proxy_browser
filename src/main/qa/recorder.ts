import { randomUUID } from 'node:crypto'
import { QaStepSchema, ScenarioInputSchema } from '@shared/qa'
import type { QaRecording, ScenarioInput } from '@shared/qa'
import type { BrowserContext } from 'playwright-core'
import type { Profile, ProfileInput } from '@shared/types'
import type { ProfileManager } from '../contracts'
import { AppException } from '../contracts'
import { navigationGuard } from './navigation'
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
    const parsed = QaStepSchema.safeParse(raw)
    if (!parsed.success || !['fill', 'click', 'select', 'check', 'uncheck'].includes(parsed.data.action)) return
    const step = parsed.data
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
      const selector = (element: Element): string => {
        if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1)
          return `#${CSS.escape(element.id)}`
        const testId = element.getAttribute('data-testid')
        if (testId) {
          const candidate = `[data-testid="${CSS.escape(testId)}"]`
          if (document.querySelectorAll(candidate).length === 1) return candidate
        }
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
          send({ action: 'fill', selector: selector(target), value: target.value })
        },
        true,
      )
      document.addEventListener(
        'change',
        (event) => {
          const target = event.target
          if (!event.isTrusted || !(target instanceof Element) || target.closest('[data-qa-sensitive]')) return
          if (target instanceof HTMLSelectElement && !target.multiple)
            send({ action: 'select', selector: selector(target), value: target.value })
          if (target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(target.type))
            send({ action: target.checked ? 'check' : 'uncheck', selector: selector(target) })
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
          if (target && !target.closest('[data-qa-sensitive]')) send({ action: 'click', selector: selector(target) })
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

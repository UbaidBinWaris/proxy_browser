import { ScenarioInputSchema } from '@shared/qa'
import type { QaDatasetSchema, QaEnvironment, ScenarioInput } from '@shared/qa'
import type { z } from 'zod'
import { FormUrlSchema } from '@shared/types'
import { AppException } from '../contracts'

const executionUrl = FormUrlSchema.refine((url) => {
  const parsed = new URL(url)
  return !parsed.username && !parsed.password
}, 'Test URLs must not contain credentials.')

export function resolveScenario(
  input: ScenarioInput,
  environment?: QaEnvironment,
  row?: z.infer<typeof QaDatasetSchema>,
): ScenarioInput {
  const vars: Record<string, string> = {
    ...input.variables,
    ...environment?.variables,
    ...row?.variables,
    ...(environment ? { baseUrl: environment.baseUrl } : {}),
  }
  const replace = (text: string): string =>
    text.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_, key: string) => {
      if (!Object.hasOwn(vars, key)) throw new AppException('INVALID_INPUT', `Missing test variable: ${key}.`)
      return vars[key]!
    })
  const original = executionUrl.safeParse(replace(input.startUrl))
  if (!original.success)
    throw new AppException(
      'INVALID_INPUT',
      'The resolved starting URL must be HTTP or HTTPS without embedded credentials.',
    )
  const originalOrigin = new URL(original.data).origin
  const mapUrl = (url: string): string => {
    const parsed = executionUrl.parse(replace(url))
    if (!environment || new URL(parsed).origin !== originalOrigin) return parsed
    const resolved = new URL(parsed)
    return environment.baseUrl + resolved.pathname + resolved.search + resolved.hash
  }
  const resolved = ScenarioInputSchema.parse({
    ...input,
    startUrl: mapUrl(input.startUrl),
    allowedOrigins: input.allowedOrigins.map((origin) =>
      environment && origin === originalOrigin ? environment.baseUrl : origin,
    ),
    steps: input.steps.map((step) => ({
      ...step,
      ...('value' in step && typeof step.value === 'string'
        ? { value: step.action === 'goto' ? mapUrl(step.value) : replace(step.value) }
        : {}),
      ...('selector' in step ? { selector: replace(step.selector) } : {}),
      // CSS fallbacks may be a former primary selector that used variables. Other fallback kinds are
      // literal page text captured by the recorder and are never substituted.
      ...('fallbacks' in step && step.fallbacks
        ? {
            fallbacks: step.fallbacks.map((fallback) =>
              fallback.kind === 'css' ? { ...fallback, value: replace(fallback.value) } : fallback,
            ),
          }
        : {}),
    })),
  })
  // The template schema accepts unresolved values for editing; execution never does.
  for (const url of [
    resolved.startUrl,
    ...resolved.steps.filter((step) => step.action === 'goto').map((step) => step.value),
  ]) {
    executionUrl.parse(url)
    if (!resolved.allowedOrigins.includes(new URL(url).origin))
      throw new AppException('INVALID_INPUT', 'Resolved navigation must use an approved origin.')
  }
  return resolved
}

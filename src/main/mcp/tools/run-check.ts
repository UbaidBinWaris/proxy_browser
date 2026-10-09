import { z } from 'zod'

import { QaHealingModeSchema, QaStepSchema } from '@shared/qa'
import type { QaStep } from '@shared/qa'
import { BrowserEngineSchema, BROWSER_ENGINE_LABELS, DEFAULT_PRODUCT_KEY, DEFAULT_PROVIDER_ID, FormUrlSchema, GeoTargetSchema } from '@shared/types'
import type { BrowserEngine, DevicePresetInfo } from '@shared/types'

import { AppException } from '../../contracts'
import { DEVICE_PRESETS } from '../../browser/device-presets'
import { timezoneForStateCode } from '../../locations/us-state-timezones'
import { ScenarioManifestSchema } from '../../qa/cli-manifest'
import { assertCaseLimit, assertOriginsAllowed, originOf } from '../policy'
import { createRedactor, defineTool, manifestValues, parseToolInput, runResultContent } from './summary'

const DEFAULT_STEPS: QaStep[] = [{ action: 'assertVisible', selector: 'body' }]
const DEFAULT_TIMEZONE = 'America/New_York'

export const RunCheckInputSchema = z.object({
  url: FormUrlSchema.refine((value) => {
    const url = new URL(value)
    return !url.username && !url.password
  }, 'URLs must not contain credentials.').describe('Start URL; its origin must be allowlisted by the operator.'),
  engines: z.array(BrowserEngineSchema).min(1).max(10).describe('Engines from list_capabilities, e.g. ["chromium", "webkit"].'),
  devices: z.array(z.string().trim().min(1).max(100)).min(1).max(20).describe('Device preset ids from search_devices.'),
  targets: z.array(GeoTargetSchema).max(20).optional().describe('Exit locations (`target` objects from search_locations); needs proxy credentials.'),
  steps: z
    .array(QaStepSchema)
    .min(1)
    .max(100)
    .optional()
    .describe('Scenario steps (goto, fill, click, select, check, uncheck, assertVisible, assertText, assertUrl, assertStatus, assertScreenshot). Default: assert the page body is visible.'),
  healing: QaHealingModeSchema.default('warn').describe('Self-healing of selectors: off, warn (default) or fail.'),
  direct: z.boolean().default(false).describe('Connect without the proxy even when credentials are configured (e.g. for a localhost site).'),
  timeoutMs: z.int().min(1000).max(60000).optional().describe('Per-step timeout (default 15000).'),
})

function presetFor(id: string): DevicePresetInfo {
  const preset = DEVICE_PRESETS.find((item) => item.id === id)
  if (!preset) throw new AppException('INVALID_INPUT', `Unknown device preset "${id.slice(0, 100)}". Use search_devices to find preset ids.`)
  return preset
}

export const runCheck = defineTool({
  name: 'run_check',
  title: 'Run an ad-hoc check',
  description:
    'Open an allowlisted URL in every engine × device × target combination, run the optional steps and report per-case status, failed steps, console errors, failed requests, exit IP and location match, healed selectors, plus up to 4 masked screenshots. Each case counts against the daily budget. Submit clicks create real records on the site under test: use synthetic data and tag test submissions.',
  inputSchema: RunCheckInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async run(input, deps, ctx) {
    const { policy } = deps
    const steps = input.steps ?? DEFAULT_STEPS
    const gotoUrls = steps.flatMap((step) => (step.action === 'goto' ? [step.value] : []))
    if (gotoUrls.some((url) => url.includes('{{') || !originOf(url)))
      throw new AppException('INVALID_INPUT', 'goto steps in run_check need absolute http(s) URLs (variables are only available in manifests).')
    const origins = [...new Set([input.url, ...gotoUrls].map((url) => originOf(url)!))]
    ctx.facts.origins = origins
    assertOriginsAllowed(policy, origins)

    const engines = [...new Set(input.engines)]
    const devices = [...new Set(input.devices)]
    const targets = input.targets ?? []
    const cases = engines.length * devices.length * Math.max(1, targets.length)
    ctx.facts.cases = cases
    assertCaseLimit(policy, cases)
    const presets = devices.map(presetFor)
    for (const preset of presets)
      for (const engine of engines)
        if (!preset.supportedEngines.includes(engine))
          throw new AppException('INVALID_INPUT', `${BROWSER_ENGINE_LABELS[engine]} cannot emulate "${preset.label}" (${preset.id}). Supported engines: ${preset.supportedEngines.join(', ')}.`)

    const proxy = input.direct ? null : deps.routing().proxy
    if (targets.length > 0 && !proxy)
      throw new AppException(
        'INVALID_INPUT',
        input.direct ? 'Location targets need the proxy; remove `direct` or the targets.' : 'Location targets need proxy credentials, and none are configured on this server.',
      )
    await deps.assertEngines(engines)

    const first = presets[0]!
    const engine: BrowserEngine = engines[0]!
    const stateCode = targets[0]?.stateCode
    const manifest = parseToolInput(ScenarioManifestSchema, {
      scenario: {
        name: `MCP check ${origins[0]}`,
        profileId: 'mcp-check',
        startUrl: input.url,
        allowedOrigins: policy.allowedOrigins,
        steps,
        healing: input.healing,
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      },
      profile: {
        name: 'MCP check',
        engine,
        deviceType: first.deviceType,
        devicePreset: first.id,
        viewportWidth: first.viewportWidth,
        viewportHeight: first.viewportHeight,
        userAgent: null,
        locale: 'en-US',
        timezone: (stateCode && timezoneForStateCode(stateCode)) || DEFAULT_TIMEZONE,
        proxyMode: proxy ? 'sticky' : 'none',
        stickySessionId: proxy ? 'mcp-check' : null,
        formUrlOverride: null,
        notes: '',
        proxyPool: proxy?.product ?? DEFAULT_PRODUCT_KEY,
        providerId: proxy?.providerId ?? DEFAULT_PROVIDER_ID,
        target: null,
      },
      matrix: { engines, devices, targets, concurrency: policy.concurrency, retries: 0 },
      environments: [],
    })

    deps.budget.reserve(cases)
    const batch = await deps.run({ manifest }, ctx.signal)
    ctx.facts.outcome = batch.status
    return runResultContent(batch, createRedactor(deps.sanitize, manifestValues(manifest)), deps)
  },
})

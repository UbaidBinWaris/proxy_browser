import { z } from 'zod'

import { TARGET_MODES } from '@shared/types'

import { defineTool, jsonContent } from './summary'

export const listCapabilities = defineTool({
  name: 'list_capabilities',
  title: 'List capabilities',
  description:
    'Installed browser engines with versions, proxy providers and products configured on this server, location target modes, and the limits the operator set (allowed origins, cases per call, concurrency, remaining daily budget). Call this first.',
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async run(_input, deps, ctx) {
    const capabilities = await deps.capabilities()
    const routing = deps.routing()
    const { policy } = deps
    ctx.facts.outcome = 'ok'
    return [
      jsonContent({
        engines: capabilities.engines,
        unavailableEngines: capabilities.unavailableEngines,
        providers: capabilities.providers,
        proxy: routing.proxy
          ? { configured: true, providerId: routing.proxy.providerId, product: routing.proxy.product }
          : { configured: false, note: 'No proxy credentials are configured: checks connect directly and location targets are unavailable.' },
        customGateway: routing.customGateway,
        targetModes: TARGET_MODES,
        limits: {
          allowedOrigins: policy.allowedOrigins,
          maxCasesPerCall: policy.maxCases,
          concurrency: policy.concurrency,
          dailyBudget: policy.dailyBudget,
          remainingToday: deps.budget.remaining(),
          workspace: policy.workspace !== null,
        },
        notes: [
          'Only the allowed origins can be opened; navigation to any other origin is blocked.',
          'Steps use the scenario step schema: goto, fill, click, select, check, uncheck, upload (fixtures embedded in the scenario), switchPage (main or popup:n), assertVisible, assertText, assertUrl, assertStatus, assertScreenshot. Action steps take an optional frame path of iframe selectors.',
          'Clicks on submit buttons create real records on the site under test; use synthetic data and tag test submissions.',
        ],
      }),
    ]
  },
})

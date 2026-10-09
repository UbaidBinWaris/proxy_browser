import { z } from 'zod'

import { QaHealingModeSchema } from '@shared/qa'
import type { BrowserEngine, ProfileInput } from '@shared/types'
import { DEFAULT_PROVIDER_ID } from '@shared/types'

import { AppException } from '../../contracts'
import { configErrorText, parseQaManifest } from '../../qa/cli-manifest'
import type { QaManifest, ScenarioManifestSchema } from '../../qa/cli-manifest'
import { assertCaseLimit, assertOriginsAllowed } from '../policy'
import { createRedactor, defineTool, manifestValues, runResultContent } from './summary'
import type { Routing } from './types'

export const MAX_MANIFEST_BYTES = 10 * 1024 * 1024
export const MAX_BASELINE_BYTES = 50 * 1024 * 1024

type ManifestScenario = z.infer<typeof ScenarioManifestSchema>['scenario']

/** Each scenario of the manifest with its profile, checking a suite's references as the CLI does. */
export function manifestPlans(manifest: QaManifest): Array<{ scenario: ManifestScenario; profile: ProfileInput }> {
  if ('scenario' in manifest) return [{ scenario: manifest.scenario, profile: manifest.profile }]
  if (
    new Set(manifest.profiles.map((profile) => profile.id)).size !== manifest.profiles.length ||
    new Set(manifest.scenarios.map((scenario) => scenario.id)).size !== manifest.scenarios.length
  )
    throw new AppException('INVALID_INPUT', 'Suite manifest contains duplicate identifiers.')
  return manifest.suite.scenarioIds.map((id) => {
    const scenario = manifest.scenarios.find((item) => item.id === id)
    if (!scenario) throw new AppException('INVALID_INPUT', 'Suite manifest has a missing scenario.')
    const profile = manifest.profiles.find((item) => item.id === scenario.profileId)
    if (!profile) throw new AppException('INVALID_INPUT', 'Suite manifest has a missing profile.')
    return { scenario, profile }
  })
}

/** Cases and case attempts (cases × (retries + 1)) the QA service will plan for this manifest. */
export function countManifestCases(manifest: QaManifest): { cases: number; attempts: number; engines: BrowserEngine[] } {
  const matrix = manifest.matrix
  const engines = new Set<BrowserEngine>()
  let cases = 0
  for (const { scenario, profile } of manifestPlans(manifest)) {
    const rows = scenario.datasets ?? []
    const selected = matrix?.datasetIds?.length ? rows.filter((row) => matrix.datasetIds!.includes(row.id)) : rows
    const caseEngines = [...new Set(matrix?.engines.length ? matrix.engines : [profile.engine])]
    const devices = new Set(matrix?.devices.length ? matrix.devices : [profile.devicePreset])
    const targets = matrix?.targets.length ? matrix.targets.length : 1
    for (const engine of caseEngines) engines.add(engine)
    cases += Math.max(1, selected.length) * caseEngines.length * devices.size * targets
  }
  return { cases, attempts: cases * ((matrix?.retries ?? 0) + 1), engines: [...engines] }
}

/** Every origin the manifest may navigate to: each scenario's approved origins and the chosen environment. */
export function manifestOrigins(manifest: QaManifest, environmentName?: string): string[] {
  const scenarios = 'scenario' in manifest ? [manifest.scenario] : manifest.scenarios
  const origins = scenarios.flatMap((scenario) => scenario.allowedOrigins)
  const environment = manifest.environments.find((env) => env.name === environmentName)
  if (environment) origins.push(environment.baseUrl)
  return [...new Set(origins)]
}

/** Configuration problems the runtime would hit later (custom gateways, provider mismatch), refused up front. */
export function assertRoutable(manifest: QaManifest, routing: Routing): void {
  const plans = manifestPlans(manifest)
  if (plans.some(({ scenario }) => scenario.gatewayId) && !routing.customGateway)
    throw new AppException('INVALID_INPUT', 'This manifest uses custom gateways. Start the server with QA_PROXY_SERVER and gateway credentials.')
  const proxied = plans.filter(({ scenario, profile }) => !scenario.gatewayId && profile.proxyMode !== 'none').map(({ profile }) => profile)
  if (proxied.length === 0) return
  if (!routing.proxy) throw new AppException('PROXY_NOT_CONFIGURED', 'This manifest uses proxied profiles, but no proxy credentials are configured on this server.')
  const other = proxied.find((profile) => (profile.providerId ?? DEFAULT_PROVIDER_ID) !== routing.proxy!.providerId)
  if (other)
    throw new AppException(
      'INVALID_INPUT',
      `The manifest uses the proxy provider "${other.providerId ?? DEFAULT_PROVIDER_ID}", but the server's credentials are for "${routing.proxy.providerId}".`,
    )
}

export const runManifest = defineTool({
  name: 'run_manifest',
  title: 'Run an exported scenario or suite',
  description:
    'Run a scenario or suite manifest exported from the desktop app. `path` (and `baselines`) must resolve inside the operator\'s QA_MCP_WORKSPACE, and every origin the manifest uses must be allowlisted. Returns the same summary and screenshots as run_check.',
  inputSchema: z.object({
    path: z.string().trim().min(1).max(1000).describe('Manifest file, relative to the workspace.'),
    environment: z.string().trim().min(1).max(120).optional().describe('Environment name from the manifest.'),
    healing: QaHealingModeSchema.optional().describe("Override every scenario's self-healing mode."),
    baselines: z.string().trim().min(1).max(1000).optional().describe('Approved screenshot pack (.qavb) inside the workspace.'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async run(input, deps, ctx) {
    let manifest: QaManifest
    try {
      manifest = parseQaManifest(JSON.parse(await deps.readWorkspaceFile(input.path, MAX_MANIFEST_BYTES)))
    } catch (err) {
      if (err instanceof AppException) throw err
      throw new AppException('INVALID_INPUT', configErrorText(err))
    }
    if (input.environment && manifest.environments.filter((env) => env.name === input.environment).length !== 1)
      throw new AppException('INVALID_INPUT', 'Choose one unique environment name from the manifest.')
    const origins = manifestOrigins(manifest, input.environment)
    ctx.facts.origins = origins
    assertOriginsAllowed(deps.policy, origins)
    const { cases, attempts, engines } = countManifestCases(manifest)
    ctx.facts.cases = cases
    assertCaseLimit(deps.policy, cases)
    assertRoutable(manifest, deps.routing())
    await deps.assertEngines(engines)
    let baselinePack: unknown
    if (input.baselines) {
      try {
        baselinePack = JSON.parse(await deps.readWorkspaceFile(input.baselines, MAX_BASELINE_BYTES))
      } catch (err) {
        if (err instanceof AppException) throw err
        throw new AppException('INVALID_INPUT', 'The baseline pack is not valid JSON.')
      }
    }

    deps.budget.reserve(attempts)
    const batch = await deps.run({ manifest, environmentName: input.environment, healing: input.healing, baselinePack }, ctx.signal)
    ctx.facts.outcome = batch.status
    return runResultContent(batch, createRedactor(deps.sanitize, manifestValues(manifest)), deps)
  },
})

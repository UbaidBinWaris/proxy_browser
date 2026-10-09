/**
 * Shared pieces of the run tools: input parsing, the redacted run summary returned to the
 * assistant, screenshot selection and the in-process result store behind `get_results`.
 */
import { z } from 'zod'

import type { QaBatch, QaCase, QaStep } from '@shared/qa'

import { AppException } from '../../contracts'
import { compileSecrets, redactString } from '../../logging/redact'
import { redactEvidence } from '../../security/data-privacy'
import { firstIssueText } from '../../qa/cli-manifest'
import type { QaManifest } from '../../qa/cli-manifest'
import type { McpDeps, ResultStore, TextContent, ToolContent, ToolContext, ToolDefinition } from './types'

/** Parse tool input; a Zod failure becomes INVALID_INPUT naming the field (never echoing the value). */
export function parseToolInput<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const parsed = schema.safeParse(raw ?? {})
  if (!parsed.success) throw new AppException('INVALID_INPUT', `Invalid input: ${firstIssueText(parsed.error)}`)
  return parsed.data
}

/** Build a tool whose handler validates its own input before running. */
export function defineTool<S extends z.ZodObject>(definition: {
  name: string
  title: string
  description: string
  inputSchema: S
  annotations: ToolDefinition['annotations']
  run(input: z.output<S>, deps: McpDeps, ctx: ToolContext): Promise<ToolContent[]>
}): ToolDefinition {
  const { run, ...rest } = definition
  return { ...rest, handler: async (raw, deps, ctx) => run(parseToolInput(definition.inputSchema, raw), deps, ctx) }
}

export function jsonContent(value: unknown): TextContent {
  return { type: 'text', text: JSON.stringify(value, null, 2) }
}

/**
 * A text redactor for one call: the runtime's secrets (proxy credentials), then this call's test
 * values (typed field values, dataset and environment variables), then the evidence patterns
 * (credential URLs, Authorization headers, sensitive query parameters).
 */
export function createRedactor(sanitize: (text: string) => string, values: readonly string[]): (text: string) => string {
  const pattern = compileSecrets(values.filter((value) => value.length > 0))
  return (text) => redactEvidence(redactString(sanitize(text), pattern))
}

/** Every value a manifest would type or substitute: fill/select values, variables, dataset and environment values. */
export function manifestValues(manifest: QaManifest): string[] {
  const scenarios = 'scenario' in manifest ? [manifest.scenario] : manifest.scenarios
  const values: string[] = []
  const stepValues = (steps: readonly QaStep[]): void => {
    for (const step of steps) if (step.action === 'fill' || step.action === 'select') values.push(step.value)
  }
  for (const scenario of scenarios) {
    stepValues(scenario.steps)
    values.push(...Object.values(scenario.variables ?? {}))
    for (const row of scenario.datasets ?? []) values.push(...Object.values(row.variables))
  }
  for (const environment of manifest.environments) values.push(...Object.values(environment.variables))
  return [...new Set(values)]
}

export interface StepSummary {
  /** 1-based, as shown in reports. */
  step: number
  action: string
  error?: string
}

export interface HealedSummary {
  step: number
  action: string
  originalSelector: string
  suggestedSelector: string
  blocked: boolean
}

export interface CaseSummary {
  id: string
  scenario: string | null
  dataset: string | null
  environment: string | null
  engine: string
  device: string
  location: string | null
  status: QaCase['status']
  attempt: number
  durationMs: number
  exitIp: string | null
  locationMatch: string | null
  failedSteps: StepSummary[]
  healedSteps: HealedSummary[]
  consoleErrors: string[]
  failedRequests: string[]
  finalUrl: string
  notes: string[]
}

export interface RunSummary {
  runId: string
  status: QaBatch['status']
  total: number
  completed: number
  healedSteps: number
  startedAt: string
  endedAt: string | null
  cases: CaseSummary[]
}

const MAX_LINES = 20

function locationLabel(target: QaCase['target']): string | null {
  if (!target) return null
  if (target.zip) return `${target.zip}${target.stateCode ? `, ${target.stateCode}` : ''}`
  if (target.city) return `${target.city}${target.stateCode ? `, ${target.stateCode}` : ''}`
  if (target.state) return target.state
  return target.country.toUpperCase()
}

/** The summary the assistant sees. Every free-text field passes through `redact`. */
export function summarizeBatch(batch: QaBatch, redact: (text: string) => string): RunSummary {
  const lines = (items: readonly string[]): string[] => items.slice(0, MAX_LINES).map(redact)
  return {
    runId: batch.id,
    status: batch.status,
    total: batch.total,
    completed: batch.completed,
    healedSteps: batch.healedSteps ?? 0,
    startedAt: batch.startedAt,
    endedAt: batch.endedAt,
    cases: batch.cases.map((item) => ({
      id: item.id,
      scenario: item.scenarioName ? redact(item.scenarioName) : null,
      dataset: item.datasetName ? redact(item.datasetName) : null,
      environment: item.environmentName ? redact(item.environmentName) : null,
      engine: item.engine,
      device: item.device,
      location: locationLabel(item.target),
      status: item.status,
      attempt: item.attempt,
      durationMs: item.durationMs,
      exitIp: item.exitIp ?? null,
      locationMatch: item.targetMatch ?? null,
      failedSteps: item.steps
        .filter((step) => step.status === 'failed')
        .map((step) => ({ step: step.index + 1, action: step.action, ...(step.error ? { error: redact(step.error) } : {}) })),
      healedSteps: item.steps.flatMap((step) =>
        step.healed
          ? [
              {
                step: step.index + 1,
                action: step.action,
                originalSelector: redact(step.healed.originalSelector),
                suggestedSelector: redact(step.healed.suggestedSelector),
                blocked: step.healed.blocked === true,
              },
            ]
          : [],
      ),
      consoleErrors: lines(item.errors),
      failedRequests: lines(item.failedRequests),
      finalUrl: redact(item.finalUrl),
      notes: lines(item.notes ?? []),
    })),
  }
}

export const MAX_SCREENSHOTS = 4

/** Up to `max` screenshots, one per case: failed cases first (their failing step), then the last step of passed cases. */
export function pickScreenshots(batch: QaBatch, max = MAX_SCREENSHOTS): Array<{ caseId: string; step: number; path: string }> {
  const ordered = [...batch.cases.filter((item) => item.status !== 'passed'), ...batch.cases.filter((item) => item.status === 'passed')]
  const picked: Array<{ caseId: string; step: number; path: string }> = []
  for (const item of ordered) {
    if (picked.length >= max) break
    const withShots = item.steps.filter((step) => step.screenshot)
    const chosen = item.steps.find((step) => step.status === 'failed' && step.screenshot) ?? withShots[withShots.length - 1]
    if (chosen?.screenshot) picked.push({ caseId: item.id, step: chosen.index + 1, path: chosen.screenshot })
  }
  return picked
}

/** Summary text plus the screenshots as MCP image content; stores the summary and drops the run's artifacts. */
export async function runResultContent(batch: QaBatch, redact: (text: string) => string, deps: McpDeps): Promise<ToolContent[]> {
  const summary = summarizeBatch(batch, redact)
  deps.results.save(summary)
  const content: ToolContent[] = []
  const captions: string[] = []
  try {
    for (const shot of pickScreenshots(batch)) {
      const image = await deps.readScreenshot(shot.path)
      if (!image) continue
      captions.push(`case ${shot.caseId}, step ${shot.step}`)
      content.push({ type: 'image', data: image.data, mimeType: image.mimeType })
    }
  } finally {
    await deps.discardArtifacts(batch.id)
  }
  return [jsonContent({ ...summary, screenshots: captions }), ...content]
}

/** Keeps the latest summaries of this server process for `get_results`. */
export function createResultStore(limit = 50): ResultStore {
  const runs = new Map<string, RunSummary>()
  return {
    save(summary) {
      runs.delete(summary.runId)
      runs.set(summary.runId, structuredClone(summary))
      while (runs.size > limit) runs.delete(runs.keys().next().value!)
    },
    get: (runId) => {
      const found = runs.get(runId)
      return found ? structuredClone(found) : null
    },
  }
}

export const RunIdSchema = z.string().trim().min(1).max(100)

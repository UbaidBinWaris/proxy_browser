import { z } from 'zod'
import { BrowserEngineSchema, FormUrlSchema, GeoTargetSchema } from './types'
import { QaFixtureNameSchema, QaFixturesSchema, missingFixtureNames } from './qa-fixtures'
import { QaFramePathSchema, QaPageRefSchema } from './qa-targets'
// Checks (compliance, accessibility, performance) live in ./qa-checks.
import { QA_CHECK_STEP_SCHEMAS, QaNetworkProfileSchema } from './qa-checks'
import type { QaCheckResult, QaCheckSummary } from './qa-checks'

const selector = z.string().trim().min(1).max(1000)
const value = z.string().max(10000)
export const QaVariablesSchema = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), value)
  .refine((vars) => Object.keys(vars).length <= 50, 'Use at most 50 variables.')
export const QaDatasetSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  name: z.string().trim().min(1).max(120),
  variables: QaVariablesSchema,
})
const templateUrl = z.union([
  FormUrlSchema,
  z
    .string()
    .min(1)
    .max(2000)
    .refine((url) => /\{\{[A-Za-z][A-Za-z0-9_]*\}\}/.test(url), 'Use an HTTP URL or a URL containing variables.'),
])
/** Ordered most-stable first; the executor tries fallbacks in this order. */
export const QA_FALLBACK_KINDS = ['testid', 'role', 'label', 'placeholder', 'text', 'css'] as const
export const QA_TEST_ID_ATTRIBUTES = ['data-testid', 'data-test', 'data-qa'] as const
/**
 * An alternative way to find an action step's element when its primary selector matches nothing.
 * `role`: value = ARIA role, name = accessible name. `testid`: value = attribute value, name = attribute
 * (data-testid by default). Other kinds carry only a value.
 */
export const QaFallbackSchema = z
  .object({
    kind: z.enum(QA_FALLBACK_KINDS),
    value: z.string().trim().min(1).max(1000),
    name: z.string().trim().min(1).max(500).optional(),
  })
  .superRefine((fallback, ctx) => {
    if (fallback.kind === 'role' && !/^[a-z]{2,40}$/.test(fallback.value))
      ctx.addIssue({ code: 'custom', message: 'Use a lowercase ARIA role for role fallbacks.', path: ['value'] })
    if (fallback.kind === 'testid' && fallback.name && !(QA_TEST_ID_ATTRIBUTES as readonly string[]).includes(fallback.name))
      ctx.addIssue({ code: 'custom', message: 'Use data-testid, data-test or data-qa.', path: ['name'] })
    if (fallback.kind !== 'role' && fallback.kind !== 'testid' && fallback.name !== undefined)
      ctx.addIssue({ code: 'custom', message: 'Only role and test-ID fallbacks take a name.', path: ['name'] })
    if (fallback.kind !== 'css' && /[\r\n]/.test(fallback.value + (fallback.name ?? '')))
      ctx.addIssue({ code: 'custom', message: 'Fallback values must be a single line.', path: ['value'] })
  })
export type QaFallback = z.infer<typeof QaFallbackSchema>
const fallbacks = z.array(QaFallbackSchema).max(4).optional()
/** Iframe selectors (outermost first) of the frame an action step runs in; absent = the page itself. */
const frame = QaFramePathSchema.optional()
export const QA_HEALING_MODES = ['off', 'warn', 'fail'] as const
export const QaHealingModeSchema = z.enum(QA_HEALING_MODES)
export type QaHealingMode = z.infer<typeof QaHealingModeSchema>
export const QaStepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('goto'), value: templateUrl }),
  z.object({ action: z.literal('fill'), selector, value, fallbacks, frame }),
  z.object({ action: z.literal('click'), selector, fallbacks, frame }),
  z.object({ action: z.literal('select'), selector, value, fallbacks, frame }),
  z.object({ action: z.literal('check'), selector, fallbacks, frame }),
  z.object({ action: z.literal('uncheck'), selector, fallbacks, frame }),
  // Real-world forms: file uploads (fixtures stored in the scenario) and pop-up windows.
  z.object({ action: z.literal('upload'), selector, fixtures: z.array(QaFixtureNameSchema).min(1).max(5), fallbacks, frame }),
  z.object({ action: z.literal('switchPage'), page: QaPageRefSchema }),
  z.object({ action: z.literal('assertVisible'), selector }),
  z.object({ action: z.literal('assertText'), selector, value }),
  z.object({ action: z.literal('assertUrl'), value }),
  z.object({ action: z.literal('assertStatus'), value: z.int().min(100).max(599) }),
  z.object({
    action: z.literal('assertScreenshot'),
    name: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    maxDiffRatio: z.number().min(0).max(1).default(0.01),
  }),
  // Checks: optional additions, so scenarios saved before them stay valid.
  ...QA_CHECK_STEP_SCHEMAS,
])
export type QaStep = z.infer<typeof QaStepSchema>
export const ScenarioInputSchema = z
  .object({
    workspaceId: z.string().min(1).max(100).default('default'),
    name: z.string().trim().min(1).max(120),
    profileId: z.string().min(1),
    gatewayId: z.string().min(1).nullable().default(null),
    startUrl: templateUrl,
    variables: QaVariablesSchema.optional(),
    datasets: z.array(QaDatasetSchema).max(100).optional(),
    visualKey: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,80}$/)
      .optional(),
    allowedOrigins: z
      .array(FormUrlSchema.transform((url) => new URL(url).origin))
      .min(1)
      .max(30),
    steps: z.array(QaStepSchema).min(1).max(100),
    timeoutMs: z.int().min(1000).max(60000).default(15000),
    maskSelectors: z.array(selector).max(30).default([]),
    captureTrace: z.boolean().default(false),
    healing: QaHealingModeSchema.default('warn'),
    /**
     * Follow HTTP document redirects whose every hop stays within `allowedOrigins` (absent = true, so
     * scenarios saved before this option keep parsing unchanged). false restores strict blocking of
     * every document redirect. A hop to an unapproved origin is blocked either way.
     */
    followRedirects: z.boolean().optional(),
    /** Files that upload steps attach, stored in the scenario as test data (src/shared/qa-fixtures.ts). */
    fixtures: QaFixturesSchema.optional(),
    /** Chromium-only network throttling for every case (checks); other engines record a note and continue. */
    networkProfile: QaNetworkProfileSchema.optional(),
  })
  .superRefine((input, ctx) => {
    for (const url of [
      input.startUrl,
      ...input.steps.filter((step) => step.action === 'goto').map((step) => step.value),
    ]) {
      if (!url.includes('{{') && !input.allowedOrigins.includes(new URL(url).origin))
        ctx.addIssue({
          code: 'custom',
          message: 'Every navigation must use an approved origin.',
          path: ['allowedOrigins'],
        })
    }
    const screenshots = input.steps.filter((step) => step.action === 'assertScreenshot').map((step) => step.name)
    if (new Set(screenshots).size !== screenshots.length)
      ctx.addIssue({ code: 'custom', message: 'Use a unique name for each screenshot assertion.', path: ['steps'] })
    if (new Set(input.datasets?.map((row) => row.id)).size !== (input.datasets?.length ?? 0))
      ctx.addIssue({ code: 'custom', message: 'Dataset IDs must be unique.', path: ['datasets'] })
    for (const name of missingFixtureNames(input.steps, input.fixtures))
      ctx.addIssue({ code: 'custom', message: `Attach the upload fixture ${name}.`, path: ['fixtures'] })
  })
export type ScenarioInput = z.infer<typeof ScenarioInputSchema>
export interface QaScenario extends ScenarioInput {
  id: string
  createdAt: string
  updatedAt: string
}
export const MatrixInputSchema = z.object({
  scenarioId: z.string().min(1),
  engines: z.array(BrowserEngineSchema).max(10).default([]),
  devices: z.array(z.string().min(1)).max(20).default([]),
  targets: z.array(GeoTargetSchema.nullable()).max(20).default([]),
  concurrency: z.int().min(1).max(4).default(1),
  retries: z.int().min(0).max(2).default(0),
  environmentId: z.string().min(1).nullable().optional(),
  datasetIds: z.array(z.string().min(1)).max(100).optional(),
  suiteId: z.string().min(1).optional(),
})
export type MatrixInput = z.infer<typeof MatrixInputSchema>
export interface QaStepResult {
  index: number
  action: QaStep['action']
  status: 'passed' | 'failed'
  durationMs: number
  error?: string
  screenshot?: string
  visual?: QaVisualResult
  /** Present when the primary selector matched nothing and a fallback matched exactly one element. */
  healed?: QaHealedSelector
  /** Document redirects seen while this step ran, in order. */
  redirects?: QaRedirectHop[]
  /** Outcome and evidence of a check step (src/shared/qa-checks.ts). */
  check?: QaCheckResult
}
/** One HTTP document redirect hop recorded as evidence (URLs are redacted). */
export interface QaRedirectHop {
  /** Status of the redirect response: 301, 302, 303, 307 or 308. */
  status: number
  /** URL that answered with the redirect. */
  from: string
  /** Resolved Location, or "(invalid location)". */
  to: string
  /** True when the hop was refused (unapproved origin, hop limit, unsafe method, or follow redirects off). */
  blocked?: boolean
}
export interface QaHealedSelector {
  originalSelector: string
  usedFallback: QaFallback
  /** Position of the used fallback in the step's fallback list at run time. */
  fallbackIndex: number
  suggestedSelector: string
  /** True when healing was set to fail, so the step stopped instead of acting on the fallback. */
  blocked?: boolean
}
/** Number of steps that healed (or, in fail mode, could have healed) in the final attempt of each case. */
export function countHealedSteps(cases: Array<Pick<QaExecution, 'steps'>>): number {
  return cases.reduce((count, item) => count + item.steps.filter((step) => step.healed).length, 0)
}
export interface QaVisualResult {
  key: string
  name: string
  status: 'missing' | 'matched' | 'changed'
  actual: string
  expected?: string
  diff?: string
  diffRatio?: number
}
export const EnvironmentInputSchema = z.object({
  workspaceId: z.string().min(1).default('default'),
  name: z.string().trim().min(1).max(120),
  baseUrl: FormUrlSchema.refine((url) => {
    const parsed = new URL(url)
    return !parsed.username && !parsed.password
  }, 'Environment URLs must not contain credentials.').transform((url) => new URL(url).origin),
  variables: QaVariablesSchema.default({}),
})
export type EnvironmentInput = z.infer<typeof EnvironmentInputSchema>
export interface QaEnvironment extends EnvironmentInput {
  id: string
}
export const SuiteInputSchema = z.object({
  workspaceId: z.string().min(1).default('default'),
  name: z.string().trim().min(1).max(120),
  scenarioIds: z
    .array(z.string().min(1))
    .min(1)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'Choose each scenario once.'),
})
export type SuiteInput = z.infer<typeof SuiteInputSchema>
export interface QaSuite extends SuiteInput {
  id: string
}
export interface QaRecording {
  id: string
  status: 'recording' | 'stopped'
  steps: QaStep[]
  warnings: string[]
}
export interface QaExecution {
  status: 'passed' | 'failed' | 'cancelled'
  steps: QaStepResult[]
  errors: string[]
  failedRequests: string[]
  trace?: string
  finalUrl: string
  durationMs: number
  /** Informational evidence, e.g. 'site access token "Staging" applied to https://staging.example.com' (never a secret). */
  notes?: string[]
  /** Every document redirect hop of the run (start navigation and steps, all frames), in order; at most 50. */
  redirects?: QaRedirectHop[]
  /** One summary per check step that ran, for matrix views (absent when the scenario has no checks). */
  checks?: QaCheckSummary[]
}
export interface QaCase extends QaExecution {
  id: string
  engine: string
  device: string
  target: z.infer<typeof GeoTargetSchema> | null
  attempt: number
  attempts?: Array<QaExecution & { attempt: number }>
  runId?: string
  exitIp?: string
  targetMatch?: string | null
  scenarioId?: string
  scenarioName?: string
  datasetId?: string
  datasetName?: string
  environmentName?: string
}
export interface QaBatch {
  id: string
  workspaceId: string
  scenarioId: string
  scenarioName: string
  status: 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'interrupted'
  startedAt: string
  endedAt: string | null
  total: number
  completed: number
  cases: QaCase[]
  input: MatrixInput
  suiteId?: string
  environmentName?: string
  /** Healed steps across completed cases; absent on batches recorded before self-healing existed. */
  healedSteps?: number
}
export interface QaWorkspace {
  id: string
  name: string
  createdAt: string
}
export interface QaAuditEntry {
  id: number
  timestamp: string
  workspaceId: string
  actor: string
  action: string
  entityId: string
}
export const QaPolicySchema = z.object({
  retentionDays: z.int().min(1).max(3650).default(30),
  maxCombinations: z.int().min(1).max(500).default(100),
  maxConcurrentBrowsers: z.int().min(1).max(4).default(2),
  maxDailyCases: z.int().min(1).max(10000).default(500),
  allowTraces: z.boolean().default(false),
})
export type QaPolicy = z.infer<typeof QaPolicySchema>
export interface QaSchedule {
  id: string
  scenarioId: string
  input: MatrixInput
  intervalMinutes: number
  nextRunAt: string
  enabled: boolean
  lastError?: string | null
  lastBatchId?: string | null
  lastRunAt?: string
}
export const ScheduleInputSchema = z.object({
  input: MatrixInputSchema,
  intervalMinutes: z.int().min(5).max(10080),
  enabled: z.boolean().default(true),
})
export type ScheduleInput = z.infer<typeof ScheduleInputSchema>
export const GatewayInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    server: z.url({ protocol: /^(https?|socks5)$/ }).refine((value) => {
      const url = new URL(value)
      return !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
    }, 'Use a proxy server URL without credentials, path, query or fragment.'),
    username: z.string().max(512),
    password: z.string().max(1024),
  })
  .refine(
    (input) => !input.server.startsWith('socks5:') || (!input.username && !input.password),
    'Use an HTTP gateway for username/password authentication; SOCKS5 gateways must be unauthenticated.',
  )
export type GatewayInput = z.infer<typeof GatewayInputSchema>
export interface QaGateway {
  id: string
  name: string
  server: string
  lastCheckedAt: string | null
  exitIp: string | null
  latencyMs: number | null
  lastError: string | null
}
export interface QaSnapshot {
  workspaces: QaWorkspace[]
  scenarios: QaScenario[]
  batches: QaBatch[]
  audit: QaAuditEntry[]
  policy: QaPolicy
  schedules: QaSchedule[]
  gateways: QaGateway[]
  environments: QaEnvironment[]
  suites: QaSuite[]
}
export interface QaExport {
  format: 'json' | 'junit' | 'html'
  content: string
  fileName: string
}
export interface UpdateStatus {
  configured: boolean
  available: boolean
  currentVersion: string
  version?: string
  fileName?: string
}

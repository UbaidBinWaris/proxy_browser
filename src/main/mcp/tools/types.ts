/**
 * Contracts shared by the MCP tool handlers. Handlers are pure functions of
 * `(input, deps, ctx)`: everything that touches browsers, proxies or files goes through `McpDeps`,
 * which `../deps.ts` implements on the headless QA runtime and tests replace with fakes.
 */
import type { z } from 'zod'

import type { QaBatch, QaHealingMode } from '@shared/qa'
import type { BrowserEngine, BrowserEngineInfo, GeoTarget, IpInfo, LocationEntry, LocationQueryResult, LocationSearch, ProductKey, ProviderId, TargetMatch, TargetMode } from '@shared/types'

import type { QaManifest } from '../../qa/cli-manifest'
import type { BudgetTracker, McpPolicy } from '../policy'
import type { RunSummary } from './summary'

export interface TextContent {
  type: 'text'
  text: string
}
export interface ImageContent {
  type: 'image'
  /** Base64 PNG. */
  data: string
  mimeType: 'image/png'
}
export type ToolContent = TextContent | ImageContent

/** What the audit line records about a call: origins, case count and outcome (never values). */
export interface AuditFacts {
  origins?: string[]
  cases?: number
  outcome?: string
}

export interface ToolContext {
  /** Aborted when the client cancels the request (or the server shuts down). */
  signal: AbortSignal
  /** Filled in by the handler as it learns them, so the audit line has them even on error. */
  facts: AuditFacts
}

export interface ToolDefinition {
  name: string
  title: string
  description: string
  inputSchema: z.ZodObject
  /** MCP tool annotations (hints for the client UI). */
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
  /** Validates `raw` against `inputSchema` itself, so it can be called directly in tests. */
  handler(raw: unknown, deps: McpDeps, ctx: ToolContext): Promise<ToolContent[]>
}

export interface EngineCapability {
  id: BrowserEngine
  label: string
  version: string | null
  kind: BrowserEngineInfo['kind']
}

export interface ProviderCapability {
  id: ProviderId
  displayName: string
  products: ProductKey[]
  /** Products the environment supplied credentials for. */
  configuredProducts: ProductKey[]
  targetModes: TargetMode[]
  stickySessions: boolean
}

export interface RuntimeCapabilities {
  engines: EngineCapability[]
  unavailableEngines: Array<{ id: BrowserEngine; note: string }>
  providers: ProviderCapability[]
}

/** How ad-hoc checks are routed, from the environment the server started with. */
export interface Routing {
  /** Provider product the environment credentials belong to; null when none are configured (direct). */
  proxy: { providerId: ProviderId; product: ProductKey } | null
  /** QA_PROXY_SERVER was set (manifests that use custom gateways can run). */
  customGateway: boolean
}

export interface ExitIpRequest {
  providerId: ProviderId
  product: ProductKey
  target: GeoTarget | null
}

export interface ExitIpResult {
  ip: IpInfo
  targetMatch: TargetMatch | null
  attempts: number
  /** Set when no attempt met the requested location exactly. */
  warning: string | null
}

export interface RunRequest {
  manifest: QaManifest
  environmentName?: string
  healing?: QaHealingMode
  /** Parsed `.qavb` baseline pack (validated by the visual store on import). */
  baselinePack?: unknown
}

export interface ScreenshotImage {
  data: string
  mimeType: 'image/png'
}

export interface ResultStore {
  save(summary: RunSummary): void
  get(runId: string): RunSummary | null
}

export interface McpDeps {
  policy: McpPolicy
  budget: BudgetTracker
  results: ResultStore
  /** Redacts the runtime's registered secrets (proxy credentials) and credential-shaped text. */
  sanitize(text: string): string
  capabilities(): Promise<RuntimeCapabilities>
  routing(): Routing
  locations: {
    query(input: LocationSearch): LocationQueryResult
    toTarget(entry: LocationEntry): GeoTarget
  }
  /** BROWSER_MISSING for the first engine that is not installed. */
  assertEngines(engines: readonly BrowserEngine[]): Promise<void>
  checkExitIp(request: ExitIpRequest, signal: AbortSignal): Promise<ExitIpResult>
  /** Run a scenario or suite manifest to completion (runs are serialised) and return the batch. */
  run(request: RunRequest, signal: AbortSignal): Promise<QaBatch>
  /** Read a UTF-8 file that must resolve inside QA_MCP_WORKSPACE. */
  readWorkspaceFile(path: string, maxBytes: number): Promise<string>
  /** A downscaled copy of a run's screenshot, or null when it cannot be read. */
  readScreenshot(path: string): Promise<ScreenshotImage | null>
  /** Delete a finished run's screenshots and other artifacts. */
  discardArtifacts(runId: string): Promise<void>
}

/** Fake MCP dependencies: records calls and returns canned batches, no browsers or network. */
import type { QaBatch, QaCase } from '../../src/shared/qa'
import type { LocationEntry } from '../../src/shared/types'
import { createBudgetTracker, memoryBudgetStore } from '../../src/main/mcp/policy'
import type { McpPolicy } from '../../src/main/mcp/policy'
import { createResultStore } from '../../src/main/mcp/tools/summary'
import type { McpDeps, RunRequest } from '../../src/main/mcp/tools/types'
import { compileSecrets, redactString } from '../../src/main/logging/redact'
import { AppException } from '../../src/main/contracts'

export const PROXY_PASSWORD = 'planted-proxy-password-9f3a'

export interface FakeDeps extends McpDeps {
  calls: { run: RunRequest[]; assertEngines: string[][]; checkExitIp: number; readWorkspaceFile: string[]; discarded: string[] }
  nextBatch: (request: RunRequest) => QaBatch
}

export function fakeCase(overrides: Partial<QaCase> = {}): QaCase {
  return {
    id: '1',
    engine: 'chromium',
    device: 'desktop-chrome',
    target: null,
    attempt: 1,
    status: 'passed',
    steps: [{ index: 0, action: 'assertVisible', status: 'passed', durationMs: 5, screenshot: '/artifacts/run/1-1/step-1.png' }],
    errors: [],
    failedRequests: [],
    finalUrl: 'https://staging.example.com/',
    durationMs: 50,
    ...overrides,
  }
}

export function fakeBatch(cases: QaCase[], overrides: Partial<QaBatch> = {}): QaBatch {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    workspaceId: 'default',
    scenarioId: 's',
    scenarioName: 'MCP check',
    status: cases.every((item) => item.status === 'passed') ? 'passed' : 'failed',
    startedAt: '2026-10-09T10:00:00.000Z',
    endedAt: '2026-10-09T10:00:01.000Z',
    total: cases.length,
    completed: cases.length,
    healedSteps: 0,
    cases,
    input: { scenarioId: 's', engines: [], devices: [], targets: [], concurrency: 1, retries: 0 },
    ...overrides,
  }
}

const AUSTIN: LocationEntry = { kind: 'city', label: 'Austin, TX', country: 'us', state: 'Texas', stateCode: 'TX', city: 'Austin', zip: null, timezone: 'America/Chicago' }

export function createFakeDeps(options: { policy?: Partial<McpPolicy>; proxy?: boolean; customGateway?: boolean; files?: Record<string, string>; budget?: number } = {}): FakeDeps {
  const policy: McpPolicy = { allowedOrigins: ['https://staging.example.com'], workspace: '/workspace', maxCases: 12, concurrency: 2, dailyBudget: options.budget ?? 200, ...options.policy }
  const pattern = compileSecrets([PROXY_PASSWORD])
  const calls: FakeDeps['calls'] = { run: [], assertEngines: [], checkExitIp: 0, readWorkspaceFile: [], discarded: [] }
  const deps: FakeDeps = {
    calls,
    nextBatch: () => fakeBatch([fakeCase()]),
    policy,
    budget: createBudgetTracker(policy.dailyBudget, memoryBudgetStore()),
    results: createResultStore(),
    sanitize: (text) => redactString(text, pattern),
    routing: () => ({ proxy: options.proxy ? { providerId: 'dataimpulse', product: 'residential' } : null, customGateway: options.customGateway ?? false }),
    capabilities: async () => ({
      engines: [{ id: 'chromium', label: 'Chromium', version: '153.0', kind: 'bundled' }],
      unavailableEngines: [{ id: 'msedge', note: 'Not installed.' }],
      providers: [{ id: 'dataimpulse', displayName: 'DataImpulse', products: ['residential', 'mobile'], configuredProducts: options.proxy ? ['residential'] : [], targetModes: ['country', 'state', 'city', 'zip'], stickySessions: true }],
    }),
    locations: {
      query: ({ mode }) => (mode === 'city' ? { entries: [AUSTIN], total: 1 } : { entries: [], total: 0 }),
      toTarget: (entry) => ({ mode: entry.kind, country: 'us', state: entry.state, stateCode: entry.stateCode, city: entry.city, zip: entry.zip }),
    },
    async assertEngines(engines) {
      calls.assertEngines.push([...engines])
    },
    async checkExitIp() {
      calls.checkExitIp++
      return {
        ip: { ip: '203.0.113.7', country: 'United States', countryCode: 'US', region: 'Texas', city: 'Austin', postalCode: '78701', isp: `ISP ${PROXY_PASSWORD}`, asn: 'AS64500', latencyMs: 80, provider: 'ip-api', checkedAt: '2026-10-09T10:00:00Z' },
        targetMatch: 'match',
        attempts: 1,
        warning: null,
      }
    },
    async run(request) {
      calls.run.push(request)
      return deps.nextBatch(request)
    },
    async readWorkspaceFile(path) {
      calls.readWorkspaceFile.push(path)
      const content = options.files?.[path]
      if (content === undefined) throw new AppException('NOT_FOUND', 'That file does not exist inside the workspace.')
      return content
    },
    async readScreenshot(path) {
      return { data: Buffer.from(`png:${path}`).toString('base64'), mimeType: 'image/png' }
    },
    async discardArtifacts(runId) {
      calls.discarded.push(runId)
    },
  }
  return deps
}

export const ctx = () => ({ signal: new AbortController().signal, facts: {} as { origins?: string[]; cases?: number; outcome?: string } })

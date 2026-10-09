/**
 * `qa-mcp`: Model Context Protocol server for geo- and device-aware QA checks (out/main/qa-mcp.js).
 *
 * - stdio transport only; stdout carries protocol messages exclusively, every log line goes to
 *   stderr (console.log/info/debug are redirected there before anything else runs).
 * - Refuses to start without QA_MCP_ALLOWED_ORIGINS (see ./policy.ts for all settings).
 * - Every tool call writes one audit line to stderr: tool, origins, case count, outcome and
 *   duration, never input values.
 * - Tool failures are MCP tool errors (`isError: true`) whose text is
 *   `{"error":{"code":"<AppError code>","message":"…"}}`.
 *
 * Uses the SDK's low-level `Server` (not `McpServer`) so that input validation, the error shape
 * and the audit line are the same for every call, including calls with invalid arguments.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { APP_ERROR_CODES } from '@shared/types'
import type { AppError, AppErrorCode } from '@shared/types'

import { AppException } from '../contracts'
import { redactEvidence } from '../security/data-privacy'
import { createMcpRuntime } from './deps'
import type { McpRuntime } from './deps'
import { parsePolicy } from './policy'
import { TOOLS } from './tools'
import type { AuditFacts, McpDeps, ToolDefinition } from './tools/types'

export const SERVER_NAME = 'proxy-qa'

/** The app version from package.json next to the build (out/main/../../) or the source tree. */
export function serverVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [resolve(here, '../../package.json'), resolve(here, '../../../package.json')]) {
    try {
      const { name, version } = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: unknown; version?: unknown }
      if (name === 'proxy-qa-browser' && typeof version === 'string') return version
    } catch {
      // Try the next location.
    }
  }
  return '0.0.0'
}

const INSTRUCTIONS = [
  'Proxy QA Browser runs real-browser QA checks on sites the operator allowlisted, optionally through a geo-targeted proxy exit.',
  'Start with list_capabilities (engines, providers, limits), then search_devices / search_locations to pick presets and targets, then run_check or run_manifest.',
  'Only allowlisted origins can be opened. Use synthetic test data: submit clicks create real records on the site under test.',
].join(' ')

export interface ServerOptions {
  /** Receives one JSON audit line per tool call (default: stderr). */
  audit?: (line: string) => void
  /** Clock for audit durations (tests). */
  now?: () => number
}

const isAppErrorCode = (code: unknown): code is AppErrorCode => typeof code === 'string' && (APP_ERROR_CODES as readonly string[]).includes(code)

/** Any thrown value as an AppError with a redacted message. */
export function toAppError(err: unknown, sanitize: (text: string) => string): AppError {
  // Our own messages need only the secret/credential redaction; anything else may carry raw URLs.
  const clean = (text: string): string => redactEvidence(sanitize(text)).slice(0, 2000)
  if (err instanceof AppException) return { code: err.code, message: sanitize(err.message).slice(0, 2000) }
  if (err instanceof Error && err.name === 'AbortError') return { code: 'SESSION_CLOSED', message: 'The request was cancelled.' }
  const code = (err as { code?: unknown } | null)?.code
  if (err instanceof Error && isAppErrorCode(code)) return { code, message: clean(err.message) }
  return { code: 'INTERNAL', message: err instanceof Error ? clean(err.message) : 'Internal error.' }
}

export function toolErrorResult(error: AppError): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error }) }] }
}

/** The JSON Schema advertised for a tool (input side of the Zod schema). */
export function toolInputJsonSchema(tool: ToolDefinition): { type: 'object'; [key: string]: unknown } {
  const schema = z.toJSONSchema(tool.inputSchema, { io: 'input', target: 'draft-7', unrepresentable: 'any' }) as Record<string, unknown>
  delete schema.$schema
  return { ...schema, type: 'object' }
}

/** Build the MCP server over `deps`; the caller connects a transport. */
export function createQaMcpServer(deps: McpDeps, options: ServerOptions = {}): Server {
  const audit = options.audit ?? ((line: string) => process.stderr.write(`${line}\n`))
  const now = options.now ?? Date.now
  const server = new Server({ name: SERVER_NAME, version: serverVersion() }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS })
  const byName = new Map(TOOLS.map((tool) => [tool.name, tool]))

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: toolInputJsonSchema(tool),
      annotations: { title: tool.title, ...tool.annotations },
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const started = now()
    const name = request.params.name
    const facts: AuditFacts = {}
    const tool = byName.get(name)
    const write = (outcome: string): void =>
      audit(
        JSON.stringify({
          audit: 'qa-mcp',
          at: new Date().toISOString(),
          tool: tool ? name : 'unknown',
          origins: facts.origins ?? [],
          cases: facts.cases ?? 0,
          outcome,
          ms: now() - started,
        }),
      )
    if (!tool) {
      write('error:NOT_FOUND')
      return toolErrorResult({ code: 'NOT_FOUND', message: 'Unknown tool. Call tools/list for the available tools.' })
    }
    try {
      const content = await tool.handler(request.params.arguments ?? {}, deps, { signal: extra.signal, facts })
      write(facts.outcome ?? 'ok')
      return { content }
    } catch (err) {
      const error = toAppError(err, deps.sanitize)
      write(`error:${error.code}`)
      return toolErrorResult(error)
    }
  })
  return server
}

/** Process entry: policy → runtime → stdio. Returns the exit code when the server stops. */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  // stdout is the protocol channel: nothing else may ever write to it.
  console.log = console.error
  console.info = console.error
  console.debug = console.error
  let policy
  try {
    policy = parsePolicy(env)
  } catch (err) {
    process.stderr.write(`qa-mcp configuration error: ${err instanceof Error ? err.message : 'invalid settings'}\n`)
    return 2
  }
  let runtime: McpRuntime
  try {
    runtime = await createMcpRuntime(env, policy)
  } catch (err) {
    process.stderr.write(`qa-mcp configuration error: ${err instanceof Error ? err.message : 'invalid settings'}\n`)
    return 2
  }
  const server = createQaMcpServer(runtime)
  const transport = new StdioServerTransport()
  return await new Promise<number>((resolve) => {
    let stopping = false
    const stop = (code: number): void => {
      if (stopping) return
      stopping = true
      void (async () => {
        await server.close().catch(() => undefined)
        await runtime.dispose().catch(() => undefined)
        resolve(code)
      })()
    }
    transport.onerror = (error) => {
      process.stderr.write(`qa-mcp transport error: ${runtime.sanitize(error.message)}\n`)
      stop(1)
    }
    server.onclose = () => stop(0)
    process.stdin.once('end', () => stop(0))
    process.once('SIGINT', () => stop(130))
    process.once('SIGTERM', () => stop(143))
    server.connect(transport).then(
      () => process.stderr.write(`qa-mcp ready: ${policy.allowedOrigins.length} allowed origin(s), max ${policy.maxCases} cases per call, daily budget ${policy.dailyBudget}\n`),
      (error: unknown) => {
        process.stderr.write(`qa-mcp could not start: ${error instanceof Error ? runtime.sanitize(error.message) : 'transport failure'}\n`)
        stop(1)
      },
    )
  })
}

/** True when this module is the process entry (node out/main/qa-mcp.js), not an import (tests). */
function isEntry(): boolean {
  const script = process.argv[1]
  if (!script) return false
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntry()) {
  void main().then(
    (code) => {
      process.exitCode = code
      // Browser processes and timers must not keep a stopped server alive.
      setTimeout(() => process.exit(code), 2000).unref()
    },
    (err: unknown) => {
      process.stderr.write(`qa-mcp fatal error: ${err instanceof Error ? err.message : 'unknown'}\n`)
      process.exit(1)
    },
  )
}

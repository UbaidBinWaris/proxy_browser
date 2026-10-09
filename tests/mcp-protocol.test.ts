import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppException } from '../src/main/contracts'
import { SERVER_NAME, createQaMcpServer, main, toAppError } from '../src/main/mcp/server'
import { TOOLS } from '../src/main/mcp/tools'
import { createFakeDeps } from './helpers/mcp-fakes'
import type { FakeDeps } from './helpers/mcp-fakes'

describe('process entry', () => {
  it('refuses to start without QA_MCP_ALLOWED_ORIGINS (exit code 2, message on stderr)', async () => {
    const saved = { log: console.log, info: console.info, debug: console.debug }
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      expect(await main({})).toBe(2)
      expect(await main({ QA_MCP_ALLOWED_ORIGINS: 'http://staging.example.com' })).toBe(2)
      const output = write.mock.calls.map((call) => String(call[0])).join('')
      expect(output).toContain('qa-mcp configuration error: QA_MCP_ALLOWED_ORIGINS is required')
      expect(output).toContain('http:// is allowed only for localhost')
    } finally {
      write.mockRestore()
      Object.assign(console, saved)
    }
  })
})

describe('tool error mapping', () => {
  const sanitize = (value: string): string => value.split('planted-secret').join('[REDACTED]')
  it('keeps AppError codes and redacts secrets and sensitive URLs', () => {
    expect(toAppError(new AppException('PROXY_DEAD', 'Gateway refused planted-secret'), sanitize)).toEqual({ code: 'PROXY_DEAD', message: 'Gateway refused [REDACTED]' })
    expect(toAppError(new Error('fetch https://a.example/x?token=abc123 failed with planted-secret'), sanitize)).toEqual({ code: 'INTERNAL', message: expect.not.stringMatching(/abc123|planted-secret/) })
    expect(toAppError(Object.assign(new Error('aborted'), { name: 'AbortError' }), sanitize)).toEqual({ code: 'SESSION_CLOSED', message: 'The request was cancelled.' })
    expect(toAppError('weird', sanitize)).toEqual({ code: 'INTERNAL', message: 'Internal error.' })
  })
})

describe('MCP protocol (in-memory client/server)', () => {
  let client: Client
  let deps: FakeDeps
  let audit: string[]
  let close: () => Promise<void>

  beforeEach(async () => {
    deps = createFakeDeps()
    audit = []
    const server = createQaMcpServer(deps, { audit: (line) => audit.push(line) })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'protocol-test', version: '1.0.0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    close = async () => {
      await client.close()
      await server.close()
    }
  })
  afterEach(async () => close())

  const textOf = (result: Awaited<ReturnType<Client['callTool']>>): string => {
    const content = result.content as Array<{ type: string; text?: string }>
    return content[0]?.text ?? ''
  }

  it('identifies itself and advertises tools with instructions', () => {
    expect(client.getServerVersion()).toEqual({ name: SERVER_NAME, version: (JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }).version })
    expect(client.getServerCapabilities()?.tools).toBeDefined()
    expect(client.getInstructions()).toMatch(/allowlisted/)
  })

  it('lists every tool with a JSON Schema derived from its Zod input schema', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(['list_capabilities', 'search_devices', 'search_locations', 'check_exit_ip', 'run_check', 'run_manifest', 'get_results'])
    expect(tools).toHaveLength(TOOLS.length)
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.description?.length).toBeGreaterThan(20)
    }
    const runCheck = tools.find((tool) => tool.name === 'run_check')!
    const properties = runCheck.inputSchema.properties as Record<string, Record<string, unknown>>
    expect(Object.keys(properties)).toEqual(expect.arrayContaining(['url', 'engines', 'devices', 'targets', 'steps', 'healing', 'direct']))
    expect(runCheck.inputSchema.required).toEqual(expect.arrayContaining(['url', 'engines', 'devices']))
    expect(runCheck.inputSchema.required).not.toContain('steps')
    expect(JSON.stringify(properties.steps)).toContain('assertScreenshot')
    expect(JSON.stringify(properties.steps)).not.toContain('evaluate')
    expect(runCheck.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true })
    const devices = tools.find((tool) => tool.name === 'search_devices')!
    expect((devices.inputSchema.properties as Record<string, { maximum?: number }>).limit?.maximum).toBe(20)
  })

  it('returns a refused origin as a tool error with the AppError shape and audits it without values', async () => {
    const result = await client.callTool({
      name: 'run_check',
      arguments: { url: 'https://evil.example.com/login', engines: ['chromium'], devices: ['desktop-chrome'], steps: [{ action: 'fill', selector: '#q', value: 'typed-value-xyz' }] },
    })
    expect(result.isError).toBe(true)
    const body = JSON.parse(textOf(result)) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('INVALID_INPUT')
    expect(body.error.message).toMatch(/^Origin not allowlisted: https:\/\/evil\.example\.com\./)
    expect(deps.calls.run).toEqual([])
    expect(audit).toHaveLength(1)
    const line = JSON.parse(audit[0]!) as Record<string, unknown>
    expect(line).toMatchObject({ audit: 'qa-mcp', tool: 'run_check', origins: ['https://evil.example.com'], cases: 0, outcome: 'error:INVALID_INPUT' })
    expect(audit[0]).not.toContain('typed-value-xyz')
    expect(audit[0]).not.toContain('/login')
  })

  it('reports invalid arguments and unknown tools in the same shape, and audits them', async () => {
    const invalid = await client.callTool({ name: 'search_devices', arguments: { query: 'pixel', limit: 50 } })
    expect(invalid.isError).toBe(true)
    expect(JSON.parse(textOf(invalid))).toEqual({ error: { code: 'INVALID_INPUT', message: expect.stringContaining('limit') } })
    const unknown = await client.callTool({ name: 'evaluate_js', arguments: {} })
    expect(unknown.isError).toBe(true)
    expect(JSON.parse(textOf(unknown)).error.code).toBe('NOT_FOUND')
    expect(audit.map((line) => (JSON.parse(line) as { tool: string; outcome: string }).outcome)).toEqual(['error:INVALID_INPUT', 'error:NOT_FOUND'])
    expect(audit[1]).toContain('"tool":"unknown"')
  })

  it('returns run results as text plus image content', async () => {
    const result = await client.callTool({ name: 'run_check', arguments: { url: 'https://staging.example.com/', engines: ['chromium'], devices: ['desktop-chrome'] } })
    expect(result.isError).toBeFalsy()
    const content = result.content as Array<{ type: string; mimeType?: string }>
    expect(content[0]?.type).toBe('text')
    expect(content.slice(1)).toEqual([expect.objectContaining({ type: 'image', mimeType: 'image/png' })])
    expect(JSON.parse(audit[0]!)).toMatchObject({ tool: 'run_check', origins: ['https://staging.example.com'], cases: 1, outcome: 'passed' })
  })
})

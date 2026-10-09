import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { PNG } from 'pngjs'
import { chromium } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createMcpRuntime } from '../src/main/mcp/deps'
import type { McpRuntime } from '../src/main/mcp/deps'
import { parsePolicy } from '../src/main/mcp/policy'
import { createQaMcpServer } from '../src/main/mcp/server'
import type { McpDeps } from '../src/main/mcp/tools/types'

const available = existsSync(chromium.executablePath())
if (!available && process.env.QA_REQUIRE_BROWSER_TESTS === '1') throw new Error('Chromium is required for MCP integration tests. Install it before running CI.')

describe('MCP runtime set-up', () => {
  it('takes proxy credentials from the environment, removes them and redacts them', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'qa-mcp-env-'))
    const env: NodeJS.ProcessEnv = {
      DATAIMPULSE_PROXY_HOST: 'gw.dataimpulse.com',
      DATAIMPULSE_PROXY_PORT: '823',
      DATAIMPULSE_PROXY_USERNAME: 'planted-user-71',
      DATAIMPULSE_PROXY_PASSWORD: 'planted-password-71',
      PATH: process.env.PATH,
    }
    const runtime = await createMcpRuntime(env, parsePolicy({ QA_MCP_ALLOWED_ORIGINS: 'https://staging.example.com' }), { stateRoot, warn: () => undefined })
    try {
      expect(env.DATAIMPULSE_PROXY_PASSWORD).toBeUndefined()
      expect(env.DATAIMPULSE_PROXY_USERNAME).toBeUndefined()
      expect(env.PATH).toBe(process.env.PATH)
      expect(runtime.routing()).toEqual({ proxy: { providerId: 'dataimpulse', product: 'residential' }, customGateway: false })
      expect(runtime.sanitize('auth planted-user-71:planted-password-71 and planted-password-71')).not.toMatch(/planted-(user|password)/)
      const capabilities = await runtime.capabilities()
      expect(capabilities.providers.find((provider) => provider.id === 'dataimpulse')?.configuredProducts).toEqual(['residential'])
      expect(JSON.stringify(capabilities)).not.toContain('planted-password-71')
    } finally {
      await runtime.dispose()
    }
    expect(readdirSync(stateRoot)).toEqual([])
    rmSync(stateRoot, { recursive: true, force: true })
  })

  it('refuses an unreadable workspace and invalid proxy variables', async () => {
    const policy = parsePolicy({ QA_MCP_ALLOWED_ORIGINS: 'https://staging.example.com', QA_MCP_WORKSPACE: join(tmpdir(), 'qa-mcp-no-such-dir-x9') })
    await expect(createMcpRuntime({}, policy)).rejects.toThrow(/QA_MCP_WORKSPACE does not exist/)
    const ok = parsePolicy({ QA_MCP_ALLOWED_ORIGINS: 'https://staging.example.com' })
    await expect(createMcpRuntime({ QA_PROVIDER: 'dataimpulse' }, ok)).rejects.toThrow(/Proxy variables are incomplete/)
  })
})

describe.skipIf(!available)('MCP run_check against a real local page (Chromium)', () => {
  let siteHits = 0
  let foreignHits = 0
  const site = createServer((_req, res) => {
    siteHits++
    res.setHeader('Content-Type', 'text/html')
    res.end(
      '<!doctype html><html><body><h1>Signup</h1><label>Email<input id="email" type="email"></label><button id="submit" onclick="document.querySelector(\'#result\').textContent=\'Thanks\'">Sign up</button><div id="result"></div></body></html>',
    )
  })
  const foreign = createServer((_req, res) => {
    foreignHits++
    res.end('foreign')
  })
  let origin: string, foreignOrigin: string, stateRoot: string
  let runtime: McpRuntime
  let client: Client
  let runs = 0
  let engineChecks = 0

  beforeAll(async () => {
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
    await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`
    foreignOrigin = `http://127.0.0.1:${(foreign.address() as { port: number }).port}`
    stateRoot = mkdtempSync(join(tmpdir(), 'qa-mcp-browser-'))
    runtime = await createMcpRuntime({ PATH: process.env.PATH }, parsePolicy({ QA_MCP_ALLOWED_ORIGINS: origin, QA_MCP_CONCURRENCY: '1' }), { stateRoot })
    const deps: McpDeps = {
      ...runtime,
      run: (request, signal) => {
        runs++
        return runtime.run(request, signal)
      },
      assertEngines: (engines) => {
        engineChecks++
        return runtime.assertEngines(engines)
      },
    }
    const server = createQaMcpServer(deps, { audit: () => undefined })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'browser-test', version: '1.0.0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  })
  afterAll(async () => {
    await client?.close()
    await runtime?.dispose()
    await Promise.all([new Promise<void>((resolve) => site.close(() => resolve())), new Promise<void>((resolve) => foreign.close(() => resolve()))])
    if (stateRoot) rmSync(stateRoot, { recursive: true, force: true })
  })

  it('passes on an allowlisted 127.0.0.1 origin and returns masked, downscaled screenshots', async () => {
    const result = await client.callTool({
      name: 'run_check',
      arguments: {
        url: `${origin}/signup`,
        engines: ['chromium'],
        devices: ['desktop-chrome'],
        steps: [
          { action: 'fill', selector: '#email', value: 'planted-mcp@example.test' },
          { action: 'click', selector: '#submit' },
          { action: 'assertText', selector: '#result', value: 'Thanks' },
        ],
      },
    })
    const content = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>
    expect(result.isError, content[0]?.text).toBeFalsy()
    const summary = JSON.parse(content[0]!.text!) as { runId: string; status: string; cases: Array<{ status: string; engine: string; failedSteps: unknown[] }> }
    expect(summary.status).toBe('passed')
    expect(summary.cases).toEqual([expect.objectContaining({ status: 'passed', engine: 'chromium', failedSteps: [] })])
    const images = content.filter((item) => item.type === 'image')
    expect(images).toHaveLength(1)
    const png = PNG.sync.read(Buffer.from(images[0]!.data!, 'base64'))
    expect(png.width).toBeLessThanOrEqual(800)
    expect(JSON.stringify(content)).not.toContain('planted-mcp@example.test')
    expect(siteHits).toBeGreaterThan(0)
    expect(runtime.budget.remaining()).toBe(199)

    const stored = await client.callTool({ name: 'get_results', arguments: { runId: summary.runId } })
    expect(JSON.parse((stored.content as Array<{ text: string }>)[0]!.text).status).toBe('passed')
  })

  it('refuses a non-allowlisted origin before any browser starts', async () => {
    const before = { runs, engineChecks, remaining: runtime.budget.remaining() }
    const result = await client.callTool({ name: 'run_check', arguments: { url: `${foreignOrigin}/`, engines: ['chromium'], devices: ['desktop-chrome'] } })
    expect(result.isError).toBe(true)
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text).error).toEqual({ code: 'INVALID_INPUT', message: expect.stringContaining(`Origin not allowlisted: ${foreignOrigin}`) })
    expect({ runs, engineChecks, remaining: runtime.budget.remaining() }).toEqual(before)
    expect(foreignHits).toBe(0)
  })
})

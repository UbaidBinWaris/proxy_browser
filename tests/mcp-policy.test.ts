import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import {
  McpConfigError,
  assertCaseLimit,
  assertOriginsAllowed,
  createBudgetTracker,
  disallowedOrigins,
  memoryBudgetStore,
  parseAllowedOrigin,
  parseAllowedOrigins,
  parseBudgetState,
  parsePolicy,
  remainingBudget,
  reserveBudget,
  resolveInWorkspace,
} from '../src/main/mcp/policy'
import { fileBudgetStore } from '../src/main/mcp/deps'

describe('QA_MCP_ALLOWED_ORIGINS parsing', () => {
  it('normalises entries to origins and deduplicates them', () => {
    expect(parseAllowedOrigins(' https://Staging.Example.com/ , https://staging.example.com:443,http://127.0.0.1:8080,http://localhost:3000')).toEqual([
      'https://staging.example.com',
      'http://127.0.0.1:8080',
      'http://localhost:3000',
    ])
    expect(parseAllowedOrigin('http://[::1]:5173')).toBe('http://[::1]:5173')
    expect(parseAllowedOrigin('https://staging.example.com:8443')).toBe('https://staging.example.com:8443')
  })

  it('is required', () => {
    expect(() => parseAllowedOrigins(undefined)).toThrow(McpConfigError)
    expect(() => parseAllowedOrigins(' , ')).toThrow(/QA_MCP_ALLOWED_ORIGINS is required/)
    expect(() => parsePolicy({})).toThrow(/QA_MCP_ALLOWED_ORIGINS is required/)
  })

  it('refuses http for public hosts, paths, queries, fragments, credentials, wildcards and other schemes', () => {
    for (const bad of [
      'http://staging.example.com',
      'https://staging.example.com/app',
      'https://staging.example.com?x=1',
      'https://staging.example.com/#top',
      'https://user:pass@staging.example.com',
      'https://*.example.com',
      'ftp://staging.example.com',
      'staging.example.com',
    ])
      expect(() => parseAllowedOrigin(bad), bad).toThrow(McpConfigError)
  })

  it('never echoes a credential from a refused entry', () => {
    try {
      parseAllowedOrigin('https://user:hunter2@staging.example.com')
      expect.unreachable()
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('hunter2')
    }
  })

  it('limits the allowlist to the 30 origins a scenario can carry', () => {
    const many = Array.from({ length: 31 }, (_, index) => `https://s${index}.example.com`).join(',')
    expect(() => parseAllowedOrigins(many)).toThrow(/at most 30/)
  })
})

describe('policy settings', () => {
  it('applies the documented defaults', () => {
    expect(parsePolicy({ QA_MCP_ALLOWED_ORIGINS: 'https://staging.example.com' })).toEqual({
      allowedOrigins: ['https://staging.example.com'],
      workspace: null,
      maxCases: 12,
      concurrency: 2,
      dailyBudget: 200,
    })
  })

  it('reads and bounds the numeric limits', () => {
    const base = { QA_MCP_ALLOWED_ORIGINS: 'https://staging.example.com' }
    expect(parsePolicy({ ...base, QA_MCP_MAX_CASES: '4', QA_MCP_CONCURRENCY: '1', QA_MCP_DAILY_BUDGET: '50' })).toMatchObject({ maxCases: 4, concurrency: 1, dailyBudget: 50 })
    expect(() => parsePolicy({ ...base, QA_MCP_CONCURRENCY: '5' })).toThrow(/QA_MCP_CONCURRENCY must be between 1 and 4/)
    expect(() => parsePolicy({ ...base, QA_MCP_CONCURRENCY: '0' })).toThrow(McpConfigError)
    expect(() => parsePolicy({ ...base, QA_MCP_MAX_CASES: '2.5' })).toThrow(/whole number/)
    expect(() => parsePolicy({ ...base, QA_MCP_DAILY_BUDGET: '-1' })).toThrow(McpConfigError)
  })
})

describe('origin subset checks', () => {
  const policy = { allowedOrigins: ['https://staging.example.com', 'http://127.0.0.1:8080'] }

  it('accepts URLs and origins on the allowlist', () => {
    expect(disallowedOrigins(policy, ['https://staging.example.com/signup?step=2', 'http://127.0.0.1:8080/'])).toEqual([])
    expect(() => assertOriginsAllowed(policy, ['https://staging.example.com'])).not.toThrow()
  })

  it('refuses another scheme, port or host and names only the origin', () => {
    expect(disallowedOrigins(policy, ['http://staging.example.com/', 'http://127.0.0.1:9090/x?token=abc', 'https://evil.example.com', 'not a url'])).toEqual([
      'http://staging.example.com',
      'http://127.0.0.1:9090',
      'https://evil.example.com',
      'not a url',
    ])
    expect(() => assertOriginsAllowed(policy, ['https://evil.example.com/path'])).toThrow(/Origin not allowlisted: https:\/\/evil\.example\.com\./)
  })

  it('enforces the per-call case limit', () => {
    expect(() => assertCaseLimit({ maxCases: 4 }, 4)).not.toThrow()
    expect(() => assertCaseLimit({ maxCases: 4 }, 5)).toThrow(/would run 5 cases; the limit is 4/)
  })
})

describe('workspace containment', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-mcp-ws-'))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  mkdirSync(join(workspace, 'suites'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(workspace, 'suites', 'signup.json'), '{}')
  writeFileSync(join(outside, 'secret.json'), '{}')
  symlinkSync(join(outside, 'secret.json'), join(workspace, 'escape.json'))
  symlinkSync(outside, join(workspace, 'linked-dir'))
  symlinkSync(join(workspace, 'suites', 'signup.json'), join(workspace, 'inside-link.json'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('resolves relative and absolute paths inside the workspace', async () => {
    const expected = join(workspace, 'suites', 'signup.json')
    await expect(resolveInWorkspace(workspace, 'suites/signup.json')).resolves.toBe(expected)
    await expect(resolveInWorkspace(workspace, expected)).resolves.toBe(expected)
    await expect(resolveInWorkspace(workspace, 'inside-link.json')).resolves.toBe(expected)
  })

  it('refuses ../ escapes, absolute paths outside and symlink escapes', async () => {
    await expect(resolveInWorkspace(workspace, '../outside/secret.json')).rejects.toThrow(/must resolve inside QA_MCP_WORKSPACE/)
    await expect(resolveInWorkspace(workspace, join(outside, 'secret.json'))).rejects.toThrow(/must resolve inside/)
    await expect(resolveInWorkspace(workspace, 'escape.json')).rejects.toThrow(/must resolve inside/)
    await expect(resolveInWorkspace(workspace, 'linked-dir/secret.json')).rejects.toThrow(/must resolve inside/)
    await expect(resolveInWorkspace(workspace, '.')).rejects.toThrow(/must resolve inside/)
  })

  it('reports missing files and a missing workspace setting', async () => {
    await expect(resolveInWorkspace(workspace, 'nope.json')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(resolveInWorkspace(null, 'suites/signup.json')).rejects.toThrow(/Set QA_MCP_WORKSPACE/)
    await expect(resolveInWorkspace(workspace, 'a\0b')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

describe('daily budget', () => {
  const day1 = new Date('2026-10-08T23:59:00Z')
  const day2 = new Date('2026-10-09T00:00:30Z')

  it('counts attempts per UTC day and resets at midnight UTC', () => {
    let state = reserveBudget(null, 10, 6, day1)
    expect(state).toEqual({ day: '2026-10-08', used: 6 })
    expect(remainingBudget(state, 10, day1)).toBe(4)
    state = reserveBudget(state, 10, 4, day1)
    expect(remainingBudget(state, 10, day1)).toBe(0)
    expect(() => reserveBudget(state, 10, 1, day1)).toThrow(/exhausted/)
    expect(remainingBudget(state, 10, day2)).toBe(10)
    expect(reserveBudget(state, 10, 3, day2)).toEqual({ day: '2026-10-09', used: 3 })
  })

  it('refuses a reservation larger than what remains, without consuming anything', () => {
    const tracker = createBudgetTracker(5, memoryBudgetStore(), () => day1)
    tracker.reserve(3)
    expect(() => tracker.reserve(3)).toThrow(/needs 3 case attempts but only 2/)
    expect(tracker.remaining()).toBe(2)
    try {
      tracker.reserve(3)
    } catch (err) {
      expect((err as { code: string }).code).toBe('SESSION_LIMIT')
    }
  })

  it('validates persisted state', () => {
    expect(parseBudgetState({ day: '2026-10-08', used: 3 })).toEqual({ day: '2026-10-08', used: 3 })
    expect(parseBudgetState({ day: 'yesterday', used: 3 })).toBeNull()
    expect(parseBudgetState({ day: '2026-10-08', used: -1 })).toBeNull()
    expect(parseBudgetState('x')).toBeNull()
  })

  it('persists the count in the workspace state file across restarts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-mcp-budget-'))
    try {
      const file = join(dir, '.qa-mcp', 'budget.json')
      createBudgetTracker(10, fileBudgetStore(file), () => day1).reserve(7)
      const restarted = createBudgetTracker(10, fileBudgetStore(file), () => day1)
      expect(restarted.remaining()).toBe(3)
      expect(createBudgetTracker(10, fileBudgetStore(file), () => day2).remaining()).toBe(10)
      writeFileSync(file, 'not json')
      expect(createBudgetTracker(10, fileBudgetStore(file), () => day1).remaining()).toBe(10)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

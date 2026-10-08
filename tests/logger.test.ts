import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LogEntry } from '@shared/types'

import type { LogRepository } from '../src/main/contracts'
import { createLogger, redactSecrets } from '../src/main/logging/logger'

function memoryRepo(): LogRepository & { rows: LogEntry[]; pruneCalls: number[] } {
  const rows: LogEntry[] = []
  const pruneCalls: number[] = []
  let nextId = 1
  return {
    rows,
    pruneCalls,
    insert: (entry) => {
      const saved: LogEntry = { id: nextId++, ...entry }
      rows.push(saved)
      return saved
    },
    query: (query = {}) => {
      const limit = query.limit ?? 500
      return [...rows].reverse().slice(0, limit)
    },
    clear: () => {
      rows.length = 0
    },
    prune: (max) => {
      pruneCalls.push(max)
      while (rows.length > max) rows.shift()
    },
  }
}

const SECRET = 'Sup3r-S3cret-P@ss'

describe('redactSecrets', () => {
  it('replaces registered secrets deeply in strings, arrays and nested objects', () => {
    const out = redactSecrets(
      {
        msg: `connecting with ${SECRET} now`,
        nested: { list: [SECRET, `x${SECRET}y`, 42, true, null] },
        [SECRET]: 'key-is-secret',
      },
      [SECRET],
    ) as Record<string, unknown>
    expect(out.msg).toBe('connecting with [REDACTED] now')
    expect(out.nested).toEqual({ list: ['[REDACTED]', 'x[REDACTED]y', 42, true, null] })
    expect(out['[REDACTED]']).toBe('key-is-secret')
    expect(JSON.stringify(out)).not.toContain(SECRET)
  })

  it('scrubs URL credentials with and without scheme', () => {
    expect(redactSecrets('proxy http://alice:hunter2@gw.dataimpulse.com:823/', [])).toBe(
      'proxy http://[REDACTED]:[REDACTED]@gw.dataimpulse.com:823/',
    )
    expect(redactSecrets('server=alice__cr.us:hunter2@gw.dataimpulse.com:823', [])).toBe(
      'server=[REDACTED]:[REDACTED]@gw.dataimpulse.com:823',
    )
    expect(redactSecrets('https://gw.dataimpulse.com:823/ no creds', [])).toBe('https://gw.dataimpulse.com:823/ no creds')
  })

  it('scrubs Authorization / Proxy-Authorization header values', () => {
    expect(redactSecrets('Proxy-Authorization: Basic YWxpY2U6aHVudGVyMg==', [])).toBe('Proxy-Authorization: [REDACTED]')
    expect(redactSecrets({ headers: { authorization: 'Bearer abc.def.ghi', accept: '*/*' } }, [])).toEqual({
      headers: { authorization: '[REDACTED]', accept: '*/*' },
    })
    expect(redactSecrets('{"Proxy-Authorization":"Basic xyz","host":"a"}', [])).toBe('{"Proxy-Authorization":"[REDACTED]","host":"a"}')
  })

  it('scrubs password=... and "password":"..." patterns', () => {
    expect(redactSecrets('user=alice&password=hunter2&x=1', [])).toBe('user=alice&password=[REDACTED]&x=1')
    expect(redactSecrets('{"username":"alice","password":"hunter2"}', [])).toBe('{"username":"alice","password":"[REDACTED]"}')
    expect(redactSecrets('password: hunter2', [])).toBe('password: [REDACTED]')
  })

  it('serialises errors, dates and circular structures safely', () => {
    const err = new Error(`boom ${SECRET}`)
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    const out = redactSecrets({ err, when: new Date('2026-01-01T00:00:00Z'), circular }, [SECRET]) as Record<string, unknown>
    expect((out.err as { message: string }).message).toBe('boom [REDACTED]')
    expect((out.err as { name: string }).name).toBe('Error')
    expect(out.when).toBe('2026-01-01T00:00:00.000Z')
    expect((out.circular as { self: string }).self).toBe('[Circular]')
  })
})

describe('createLogger', () => {
  let dir: string
  let repo: ReturnType<typeof memoryRepo>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proxy-qa-logs-'))
    repo = memoryRepo()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('redacts registered secrets, URL creds and headers before persisting, writing and notifying', () => {
    const logger = createLogger({ repo, fileDir: dir })
    logger.registerSecret(SECRET)
    const seen: LogEntry[] = []
    const off = logger.onEntry((e) => seen.push(e))

    logger.info('proxy', `Using proxy http://alice:${SECRET}@gw.dataimpulse.com:823 for QA`, {
      password: SECRET,
      headers: { 'Proxy-Authorization': `Basic ${Buffer.from(`alice:${SECRET}`).toString('base64')}` },
      server: `alice:${SECRET}@gw.dataimpulse.com:823`,
      ok: true,
      depth: { list: [SECRET] },
    })

    expect(repo.rows).toHaveLength(1)
    const row = repo.rows[0]!
    expect(row.message).toBe('Using proxy http://[REDACTED]:[REDACTED]@gw.dataimpulse.com:823 for QA')
    expect(row.meta).toEqual({
      password: '[REDACTED]',
      headers: { 'Proxy-Authorization': '[REDACTED]' },
      server: '[REDACTED]:[REDACTED]@gw.dataimpulse.com:823',
      ok: true,
      depth: { list: ['[REDACTED]'] },
    })
    expect(JSON.stringify(row)).not.toContain(SECRET)

    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual(row)
    expect(seen[0]!.id).toBe(1)

    const files = readdirSync(dir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^app-\d{4}-\d{2}-\d{2}\.log$/)
    const content = readFileSync(join(dir, files[0]!), 'utf8')
    expect(content.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(content.trim()) as LogEntry
    expect(parsed).toEqual(row)
    expect(content).not.toContain(SECRET)

    off()
    logger.warn('proxy', 'second')
    expect(seen).toHaveLength(1)
    expect(repo.rows).toHaveLength(2)
    expect(repo.rows[1]!.level).toBe('WARN')
    expect(repo.rows[1]!.meta).toBeNull()
  })

  it('prunes the repository every N inserts and exposes query/clear', () => {
    const logger = createLogger({ repo, fileDir: dir, maxRows: 5, pruneEvery: 3 })
    for (let i = 0; i < 7; i += 1) logger.error('test', `entry ${i}`)
    expect(repo.pruneCalls).toEqual([5, 5])
    expect(repo.rows.length).toBeLessThanOrEqual(6)
    expect(logger.query({ limit: 2 }).map((e) => e.message)).toEqual(['entry 6', 'entry 5'])
    logger.clear()
    expect(logger.query()).toEqual([])
  })

  it('echoes to console when enabled, using the matching console method', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const logger = createLogger({ repo, fileDir: dir, console: true })
    logger.registerSecret(SECRET)
    logger.info('a', 'one')
    logger.warn('a', 'two')
    logger.error('a', `three ${SECRET}`)
    expect(log).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0]?.[0])).toContain('three [REDACTED]')
    expect(String(error.mock.calls[0]?.[0])).not.toContain(SECRET)
  })

  it('still notifies listeners when persistence fails', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const broken: LogRepository = {
      ...repo,
      insert: () => {
        throw new Error('disk full')
      },
    }
    const logger = createLogger({ repo: broken, fileDir: dir })
    const seen: LogEntry[] = []
    logger.onEntry((e) => seen.push(e))
    logger.info('x', 'hello')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.id).toBe(-1)
    expect(seen[0]!.message).toBe('hello')
  })
})

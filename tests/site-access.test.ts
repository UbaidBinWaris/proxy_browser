/**
 * Site access tokens: pure matching and validation, the encrypted store (fake safeStorage), the IPC
 * surface (never returns the secret) and log redaction. Real-browser routing and redirect safety are
 * covered by tests/site-access-browser.test.ts.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogEntry } from '@shared/types'
import { IPC } from '@shared/ipc'
import {
  SiteAccessTokenInputSchema,
  maskSiteAccessValue,
  parseSiteAccessOrigin,
  siteAccessHeaderNameProblem,
  siteAccessHeaderValueProblem,
} from '@shared/site-access'
import type { SiteAccessTokenInput } from '@shared/site-access'
import type { LogRepository, Logger } from '../src/main/contracts'
import { createLogger } from '../src/main/logging/logger'
import { toInvokeHandler } from '../src/main/ipc/handle'
import { allIpcChannels } from '../src/main/ipc/index'
import { createSiteAccessMatcher, findSiteAccessConflicts, requestOrigin } from '../src/main/site-access/matcher'
import type { SiteAccessRule } from '../src/main/site-access/matcher'
import { SITE_ACCESS_FILE_NAME, createSiteAccessStore } from '../src/main/site-access/store'
import type { SiteAccessEncryption, SiteAccessStore } from '../src/main/site-access/store'
import { TRACE_SKIPPED_NOTE, createSiteAccess, shouldSkipTrace, siteAccessHandlers, siteAccessNote } from '../src/main/site-access'
import { redirectTrampoline } from '../src/main/site-access/attach'

const SECRET = 'qa-allow-7c1e55d0b9a24f3e' // gitleaks:allow (synthetic test value)
const OTHER_SECRET = 'qa-allow-second-91f0aa2c4e' // gitleaks:allow (synthetic test value)

// ---------------------------------------------------------------------------
// Origins, header names and values
// ---------------------------------------------------------------------------

describe('parseSiteAccessOrigin', () => {
  const origin = (raw: string): string | null => {
    const parsed = parseSiteAccessOrigin(raw)
    return parsed.ok ? parsed.origin : null
  }

  it('normalises case, IDN, the default port and a trailing slash', () => {
    expect(origin('https://Staging.Example.COM')).toBe('https://staging.example.com')
    expect(origin('https://staging.example.com/')).toBe('https://staging.example.com')
    expect(origin('https://staging.example.com:443')).toBe('https://staging.example.com')
    expect(origin('https://staging.example.com:8443/')).toBe('https://staging.example.com:8443')
    expect(origin('https://BÜCHER.example')).toBe('https://xn--bcher-kva.example')
    expect(origin('  https://a.example  ')).toBe('https://a.example')
  })

  it('allows plain http only for loopback staging', () => {
    expect(origin('http://localhost:3000')).toBe('http://localhost:3000')
    expect(origin('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080')
    expect(origin('http://[::1]:5173')).toBe('http://[::1]:5173')
    expect(origin('http://staging.example.com')).toBeNull()
    expect(origin('http://10.0.0.5')).toBeNull()
  })

  it('rejects paths, queries, fragments, credentials, wildcards and other schemes', () => {
    for (const raw of [
      'https://example.com/form',
      'https://example.com/?a=1',
      'https://example.com/#x',
      'https://user:pass@example.com',
      'https://*.example.com',
      'ftp://example.com',
      'example.com',
      'wss://example.com',
      '',
    ]) {
      const parsed = parseSiteAccessOrigin(raw)
      expect(parsed.ok, raw).toBe(false)
    }
  })
})

describe('header name and value validation', () => {
  it('accepts custom token headers', () => {
    expect(siteAccessHeaderNameProblem('X-QA-Access')).toBeNull()
    expect(siteAccessHeaderNameProblem('x_qa.token')).toBeNull()
  })

  it.each([
    'Host',
    'Cookie',
    'Authorization',
    'Proxy-Authorization',
    'Content-Length',
    'Origin',
    'Referer',
    'Sec-Fetch-Mode',
    'sec-ch-ua',
    'Proxy-Anything',
    'User-Agent',
    'X-Forwarded-For',
    'Forwarded',
    'CF-Connecting-IP',
    'True-Client-IP',
    'X-Real-IP',
  ])('denies %s', (name) => {
    expect(siteAccessHeaderNameProblem(name)).not.toBeNull()
    expect(siteAccessHeaderNameProblem(name.toLowerCase())).not.toBeNull()
  })

  it('rejects non-token characters', () => {
    expect(siteAccessHeaderNameProblem('X QA')).not.toBeNull()
    expect(siteAccessHeaderNameProblem('X-QA:1')).not.toBeNull()
    expect(siteAccessHeaderNameProblem('')).not.toBeNull()
  })

  it('rejects control characters, padding and over-long values', () => {
    expect(siteAccessHeaderValueProblem(SECRET)).toBeNull()
    expect(siteAccessHeaderValueProblem('a b')).toBeNull()
    expect(siteAccessHeaderValueProblem('abc\r\nX-Evil: 1')).not.toBeNull()
    expect(siteAccessHeaderValueProblem(' abc')).not.toBeNull()
    expect(siteAccessHeaderValueProblem('abc ')).not.toBeNull()
    expect(siteAccessHeaderValueProblem('x'.repeat(4096))).toBeNull()
    expect(siteAccessHeaderValueProblem('x'.repeat(4097))).not.toBeNull()
    expect(siteAccessHeaderValueProblem('')).not.toBeNull()
  })

  it('masks values without ever revealing short secrets', () => {
    expect(maskSiteAccessValue('short-secret')).toBe('••••••••')
    expect(maskSiteAccessValue(SECRET)).toBe(`••••••••${SECRET.slice(-4)}`)
    expect(maskSiteAccessValue(SECRET)).not.toContain(SECRET.slice(0, 8))
  })
})

describe('SiteAccessTokenInputSchema', () => {
  const base: SiteAccessTokenInput = {
    name: 'Staging',
    origins: ['https://staging.example.com'],
    headerName: 'X-QA-Access',
    headerValue: SECRET,
    enabled: true,
  }

  it('normalises the origin list', () => {
    const parsed = SiteAccessTokenInputSchema.parse({ ...base, origins: ['https://STAGING.example.com/', 'http://localhost:3000'] })
    expect(parsed.origins).toEqual(['https://staging.example.com', 'http://localhost:3000'])
  })

  it('requires 1–20 distinct origins', () => {
    expect(SiteAccessTokenInputSchema.safeParse({ ...base, origins: [] }).success).toBe(false)
    const twenty = Array.from({ length: 20 }, (_, i) => `https://s${i}.example.com`)
    expect(SiteAccessTokenInputSchema.safeParse({ ...base, origins: twenty }).success).toBe(true)
    expect(SiteAccessTokenInputSchema.safeParse({ ...base, origins: [...twenty, 'https://s20.example.com'] }).success).toBe(false)
    const duplicate = SiteAccessTokenInputSchema.safeParse({ ...base, origins: ['https://a.example', 'https://A.example/'] })
    expect(duplicate.success).toBe(false)
    expect(duplicate.error?.issues[0]?.message).toContain('listed twice')
  })

  it('lets an update omit the value', () => {
    const { headerValue: _value, ...rest } = base
    expect(SiteAccessTokenInputSchema.safeParse(rest).success).toBe(true)
    expect(SiteAccessTokenInputSchema.safeParse({ ...rest, headerValue: '' }).success).toBe(true)
  })

  it('rejects a deny-listed header', () => {
    expect(SiteAccessTokenInputSchema.safeParse({ ...base, headerName: 'Cookie' }).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Matcher
// ---------------------------------------------------------------------------

describe('site access matcher (exact origin)', () => {
  const rules: SiteAccessRule[] = [
    { id: 't1', name: 'Staging', origins: ['https://staging.example.com', 'http://localhost:3000'], headerName: 'X-QA-Access', headerValue: SECRET },
    { id: 't2', name: 'IDN', origins: ['https://bücher.example'], headerName: 'X-QA-Access', headerValue: OTHER_SECRET },
  ]
  const matcher = createSiteAccessMatcher(rules)
  const header = (url: string): string | null => matcher.match(url)?.headers['x-qa-access'] ?? null

  it('matches the exact origin and ignores path, query and fragment', () => {
    expect(header('https://staging.example.com')).toBe(SECRET)
    expect(header('https://staging.example.com/')).toBe(SECRET)
    expect(header('https://staging.example.com/forms/lead?step=2#top')).toBe(SECRET)
    expect(header('https://STAGING.example.com:443/x')).toBe(SECRET)
    expect(header('http://localhost:3000/api')).toBe(SECRET)
  })

  it('does not match another port, scheme, subdomain or look-alike host', () => {
    expect(header('https://staging.example.com:8443/')).toBeNull()
    expect(header('http://staging.example.com/')).toBeNull()
    expect(header('https://localhost:3000/')).toBeNull()
    expect(header('http://localhost:3001/')).toBeNull()
    expect(header('https://www.staging.example.com/')).toBeNull()
    expect(header('https://example.com/')).toBeNull()
    expect(header('https://staging.example.com.evil.test/')).toBeNull()
    expect(header('https://staging.example.com@evil.test/')).toBeNull()
    expect(header('https://evil.test/?u=https://staging.example.com')).toBeNull()
  })

  it('matches IDN hosts through their punycode form', () => {
    expect(header('https://xn--bcher-kva.example/')).toBe(OTHER_SECRET)
    expect(header('https://BÜCHER.example/a')).toBe(OTHER_SECRET)
  })

  it('ignores non-web URLs', () => {
    expect(requestOrigin('data:text/plain,hi')).toBeNull()
    expect(requestOrigin('blob:https://staging.example.com/1234')).toBeNull()
    expect(requestOrigin('about:blank')).toBeNull()
    expect(requestOrigin('not a url')).toBeNull()
    expect(header('ws://localhost:3000/socket')).toBeNull()
  })

  it('reports which token applied to which origin, with lower-case header names', () => {
    expect(matcher.match('https://staging.example.com/x')).toEqual({
      headers: { 'x-qa-access': SECRET },
      applied: [{ tokenId: 't1', tokenName: 'Staging', origin: 'https://staging.example.com' }],
    })
    expect([...matcher.origins].sort()).toEqual(['http://localhost:3000', 'https://staging.example.com', 'https://xn--bcher-kva.example'])
  })
})

describe('findSiteAccessConflicts', () => {
  it('flags two tokens sending the same header (any case) to the same origin', () => {
    const problems = findSiteAccessConflicts([
      { id: 'a', name: 'A', origins: ['https://s.example.com'], headerName: 'X-QA-Access' },
      { id: 'b', name: 'B', origins: ['https://S.example.com/'], headerName: 'x-qa-access' },
    ])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('https://s.example.com')
  })

  it('allows different headers on one origin and one header on different origins', () => {
    expect(
      findSiteAccessConflicts([
        { id: 'a', name: 'A', origins: ['https://s.example.com'], headerName: 'X-QA-Access' },
        { id: 'b', name: 'B', origins: ['https://s.example.com'], headerName: 'X-Test-Lead' },
        { id: 'c', name: 'C', origins: ['https://t.example.com'], headerName: 'X-QA-Access' },
      ]),
    ).toEqual([])
  })
})

describe('redirect trampoline and evidence', () => {
  it('escapes the target in both the script and the meta refresh', () => {
    const page = redirectTrampoline('https://s.example.com/a?b="</script><script>alert(1)</script>&c=<x>')
    expect(page).not.toContain('</script><script>alert(1)')
    expect(page).toContain('location.replace(')
    expect(page).toContain('&quot;')
  })

  it('evidence names the token and origin, never the value', () => {
    expect(siteAccessNote('Staging', 'https://s.example.com')).toBe('site access token "Staging" applied to https://s.example.com')
  })
})

// ---------------------------------------------------------------------------
// Store (fake safeStorage)
// ---------------------------------------------------------------------------

/** Reversible stand-in for safeStorage: the ciphertext never contains the plain value. */
function fakeSafeStorage(): SiteAccessEncryption & { encryptString: ReturnType<typeof vi.fn> } {
  return {
    encryptString: vi.fn((value: string) => Buffer.from(`enc:${Buffer.from(value, 'utf8').toString('hex').split('').reverse().join('')}`)),
    decryptString: (value: Buffer) => {
      const text = value.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('bad ciphertext')
      return Buffer.from(text.slice(4).split('').reverse().join(''), 'hex').toString('utf8')
    },
  }
}

function memoryRepo(): LogRepository & { rows: LogEntry[] } {
  const rows: LogEntry[] = []
  return {
    rows,
    insert: (entry) => {
      const saved: LogEntry = { id: rows.length + 1, ...entry }
      rows.push(saved)
      return saved
    },
    query: () => [...rows].reverse(),
    clear: () => {
      rows.length = 0
    },
    prune: () => undefined,
  }
}

describe('site access store', () => {
  let dir: string
  let file: string
  let repo: ReturnType<typeof memoryRepo>
  let logger: Logger
  let registered: string[]

  const input = (patch: Partial<SiteAccessTokenInput> = {}): SiteAccessTokenInput => ({
    name: 'Staging',
    origins: ['https://staging.example.com'],
    headerName: 'X-QA-Access',
    headerValue: SECRET,
    enabled: true,
    ...patch,
  })

  const open = (encryption: SiteAccessEncryption | null = fakeSafeStorage()): SiteAccessStore => {
    const store = createSiteAccessStore({ file, logger, now: () => new Date('2026-10-08T10:00:00.000Z') })
    store.unlock(encryption)
    return store
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'site-access-'))
    file = join(dir, SITE_ACCESS_FILE_NAME)
    repo = memoryRepo()
    const base = createLogger({ repo, fileDir: join(dir, 'logs') })
    registered = []
    logger = {
      ...base,
      registerSecret: (value) => {
        registered.push(value)
        base.registerSecret(value)
      },
    }
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips through encryption without the value ever touching the file', () => {
    const store = open()
    const saved = store.save(input())
    expect(saved).toMatchObject({ name: 'Staging', origins: ['https://staging.example.com'], headerName: 'X-QA-Access', enabled: true, valueAvailable: true })
    expect(saved.valuePreview).toBe(`••••••••${SECRET.slice(-4)}`)
    expect(registered).toContain(SECRET)

    const onDisk = readFileSync(file, 'utf8')
    expect(onDisk).not.toContain(SECRET)
    expect(onDisk).toContain('X-QA-Access')

    registered.length = 0
    const reopened = open()
    expect(reopened.activeRules()).toEqual([
      { id: saved.id, name: 'Staging', origins: ['https://staging.example.com'], headerName: 'X-QA-Access', headerValue: SECRET },
    ])
    // Registered with the redactor as soon as it is decrypted at start-up.
    expect(registered).toContain(SECRET)
  })

  it('keeps the stored value when an update omits it, and replaces it when given', () => {
    const store = open()
    const saved = store.save(input())
    const renamed = store.save({ ...input({ name: 'Renamed', origins: ['https://staging.example.com', 'http://localhost:3000'] }), headerValue: '' }, saved.id)
    expect(renamed.name).toBe('Renamed')
    expect(store.activeRules()[0]?.headerValue).toBe(SECRET)
    store.save(input({ headerValue: OTHER_SECRET }), saved.id)
    expect(store.activeRules()[0]?.headerValue).toBe(OTHER_SECRET)
    expect(store.status().tokens).toHaveLength(1)
  })

  it('requires a value for a new token', () => {
    const store = open()
    expect(() => store.save({ ...input(), headerValue: '' })).toThrow(/secret header value/)
  })

  it('refuses a token that would send the same header to an origin another token covers', () => {
    const store = open()
    store.save(input())
    const before = readFileSync(file, 'utf8')
    expect(() => store.save(input({ name: 'Duplicate', origins: ['https://STAGING.example.com/'], headerName: 'x-qa-access' }))).toThrow(/both send/)
    expect(readFileSync(file, 'utf8')).toBe(before)
    // A different header on the same origin is fine.
    store.save(input({ name: 'Lead tag', headerName: 'X-Test-Lead', headerValue: OTHER_SECRET }))
    expect(store.status().tokens).toHaveLength(2)
  })

  it('only enabled tokens are applied; disabling and deleting take effect at once', () => {
    const store = open()
    const saved = store.save(input())
    expect(store.setEnabled(saved.id, false).enabled).toBe(false)
    expect(store.activeRules()).toEqual([])
    store.setEnabled(saved.id, true)
    expect(store.activeRules()).toHaveLength(1)
    store.remove(saved.id)
    expect(store.activeRules()).toEqual([])
    expect(store.status().tokens).toEqual([])
    expect(() => store.remove(saved.id)).toThrow(/no longer exists/)
  })

  it('without a usable keychain nothing can be saved or applied', () => {
    const store = open(null)
    expect(store.status()).toMatchObject({ available: false, tokens: [] })
    expect(store.status().reason).toMatch(/keychain/)
    expect(() => store.save(input())).toThrow(/keychain/)
    expect(store.activeRules()).toEqual([])
  })

  it('a value that cannot be decrypted on this device is listed but never applied', () => {
    open().save(input())
    const foreign: SiteAccessEncryption = {
      encryptString: (value) => Buffer.from(value),
      decryptString: () => {
        throw new Error('different machine')
      },
    }
    const store = open(foreign)
    const [token] = store.status().tokens
    expect(token).toMatchObject({ valueAvailable: false, valuePreview: 'Unavailable on this device' })
    expect(store.activeRules()).toEqual([])
    expect(() => store.save({ ...input(), headerValue: '' }, token!.id)).toThrow(/cannot be decrypted/)
  })

  it('an unreadable file yields no tokens instead of failing start-up', () => {
    writeFileSync(file, '{not json')
    const store = open()
    expect(store.status().tokens).toEqual([])
    expect(repo.rows.some((row) => row.level === 'WARN' && row.scope === 'site-access')).toBe(true)
  })

  it('the secret never reaches a log line or log file, even when something logs it verbatim', () => {
    const store = open()
    store.save(input())
    logger.info('test', `accidentally logging ${SECRET}`, { header: { 'x-qa-access': SECRET } })
    logger.warn('test', 'meta only', { value: SECRET })
    const persisted = JSON.stringify(repo.rows)
    expect(persisted).not.toContain(SECRET)
    expect(persisted).toContain('[REDACTED]')
    const files = readdirSync(join(dir, 'logs'))
    expect(files.length).toBeGreaterThan(0)
    for (const name of files) expect(readFileSync(join(dir, 'logs', name), 'utf8')).not.toContain(SECRET)
  })
})

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

describe('siteAccess IPC', () => {
  let dir: string
  let store: SiteAccessStore
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), registerSecret: vi.fn(), query: vi.fn(() => []), clear: vi.fn(), onEntry: vi.fn() } as unknown as Logger,
    sanitize: (text: string) => text.split(SECRET).join('[REDACTED]'),
  }
  const call = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = siteAccessHandlers(store).find((candidate) => candidate.channel === channel)
    if (!handler) throw new Error(`no handler for ${channel}`)
    return toInvokeHandler(handler, ctx)(null, ...args)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'site-access-ipc-'))
    store = createSiteAccessStore({ file: join(dir, SITE_ACCESS_FILE_NAME), logger: ctx.logger })
    store.unlock(fakeSafeStorage())
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('declares its own namespace and every channel has a handler', () => {
    const channels = Object.values(IPC.siteAccess)
    expect(channels.every((channel) => allIpcChannels().includes(channel))).toBe(true)
    expect(siteAccessHandlers(store).map((handler) => handler.channel).sort()).toEqual([...channels].sort())
  })

  it('never returns the header value: save, status, toggle', async () => {
    const saved = (await call(IPC.siteAccess.save, {
      name: 'Staging',
      origins: ['https://staging.example.com'],
      headerName: 'X-QA-Access',
      headerValue: SECRET,
      enabled: true,
    })) as { ok: true; data: { id: string } }
    expect(saved.ok).toBe(true)
    const responses = [
      saved,
      await call(IPC.siteAccess.status),
      await call(IPC.siteAccess.setEnabled, saved.data.id, false),
      // An update without a value keeps the stored secret (and here keeps the token disabled).
      await call(IPC.siteAccess.save, { name: 'Staging 2', origins: ['https://staging.example.com'], headerName: 'X-QA-Access', enabled: false }, saved.data.id),
      await call(IPC.siteAccess.status),
    ]
    for (const response of responses) {
      expect(response).toMatchObject({ ok: true })
      expect(JSON.stringify(response)).not.toContain(SECRET)
      expect(JSON.stringify(response)).not.toContain(SECRET.slice(0, 12))
    }
    expect(store.activeRules()).toEqual([])
    await call(IPC.siteAccess.setEnabled, saved.data.id, true)
    expect(store.activeRules()[0]?.headerValue).toBe(SECRET)
  })

  it('answers invalid input with an actionable INVALID_INPUT that does not echo the value', async () => {
    const bad = (await call(IPC.siteAccess.save, {
      name: 'Bad',
      origins: ['http://staging.example.com'],
      headerName: 'X-QA-Access',
      headerValue: SECRET,
      enabled: true,
    })) as { ok: false; error: { code: string; message: string } }
    expect(bad.ok).toBe(false)
    expect(bad.error.code).toBe('INVALID_INPUT')
    expect(bad.error.message).toMatch(/http is allowed only for localhost/)
    expect(JSON.stringify(bad)).not.toContain(SECRET)

    const denied = (await call(IPC.siteAccess.save, {
      name: 'Bad',
      origins: ['https://staging.example.com'],
      headerName: 'Authorization',
      headerValue: SECRET,
      enabled: true,
    })) as { ok: false; error: { code: string } }
    expect(denied).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  })

  it('reports an unavailable store instead of throwing across IPC', async () => {
    const handler = siteAccessHandlers(undefined).find((candidate) => candidate.channel === IPC.siteAccess.status)!
    expect(await toInvokeHandler(handler, ctx)(null)).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
  })
})

describe('trace capture while tokens are active', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('skips requested traces only while an enabled token would be sent', () => {
    dir = mkdtempSync(join(tmpdir(), 'site-access-trace-'))
    const logger = createLogger({ repo: memoryRepo(), fileDir: join(dir, 'logs') })
    const siteAccess = createSiteAccess({ file: join(dir, SITE_ACCESS_FILE_NAME), logger })
    siteAccess.unlock(fakeSafeStorage())

    expect(siteAccess.hasActiveRules?.()).toBe(false)
    expect(shouldSkipTrace(true, siteAccess)).toBe(false)

    const saved = siteAccess.store.save({
      name: 'Staging',
      origins: ['https://staging.example.com'],
      headerName: 'X-QA-Access',
      headerValue: SECRET,
      enabled: true,
    })
    expect(shouldSkipTrace(true, siteAccess)).toBe(true)
    expect(shouldSkipTrace(false, siteAccess)).toBe(false)
    expect(shouldSkipTrace(undefined, siteAccess)).toBe(false)

    siteAccess.store.setEnabled(saved.id, false)
    expect(shouldSkipTrace(true, siteAccess)).toBe(false)
    expect(shouldSkipTrace(true, undefined)).toBe(false)
    expect(TRACE_SKIPPED_NOTE).not.toContain(SECRET)
  })
})

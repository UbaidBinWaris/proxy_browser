import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { AppException } from '../src/main/contracts'
import type { Logger } from '../src/main/contracts'
import { IdArg, NoArgs, registerSpecs, spec, toInvokeHandler } from '../src/main/ipc/handle'
import type { HandlerContext, InvokeHandler, IpcRegistrar } from '../src/main/ipc/handle'
import { compileSecrets, redactString } from '../src/main/logging/redact'

function fakeLogger(): Logger & { entries: Array<{ level: string; message: string; meta?: Record<string, unknown> }> } {
  const entries: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = []
  const push = (level: string) => (_scope: string, message: string, meta?: Record<string, unknown>) => {
    entries.push({ level, message, meta })
  }
  return {
    entries,
    info: push('INFO'),
    warn: push('WARN'),
    error: push('ERROR'),
    log: (level, scope, message, meta) => push(level)(scope, message, meta),
    onEntry: () => () => {},
    query: () => [],
    clear: () => {},
    registerSecret: () => {},
  }
}

function context(secrets: string[] = []): HandlerContext & { logger: ReturnType<typeof fakeLogger> } {
  const logger = fakeLogger()
  return { logger, sanitize: (text) => redactString(text, compileSecrets(secrets)) }
}

describe('toInvokeHandler', () => {
  it('validates arguments and returns ok envelopes', async () => {
    const handler = toInvokeHandler(
      spec('t:echo', IdArg, ([id]) => `hello ${id}`),
      context(),
    )
    await expect(handler({}, 'abc')).resolves.toEqual({ ok: true, data: 'hello abc' })
  })

  it('rejects invalid arguments with INVALID_INPUT and never calls the handler', async () => {
    const run = vi.fn()
    const handler = toInvokeHandler(spec('t:id', IdArg, run), context())
    const result = await handler({}, 42)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('INVALID_INPUT')
    expect(result.error.message).toContain('t:id')
    expect(run).not.toHaveBeenCalled()
  })

  it('maps AppException to its AppError and sanitizes message and detail', async () => {
    const ctx = context(['s3cret'])
    const handler = toInvokeHandler(
      spec('t:boom', NoArgs, () => {
        throw new AppException('NOT_FOUND', 'Missing thing', 'password was s3cret')
      }),
      ctx,
    )
    const result = await handler({})
    expect(result).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Missing thing', detail: expect.not.stringContaining('s3cret') },
    })
  })

  it('maps ZodError thrown inside a handler to INVALID_INPUT using the first issue', async () => {
    const handler = toInvokeHandler(
      spec('t:zod', NoArgs, () => z.object({ url: z.url() }).parse({ url: 'nope' })),
      context(),
    )
    const result = await handler({})
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('INVALID_INPUT')
    expect(result.error.message.startsWith('url:')).toBe(true)
  })

  it('maps unknown errors to INTERNAL, redacts secrets and logs the failure', async () => {
    const ctx = context(['hunter2'])
    const handler = toInvokeHandler(
      spec('t:crash', NoArgs, async () => {
        throw new Error('connect http://user:hunter2@gw.example:823 failed')
      }),
      ctx,
    )
    const result = await handler({})
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('INTERNAL')
    expect(result.error.message).toContain('t:crash')
    expect(result.error.detail).not.toContain('hunter2')
    expect(ctx.logger.entries.some((e) => e.level === 'ERROR' && e.message.includes('t:crash'))).toBe(true)
  })

  it('handles non-Error throwables', async () => {
    const handler = toInvokeHandler(
      spec('t:string', NoArgs, () => {
        throw 'plain string failure'
      }),
      context(),
    )
    const result = await handler({})
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('INTERNAL')
    expect(result.error.detail).toBe('plain string failure')
  })
})

describe('registerSpecs', () => {
  function fakeRegistrar(): IpcRegistrar & { handlers: Map<string, InvokeHandler> } {
    const handlers = new Map<string, InvokeHandler>()
    return {
      handlers,
      handle: (channel, listener) => {
        handlers.set(channel, listener)
      },
      removeHandler: (channel) => {
        handlers.delete(channel)
      },
    }
  }

  it('registers every spec and the disposer removes them', () => {
    const registrar = fakeRegistrar()
    const dispose = registerSpecs(registrar, [spec('a', NoArgs, () => 1), spec('b', NoArgs, () => 2)], context())
    expect([...registrar.handlers.keys()]).toEqual(['a', 'b'])
    dispose()
    expect(registrar.handlers.size).toBe(0)
  })

  it('refuses duplicate channels', () => {
    const registrar = fakeRegistrar()
    expect(() => registerSpecs(registrar, [spec('a', NoArgs, () => 1), spec('a', NoArgs, () => 2)], context())).toThrow(
      AppException,
    )
  })
})

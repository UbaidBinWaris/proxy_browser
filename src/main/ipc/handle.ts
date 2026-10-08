/**
 * IPC handler plumbing.
 *
 * A `HandlerSpec` pairs an invoke channel with a Zod schema for its argument
 * tuple and the function that services it. `toInvokeHandler` turns a spec into
 * the function given to `ipcMain.handle`: arguments are validated, the service
 * function awaited and the outcome wrapped in an `IpcResult` envelope. Nothing
 * ever throws across the IPC boundary and every error message is run through
 * secret redaction before it reaches the renderer.
 */
import { z } from 'zod'

import { fail, ok } from '@shared/types'
import type { IpcResult } from '@shared/types'

import { AppException } from '../contracts'
import type { Logger } from '../contracts'

const LOG_SCOPE = 'ipc'

export interface HandlerSpec<S extends z.ZodType = z.ZodType, T = unknown> {
  channel: string
  /** Schema for the full argument tuple the renderer sends (`[]` for none). */
  args: S
  run(input: z.output<S>): T | Promise<T>
}

export interface HandlerContext {
  logger: Logger
  /** Redacts registered secrets and credential-looking fragments from free text. */
  sanitize: (text: string) => string
}

export type InvokeHandler = (event: unknown, ...rawArgs: unknown[]) => Promise<IpcResult<unknown>>

/** Minimal structural view of `ipcMain` so handlers can be registered against a fake in tests. */
export interface IpcRegistrar {
  handle(channel: string, listener: InvokeHandler): void
  removeHandler(channel: string): void
}

/** Typed constructor for a handler spec (keeps inference for `run`'s input). */
export function spec<S extends z.ZodType, T>(channel: string, args: S, run: (input: z.output<S>) => T | Promise<T>): HandlerSpec<S, T> {
  return { channel, args, run }
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'Invalid input.'
  const path = issue.path.map(String).join('.')
  return path ? `${path}: ${issue.message}` : issue.message
}

/** Convert anything thrown by a handler into an `IpcResult` failure. */
export function toIpcFailure(err: unknown, channel: string, ctx: HandlerContext): IpcResult<never> {
  if (err instanceof AppException) {
    const appError = err.toAppError()
    return fail({
      code: appError.code,
      message: ctx.sanitize(appError.message),
      ...(appError.detail ? { detail: ctx.sanitize(appError.detail) } : {}),
    })
  }
  if (err instanceof z.ZodError) {
    return fail({ code: 'INVALID_INPUT', message: ctx.sanitize(firstIssue(err)) })
  }
  const detail = ctx.sanitize(err instanceof Error ? err.message : String(err))
  ctx.logger.error(LOG_SCOPE, `Unhandled error in ${channel}`, { channel, error: err })
  return fail({
    code: 'INTERNAL',
    message: `Something went wrong while handling "${channel}". Check the Logs page for details.`,
    detail,
  })
}

export function toInvokeHandler<S extends z.ZodType, T>(handler: HandlerSpec<S, T>, ctx: HandlerContext): InvokeHandler {
  return async (_event: unknown, ...rawArgs: unknown[]): Promise<IpcResult<unknown>> => {
    const parsed = handler.args.safeParse(rawArgs)
    if (!parsed.success) {
      return fail({ code: 'INVALID_INPUT', message: ctx.sanitize(`Invalid request to ${handler.channel}: ${firstIssue(parsed.error)}`) })
    }
    try {
      const data = await handler.run(parsed.data as z.output<S>)
      return ok<unknown>(data)
    } catch (err) {
      return toIpcFailure(err, handler.channel, ctx)
    }
  }
}

/** Register every spec on the registrar; returns a function that removes them again. */
export function registerSpecs(registrar: IpcRegistrar, specs: readonly HandlerSpec[], ctx: HandlerContext): () => void {
  const channels = new Set<string>()
  for (const handler of specs) {
    if (channels.has(handler.channel)) {
      throw new AppException('INTERNAL', `IPC channel "${handler.channel}" is registered twice.`)
    }
    channels.add(handler.channel)
    registrar.handle(handler.channel, toInvokeHandler(handler, ctx))
  }
  return () => {
    for (const channel of channels) registrar.removeHandler(channel)
  }
}

// Shared argument schemas -----------------------------------------------------

export const IdSchema = z.string().trim().min(1, 'An id is required')
export const NoArgs = z.tuple([])
export const IdArg = z.tuple([IdSchema])
export const NullableIdArg = z.tuple([IdSchema.nullable()])

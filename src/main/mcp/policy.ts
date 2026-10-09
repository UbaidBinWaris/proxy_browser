/**
 * MCP server policy: the operator's limits on what an AI assistant may do through `qa-mcp`.
 *
 * Settings (environment, read once at start-up):
 *   QA_MCP_ALLOWED_ORIGINS  required  comma-separated origins; https, or http for localhost only
 *   QA_MCP_WORKSPACE        optional  directory manifests, baselines and the budget file live in
 *   QA_MCP_MAX_CASES        optional  cases per tool call (default 12, 1–100)
 *   QA_MCP_CONCURRENCY      optional  concurrent browsers (default 2, 1–4)
 *   QA_MCP_DAILY_BUDGET     optional  case attempts per UTC day (default 200, 1–10000)
 *
 * Everything here is free of side effects except `resolveInWorkspace` (which only reads real
 * paths through an injectable function), so policy decisions are unit-testable.
 */
import { realpath as fsRealpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import { AppException } from '../contracts'

export const MCP_ENV = {
  allowedOrigins: 'QA_MCP_ALLOWED_ORIGINS',
  workspace: 'QA_MCP_WORKSPACE',
  maxCases: 'QA_MCP_MAX_CASES',
  concurrency: 'QA_MCP_CONCURRENCY',
  dailyBudget: 'QA_MCP_DAILY_BUDGET',
} as const

export const MCP_DEFAULTS = { maxCases: 12, concurrency: 2, dailyBudget: 200 } as const
/** A scenario carries at most 30 approved origins (ScenarioInputSchema), so the allowlist does too. */
export const MAX_ALLOWED_ORIGINS = 30

export interface McpPolicy {
  /** Normalised origins ("https://staging.example.com"), deduplicated, in the operator's order. */
  allowedOrigins: string[]
  /** Workspace directory as given (resolved to an absolute path); null when not configured. */
  workspace: string | null
  maxCases: number
  concurrency: number
  dailyBudget: number
}

/** Refusal to start: a message naming the variable, never echoing a secret value. */
export class McpConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpConfigError'
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** True for hosts that only reach this machine (http is allowed for these). */
export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname.toLowerCase()) || /^127(?:\.\d{1,3}){3}$/.test(hostname)
}

/**
 * Parse one allowlist entry into an origin. Accepts "https://host[:port]" (an optional trailing
 * slash is tolerated) and "http://" only for localhost / 127.x / [::1]. Paths, queries,
 * fragments, credentials and wildcards are refused so an entry always means exactly one origin.
 */
export function parseAllowedOrigin(entry: string): string {
  const text = entry.trim()
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new McpConfigError(`${MCP_ENV.allowedOrigins}: "${text.slice(0, 120)}" is not a URL origin such as https://staging.example.com.`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new McpConfigError(`${MCP_ENV.allowedOrigins}: only https:// origins (http:// for localhost) are allowed.`)
  if (url.protocol === 'http:' && !isLocalHost(url.hostname))
    throw new McpConfigError(`${MCP_ENV.allowedOrigins}: http:// is allowed only for localhost, 127.0.0.1 and [::1]; use https:// for ${url.hostname}.`)
  if (url.username || url.password) throw new McpConfigError(`${MCP_ENV.allowedOrigins}: origins must not contain credentials.`)
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || /[?#]/.test(text.replace(/\/$/, '').slice(url.origin.length)))
    throw new McpConfigError(`${MCP_ENV.allowedOrigins}: "${url.origin}" must be an origin only (no path, query or fragment).`)
  if (url.hostname.includes('*')) throw new McpConfigError(`${MCP_ENV.allowedOrigins}: wildcards are not supported; list each origin.`)
  return url.origin
}

/** Parse the comma-separated allowlist. Empty or missing is a configuration error. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  const entries = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  if (entries.length === 0)
    throw new McpConfigError(`${MCP_ENV.allowedOrigins} is required: list the origins the assistant may test, e.g. https://staging.example.com.`)
  const origins = [...new Set(entries.map(parseAllowedOrigin))]
  if (origins.length > MAX_ALLOWED_ORIGINS)
    throw new McpConfigError(`${MCP_ENV.allowedOrigins}: at most ${MAX_ALLOWED_ORIGINS} origins are supported.`)
  return origins
}

function parseIntSetting(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim()
  if (raw === undefined || raw === '') return fallback
  if (!/^\d+$/.test(raw)) throw new McpConfigError(`${key} must be a whole number between ${min} and ${max}.`)
  const value = Number(raw)
  if (value < min || value > max) throw new McpConfigError(`${key} must be between ${min} and ${max}.`)
  return value
}

/** Read every QA_MCP_* setting. Throws McpConfigError; the server must not start on error. */
export function parsePolicy(env: NodeJS.ProcessEnv): McpPolicy {
  const workspaceRaw = env[MCP_ENV.workspace]?.trim()
  return {
    allowedOrigins: parseAllowedOrigins(env[MCP_ENV.allowedOrigins]),
    workspace: workspaceRaw ? resolve(workspaceRaw) : null,
    maxCases: parseIntSetting(env, MCP_ENV.maxCases, MCP_DEFAULTS.maxCases, 1, 100),
    concurrency: parseIntSetting(env, MCP_ENV.concurrency, MCP_DEFAULTS.concurrency, 1, 4),
    dailyBudget: parseIntSetting(env, MCP_ENV.dailyBudget, MCP_DEFAULTS.dailyBudget, 1, 10000),
  }
}

/** The origin of an http(s) URL, or null when it is not one. */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null
  } catch {
    return null
  }
}

/** Origins (or URLs) that are not on the allowlist; unparseable entries are reported as given. */
export function disallowedOrigins(policy: Pick<McpPolicy, 'allowedOrigins'>, urlsOrOrigins: readonly string[]): string[] {
  const allowed = new Set(policy.allowedOrigins)
  const refused: string[] = []
  for (const value of urlsOrOrigins) {
    const origin = originOf(value)
    const shown = origin ?? value.slice(0, 120)
    if ((!origin || !allowed.has(origin)) && !refused.includes(shown)) refused.push(shown)
  }
  return refused
}

/** Throw INVALID_INPUT unless every URL/origin is allowlisted. */
export function assertOriginsAllowed(policy: Pick<McpPolicy, 'allowedOrigins'>, urlsOrOrigins: readonly string[]): void {
  const refused = disallowedOrigins(policy, urlsOrOrigins)
  if (refused.length > 0)
    throw new AppException(
      'INVALID_INPUT',
      `Origin not allowlisted: ${refused.join(', ')}. The operator allows only ${policy.allowedOrigins.join(', ')} (${MCP_ENV.allowedOrigins}).`,
    )
}

/** Throw INVALID_INPUT when a call would run more cases than QA_MCP_MAX_CASES. */
export function assertCaseLimit(policy: Pick<McpPolicy, 'maxCases'>, cases: number): void {
  if (cases > policy.maxCases)
    throw new AppException('INVALID_INPUT', `This call would run ${cases} cases; the limit is ${policy.maxCases} per call (${MCP_ENV.maxCases}).`)
}

// ---------------------------------------------------------------------------
// Workspace containment
// ---------------------------------------------------------------------------

/**
 * Resolve a path the assistant supplied against the workspace and return its real path. The
 * file must exist, and its real path (symlinks resolved) must lie strictly inside the workspace's
 * real path, so `../` and symlink escapes are both refused.
 */
export async function resolveInWorkspace(
  workspace: string | null,
  requested: string,
  realpath: (path: string) => Promise<string> = fsRealpath,
): Promise<string> {
  if (!workspace) throw new AppException('INVALID_INPUT', `Set ${MCP_ENV.workspace} to a directory before using workspace files.`)
  if (typeof requested !== 'string' || requested.length === 0 || requested.includes('\0'))
    throw new AppException('INVALID_INPUT', 'Give a file path inside the workspace.')
  let root: string, target: string
  try {
    root = await realpath(workspace)
  } catch {
    throw new AppException('INVALID_INPUT', `${MCP_ENV.workspace} does not exist or cannot be read.`)
  }
  try {
    target = await realpath(isAbsolute(requested) ? requested : resolve(root, requested))
  } catch {
    throw new AppException('NOT_FOUND', 'That file does not exist inside the workspace.')
  }
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel))
    throw new AppException('INVALID_INPUT', `The path must resolve inside ${MCP_ENV.workspace} (symlinks are followed before the check).`)
  return target
}

// ---------------------------------------------------------------------------
// Daily budget
// ---------------------------------------------------------------------------

export interface BudgetState {
  /** UTC day the count belongs to, "YYYY-MM-DD". */
  day: string
  used: number
}

export const utcDay = (now: Date): string => now.toISOString().slice(0, 10)

/** Case attempts already used today (a state from an earlier UTC day counts as zero). */
export function usedToday(state: BudgetState | null, now: Date): number {
  return state && state.day === utcDay(now) ? state.used : 0
}

export function remainingBudget(state: BudgetState | null, limit: number, now: Date): number {
  return Math.max(0, limit - usedToday(state, now))
}

/** The state after reserving `attempts`, or an AppException when the day's budget cannot cover them. */
export function reserveBudget(state: BudgetState | null, limit: number, attempts: number, now: Date): BudgetState {
  if (!Number.isInteger(attempts) || attempts < 0) throw new AppException('INTERNAL', 'Invalid budget reservation.')
  const remaining = remainingBudget(state, limit, now)
  if (attempts > remaining)
    throw new AppException(
      'SESSION_LIMIT',
      remaining === 0
        ? `The daily budget of ${limit} case attempts is exhausted (${MCP_ENV.dailyBudget}). It resets at 00:00 UTC.`
        : `This call needs ${attempts} case attempts but only ${remaining} of today's ${limit} remain (${MCP_ENV.dailyBudget}).`,
    )
  return { day: utcDay(now), used: usedToday(state, now) + attempts }
}

/** Where the budget state lives: a JSON file under the workspace, or memory. */
export interface BudgetStore {
  load(): BudgetState | null
  save(state: BudgetState): void
}

export function memoryBudgetStore(): BudgetStore {
  let state: BudgetState | null = null
  return { load: () => state, save: (next) => (state = { ...next }) }
}

/** Validate a loaded state; anything malformed counts as "nothing used" for an unknown day. */
export function parseBudgetState(raw: unknown): BudgetState | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { day, used } = raw as Record<string, unknown>
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  if (typeof used !== 'number' || !Number.isInteger(used) || used < 0) return null
  return { day, used }
}

export interface BudgetTracker {
  remaining(): number
  /** Reserve case attempts; throws SESSION_LIMIT when today's budget cannot cover them. */
  reserve(attempts: number): void
  readonly limit: number
}

export function createBudgetTracker(limit: number, store: BudgetStore, now: () => Date = () => new Date()): BudgetTracker {
  return {
    limit,
    remaining: () => remainingBudget(store.load(), limit, now()),
    reserve(attempts) {
      store.save(reserveBudget(store.load(), limit, attempts, now()))
    },
  }
}

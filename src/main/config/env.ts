/**
 * Environment loading and proxy credential validation.
 *
 * The proxy password read here must never leave the main process: callers
 * expose only `maskUsername(...)`, host and port to the renderer.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { parse } from 'dotenv'
import { z } from 'zod'

export const PROXY_ENV_KEYS = {
  host: 'DATAIMPULSE_PROXY_HOST',
  port: 'DATAIMPULSE_PROXY_PORT',
  username: 'DATAIMPULSE_PROXY_USERNAME',
  password: 'DATAIMPULSE_PROXY_PASSWORD',
} as const

export interface ProxyEnvConfig {
  host: string
  port: number
  username: string
  password: string
}

export interface ReadProxyEnvResult {
  config: ProxyEnvConfig | null
  /** Env var names that are missing or invalid. */
  missing: string[]
}

export interface EnvCandidateOptions {
  cwd: string
  execDir: string
  userData: string
  isPackaged: boolean
  portableDir?: string | null
  /**
   * Path of the running AppImage (env `APPIMAGE`). Inside an AppImage,
   * `process.execPath` points into the transient squashfs mount, so the
   * directory the user actually sees is `dirname(APPIMAGE)`.
   */
  appImagePath?: string | null
}

/**
 * Candidate `.env` locations in priority order:
 *   1. <dir of the AppImage file>/.env (Linux AppImage)
 *   2. PORTABLE_EXECUTABLE_DIR/.env (portable Windows build)
 *   3. <dir of executable>/.env
 *   4. <cwd>/.env (development only)
 *   5. <userData>/.env
 */
export function defaultEnvCandidates(opts: EnvCandidateOptions): string[] {
  const candidates: string[] = []
  if (opts.appImagePath) candidates.push(join(dirname(opts.appImagePath), '.env'))
  if (opts.portableDir) candidates.push(join(opts.portableDir, '.env'))
  candidates.push(join(opts.execDir, '.env'))
  if (!opts.isPackaged) candidates.push(join(opts.cwd, '.env'))
  candidates.push(join(opts.userData, '.env'))
  return Array.from(new Set(candidates))
}

/**
 * Load the first existing `.env` file among `candidates` into `process.env`.
 * Existing environment variables are never overridden.
 */
export function loadDotEnv(candidates: string[]): { loadedFrom: string | null } {
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    let raw: string
    try {
      raw = readFileSync(candidate, 'utf8')
    } catch {
      continue
    }
    const parsed = parse(raw)
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) process.env[key] = value
    }
    return { loadedFrom: candidate }
  }
  return { loadedFrom: null }
}

const PortSchema = z.coerce.number().int().min(1).max(65535)
const HostSchema = z.string().trim().min(1).max(253)
const UsernameSchema = z.string().trim().min(1).max(512)
const PasswordSchema = z.string().min(1).max(512)

/**
 * Validate the DataImpulse proxy env vars. Never throws; a null `config`
 * means at least one variable is missing or invalid (listed in `missing`).
 */
export function readProxyEnv(env: NodeJS.ProcessEnv = process.env): ReadProxyEnvResult {
  const missing: string[] = []

  const host = HostSchema.safeParse(env[PROXY_ENV_KEYS.host])
  if (!host.success) missing.push(PROXY_ENV_KEYS.host)

  const portRaw = env[PROXY_ENV_KEYS.port]
  const port = portRaw === undefined || portRaw.trim() === '' ? null : PortSchema.safeParse(portRaw.trim())
  if (port === null || !port.success) missing.push(PROXY_ENV_KEYS.port)

  const username = UsernameSchema.safeParse(env[PROXY_ENV_KEYS.username])
  if (!username.success) missing.push(PROXY_ENV_KEYS.username)

  const password = PasswordSchema.safeParse(env[PROXY_ENV_KEYS.password])
  if (!password.success) missing.push(PROXY_ENV_KEYS.password)

  if (!host.success || port === null || !port.success || !username.success || !password.success) {
    return { config: null, missing }
  }

  return {
    config: { host: host.data, port: port.data, username: username.data, password: password.data },
    missing: [],
  }
}

/**
 * Mask the middle of a username for display: "ab****yz".
 * Names of 5 characters or fewer are fully masked so nothing leaks.
 */
export function maskUsername(username: string): string {
  const u = username.trim()
  if (u.length === 0) return ''
  if (u.length <= 5) return '*'.repeat(u.length)
  return `${u.slice(0, 2)}****${u.slice(-2)}`
}

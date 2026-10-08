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
 * Validate the DataImpulse proxy env vars (the `DATAIMPULSE_PROXY_*` alias of
 * `QA_PROVIDER=dataimpulse`). Never throws; a null `config`
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

// ---------------------------------------------------------------------------
// Provider-neutral proxy credentials (QA CLI, CI, development .env)
// ---------------------------------------------------------------------------

/**
 * Provider-neutral variables. `DATAIMPULSE_PROXY_*` (`PROXY_ENV_KEYS`) stays a documented alias
 * for `QA_PROVIDER=dataimpulse` with the same host/port/username/password.
 */
export const PROVIDER_ENV_KEYS = {
  provider: 'QA_PROVIDER',
  product: 'QA_PROVIDER_PRODUCT',
  host: 'QA_PROVIDER_HOST',
  port: 'QA_PROVIDER_PORT',
  username: 'QA_PROVIDER_USERNAME',
  password: 'QA_PROVIDER_PASSWORD',
  /** `QA_PROVIDER_EXTRA_<KEY>` → extra credential field `<key>` (matched case-insensitively). */
  extraPrefix: 'QA_PROVIDER_EXTRA_',
} as const

/** The provider facts env parsing needs (from the provider registry). */
export interface ProviderEnvInfo {
  /** Gateway host/port used when QA_PROVIDER_HOST / _PORT are not set. */
  defaults: { host: string; port: number }
  /** Declared extra credential field keys (`capabilities.extraCredentialFields`). */
  extraFieldKeys: readonly string[]
  /** Offered product keys. */
  productKeys: readonly string[]
}

export interface ProviderEnvConfig {
  providerId: string
  /** QA_PROVIDER_PRODUCT; null when not set (the caller picks the product). */
  product: string | null
  host: string
  port: number
  username: string
  password: string
  extras: Record<string, string>
}

export interface ReadProviderEnvResult {
  config: ProviderEnvConfig | null
  /** Variable names that are missing or invalid. */
  missing: string[]
  /** Which variable family supplied the credentials. */
  source: 'QA_PROVIDER' | 'DATAIMPULSE_PROXY' | null
  /** Non-fatal notes (ignored variables), never containing a value. */
  warnings: string[]
}

const ProviderIdEnvSchema = z.string().trim().regex(/^[a-z0-9-]{1,32}$/)

/** True when any QA_PROVIDER* variable is set (non-empty). */
function usesProviderVariables(env: NodeJS.ProcessEnv): boolean {
  return Object.entries(env).some(([key, value]) => key.startsWith('QA_PROVIDER') && value !== undefined && value.trim() !== '')
}

/**
 * Validate the provider-neutral proxy variables (`QA_PROVIDER*`), falling back to the
 * `DATAIMPULSE_PROXY_*` alias when none of them is set. Never throws and never returns a value
 * in `missing`/`warnings`. `providers(id)` describes a registered provider (null = unknown id,
 * which is reported as an invalid QA_PROVIDER).
 */
export function readProviderEnv(env: NodeJS.ProcessEnv, providers: (id: string) => ProviderEnvInfo | null): ReadProviderEnvResult {
  if (!usesProviderVariables(env)) {
    const legacy = readProxyEnv(env)
    if (legacy.config) {
      return { config: { providerId: 'dataimpulse', product: null, ...legacy.config, extras: {} }, missing: [], source: 'DATAIMPULSE_PROXY', warnings: [] }
    }
    const anyLegacy = Object.values(PROXY_ENV_KEYS).some((key) => (env[key] ?? '').trim() !== '')
    return { config: null, missing: anyLegacy ? legacy.missing : [], source: null, warnings: [] }
  }

  const missing: string[] = []
  const warnings: string[] = []
  if (Object.values(PROXY_ENV_KEYS).some((key) => (env[key] ?? '').trim() !== '')) {
    warnings.push(`${PROVIDER_ENV_KEYS.provider} variables are set, so the DATAIMPULSE_PROXY_* variables are ignored.`)
  }
  const providerId = ProviderIdEnvSchema.safeParse(env[PROVIDER_ENV_KEYS.provider])
  const info = providerId.success ? providers(providerId.data) : null
  if (!providerId.success || !info) missing.push(PROVIDER_ENV_KEYS.provider)

  const productRaw = env[PROVIDER_ENV_KEYS.product]?.trim() ?? ''
  const product = productRaw === '' ? null : productRaw
  if (product !== null && info && !info.productKeys.includes(product)) missing.push(PROVIDER_ENV_KEYS.product)

  const hostRaw = env[PROVIDER_ENV_KEYS.host]
  const host = hostRaw === undefined || hostRaw.trim() === '' ? (info ? { success: true as const, data: info.defaults.host } : null) : HostSchema.safeParse(hostRaw)
  if (host !== null && !host.success) missing.push(PROVIDER_ENV_KEYS.host)

  const portRaw = env[PROVIDER_ENV_KEYS.port]
  const port = portRaw === undefined || portRaw.trim() === '' ? (info ? { success: true as const, data: info.defaults.port } : null) : PortSchema.safeParse(portRaw.trim())
  if (port !== null && !port.success) missing.push(PROVIDER_ENV_KEYS.port)

  const username = UsernameSchema.safeParse(env[PROVIDER_ENV_KEYS.username])
  if (!username.success) missing.push(PROVIDER_ENV_KEYS.username)
  const password = PasswordSchema.safeParse(env[PROVIDER_ENV_KEYS.password])
  if (!password.success) missing.push(PROVIDER_ENV_KEYS.password)

  const extras: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(PROVIDER_ENV_KEYS.extraPrefix) || value === undefined || value === '') continue
    const suffix = key.slice(PROVIDER_ENV_KEYS.extraPrefix.length)
    const declared = info?.extraFieldKeys.find((field) => field.toLowerCase() === suffix.toLowerCase())
    if (declared) extras[declared] = value
    else if (info) warnings.push(`${key} is ignored: the provider declares no "${suffix.toLowerCase()}" credential field.`)
  }

  if (missing.length > 0 || !providerId.success || !info || !host?.success || !port?.success || !username.success || !password.success) {
    return { config: null, missing, source: 'QA_PROVIDER', warnings }
  }
  return {
    config: { providerId: providerId.data, product, host: host.data, port: port.data, username: username.data, password: password.data, extras },
    missing: [],
    source: 'QA_PROVIDER',
    warnings,
  }
}

/** Every variable that can carry a proxy secret (login, password, extra fields), for removal from process.env. */
export function proxySecretEnvKeys(env: NodeJS.ProcessEnv): string[] {
  const keys = new Set<string>([PROXY_ENV_KEYS.username, PROXY_ENV_KEYS.password, PROVIDER_ENV_KEYS.username, PROVIDER_ENV_KEYS.password])
  for (const key of Object.keys(env)) if (key.startsWith(PROVIDER_ENV_KEYS.extraPrefix)) keys.add(key)
  return [...keys]
}

/** Remove every proxy secret variable from `env` (default: process.env) so child processes never inherit it. */
export function scrubProxySecretEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of proxySecretEnvKeys(env)) delete env[key]
}

/**
 * `<userData>/install.json`: per-installation, non-secret bookkeeping.
 *
 *   installId            random UUID created on first run; binds the vault
 *                        blob (AAD) and names the key file
 *   createdAt/appVersion when this installation was created
 *   setupCompletedAt     null until the first-run setup has been completed
 *   lastProxyTest*       outcome of the last on-demand gateway test so the
 *                        health view can show it without re-testing (quota)
 *
 * A corrupt file is moved aside (`install.json.corrupt-<timestamp>`) and a
 * fresh one is created — the vault then reports it cannot be decrypted, which
 * is honest: a new installId means the old blob no longer verifies.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import { z } from 'zod'

import { ProxyStatusSchema } from '@shared/types'
import type { ProxyStatus } from '@shared/types'

import { AppException } from '../contracts'
import { writeFileAtomicSync } from '../util/atomic-file'

export const INSTALL_FILE_NAME = 'install.json'

const InstallStateSchema = z.object({
  installId: z.string().min(1),
  createdAt: z.string().min(1),
  appVersion: z.string(),
  setupCompletedAt: z.string().nullable().default(null),
  lastProxyTestAt: z.string().nullable().default(null),
  lastProxyTestStatus: ProxyStatusSchema.nullable().default(null),
})

export interface InstallState {
  installId: string
  createdAt: string
  appVersion: string
  setupCompletedAt: string | null
  lastProxyTestAt: string | null
  lastProxyTestStatus: ProxyStatus | null
}

export type InstallStatePatch = Partial<Pick<InstallState, 'setupCompletedAt' | 'lastProxyTestAt' | 'lastProxyTestStatus'>>

export interface InstallStateStore {
  readonly path: string
  /** Set when an unreadable install.json was moved aside during load. */
  readonly recoveredFrom: string | null
  get(): InstallState
  update(patch: InstallStatePatch): InstallState
}

export interface InstallStateStoreOptions {
  userData: string
  appVersion: string
  now?: () => Date
  newId?: () => string
}

export function createInstallStateStore(opts: InstallStateStoreOptions): InstallStateStore {
  const now = opts.now ?? ((): Date => new Date())
  const newId = opts.newId ?? randomUUID
  const path = join(opts.userData, INSTALL_FILE_NAME)
  let recoveredFrom: string | null = null

  const write = (state: InstallState): void => {
    try {
      writeFileAtomicSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o644 })
    } catch (err) {
      throw new AppException('INTERNAL', `Could not write ${path}. Check that the application data folder is writable.`, err instanceof Error ? err.message : String(err))
    }
  }

  const load = (): InstallState | null => {
    if (!existsSync(path)) return null
    try {
      return InstallStateSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    } catch {
      const aside = `${path}.corrupt-${now().getTime()}`
      renameSync(path, aside)
      recoveredFrom = aside
      return null
    }
  }

  const fresh = (): InstallState => {
    const created: InstallState = {
      installId: newId(),
      createdAt: now().toISOString(),
      appVersion: opts.appVersion,
      setupCompletedAt: null,
      lastProxyTestAt: null,
      lastProxyTestStatus: null,
    }
    write(created)
    return created
  }

  let state: InstallState = load() ?? fresh()

  return {
    path,
    get recoveredFrom(): string | null {
      return recoveredFrom
    },
    get: () => ({ ...state }),
    update: (patch) => {
      state = { ...state, ...patch }
      write(state)
      return { ...state }
    },
  }
}

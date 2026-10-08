import type { DatabaseSync } from 'node:sqlite'

import { AppSettingsPatchSchema, AppSettingsSchema, DEFAULT_SETTINGS, FormUrlSchema } from '@shared/types'
import type { AppSettings, AppSettingsPatch } from '@shared/types'

import { AppException } from '../../contracts'
import type { SettingsRepository } from '../../contracts'
import { asString, guarded, nowIso, transaction } from '../sql'
import type { Row } from '../sql'

export interface SettingsRepositoryOptions {
  /** Used when no screenshotDir has been stored yet. */
  defaultScreenshotDir: string
  /** Optional initial defaultFormUrl (e.g. from PROXY_QA_DEFAULT_FORM_URL); ignored when not a valid URL. */
  defaultFormUrl?: string | null
}

const SETTING_KEYS = Object.keys(AppSettingsSchema.shape) as (keyof AppSettings)[]

/** Build the defaults layer: DEFAULT_SETTINGS + screenshotDir + optional env form URL. */
export function buildDefaultSettings(opts: SettingsRepositoryOptions): AppSettings {
  const envUrl = opts.defaultFormUrl?.trim()
  const envUrlValid = envUrl ? FormUrlSchema.safeParse(envUrl).success : false
  return {
    ...DEFAULT_SETTINGS,
    defaultFormUrl: envUrlValid && envUrl ? envUrl : DEFAULT_SETTINGS.defaultFormUrl,
    screenshotDir: opts.defaultScreenshotDir,
  }
}

export function createSettingsRepository(db: DatabaseSync, opts: SettingsRepositoryOptions): SettingsRepository {
  const defaults = buildDefaultSettings(opts)
  const selectAll = db.prepare('SELECT key, value FROM app_settings')
  const upsert = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `)

  const get = (): AppSettings =>
    guarded('load settings', () => {
      const stored: Record<string, unknown> = {}
      for (const row of selectAll.all() as Row[]) {
        const key = asString(row.key)
        if (!(SETTING_KEYS as string[]).includes(key)) continue
        try {
          stored[key] = JSON.parse(asString(row.value))
        } catch {
          // Corrupt value: fall back to the default for this key.
        }
      }
      // Validate each stored key on its own so one bad value does not discard the others.
      const merged: Record<string, unknown> = { ...defaults }
      for (const key of SETTING_KEYS) {
        if (!(key in stored)) continue
        const result = AppSettingsSchema.shape[key].safeParse(stored[key])
        if (result.success) merged[key] = result.data
      }
      return AppSettingsSchema.parse(merged)
    })

  return {
    get,
    update: (rawPatch: AppSettingsPatch) => {
      const parsed = AppSettingsPatchSchema.safeParse(rawPatch)
      if (!parsed.success) {
        const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'settings'}: ${i.message}`).join('; ')
        throw new AppException('INVALID_INPUT', 'Settings are invalid. Check the highlighted fields and try again.', detail)
      }
      return guarded('save settings', () => {
        const ts = nowIso()
        transaction(db, () => {
          for (const key of SETTING_KEYS) {
            const value = parsed.data[key]
            if (value === undefined) continue
            upsert.run(key, JSON.stringify(value), ts)
          }
        })
        return get()
      })
    },
  }
}

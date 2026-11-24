import type { DatabaseSync } from 'node:sqlite'

import { AppSettingsPatchSchema, AppSettingsSchema, DEFAULT_PROVIDER_ID, DEFAULT_SETTINGS, DEFAULT_STICKY_TTL_MINUTES, FormUrlSchema } from '@shared/types'
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

/** Global setting of earlier versions; its value now lives in `providerOptions.dataimpulse.encoding`. */
export const LEGACY_TARGETING_ENCODING_KEY = 'targetingEncoding'

/**
 * One-time move of the legacy global `targetingEncoding` into the DataImpulse provider options
 * (the only provider it ever applied to). An encoding already present in `providerOptions` wins;
 * a corrupt legacy value is dropped. Runs in one transaction; a no-op once the legacy row is gone.
 * Returns true when a legacy row was found.
 */
export function migrateLegacySettings(db: DatabaseSync, ts: string = nowIso()): boolean {
  const legacy = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(LEGACY_TARGETING_ENCODING_KEY) as Row | undefined
  if (!legacy) return false
  transaction(db, () => {
    let encoding: unknown = null
    try {
      encoding = JSON.parse(asString(legacy.value))
    } catch {
      // Corrupt legacy value: nothing to carry over.
    }
    const optionsRow = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('providerOptions') as Row | undefined
    let options: Record<string, unknown> = {}
    if (optionsRow) {
      try {
        const parsed = AppSettingsSchema.shape.providerOptions.safeParse(JSON.parse(asString(optionsRow.value)))
        if (parsed.success) options = parsed.data
      } catch {
        // Corrupt providerOptions: rebuilt from the legacy value below.
      }
    }
    const current = (options[DEFAULT_PROVIDER_ID] ?? {}) as { encoding?: string }
    if (typeof encoding === 'string' && encoding.length > 0 && current.encoding === undefined) {
      options = { ...options, [DEFAULT_PROVIDER_ID]: { ...current, encoding } }
      db.prepare(
        'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      ).run('providerOptions', JSON.stringify(options), ts)
    }
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(LEGACY_TARGETING_ENCODING_KEY)
  })
  return true
}

/** The sticky lifetime 2.1.x used by default. */
export const PREVIOUS_DEFAULT_STICKY_TTL_MINUTES = 15
/** Marker row: the one-time move off the 2.1.x default lifetime has run (not a setting; get() ignores it). */
export const STICKY_TTL_MIGRATION_KEY = 'migration:stickyTtlDefault'

/**
 * 2.1.x kept a sticky IP for 15 minutes by default, and the Settings page stores every field when saved, so most
 * installs hold that value without anyone having chosen it. A visit longer than 15 minutes then lost its IP and the
 * browser was stopped mid-form. Moves a stored 15 to the current default once; any other value was chosen and
 * stays. Returns true when the stored value was moved.
 */
export function migrateStickyTtlDefault(db: DatabaseSync, ts: string = nowIso()): boolean {
  const select = db.prepare('SELECT value FROM app_settings WHERE key = ?')
  if (select.get(STICKY_TTL_MIGRATION_KEY)) return false
  const upsert = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `)
  let moved = false
  transaction(db, () => {
    const stored = select.get('defaultStickyTtlMinutes') as Row | undefined
    if (stored && asString(stored.value) === JSON.stringify(PREVIOUS_DEFAULT_STICKY_TTL_MINUTES)) {
      upsert.run('defaultStickyTtlMinutes', JSON.stringify(DEFAULT_STICKY_TTL_MINUTES), ts)
      moved = true
    }
    upsert.run(STICKY_TTL_MIGRATION_KEY, JSON.stringify(true), ts)
  })
  return moved
}

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
  try {
    migrateLegacySettings(db)
  } catch {
    // The legacy row stays and is retried on the next start; until then the provider default encoding applies.
  }
  try {
    migrateStickyTtlDefault(db)
  } catch {
    // Retried on the next start (no marker row was written); until then the stored lifetime applies.
  }
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

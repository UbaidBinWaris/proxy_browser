import type { DatabaseSync } from 'node:sqlite'

import { DEFAULT_PRODUCT_KEY, DEFAULT_PROVIDER_ID, GeoTargetSchema, ProfileInputSchema, normalizeProxyMode } from '@shared/types'
import type { BrowserEngine, DevicePresetId, DeviceType, GeoTarget, Profile, ProfileInput, ProxyMode } from '@shared/types'

import { AppException } from '../../contracts'
import type { ProfileListOptions, ProfileRepository } from '../../contracts'
import { asNumber, asNumberOrNull, asString, asStringOrNull, boolToInt, guarded, intToBool, newId, nowIso, nullable, toJson } from '../sql'
import type { Cell, Row } from '../sql'

const COLUMNS = `id, name, engine, device_type, device_preset, viewport_width, viewport_height, user_agent,
  locale, timezone, proxy_mode, sticky_session_id, form_url_override, notes, proxy_pool, target_json,
  sticky_ttl_minutes, ephemeral, provider_id, created_at, updated_at`

/** Parse a stored GeoTarget JSON column; anything unreadable yields null (the profile just loses its filter). */
export function parseTargetJson(value: Cell): GeoTarget | null {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const parsed = GeoTargetSchema.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function targetToJson(target: GeoTarget | null): string | null {
  return target ? toJson(target) : null
}

function rowToProfile(row: Row): Profile {
  return {
    id: asString(row.id),
    name: asString(row.name),
    engine: asString(row.engine) as BrowserEngine,
    deviceType: asString(row.device_type) as DeviceType,
    devicePreset: asString(row.device_preset) as DevicePresetId,
    viewportWidth: asNumber(row.viewport_width),
    viewportHeight: asNumber(row.viewport_height),
    userAgent: asStringOrNull(row.user_agent),
    locale: asString(row.locale),
    timezone: asString(row.timezone),
    // Migration 8 rewrote the legacy dataimpulse-* values; normalising again keeps a row written by an older build readable.
    proxyMode: normalizeProxyMode(asString(row.proxy_mode)) as ProxyMode,
    stickySessionId: asStringOrNull(row.sticky_session_id),
    formUrlOverride: asStringOrNull(row.form_url_override),
    notes: asString(row.notes),
    proxyPool: asStringOrNull(row.proxy_pool) ?? DEFAULT_PRODUCT_KEY,
    providerId: asStringOrNull(row.provider_id) ?? DEFAULT_PROVIDER_ID,
    target: parseTargetJson(row.target_json),
    stickyTtlMinutes: asNumberOrNull(row.sticky_ttl_minutes),
    ephemeral: intToBool(row.ephemeral),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  }
}

function validate(input: ProfileInput): ProfileInput {
  const parsed = ProfileInputSchema.safeParse(input)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')
    throw new AppException('INVALID_INPUT', 'Profile data is invalid. Check the highlighted fields and try again.', detail)
  }
  return parsed.data
}

export function createProfileRepository(db: DatabaseSync): ProfileRepository {
  const selectAll = db.prepare(`SELECT ${COLUMNS} FROM profiles ORDER BY created_at ASC, name ASC`)
  const selectVisible = db.prepare(`SELECT ${COLUMNS} FROM profiles WHERE ephemeral = 0 ORDER BY created_at ASC, name ASC`)
  const selectOne = db.prepare(`SELECT ${COLUMNS} FROM profiles WHERE id = ?`)
  const insert = db.prepare(`
    INSERT INTO profiles (${COLUMNS})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const update = db.prepare(`
    UPDATE profiles SET
      name = ?, engine = ?, device_type = ?, device_preset = ?, viewport_width = ?, viewport_height = ?,
      user_agent = ?, locale = ?, timezone = ?, proxy_mode = ?, sticky_session_id = ?, form_url_override = ?,
      notes = ?, proxy_pool = ?, target_json = ?, sticky_ttl_minutes = ?, ephemeral = ?, provider_id = ?, updated_at = ?
    WHERE id = ?
  `)
  const remove = db.prepare('DELETE FROM profiles WHERE id = ?')
  const countAll = db.prepare('SELECT COUNT(*) AS n FROM profiles')
  const countVisible = db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE ephemeral = 0')

  const get = (id: string): Profile | null =>
    guarded('load profile', () => {
      const row = selectOne.get(id) as Row | undefined
      return row ? rowToProfile(row) : null
    })

  return {
    list: (options?: ProfileListOptions) =>
      guarded('list profiles', () => ((options?.includeEphemeral ? selectAll : selectVisible).all() as Row[]).map(rowToProfile)),
    get,
    count: (options?: ProfileListOptions) => guarded('count profiles', () => asNumber(((options?.includeEphemeral ? countAll : countVisible).get() as Row).n)),

    create: (rawInput) => {
      const input = validate(rawInput)
      const id = newId()
      const ts = nowIso()
      return guarded('create profile', () => {
        insert.run(
          id,
          input.name,
          input.engine,
          input.deviceType,
          input.devicePreset,
          input.viewportWidth,
          input.viewportHeight,
          nullable(input.userAgent === '' ? null : input.userAgent),
          input.locale,
          input.timezone,
          input.proxyMode,
          nullable(input.stickySessionId),
          nullable(input.formUrlOverride),
          input.notes,
          input.proxyPool,
          targetToJson(input.target),
          nullable(input.stickyTtlMinutes),
          boolToInt(input.ephemeral),
          input.providerId,
          ts,
          ts,
        )
        const created = get(id)
        if (!created) throw new AppException('INTERNAL', 'Profile was not saved. Try again.')
        return created
      })
    },

    update: (id, rawInput) => {
      const input = validate(rawInput)
      return guarded('update profile', () => {
        const result = update.run(
          input.name,
          input.engine,
          input.deviceType,
          input.devicePreset,
          input.viewportWidth,
          input.viewportHeight,
          nullable(input.userAgent === '' ? null : input.userAgent),
          input.locale,
          input.timezone,
          input.proxyMode,
          nullable(input.stickySessionId),
          nullable(input.formUrlOverride),
          input.notes,
          input.proxyPool,
          targetToJson(input.target),
          nullable(input.stickyTtlMinutes),
          boolToInt(input.ephemeral),
          input.providerId,
          nowIso(),
          id,
        )
        if (Number(result.changes) === 0) {
          throw new AppException('NOT_FOUND', 'Profile not found. It may have been deleted.', `profile id ${id}`)
        }
        const updated = get(id)
        if (!updated) throw new AppException('NOT_FOUND', 'Profile not found. It may have been deleted.', `profile id ${id}`)
        return updated
      })
    },

    delete: (id) =>
      guarded('delete profile', () => {
        const result = remove.run(id)
        if (Number(result.changes) === 0) {
          throw new AppException('NOT_FOUND', 'Profile not found. It may already have been deleted.', `profile id ${id}`)
        }
      }),
  }
}

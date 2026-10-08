import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { GeoTarget, ProfileInput, TestRun } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'

import { AppException } from '../src/main/contracts'
import type { Database } from '../src/main/contracts'
import { openDatabase } from '../src/main/database'
import { MIGRATIONS, runMigrations } from '../src/main/database/schema'
import { resolveAppPaths } from '../src/main/config/paths'

const profileInput = (overrides: Partial<ProfileInput> = {}): ProfileInput => ({
  name: 'Windows Chrome',
  engine: 'chromium',
  deviceType: 'desktop',
  devicePreset: 'windows-desktop',
  viewportWidth: 1366,
  viewportHeight: 768,
  userAgent: null,
  locale: 'en-US',
  timezone: 'America/New_York',
  proxyMode: 'dataimpulse-sticky',
  stickySessionId: 'win-chrome-1',
  formUrlOverride: null,
  notes: '',
  proxyPool: 'residential',
  target: null,
  stickyTtlMinutes: null,
  ephemeral: false,
  ...overrides,
})

const NJ: GeoTarget = { mode: 'state', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: null, zip: null }
const NEWARK: GeoTarget = { mode: 'city', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: 'Newark', zip: null }

const runInput = (overrides: Partial<Omit<TestRun, 'id'>> = {}): Omit<TestRun, 'id'> => ({
  profileId: null,
  profileName: 'Windows Chrome',
  engine: 'chromium',
  devicePreset: 'windows-desktop',
  proxyPool: null,
  target: null,
  targetingString: null,
  targetMatch: null,
  publicIp: null,
  country: null,
  region: null,
  city: null,
  postalCode: null,
  locationAttempts: 1,
  locationMaxAttempts: 1,
  locationWarning: null,
  proxySessionId: null,
  formUrl: 'https://forms.example.com/qa',
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: null,
  status: 'running',
  notes: '',
  httpStatus: null,
  finalUrl: null,
  screenshotPath: null,
  leadId: null,
  certificateId: null,
  errorMessage: null,
  ...overrides,
})

describe('database', () => {
  let dir: string
  let dbPath: string
  let db: Database

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proxy-qa-db-'))
    dbPath = join(dir, 'proxy-qa.sqlite')
    db = openDatabase(dbPath, { defaultScreenshotDir: join(dir, 'shots'), env: {} })
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('open & migrations', () => {
    it('creates the file, enables WAL + foreign keys and records migrations', () => {
      expect(existsSync(dbPath)).toBe(true)
      expect(db.path).toBe(dbPath)
      const raw = new DatabaseSync(dbPath)
      const journal = raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
      expect(journal.journal_mode).toBe('wal')
      const migrations = raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]
      expect(migrations.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7])
      const tables = raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((r) => (r as { name: string }).name)
      for (const t of ['profiles', 'proxy_sessions', 'test_runs', 'network_entries', 'app_settings', 'logs', 'schema_migrations']) {
        expect(tables).toContain(t)
      }
      raw.close()
    })

    it('is idempotent on reopen and keeps data', () => {
      const created = db.profiles.create(profileInput())
      db.close()
      db = openDatabase(dbPath, { defaultScreenshotDir: join(dir, 'shots'), env: {} })
      expect(db.profiles.get(created.id)).toEqual(created)
      const raw = new DatabaseSync(dbPath)
      const count = raw.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }
      expect(count.n).toBe(MIGRATIONS.length)
      raw.close()
    })

    it('close is safe to call twice', () => {
      db.close()
      expect(() => db.close()).not.toThrow()
      db = openDatabase(dbPath, { defaultScreenshotDir: join(dir, 'shots'), env: {} })
    })

    it('v2 drops orphaned proxy_sessions rows, keeps the gateway row and switches the FK to CASCADE', () => {
      db.close()
      const legacyPath = join(dir, 'legacy.sqlite')
      const legacy = new DatabaseSync(legacyPath)
      legacy.exec('PRAGMA foreign_keys = ON')
      expect(runMigrations(legacy, MIGRATIONS.slice(0, 1))).toEqual([1])
      const ts = '2026-01-01T00:00:00.000Z'
      legacy
        .prepare(
          `INSERT INTO profiles (id, name, engine, device_type, device_preset, viewport_width, viewport_height, user_agent, locale, timezone,
             proxy_mode, sticky_session_id, form_url_override, notes, created_at, updated_at)
           VALUES ('prof-1', 'Keep', 'chromium', 'desktop', 'windows-desktop', 1366, 768, NULL, 'en-US', 'UTC',
             'dataimpulse-sticky', 'keep-1', NULL, '', ?, ?)`,
        )
        .run(ts, ts)
      const insert = legacy.prepare(
        `INSERT INTO proxy_sessions (id, profile_id, provider, session_id, status, last_ip, country, created_at, updated_at)
         VALUES (?, ?, 'dataimpulse', ?, ?, ?, ?, ?, ?)`,
      )
      insert.run('gw', null, null, 'working', '198.51.100.1', 'United States', ts, ts)
      insert.run('orphan-a', null, 'e2e-webkit-001', 'failed', null, null, ts, ts)
      insert.run('orphan-b', null, 'e2e-firefox-001', 'working', '198.51.100.2', 'Germany', ts, ts)
      insert.run('owned', 'prof-1', 'keep-1', 'working', '198.51.100.3', 'Canada', ts, ts)
      legacy.close()

      db = openDatabase(legacyPath, { defaultScreenshotDir: join(dir, 'shots'), env: {} })
      const ids = db.proxySessions.list().map((s) => s.id).sort()
      expect(ids).toEqual(['gw', 'owned'])
      expect(db.proxySessions.get('gw')).toMatchObject({ profileId: null, sessionId: null, lastIp: '198.51.100.1', countryCode: null })
      expect(db.proxySessions.get('owned')).toMatchObject({ profileId: 'prof-1', sessionId: 'keep-1', country: 'Canada' })

      const raw = new DatabaseSync(legacyPath)
      const versions = (raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]).map((m) => m.version)
      expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7])
      const fk = raw.prepare('PRAGMA foreign_key_list(proxy_sessions)').all() as Array<{ on_delete: string; table: string }>
      expect(fk).toEqual([expect.objectContaining({ table: 'profiles', on_delete: 'CASCADE' })])
      const runsFk = raw.prepare('PRAGMA foreign_key_list(test_runs)').all() as Array<{ on_delete: string }>
      expect(runsFk[0]?.on_delete).toBe('SET NULL')
      const indexes = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'proxy_sessions'").all() as { name: string }[]).map(
        (i) => i.name,
      )
      expect(indexes).toEqual(expect.arrayContaining(['idx_proxy_sessions_profile', 'idx_proxy_sessions_status']))
      raw.close()

      db.profiles.delete('prof-1')
      expect(db.proxySessions.get('owned')).toBeNull()
      expect(db.proxySessions.get('gw')).not.toBeNull()
    })

    it('v3 adds pool/target columns with defaults so pre-existing rows load unchanged', () => {
      db.close()
      const legacyPath = join(dir, 'v2.sqlite')
      const legacy = new DatabaseSync(legacyPath)
      legacy.exec('PRAGMA foreign_keys = ON')
      expect(runMigrations(legacy, MIGRATIONS.slice(0, 2))).toEqual([1, 2])
      const ts = '2026-01-01T00:00:00.000Z'
      legacy
        .prepare(
          `INSERT INTO profiles (id, name, engine, device_type, device_preset, viewport_width, viewport_height, user_agent, locale, timezone,
             proxy_mode, sticky_session_id, form_url_override, notes, created_at, updated_at)
           VALUES ('prof-1', 'Old', 'chromium', 'desktop', 'windows-desktop', 1366, 768, NULL, 'en-US', 'UTC',
             'dataimpulse-sticky', 'old-1', NULL, '', ?, ?)`,
        )
        .run(ts, ts)
      legacy
        .prepare(`INSERT INTO proxy_sessions (id, profile_id, provider, session_id, status, created_at, updated_at) VALUES ('ps-1', 'prof-1', 'dataimpulse', 'old-1', 'working', ?, ?)`)
        .run(ts, ts)
      legacy
        .prepare(
          `INSERT INTO test_runs (id, profile_id, profile_name, engine, device_preset, form_url, started_at, status, notes)
           VALUES ('run-1', 'prof-1', 'Old', 'chromium', 'windows-desktop', 'https://x.example/', ?, 'success', '')`,
        )
        .run(ts)
      legacy.close()

      db = openDatabase(legacyPath, { defaultScreenshotDir: join(dir, 'shots'), env: {} })
      expect(db.profiles.get('prof-1')).toMatchObject({ proxyPool: 'residential', target: null, stickyTtlMinutes: null, ephemeral: false })
      expect(db.proxySessions.get('ps-1')).toMatchObject({ pool: 'residential', target: null, targetingString: null, targetMatch: null, sessionId: 'old-1' })
      expect(db.testRuns.get('run-1')).toMatchObject({ proxyPool: null, target: null, targetingString: null, targetMatch: null })

      const raw = new DatabaseSync(legacyPath)
      const columns = (table: string): string[] => (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
      expect(columns('profiles')).toEqual(expect.arrayContaining(['proxy_pool', 'target_json', 'sticky_ttl_minutes', 'ephemeral']))
      expect(columns('proxy_sessions')).toEqual(expect.arrayContaining(['pool', 'target_json', 'targeting_string', 'target_match']))
      expect(columns('test_runs')).toEqual(expect.arrayContaining(['pool', 'target_json', 'targeting_string', 'target_match']))
      const preset = raw.prepare("SELECT type FROM pragma_table_info('profiles') WHERE name = 'device_preset'").get() as { type: string }
      expect(preset.type).toBe('TEXT')
      raw.close()
    })

    it('v4 adds postal codes and location attempts; older rows load as one attempt out of one', () => {
      db.close()
      const legacyPath = join(dir, 'v3.sqlite')
      const legacy = new DatabaseSync(legacyPath)
      legacy.exec('PRAGMA foreign_keys = ON')
      expect(runMigrations(legacy, MIGRATIONS.slice(0, 3))).toEqual([1, 2, 3])
      const ts = '2026-01-01T00:00:00.000Z'
      legacy
        .prepare(
          `INSERT INTO proxy_sessions (id, profile_id, provider, session_id, status, last_ip, region, city, created_at, updated_at)
           VALUES ('gw', NULL, 'dataimpulse', NULL, 'working', '198.51.100.1', 'New Jersey', 'Newark', ?, ?)`,
        )
        .run(ts, ts)
      legacy
        .prepare(
          `INSERT INTO test_runs (id, profile_id, profile_name, engine, device_preset, form_url, started_at, status, notes, region, city)
           VALUES ('run-1', NULL, 'Old', 'chromium', 'windows-desktop', 'https://x.example/', ?, 'success', '', 'New Jersey', 'Newark')`,
        )
        .run(ts)
      legacy.close()

      db = openDatabase(legacyPath, { defaultScreenshotDir: join(dir, 'shots'), env: {} })
      expect(db.proxySessions.get('gw')).toMatchObject({ region: 'New Jersey', city: 'Newark', postalCode: null })
      expect(db.testRuns.get('run-1')).toMatchObject({ city: 'Newark', postalCode: null, locationAttempts: 1, locationMaxAttempts: 1, locationWarning: null })

      const raw = new DatabaseSync(legacyPath)
      const columns = (table: string): string[] => (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
      expect(columns('proxy_sessions')).toContain('postal_code')
      expect(columns('test_runs')).toEqual(expect.arrayContaining(['postal_code', 'location_attempts', 'location_max_attempts', 'location_warning']))
      raw.close()
    })
  })

  describe('profiles', () => {
    it('supports CRUD and count', () => {
      expect(db.profiles.count()).toBe(0)
      const a = db.profiles.create(profileInput({ name: 'A' }))
      const b = db.profiles.create(profileInput({ name: 'B', userAgent: '' }))
      expect(a.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(a.createdAt).toBe(a.updatedAt)
      expect(b.userAgent).toBeNull()
      expect(db.profiles.count()).toBe(2)
      expect(db.profiles.list().map((p) => p.name)).toEqual(['A', 'B'])

      const updated = db.profiles.update(a.id, profileInput({ name: 'A2', proxyMode: 'none', stickySessionId: null, notes: 'hi' }))
      expect(updated.name).toBe('A2')
      expect(updated.proxyMode).toBe('none')
      expect(updated.stickySessionId).toBeNull()
      expect(updated.notes).toBe('hi')
      expect(updated.createdAt).toBe(a.createdAt)

      db.profiles.delete(a.id)
      expect(db.profiles.get(a.id)).toBeNull()
      expect(db.profiles.count()).toBe(1)
    })

    it('stores pool, target, TTL and ephemeral; list()/count() hide ephemeral profiles unless asked', () => {
      const visible = db.profiles.create(profileInput({ name: 'Visible' }))
      const quick = db.profiles.create(profileInput({ name: 'Quick', proxyPool: 'mobile', target: NEWARK, stickyTtlMinutes: 45, ephemeral: true }))
      expect(quick).toMatchObject({ proxyPool: 'mobile', target: NEWARK, stickyTtlMinutes: 45, ephemeral: true })
      expect(db.profiles.get(quick.id)?.target).toEqual(NEWARK)
      expect(db.profiles.list().map((p) => p.id)).toEqual([visible.id])
      expect(db.profiles.list({ includeEphemeral: true }).map((p) => p.id)).toEqual([visible.id, quick.id])
      expect(db.profiles.count()).toBe(1)
      expect(db.profiles.count({ includeEphemeral: true })).toBe(2)

      const saved = db.profiles.update(quick.id, profileInput({ name: 'Quick', proxyPool: 'mobile', target: NJ, stickyTtlMinutes: null, ephemeral: false }))
      expect(saved).toMatchObject({ ephemeral: false, target: NJ, stickyTtlMinutes: null })
      expect(db.profiles.count()).toBe(2)
      expect(() => db.profiles.create(profileInput({ target: { ...NJ, zip: '12' } }))).toThrowError(AppException)
      expect(() => db.profiles.create(profileInput({ proxyPool: 'datacenter' as never }))).toThrowError(AppException)
    })

    it('rejects invalid input and missing ids with AppException codes', () => {
      expect(() => db.profiles.create(profileInput({ name: '' }))).toThrowError(AppException)
      try {
        db.profiles.create(profileInput({ viewportWidth: 10 }))
      } catch (err) {
        expect((err as AppException).code).toBe('INVALID_INPUT')
      }
      try {
        db.profiles.update('nope', profileInput())
      } catch (err) {
        expect((err as AppException).code).toBe('NOT_FOUND')
      }
      expect(() => db.profiles.delete('nope')).toThrowError(/not found/i)
    })
  })

  describe('proxySessions', () => {
    it('stores the raw-gateway test row with a null profile id (no FK violation)', () => {
      const gw = db.proxySessions.upsertForProfile(null, null)
      expect(gw.profileId).toBeNull()
      expect(db.proxySessions.getByProfile(null)?.id).toBe(gw.id)
      const again = db.proxySessions.upsertForProfile(null, null)
      expect(again.id).toBe(gw.id)
      const updated = db.proxySessions.updateStatus(gw.id, { status: 'working', error: null })
      expect(updated.status).toBe('working')
    })

    it('upserts one row per profile, resets on session change, updates status, counts and deletes', () => {
      const profile = db.profiles.create(profileInput())
      const s1 = db.proxySessions.upsertForProfile(profile.id, 'sess-1')
      expect(s1.profileId).toBe(profile.id)
      expect(s1.sessionId).toBe('sess-1')
      expect(s1.status).toBe('untested')
      expect(s1.provider).toBe('dataimpulse')

      const working = db.proxySessions.updateStatus(s1.id, {
        status: 'working',
        ip: {
          ip: '203.0.113.9',
          country: 'United States',
          countryCode: 'US',
          region: 'TX',
          city: 'Austin',
          postalCode: '78701',
          isp: 'Example ISP',
          asn: 'AS64500',
          latencyMs: 321,
          provider: 'ip-api',
          checkedAt: '2026-01-01T00:00:00.000Z',
        },
        error: null,
      })
      expect(working.status).toBe('working')
      expect(working.lastIp).toBe('203.0.113.9')
      expect(working.country).toBe('United States')
      expect(working.countryCode).toBe('US')
      expect(working.latencyMs).toBe(321)
      expect(working.lastCheckedAt).toBe('2026-01-01T00:00:00.000Z')
      expect(working.lastError).toBeNull()

      const same = db.proxySessions.upsertForProfile(profile.id, 'sess-1')
      expect(same.id).toBe(s1.id)
      expect(same.lastIp).toBe('203.0.113.9')

      const rotated = db.proxySessions.upsertForProfile(profile.id, 'sess-2')
      expect(rotated.id).toBe(s1.id)
      expect(rotated.sessionId).toBe('sess-2')
      expect(rotated.status).toBe('untested')
      expect(rotated.lastIp).toBeNull()
      expect(rotated.countryCode).toBeNull()
      expect(db.proxySessions.list()).toHaveLength(1)
      expect(db.proxySessions.getByProfile(profile.id)?.id).toBe(s1.id)

      const failed = db.proxySessions.updateStatus(s1.id, { status: 'failed', error: 'Proxy authentication failed' })
      expect(failed.status).toBe('failed')
      expect(failed.lastError).toBe('Proxy authentication failed')
      expect(db.proxySessions.countByStatus('failed')).toBe(1)
      expect(db.proxySessions.countByStatus('working')).toBe(0)

      db.proxySessions.delete(s1.id)
      expect(db.proxySessions.get(s1.id)).toBeNull()
      expect(() => db.proxySessions.updateStatus(s1.id, { status: 'offline' })).toThrowError(AppException)
    })

    it('records pool/target/targeting context and resets the cached result when the context changes', () => {
      const profile = db.profiles.create(profileInput())
      const context = { pool: 'mobile' as const, target: NJ, targetingString: 'cr.us;state.newjersey;sessid.sess-1' }
      const first = db.proxySessions.upsertForProfile(profile.id, 'sess-1', context)
      expect(first).toMatchObject({ pool: 'mobile', target: NJ, targetingString: context.targetingString, targetMatch: null })
      const working = db.proxySessions.updateStatus(first.id, {
        status: 'working',
        ip: { ip: '203.0.113.9', country: 'United States', countryCode: 'US', region: 'New Jersey', city: 'Newark', postalCode: '07102', isp: null, asn: null, latencyMs: 50, provider: 'ip-api', checkedAt: '2026-01-01T00:00:00.000Z' },
        error: null,
        targetMatch: 'match',
      })
      expect(working.targetMatch).toBe('match')
      expect(working.postalCode).toBe('07102')
      // Same id + same context: cached result kept.
      expect(db.proxySessions.upsertForProfile(profile.id, 'sess-1', context)).toMatchObject({ status: 'working', targetMatch: 'match', lastIp: '203.0.113.9' })
      // Same id, new target: a different exit is requested, so the result is reset.
      const retargeted = db.proxySessions.upsertForProfile(profile.id, 'sess-1', { ...context, target: NEWARK, targetingString: 'cr.us;state.newjersey;city.newark;sessid.sess-1' })
      expect(retargeted).toMatchObject({ id: first.id, status: 'untested', lastIp: null, postalCode: null, targetMatch: null, target: NEWARK })
      // targetMatch can be updated without an IP payload too.
      expect(db.proxySessions.updateStatus(first.id, { status: 'failed', error: 'nope', targetMatch: 'unknown' })).toMatchObject({ status: 'failed', targetMatch: 'unknown' })
      // Default context for callers without pools.
      const gateway = db.proxySessions.upsertForProfile(null, null)
      expect(gateway).toMatchObject({ pool: 'residential', target: null, targetingString: null })
    })

    it('deleting a profile removes its proxy session but keeps the gateway row', () => {
      const gateway = db.proxySessions.upsertForProfile(null, null)
      const profile = db.profiles.create(profileInput())
      const owned = db.proxySessions.upsertForProfile(profile.id, 'sess-1')
      expect(db.proxySessions.list()).toHaveLength(2)

      db.profiles.delete(profile.id)
      expect(db.proxySessions.get(owned.id)).toBeNull()
      expect(db.proxySessions.get(gateway.id)).toMatchObject({ profileId: null, sessionId: null })
      expect(db.proxySessions.list().map((s) => s.id)).toEqual([gateway.id])
      // No row ever masquerades as the gateway (profile_id NULL with a session id).
      expect(db.proxySessions.list().filter((s) => s.profileId === null && s.sessionId !== null)).toEqual([])
    })
  })

  describe('testRuns', () => {
    it('creates, lists newest first with limit, updates, patches, deletes', () => {
      const r1 = db.testRuns.create(runInput({ startedAt: '2026-01-01T00:00:00.000Z' }))
      const r2 = db.testRuns.create(runInput({ startedAt: '2026-01-03T00:00:00.000Z' }))
      const r3 = db.testRuns.create(runInput({ startedAt: '2026-01-02T00:00:00.000Z' }))
      expect(db.testRuns.list().map((r) => r.id)).toEqual([r2.id, r3.id, r1.id])
      expect(db.testRuns.list(2).map((r) => r.id)).toEqual([r2.id, r3.id])

      const updated = db.testRuns.update(r1.id, {
        status: 'success',
        endedAt: '2026-01-01T00:01:00.000Z',
        httpStatus: 200,
        finalUrl: 'https://forms.example.com/thanks',
        publicIp: '203.0.113.9',
      })
      expect(updated.status).toBe('success')
      expect(updated.httpStatus).toBe(200)
      expect(updated.finalUrl).toBe('https://forms.example.com/thanks')
      expect(updated.notes).toBe('')

      const targeted = db.testRuns.create(runInput({ proxyPool: 'mobile', target: NEWARK, targetingString: 'cr.us;state.newjersey;city.newark;sessid.x', targetMatch: null }))
      expect(targeted).toMatchObject({ proxyPool: 'mobile', target: NEWARK, targetingString: 'cr.us;state.newjersey;city.newark;sessid.x', targetMatch: null })
      expect(db.testRuns.update(targeted.id, { targetMatch: 'partial' })).toMatchObject({ targetMatch: 'partial', target: NEWARK })
      expect(db.testRuns.get(targeted.id)?.target).toEqual(NEWARK)
      expect(targeted).toMatchObject({ postalCode: null, locationAttempts: 1, locationMaxAttempts: 1, locationWarning: null })
      const rerolled = db.testRuns.update(targeted.id, {
        postalCode: '07103',
        locationAttempts: 3,
        locationMaxAttempts: 3,
        locationWarning: 'Could not get an exit IP in Newark, NJ after 3 attempts; using Jersey City, NJ 07302 (same state)',
      })
      expect(rerolled).toMatchObject({ postalCode: '07103', locationAttempts: 3, locationMaxAttempts: 3 })
      expect(db.testRuns.get(targeted.id)?.locationWarning).toContain('after 3 attempts')
      db.testRuns.delete(targeted.id)

      const patched = db.testRuns.patch(r1.id, { notes: 'looks good', leadId: 'L-123', certificateId: null })
      expect(patched.notes).toBe('looks good')
      expect(patched.leadId).toBe('L-123')
      expect(patched.certificateId).toBeNull()
      expect(patched.httpStatus).toBe(200)

      expect(() => db.testRuns.patch(r1.id, { status: 'bogus' as never })).toThrowError(AppException)
      // Only the browser manager may set 'running' / 'aborted'; the renderer patch path rejects them.
      expect(() => db.testRuns.patch(r1.id, { status: 'running' as never })).toThrowError(AppException)
      expect(() => db.testRuns.patch(r1.id, { status: 'aborted' as never })).toThrowError(AppException)
      expect(db.testRuns.patch(r1.id, { status: 'failed' }).status).toBe('failed')
      expect(db.testRuns.update(r1.id, { status: 'aborted' }).status).toBe('aborted')
      expect(() => db.testRuns.update('missing', { notes: 'x' })).toThrowError(/not found/i)

      db.testRuns.delete(r1.id)
      expect(db.testRuns.get(r1.id)).toBeNull()
      expect(db.testRuns.list()).toHaveLength(2)
    })
  })

  describe('network', () => {
    it('inserts, completes, lists by run (oldest first), cascades on run delete', () => {
      const run = db.testRuns.create(runInput())
      const e1 = db.network.insert({
        runId: run.id,
        method: 'POST',
        url: 'https://api.example.com/lead',
        status: null,
        resourceType: 'xhr',
        requestTime: '2026-01-01T00:00:01.000Z',
        responseTime: null,
        durationMs: null,
        extractedIds: {},
      })
      const e2 = db.network.insert({
        runId: run.id,
        method: 'GET',
        url: 'https://api.example.com/cert',
        status: null,
        resourceType: 'fetch',
        requestTime: '2026-01-01T00:00:02.000Z',
        responseTime: null,
        durationMs: null,
        extractedIds: {},
      })
      expect(e1.status).toBeNull()
      expect(e1.extractedIds).toEqual({})

      db.network.complete(e1.id, {
        status: 201,
        responseTime: '2026-01-01T00:00:01.250Z',
        durationMs: 250,
        extractedIds: { leadId: 'L-1', lead_id: 'L-1' },
      })
      expect(() => db.network.complete('ghost', { status: 200, responseTime: null, durationMs: null, extractedIds: {} })).not.toThrow()

      const list = db.network.listByRun(run.id)
      expect(list.map((e) => e.id)).toEqual([e1.id, e2.id])
      expect(list[0]?.status).toBe(201)
      expect(list[0]?.durationMs).toBe(250)
      expect(list[0]?.extractedIds).toEqual({ leadId: 'L-1', lead_id: 'L-1' })

      db.network.deleteByRun(run.id)
      expect(db.network.listByRun(run.id)).toEqual([])

      const { id: _ignored, ...rest } = e1
      db.network.insert({ ...rest, extractedIds: {} })
      expect(db.network.listByRun(run.id)).toHaveLength(1)
      db.testRuns.delete(run.id)
      expect(db.network.listByRun(run.id)).toEqual([])
    })
  })

  describe('settings', () => {
    it('returns defaults merged with stored values and validates patches', () => {
      const initial = db.settings.get()
      expect(initial).toEqual({ ...DEFAULT_SETTINGS, screenshotDir: join(dir, 'shots') })

      const updated = db.settings.update({ ipCheckRetries: 4, defaultFormUrl: 'https://qa.example.com/form' })
      expect(updated.ipCheckRetries).toBe(4)
      expect(updated.defaultFormUrl).toBe('https://qa.example.com/form')
      expect(updated.ipCheckTimeoutMs).toBe(DEFAULT_SETTINGS.ipCheckTimeoutMs)
      expect(updated.screenshotDir).toBe(join(dir, 'shots'))

      expect(() => db.settings.update({ ipCheckRetries: 99 })).toThrowError(AppException)
      expect(() => db.settings.update({ defaultFormUrl: 'not a url' })).toThrowError(/invalid/i)
      expect(() => db.settings.update({ defaultFormUrl: 'ftp://files.example.com/form' })).toThrowError(/invalid/i)
      expect(db.settings.get().ipCheckRetries).toBe(4)

      db.close()
      db = openDatabase(dbPath, { defaultScreenshotDir: join(dir, 'other-shots'), env: {} })
      expect(db.settings.get().ipCheckRetries).toBe(4)
      expect(db.settings.get().screenshotDir).toBe(join(dir, 'other-shots'))
      db.settings.update({ screenshotDir: '/custom/shots' })
      expect(db.settings.get().screenshotDir).toBe('/custom/shots')
    })

    it('defaults browserExecutables to {} for databases that never stored it, persists overrides and validates them', () => {
      expect(db.settings.get().browserExecutables).toEqual({})
      const updated = db.settings.update({ browserExecutables: { opera: '/usr/bin/opera', 'system-chromium': '/usr/bin/chromium' } })
      expect(updated.browserExecutables).toEqual({ opera: '/usr/bin/opera', 'system-chromium': '/usr/bin/chromium' })

      db.close()
      db = openDatabase(dbPath, { defaultScreenshotDir: join(dir, 'shots'), env: {} })
      expect(db.settings.get().browserExecutables).toEqual({ opera: '/usr/bin/opera', 'system-chromium': '/usr/bin/chromium' })
      // Clearing one engine = saving the map without it.
      expect(db.settings.update({ browserExecutables: { opera: '/usr/bin/opera' } }).browserExecutables).toEqual({ opera: '/usr/bin/opera' })
      expect(db.settings.update({ browserExecutables: {} }).browserExecutables).toEqual({})

      expect(() => db.settings.update({ browserExecutables: { safari: '/x' } as never })).toThrowError(AppException)
      expect(() => db.settings.update({ browserExecutables: { opera: '' } })).toThrowError(AppException)
      // Other keys are untouched by override writes.
      db.settings.update({ ipCheckRetries: 3 })
      expect(db.settings.get()).toMatchObject({ ipCheckRetries: 3, browserExecutables: {} })
    })

    it('a patch never resets keys it does not mention (Zod defaults are not applied to patches)', () => {
      db.settings.update({ browserExecutables: { opera: '/usr/bin/opera' }, browserExecutableOrigins: { opera: 'auto' }, singleSessionMode: false, extraChromiumArgs: ['--lang=de'] })
      const after = db.settings.update({ ipCheckRetries: 4 })
      expect(after).toMatchObject({ ipCheckRetries: 4, browserExecutables: { opera: '/usr/bin/opera' }, browserExecutableOrigins: { opera: 'auto' }, singleSessionMode: false, extraChromiumArgs: ['--lang=de'] })
      expect(db.settings.update({ browserExecutableOrigins: {} }).browserExecutables).toEqual({ opera: '/usr/bin/opera' })
      expect(() => db.settings.update({ browserExecutableOrigins: { opera: 'robot' } as never })).toThrowError(AppException)
    })

    it('defaults the location policy to "state" with 3 attempts, persists changes and validates the range', () => {
      expect(db.settings.get()).toMatchObject({ locationMatchPolicy: 'state', locationMatchAttempts: 3 })
      expect(db.settings.update({ locationMatchPolicy: 'exact', locationMatchAttempts: 8 })).toMatchObject({ locationMatchPolicy: 'exact', locationMatchAttempts: 8 })
      expect(() => db.settings.update({ locationMatchAttempts: 0 })).toThrowError(AppException)
      expect(() => db.settings.update({ locationMatchAttempts: 9 })).toThrowError(AppException)
      expect(() => db.settings.update({ locationMatchAttempts: 2.5 })).toThrowError(AppException)
      expect(() => db.settings.update({ locationMatchPolicy: 'city' as never })).toThrowError(AppException)
      db.close()
      db = openDatabase(dbPath, { defaultScreenshotDir: join(dir, 'shots'), env: {} })
      expect(db.settings.get()).toMatchObject({ locationMatchPolicy: 'exact', locationMatchAttempts: 8 })
      expect(db.settings.update({ locationMatchPolicy: 'off' }).locationMatchPolicy).toBe('off')
    })

    it('honours PROXY_QA_DEFAULT_FORM_URL only when valid and only as the default layer', () => {
      db.close()
      db = openDatabase(dbPath, { defaultScreenshotDir: dir, env: { PROXY_QA_DEFAULT_FORM_URL: 'https://env.example.com/form' } })
      expect(db.settings.get().defaultFormUrl).toBe('https://env.example.com/form')
      db.settings.update({ defaultFormUrl: 'https://stored.example.com/' })
      db.close()
      db = openDatabase(dbPath, { defaultScreenshotDir: dir, env: { PROXY_QA_DEFAULT_FORM_URL: 'https://env.example.com/form' } })
      expect(db.settings.get().defaultFormUrl).toBe('https://stored.example.com/')

      const other = openDatabase(join(dir, 'other.sqlite'), { defaultScreenshotDir: dir, env: { PROXY_QA_DEFAULT_FORM_URL: 'nonsense' } })
      expect(other.settings.get().defaultFormUrl).toBe(DEFAULT_SETTINGS.defaultFormUrl)
      other.close()
      const ftp = openDatabase(join(dir, 'ftp.sqlite'), { defaultScreenshotDir: dir, env: { PROXY_QA_DEFAULT_FORM_URL: 'ftp://x.example.com/' } })
      expect(ftp.settings.get().defaultFormUrl).toBe(DEFAULT_SETTINGS.defaultFormUrl)
      ftp.close()
    })
  })

  describe('logs', () => {
    it('inserts, queries newest first with filters, prunes and clears', () => {
      const base = { timestamp: '2026-01-01T00:00:00.000Z', meta: null }
      const a = db.logs.insert({ ...base, level: 'INFO', scope: 'proxy', message: 'proxy check started' })
      const b = db.logs.insert({ ...base, level: 'ERROR', scope: 'browser', message: 'launch failed 100%', meta: { engine: 'webkit' } })
      const c = db.logs.insert({ ...base, level: 'WARN', scope: 'proxy', message: 'slow response' })
      expect(a.id).toBeLessThan(b.id)
      expect(b.meta).toEqual({ engine: 'webkit' })
      expect(a.meta).toBeNull()

      expect(db.logs.query().map((e) => e.id)).toEqual([c.id, b.id, a.id])
      expect(db.logs.query({ level: 'ERROR' }).map((e) => e.id)).toEqual([b.id])
      expect(db.logs.query({ scope: 'proxy' }).map((e) => e.id)).toEqual([c.id, a.id])
      expect(db.logs.query({ search: 'proxy' }).map((e) => e.id)).toEqual([c.id, a.id])
      expect(db.logs.query({ search: '100%' }).map((e) => e.id)).toEqual([b.id])
      expect(db.logs.query({ search: 'webkit' }).map((e) => e.id)).toEqual([b.id])
      expect(db.logs.query({ limit: 1 }).map((e) => e.id)).toEqual([c.id])

      db.logs.prune(2)
      expect(db.logs.query().map((e) => e.id)).toEqual([c.id, b.id])
      db.logs.clear()
      expect(db.logs.query()).toEqual([])
    })
  })
})

describe('resolveAppPaths', () => {
  it('creates the directory tree and names the database file', () => {
    const root = mkdtempSync(join(tmpdir(), 'proxy-qa-paths-'))
    try {
      const paths = resolveAppPaths(join(root, 'userData'))
      expect(paths.data).toBe(join(root, 'userData', 'data'))
      expect(paths.database).toBe(join(root, 'userData', 'data', 'proxy-qa.sqlite'))
      for (const dir of [paths.userData, paths.data, paths.screenshots, paths.browsers, paths.logs]) {
        expect(existsSync(dir)).toBe(true)
      }
      expect(() => resolveAppPaths(join(root, 'userData'))).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

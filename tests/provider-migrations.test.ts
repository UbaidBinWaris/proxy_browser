/**
 * Upgrade safety for selectable proxy providers (schema v8, settings, v1.3.0 exports).
 *
 * Every fixture below is written in the exact shape an earlier version stored or exported:
 * a v7 SQLite database with realistic rows, the legacy global `targetingEncoding` setting,
 * a v1.3.0 encrypted QA configuration backup and v1.3.0 CLI manifests. They must keep loading.
 */
import { createCipheriv, randomBytes, scrypt } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AppSettingsSchema, LEGACY_PROXY_MODES, ProfileInputSchema, ProxyModeSchema, normalizeProxyMode } from '../src/shared/types'
import type { Logger } from '../src/main/contracts'
import { createProfileManager } from '../src/main/browser/profile-manager'
import { openDatabase } from '../src/main/database/index'
import { LEGACY_TARGETING_ENCODING_KEY, migrateLegacySettings } from '../src/main/database/repositories/settings'
import { MIGRATIONS, runMigrations } from '../src/main/database/schema'
import { BackupConfigurationSchema, decryptBackup, restoreConfiguration } from '../src/main/qa/backup'
import { ManifestMatrixSchema, configErrorText, firstIssueText, parseQaManifest } from '../src/main/qa/cli-manifest'
import { BUILT_IN_DIALECTS, ProviderRegistry } from '../src/main/proxy/providers/registry'

const quietLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  log: () => undefined,
  onEntry: () => () => undefined,
  query: () => [],
  clear: () => undefined,
  registerSecret: () => undefined,
}

// ---------------------------------------------------------------------------
// Legacy proxy modes
// ---------------------------------------------------------------------------

describe('legacy proxy modes', () => {
  it('reads dataimpulse-sticky / dataimpulse-rotating as the provider-neutral modes and nothing else', () => {
    expect(LEGACY_PROXY_MODES).toEqual({ 'dataimpulse-sticky': 'sticky', 'dataimpulse-rotating': 'rotating' })
    expect(ProxyModeSchema.parse('dataimpulse-sticky')).toBe('sticky')
    expect(ProxyModeSchema.parse('dataimpulse-rotating')).toBe('rotating')
    expect(ProxyModeSchema.parse('none')).toBe('none')
    expect(ProxyModeSchema.parse('sticky')).toBe('sticky')
    expect(ProxyModeSchema.safeParse('dataimpulse-direct').success).toBe(false)
    expect(ProxyModeSchema.safeParse('toString').success).toBe(false)
    expect(normalizeProxyMode(42)).toBe(42)
  })
})

// ---------------------------------------------------------------------------
// SQLite: v7 → v8
// ---------------------------------------------------------------------------

describe('database migration 8 (proxy providers) on a v7 database', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proxy-qa-v8-'))
    file = join(dir, 'proxy-qa.sqlite')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** A database exactly as v1.3.0 / 1.4.0 left it (migrations 1–7) with the rows a real install has. */
  function writeV7Fixture(): void {
    const db = new DatabaseSync(file)
    db.exec('PRAGMA foreign_keys = ON')
    runMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version <= 7),
    )
    const ts = '2026-09-20T10:00:00.000Z'
    const nj = JSON.stringify({ mode: 'state', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: null, zip: null })
    const insertProfile = db.prepare(`
      INSERT INTO profiles (id, name, engine, device_type, device_preset, viewport_width, viewport_height, user_agent, locale, timezone,
        proxy_mode, sticky_session_id, form_url_override, notes, proxy_pool, target_json, sticky_ttl_minutes, ephemeral, created_at, updated_at)
      VALUES (?, ?, 'chromium', 'desktop', 'windows-desktop', 1366, 768, NULL, 'en-US', 'America/New_York', ?, ?, NULL, '', ?, ?, ?, ?, ?, ?)
    `)
    insertProfile.run('p-sticky', 'NJ sticky', 'dataimpulse-sticky', 'profile-nj-sticky', 'residential', nj, 60, 0, ts, ts)
    insertProfile.run('p-rotating', 'Mobile rotating', 'dataimpulse-rotating', null, 'mobile', null, null, 0, ts, ts)
    insertProfile.run('p-direct', 'Direct', 'none', null, 'residential', null, null, 0, ts, ts)
    insertProfile.run('p-quick', 'Residential · NJ · iPhone', 'dataimpulse-sticky', 'ql-20260920-abcd', 'residential', nj, null, 1, ts, ts)

    db.prepare(
      `INSERT INTO proxy_sessions (id, profile_id, provider, session_id, status, last_ip, country, country_code, region, city, postal_code,
        isp, asn, latency_ms, last_checked_at, last_error, created_at, updated_at, pool, target_json, targeting_string, target_match)
       VALUES ('s1', 'p-sticky', 'dataimpulse', 'profile-nj-sticky', 'working', '203.0.113.7', 'United States', 'US', 'New Jersey', 'Newark', '07102',
        'ISP', 'AS1', 120, ?, NULL, ?, ?, 'residential', ?, 'cr.us;state.newjersey;sessid.profile-nj-sticky', 'match')`,
    ).run(ts, ts, ts, nj)
    db.prepare(
      `INSERT INTO proxy_sessions (id, profile_id, provider, session_id, status, created_at, updated_at, pool)
       VALUES ('s-gateway', NULL, 'dataimpulse', NULL, 'working', ?, ?, 'mobile')`,
    ).run(ts, ts)

    const insertRun = db.prepare(`
      INSERT INTO test_runs (id, profile_id, profile_name, engine, device_preset, public_ip, form_url, started_at, ended_at, status, notes,
        pool, target_json, targeting_string, target_match, postal_code, location_attempts, location_max_attempts, location_warning)
      VALUES (?, ?, ?, 'chromium', 'windows-desktop', ?, 'https://forms.example.com/', ?, ?, 'success', '', ?, ?, ?, ?, NULL, ?, ?, NULL)
    `)
    insertRun.run('r-proxied', 'p-sticky', 'NJ sticky', '203.0.113.7', ts, ts, 'residential', nj, 'cr.us;state.newjersey;sessid.profile-nj-sticky', 'match', 2, 3)
    insertRun.run('r-direct', 'p-direct', 'Direct', '198.51.100.4', ts, ts, null, null, null, null, 1, 1)
    insertRun.run('r-orphan', null, 'Deleted profile', '203.0.113.8', ts, ts, 'mobile', null, null, null, 1, 1)

    const setting = db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
    setting.run('targetingEncoding', JSON.stringify('underscore'), ts)
    setting.run('defaultProxyPool', JSON.stringify('mobile'), ts)
    setting.run('locationMatchPolicy', JSON.stringify('exact'), ts)
    db.close()
  }

  it('rewrites the proxy modes, adds provider columns and keeps every row readable', () => {
    writeV7Fixture()
    const db = openDatabase(file, { defaultScreenshotDir: join(dir, 'shots'), env: {} })
    try {
      // Profiles: new modes, DataImpulse as the provider, everything else untouched.
      const profiles = db.profiles.list({ includeEphemeral: true }).sort((a, b) => a.id.localeCompare(b.id))
      expect(profiles.map((p) => [p.id, p.proxyMode, p.providerId, p.proxyPool])).toEqual([
        ['p-direct', 'none', 'dataimpulse', 'residential'],
        ['p-quick', 'sticky', 'dataimpulse', 'residential'],
        ['p-rotating', 'rotating', 'dataimpulse', 'mobile'],
        ['p-sticky', 'sticky', 'dataimpulse', 'residential'],
      ])
      expect(db.profiles.get('p-sticky')).toMatchObject({ stickySessionId: 'profile-nj-sticky', stickyTtlMinutes: 60, target: { state: 'New Jersey' }, ephemeral: false })
      expect(db.profiles.get('p-quick')?.ephemeral).toBe(true)

      // Test runs: proxied runs are DataImpulse runs, direct runs have no provider.
      expect(db.testRuns.get('r-proxied')).toMatchObject({ provider: 'dataimpulse', proxyPool: 'residential', locationAttempts: 2, locationMaxAttempts: 3, targetMatch: 'match' })
      expect(db.testRuns.get('r-direct')).toMatchObject({ provider: null, proxyPool: null })
      expect(db.testRuns.get('r-orphan')).toMatchObject({ provider: 'dataimpulse', proxyPool: 'mobile', profileId: null })

      // Proxy sessions keep their recorded provider.
      expect(db.proxySessions.get('s1')).toMatchObject({ provider: 'dataimpulse', pool: 'residential', lastIp: '203.0.113.7', targetMatch: 'match' })
      expect(db.proxySessions.getByProfile(null)).toMatchObject({ id: 's-gateway', provider: 'dataimpulse', pool: 'mobile' })

      // Settings: the legacy encoding now lives in the DataImpulse provider options; other settings are unchanged.
      expect(db.settings.get()).toMatchObject({
        providerOptions: { dataimpulse: { encoding: 'underscore' } },
        defaultProviderId: 'dataimpulse',
        defaultProxyPool: 'mobile',
        locationMatchPolicy: 'exact',
      })
    } finally {
      db.close()
    }

    const raw = new DatabaseSync(file)
    try {
      const versions = (raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>).map((r) => Number(r.version))
      expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      const modes = (raw.prepare('SELECT DISTINCT proxy_mode FROM profiles ORDER BY proxy_mode').all() as Array<{ proxy_mode: string }>).map((r) => r.proxy_mode)
      expect(modes).toEqual(['none', 'rotating', 'sticky'])
      expect(raw.prepare("SELECT COUNT(*) AS n FROM app_settings WHERE key = 'targetingEncoding'").get()).toMatchObject({ n: 0 })
    } finally {
      raw.close()
    }
  })

  it('is applied once: reopening is a no-op and new rows record their provider', () => {
    writeV7Fixture()
    openDatabase(file, { defaultScreenshotDir: join(dir, 'shots'), env: {} }).close()
    const db = openDatabase(file, { defaultScreenshotDir: join(dir, 'shots'), env: {} })
    try {
      expect(db.profiles.get('p-rotating')?.proxyMode).toBe('rotating')
      const created = db.profiles.create(ProfileInputSchema.parse({ ...db.profiles.get('p-sticky'), name: 'Acme copy', providerId: 'acme', proxyPool: 'isp' }))
      expect(db.profiles.get(created.id)).toMatchObject({ providerId: 'acme', proxyPool: 'isp', proxyMode: 'sticky' })
      const session = db.proxySessions.upsertForProfile(created.id, 'acme-1', { providerId: 'acme', pool: 'isp', target: null, targetingString: 'country-us' })
      expect(session).toMatchObject({ provider: 'acme', pool: 'isp' })
      // Switching provider resets the cached exit IP like a changed pool does.
      expect(db.proxySessions.upsertForProfile(created.id, 'acme-1', { providerId: 'dataimpulse', pool: 'isp', target: null, targetingString: 'country-us' })).toMatchObject({ provider: 'dataimpulse', status: 'untested' })
    } finally {
      db.close()
    }
  })

  it('reads a legacy mode written by an older build after the upgrade (shared database, downgrade and back)', () => {
    writeV7Fixture()
    openDatabase(file, { defaultScreenshotDir: join(dir, 'shots'), env: {} }).close()
    const raw = new DatabaseSync(file)
    raw.prepare("UPDATE profiles SET proxy_mode = 'dataimpulse-rotating' WHERE id = 'p-sticky'").run()
    raw.close()
    const db = openDatabase(file, { defaultScreenshotDir: join(dir, 'shots'), env: {} })
    try {
      expect(db.profiles.get('p-sticky')?.proxyMode).toBe('rotating')
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Settings: global targetingEncoding → providerOptions.dataimpulse.encoding
// ---------------------------------------------------------------------------

describe('legacy settings migration', () => {
  function settingsDb(rows: Record<string, string>): DatabaseSync {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)')
    const insert = db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
    for (const [key, value] of Object.entries(rows)) insert.run(key, value, '2026-01-01T00:00:00.000Z')
    return db
  }
  const valueOf = (db: DatabaseSync, key: string): unknown => {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined
    return row ? JSON.parse(row.value) : undefined
  }

  it('moves the value into the DataImpulse options once', () => {
    const db = settingsDb({ [LEGACY_TARGETING_ENCODING_KEY]: '"keep"' })
    expect(migrateLegacySettings(db)).toBe(true)
    expect(valueOf(db, 'providerOptions')).toEqual({ dataimpulse: { encoding: 'keep' } })
    expect(valueOf(db, LEGACY_TARGETING_ENCODING_KEY)).toBeUndefined()
    expect(migrateLegacySettings(db)).toBe(false)
    expect(AppSettingsSchema.shape.providerOptions.parse(valueOf(db, 'providerOptions'))).toEqual({ dataimpulse: { encoding: 'keep' } })
  })

  it('keeps an encoding already set in providerOptions and other providers’ options', () => {
    const db = settingsDb({ [LEGACY_TARGETING_ENCODING_KEY]: '"keep"', providerOptions: JSON.stringify({ dataimpulse: { encoding: 'underscore' }, acme: { encoding: 'loud' } }) })
    migrateLegacySettings(db)
    expect(valueOf(db, 'providerOptions')).toEqual({ dataimpulse: { encoding: 'underscore' }, acme: { encoding: 'loud' } })
    expect(valueOf(db, LEGACY_TARGETING_ENCODING_KEY)).toBeUndefined()
  })

  it('drops a corrupt legacy value without failing', () => {
    const db = settingsDb({ [LEGACY_TARGETING_ENCODING_KEY]: '{not json', providerOptions: 'also not json' })
    expect(migrateLegacySettings(db)).toBe(true)
    expect(valueOf(db, LEGACY_TARGETING_ENCODING_KEY)).toBeUndefined()
    // Nothing to carry over, so the (separately corrupt) providerOptions row is left for the per-key fallback.
    expect(db.prepare('SELECT value FROM app_settings WHERE key = ?').get('providerOptions')).toMatchObject({ value: 'also not json' })
  })
})

// ---------------------------------------------------------------------------
// v1.3.0 exports: encrypted QA configuration backup and CLI manifests
// ---------------------------------------------------------------------------

/** A profile exactly as v1.3.0 exported it (Profile with id/timestamps, legacy mode, no providerId). */
const V130_PROFILE = {
  id: 'f2b8c1d0-0000-4000-8000-000000000001',
  name: 'NJ residential sticky',
  engine: 'chromium',
  deviceType: 'desktop',
  devicePreset: 'windows-desktop',
  viewportWidth: 1366,
  viewportHeight: 768,
  userAgent: null,
  locale: 'en-US',
  timezone: 'America/New_York',
  proxyMode: 'dataimpulse-sticky',
  stickySessionId: 'profile-nj-residential',
  formUrlOverride: null,
  notes: 'exported by 1.3.0',
  proxyPool: 'residential',
  target: { mode: 'state', country: 'us', state: 'New Jersey', stateCode: 'NJ', city: null, zip: null },
  stickyTtlMinutes: 30,
  ephemeral: false,
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-09-02T08:00:00.000Z',
}

const V130_SCENARIO = {
  id: 'a1b2c3d4-0000-4000-8000-000000000002',
  workspaceId: 'default',
  name: 'Lead form',
  profileId: V130_PROFILE.id,
  gatewayId: null,
  startUrl: 'https://forms.example.com/lead',
  allowedOrigins: ['https://forms.example.com'],
  steps: [{ action: 'assertStatus', value: 200 }],
  timeoutMs: 15000,
  maskSelectors: [],
  captureTrace: false,
  healing: 'warn',
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-09-01T08:00:00.000Z',
}

/** Same container format as backup.ts writes, WITHOUT validating first (a file written by an older build). */
async function encryptRawBackup(configuration: unknown, passphrase: string): Promise<Buffer> {
  const magic = Buffer.from('PQAB1')
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = await new Promise<Buffer>((resolve, reject) =>
    scrypt(passphrase, salt, 32, { N: 32768, maxmem: 64 * 1024 * 1024 }, (err, derived) => (err ? reject(err) : resolve(derived))),
  )
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(magic)
  const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(configuration))), cipher.final()])
  return Buffer.concat([magic, salt, iv, cipher.getAuthTag(), encrypted])
}

describe('v1.3.0 QA configuration backup', () => {
  const v130Backup = {
    version: 1,
    createdAt: '2026-09-03T08:00:00.000Z',
    profiles: [V130_PROFILE, { ...V130_PROFILE, id: 'f2b8c1d0-0000-4000-8000-000000000003', name: 'Mobile rotating', proxyMode: 'dataimpulse-rotating', proxyPool: 'mobile', stickySessionId: null, stickyTtlMinutes: null }],
    workspaces: [{ id: 'default', name: 'Default' }],
    scenarios: [V130_SCENARIO],
    policy: { retentionDays: 30, maxCombinations: 100, maxConcurrentBrowsers: 2, maxDailyCases: 500, allowTraces: false },
    environments: [],
    suites: [],
  }

  it('decrypts, maps the legacy modes and restores as DataImpulse profiles', async () => {
    const bytes = await encryptRawBackup(v130Backup, 'a-long-test-passphrase')
    const configuration = await decryptBackup(bytes, 'a-long-test-passphrase')
    expect(configuration.profiles.map((p) => [p.proxyMode, p.providerId, p.proxyPool])).toEqual([
      ['sticky', 'dataimpulse', 'residential'],
      ['rotating', 'dataimpulse', 'mobile'],
    ])
    expect(BackupConfigurationSchema.safeParse(v130Backup).success).toBe(true)

    const db = openDatabase(':memory:', { defaultScreenshotDir: '/tmp/shots', env: {} })
    try {
      const registry = new ProviderRegistry({ ipChecker: { lookup: async () => Promise.reject(new Error('offline')) }, logger: quietLogger })
      for (const dialect of BUILT_IN_DIALECTS) registry.register(dialect)
      const profiles = createProfileManager({ repo: db.profiles, logger: quietLogger, providers: registry })
      expect(restoreConfiguration(db.qa!, profiles, configuration)).toBe(1)
      const restored = db.profiles.list().sort((a, b) => b.name.localeCompare(a.name))
      expect(restored.map((p) => [p.name, p.proxyMode, p.providerId])).toEqual([
        ['NJ residential sticky (restored)', 'sticky', 'dataimpulse'],
        ['Mobile rotating (restored)', 'rotating', 'dataimpulse'],
      ])
    } finally {
      db.close()
    }
  })

  it('never switches a backup profile to another provider: an unknown provider is refused by name', async () => {
    const bytes = await encryptRawBackup({ ...v130Backup, profiles: [{ ...V130_PROFILE, providerId: 'brightdata' }] }, 'a-long-test-passphrase')
    const configuration = await decryptBackup(bytes, 'a-long-test-passphrase')
    const db = openDatabase(':memory:', { defaultScreenshotDir: '/tmp/shots', env: {} })
    try {
      const registry = new ProviderRegistry({ ipChecker: { lookup: async () => Promise.reject(new Error('offline')) }, logger: quietLogger })
      for (const dialect of BUILT_IN_DIALECTS) registry.register(dialect)
      const profiles = createProfileManager({ repo: db.profiles, logger: quietLogger, providers: registry })
      expect(() => restoreConfiguration(db.qa!, profiles, configuration)).toThrowError(/proxy provider "brightdata" is not supported/)
      expect(db.profiles.list()).toEqual([])
    } finally {
      db.close()
    }
  })
})

describe('v1.3.0 CLI manifests', () => {
  /** `scenario-<id>.json` as v1.3.0 exported it (Settings → QA → Export scenario) plus a matrix written for the runner. */
  const scenarioManifest = {
    scenario: V130_SCENARIO,
    profile: V130_PROFILE,
    environments: [],
    matrix: { scenarioId: V130_SCENARIO.id, engines: ['chromium'], devices: ['windows-desktop'], retries: 1 },
  }

  it('loads a v1.3.0 scenario manifest with legacy modes', () => {
    const manifest = parseQaManifest(JSON.parse(JSON.stringify(scenarioManifest)))
    expect('profile' in manifest && manifest.profile).toMatchObject({ proxyMode: 'sticky', providerId: 'dataimpulse', proxyPool: 'residential', stickySessionId: 'profile-nj-residential' })
    expect(manifest.matrix).toMatchObject({ engines: ['chromium'], retries: 1, scenarioId: V130_SCENARIO.id })
  })

  it('loads a v1.3.0 suite manifest with legacy modes', () => {
    const suite = {
      suite: { workspaceId: 'default', name: 'Nightly', scenarioIds: [V130_SCENARIO.id] },
      scenarios: [V130_SCENARIO],
      profiles: [{ ...V130_PROFILE, proxyMode: 'dataimpulse-rotating', stickySessionId: null }],
      environments: [],
    }
    const manifest = parseQaManifest(JSON.parse(JSON.stringify(suite)))
    expect('profiles' in manifest && manifest.profiles[0]).toMatchObject({ proxyMode: 'rotating', providerId: 'dataimpulse' })
  })

  it('accepts a matrix without a scenarioId: the runner supplies its own', () => {
    const { scenarioId: _omit, ...matrix } = scenarioManifest.matrix
    const manifest = parseQaManifest({ ...scenarioManifest, matrix })
    expect(manifest.matrix).toMatchObject({ engines: ['chromium'], devices: ['windows-desktop'], retries: 1, concurrency: 1 })
    expect(manifest.matrix?.scenarioId).toBeUndefined()
    expect(ManifestMatrixSchema.safeParse({}).success).toBe(true)
  })

  it('names the failing field path and message in configuration errors, never a value', () => {
    expect(() => parseQaManifest({ ...scenarioManifest, matrix: { engines: ['netscape'] } })).toThrowError(/^Invalid manifest: matrix\.engines\.0: /)
    expect(() => parseQaManifest({ ...scenarioManifest, profile: { ...V130_PROFILE, proxyMode: 'carrier-pigeon' } })).toThrowError(/^Invalid manifest: profile\.proxyMode: /)
    expect(() => parseQaManifest({ suite: { name: 'x' }, scenarios: [], profiles: [] })).toThrowError(/^Invalid manifest: suite\./)
    expect(() => parseQaManifest([])).toThrowError('The manifest must be a JSON object.')
    let message = ''
    try {
      parseQaManifest({ ...scenarioManifest, profile: { ...V130_PROFILE, stickySessionId: 'Secret Value With Spaces' } })
    } catch (err) {
      message = configErrorText(err)
    }
    expect(message).toMatch(/profile\.stickySessionId: /)
    expect(message).not.toContain('Secret Value With Spaces')
    expect(configErrorText(new SyntaxError('Unexpected token s in JSON at position 3: secret'))).toBe('The file is not valid JSON.')
    const zod = ManifestMatrixSchema.safeParse({ retries: 7 })
    expect(zod.success).toBe(false)
    if (!zod.success) {
      expect(firstIssueText(zod.error)).toMatch(/^retries: /)
      expect(configErrorText(zod.error)).toMatch(/^retries: /)
    }
  })
})

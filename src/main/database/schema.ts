/**
 * Versioned schema migrations.
 *
 * Every migration is applied once, inside its own transaction, and recorded in
 * `schema_migrations`. Re-opening the database is a no-op for versions already
 * recorded. Never edit a published migration — add a new one.
 */
import type { DatabaseSync } from 'node:sqlite'

import { nowIso, transaction } from './sql'
import { redactUrl } from '../security/data-privacy'

export interface Migration {
  version: number
  name: string
  up: (db: DatabaseSync) => void
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS profiles (
          id                 TEXT PRIMARY KEY,
          name               TEXT    NOT NULL,
          engine             TEXT    NOT NULL,
          device_type        TEXT    NOT NULL,
          device_preset      TEXT    NOT NULL,
          viewport_width     INTEGER NOT NULL,
          viewport_height    INTEGER NOT NULL,
          user_agent         TEXT,
          locale             TEXT    NOT NULL,
          timezone           TEXT    NOT NULL,
          proxy_mode         TEXT    NOT NULL,
          sticky_session_id  TEXT,
          form_url_override  TEXT,
          notes              TEXT    NOT NULL DEFAULT '',
          created_at         TEXT    NOT NULL,
          updated_at         TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_profiles_name ON profiles(name);

        CREATE TABLE IF NOT EXISTS proxy_sessions (
          id               TEXT PRIMARY KEY,
          profile_id       TEXT REFERENCES profiles(id) ON DELETE SET NULL,
          provider         TEXT NOT NULL DEFAULT 'dataimpulse',
          session_id       TEXT,
          status           TEXT NOT NULL DEFAULT 'untested',
          last_ip          TEXT,
          country          TEXT,
          region           TEXT,
          city             TEXT,
          isp              TEXT,
          asn              TEXT,
          latency_ms       INTEGER,
          last_checked_at  TEXT,
          last_error       TEXT,
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_proxy_sessions_profile ON proxy_sessions(profile_id);
        CREATE INDEX IF NOT EXISTS idx_proxy_sessions_status  ON proxy_sessions(status);

        CREATE TABLE IF NOT EXISTS test_runs (
          id                TEXT PRIMARY KEY,
          profile_id        TEXT REFERENCES profiles(id) ON DELETE SET NULL,
          profile_name      TEXT NOT NULL,
          engine            TEXT NOT NULL,
          device_preset     TEXT NOT NULL,
          public_ip         TEXT,
          country           TEXT,
          region            TEXT,
          city              TEXT,
          proxy_session_id  TEXT,
          form_url          TEXT NOT NULL,
          started_at        TEXT NOT NULL,
          ended_at          TEXT,
          status            TEXT NOT NULL,
          notes             TEXT NOT NULL DEFAULT '',
          http_status       INTEGER,
          final_url         TEXT,
          screenshot_path   TEXT,
          lead_id           TEXT,
          certificate_id    TEXT,
          error_message     TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_test_runs_started ON test_runs(started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_test_runs_profile ON test_runs(profile_id);

        CREATE TABLE IF NOT EXISTS network_entries (
          id             TEXT PRIMARY KEY,
          run_id         TEXT NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
          method         TEXT NOT NULL,
          url            TEXT NOT NULL,
          status         INTEGER,
          resource_type  TEXT NOT NULL,
          request_time   TEXT NOT NULL,
          response_time  TEXT,
          duration_ms    INTEGER,
          extracted_ids  TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_network_entries_run ON network_entries(run_id, request_time);

        CREATE TABLE IF NOT EXISTS app_settings (
          key         TEXT PRIMARY KEY,
          value       TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS logs (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp  TEXT NOT NULL,
          level      TEXT NOT NULL,
          scope      TEXT NOT NULL,
          message    TEXT NOT NULL,
          meta       TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
        CREATE INDEX IF NOT EXISTS idx_logs_scope ON logs(scope);
      `)
    },
  },
  {
    /**
     * proxy_sessions rows belong to their profile: deleting a profile must take
     * its session row with it (v1 used ON DELETE SET NULL, which left orphans
     * that looked like the raw-gateway row). Also adds `country_code`.
     * SQLite cannot alter constraints in place, so the table is rebuilt. Rows
     * already orphaned (no profile, but a sticky session id) are dropped; the
     * real gateway row (no profile, no session id) is kept. test_runs keep
     * SET NULL on purpose: run history outlives profiles.
     */
    version: 2,
    name: 'proxy-sessions-cascade-and-country-code',
    up: (db) => {
      db.exec(`
        CREATE TABLE proxy_sessions_v2 (
          id               TEXT PRIMARY KEY,
          profile_id       TEXT REFERENCES profiles(id) ON DELETE CASCADE,
          provider         TEXT NOT NULL DEFAULT 'dataimpulse',
          session_id       TEXT,
          status           TEXT NOT NULL DEFAULT 'untested',
          last_ip          TEXT,
          country          TEXT,
          country_code     TEXT,
          region           TEXT,
          city             TEXT,
          isp              TEXT,
          asn              TEXT,
          latency_ms       INTEGER,
          last_checked_at  TEXT,
          last_error       TEXT,
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL
        );
        INSERT INTO proxy_sessions_v2 (
          id, profile_id, provider, session_id, status, last_ip, country, country_code, region, city, isp, asn,
          latency_ms, last_checked_at, last_error, created_at, updated_at
        )
        SELECT
          id, profile_id, provider, session_id, status, last_ip, country, NULL, region, city, isp, asn,
          latency_ms, last_checked_at, last_error, created_at, updated_at
        FROM proxy_sessions
        WHERE NOT (profile_id IS NULL AND session_id IS NOT NULL)
          AND (profile_id IS NULL OR profile_id IN (SELECT id FROM profiles));
        DROP INDEX IF EXISTS idx_proxy_sessions_profile;
        DROP INDEX IF EXISTS idx_proxy_sessions_status;
        DROP TABLE proxy_sessions;
        ALTER TABLE proxy_sessions_v2 RENAME TO proxy_sessions;
        CREATE INDEX IF NOT EXISTS idx_proxy_sessions_profile ON proxy_sessions(profile_id);
        CREATE INDEX IF NOT EXISTS idx_proxy_sessions_status  ON proxy_sessions(status);
      `)
    },
  },
  {
    /**
     * Provider pools and geo targeting. Profiles pick a DataImpulse pool
     * (residential/mobile), an optional exit location (JSON GeoTarget), a sticky
     * TTL and may be ephemeral (Quick Launch, hidden from the Profiles page).
     * Proxy sessions and test runs record the pool, the target, the exact
     * parameter string sent to the provider and the verified-vs-requested
     * comparison. `device_preset` stays TEXT (preset ids are open strings).
     */
    version: 3,
    name: 'proxy-pools-and-geo-targeting',
    up: (db) => {
      db.exec(`
        ALTER TABLE profiles ADD COLUMN proxy_pool         TEXT    NOT NULL DEFAULT 'residential';
        ALTER TABLE profiles ADD COLUMN target_json        TEXT;
        ALTER TABLE profiles ADD COLUMN sticky_ttl_minutes INTEGER;
        ALTER TABLE profiles ADD COLUMN ephemeral          INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX IF NOT EXISTS idx_profiles_ephemeral ON profiles(ephemeral);

        ALTER TABLE proxy_sessions ADD COLUMN pool             TEXT;
        ALTER TABLE proxy_sessions ADD COLUMN target_json      TEXT;
        ALTER TABLE proxy_sessions ADD COLUMN targeting_string TEXT;
        ALTER TABLE proxy_sessions ADD COLUMN target_match     TEXT;

        ALTER TABLE test_runs ADD COLUMN pool             TEXT;
        ALTER TABLE test_runs ADD COLUMN target_json      TEXT;
        ALTER TABLE test_runs ADD COLUMN targeting_string TEXT;
        ALTER TABLE test_runs ADD COLUMN target_match     TEXT;
      `)
    },
  },
  {
    /**
     * Exact ZIP verification and the location re-roll. Proxy sessions and test
     * runs record the exit IP's postal code next to city/region. Test runs
     * record how many sticky session ids were tried before the browser opened
     * (`location_attempts`), the attempt budget at launch and, when no attempt
     * met the location policy, the warning explaining which result was used.
     * Rows written before this version load as a single attempt out of one.
     */
    version: 4,
    name: 'postal-code-and-location-attempts',
    up: (db) => {
      db.exec(`
        ALTER TABLE proxy_sessions ADD COLUMN postal_code TEXT;

        ALTER TABLE test_runs ADD COLUMN postal_code           TEXT;
        ALTER TABLE test_runs ADD COLUMN location_attempts     INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE test_runs ADD COLUMN location_max_attempts INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE test_runs ADD COLUMN location_warning      TEXT;
      `)
    },
  },
  {
    version: 5,
    name: 'qa-automation-and-workspaces',
    up: (db) => {
      for (const table of ['qa_workspaces', 'qa_scenarios', 'qa_batches', 'qa_policy', 'qa_schedules', 'qa_gateways'])
        db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY, body TEXT NOT NULL)`)
      db.exec(
        'CREATE TABLE qa_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, workspace_id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, entity_id TEXT NOT NULL)',
      )
    },
  },
  {
    version: 6,
    name: 'redact-existing-captured-urls',
    up: (db) => {
      const network = db.prepare('UPDATE network_entries SET url=? WHERE id=?')
      for (const row of db.prepare('SELECT id,url FROM network_entries').iterate())
        network.run(redactUrl(String(row.url)), String(row.id))
      const runs = db.prepare('UPDATE test_runs SET form_url=?,final_url=? WHERE id=?')
      for (const row of db.prepare('SELECT id,form_url,final_url FROM test_runs').iterate())
        runs.run(
          redactUrl(String(row.form_url)),
          row.final_url === null ? null : redactUrl(String(row.final_url)),
          String(row.id),
        )
    },
  },
  {
    version: 7,
    name: 'qa-suites-and-environments',
    up: (db) => {
      for (const table of ['qa_suites', 'qa_environments'])
        db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY, body TEXT NOT NULL)`)
    },
  },
]

/** Create the migrations ledger and apply every pending migration in order. */
export function runMigrations(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): number[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL
    )
  `)

  const applied = new Set<number>()
  for (const row of db.prepare('SELECT version FROM schema_migrations').all()) {
    const version = (row as { version: number | bigint }).version
    applied.add(Number(version))
  }

  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
  const newlyApplied: number[] = []

  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue
    transaction(db, () => {
      migration.up(db)
      record.run(migration.version, migration.name, nowIso())
    })
    newlyApplied.push(migration.version)
  }

  return newlyApplied
}

import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

/**
 * Schema versions live in PRAGMA user_version. Add a migration to the END of the list, never edit an old one:
 * a database that has already run it will not run it again.
 */
const MIGRATIONS: ReadonlyArray<(db: Db) => void> = [
  db => {
    db.exec(`
      CREATE TABLE providers (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        type             TEXT NOT NULL CHECK (type IN ('openai','anthropic')),
        base_url         TEXT NOT NULL,
        locality         TEXT NOT NULL DEFAULT 'cloud' CHECK (locality IN ('local','cloud')),
        auth_scheme      TEXT NOT NULL DEFAULT 'bearer' CHECK (auth_scheme IN ('bearer','header','none')),
        auth_header      TEXT,
        secret_enc       TEXT,
        secret_hint      TEXT,
        extra_headers    TEXT NOT NULL DEFAULT '{}',
        options          TEXT NOT NULL DEFAULT '{}',
        max_concurrency  INTEGER,
        node             TEXT,
        enabled          INTEGER NOT NULL DEFAULT 1,
        position         INTEGER NOT NULL DEFAULT 0,
        models_synced_at TEXT,
        last_sync_error  TEXT,
        created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE TABLE models (
        id          TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        upstream_id TEXT NOT NULL,
        source      TEXT NOT NULL DEFAULT 'synced' CHECK (source IN ('synced','manual')),
        reported    TEXT NOT NULL DEFAULT '{}',
        overrides   TEXT NOT NULL DEFAULT '{}',
        present     INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE (provider_id, upstream_id)
      );
      CREATE INDEX models_provider ON models(provider_id);

      CREATE TABLE aliases (
        name        TEXT PRIMARY KEY,
        description TEXT NOT NULL DEFAULT '',
        tags        TEXT NOT NULL DEFAULT '[]',
        targets     TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE TABLE api_keys (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL UNIQUE,
        prefix           TEXT NOT NULL,
        hash             TEXT NOT NULL UNIQUE,
        default_priority INTEGER NOT NULL DEFAULT 3,
        min_priority     INTEGER NOT NULL DEFAULT 1,
        max_priority     INTEGER NOT NULL DEFAULT 5,
        local_only       INTEGER NOT NULL DEFAULT 0,
        allowed_models   TEXT,
        rpm              INTEGER,
        rpd              INTEGER,
        tokens_per_day   INTEGER,
        tokens_per_month INTEGER,
        created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_used_at     TEXT,
        revoked_at       TEXT
      );

      -- No foreign key on purpose: usage history outlives the key it belongs to.
      CREATE TABLE usage_daily (
        day           TEXT NOT NULL,
        key_id        TEXT NOT NULL,
        model_id      TEXT NOT NULL,
        requests      INTEGER NOT NULL DEFAULT 0,
        errors        INTEGER NOT NULL DEFAULT 0,
        input_tokens  INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, key_id, model_id)
      );
      CREATE INDEX usage_daily_key ON usage_daily(key_id, day);

      -- Who asked for what and what happened. Never the prompt or the answer.
      CREATE TABLE request_log (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        ts              TEXT NOT NULL,
        request_id      TEXT NOT NULL,
        key_id          TEXT,
        key_name        TEXT,
        endpoint        TEXT NOT NULL,
        requested_model TEXT,
        model_id        TEXT,
        provider_id     TEXT,
        status          INTEGER NOT NULL,
        error_code      TEXT,
        stream          INTEGER NOT NULL DEFAULT 0,
        priority        INTEGER,
        local_only      INTEGER NOT NULL DEFAULT 0,
        tag             TEXT,
        attempts        TEXT NOT NULL DEFAULT '[]',
        queue_ms        INTEGER,
        ttfb_ms         INTEGER,
        latency_ms      INTEGER,
        input_tokens    INTEGER,
        output_tokens   INTEGER,
        estimated       INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX request_log_ts ON request_log(ts);
      CREATE INDEX request_log_key ON request_log(key_id, ts);
    `);
  },
  // Aliases are gone: an app that wants a fallback picks it from the models' tags itself. A key that was limited to an
  // alias keeps working: its allow-list now names the models the alias pointed at.
  db => {
    const aliases = db.prepare('SELECT name, targets FROM aliases').all() as Array<{ name: string; targets: string }>;
    if (aliases.length) {
      const targetsOf = new Map<string, string[]>();
      for (const a of aliases) {
        try {
          const t = JSON.parse(a.targets) as unknown;
          if (Array.isArray(t)) targetsOf.set(a.name, t.filter((x): x is string => typeof x === 'string'));
        } catch {
          /* an unreadable alias grants nothing */
        }
      }
      const keys = db.prepare('SELECT id, allowed_models FROM api_keys WHERE allowed_models IS NOT NULL').all() as Array<{ id: string; allowed_models: string }>;
      const update = db.prepare('UPDATE api_keys SET allowed_models = ? WHERE id = ?');
      for (const k of keys) {
        let list: unknown;
        try {
          list = JSON.parse(k.allowed_models);
        } catch {
          continue;
        }
        if (!Array.isArray(list)) continue;
        const next = [...new Set(list.flatMap(p => (typeof p === 'string' && targetsOf.has(p) ? targetsOf.get(p)! : [p])))];
        if (next.length !== list.length || next.some((p, i) => p !== list[i])) update.run(JSON.stringify(next), k.id);
      }
    }
    db.exec('DROP TABLE aliases');
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;

export function schemaVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number;
}

export function openDatabase(path: string): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const existed = path === ':memory:' || existsSync(path);
  const db = new Database(path);
  if (path !== ':memory:') {
    db.pragma('journal_mode = WAL');
    if (!existed) {
      try {
        chmodSync(path, 0o600);
      } catch {
        /* best effort: some file systems have no modes */
      }
    }
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

/** Brings the schema up to date (or, for tests of a single step, up to `upTo`). */
export function migrate(db: Db, upTo: number = LATEST_SCHEMA_VERSION): void {
  const current = schemaVersion(db);
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `This database has schema version ${current} but this build only understands up to ${LATEST_SCHEMA_VERSION}. ` +
        `It was written by a newer MindGate — upgrade instead of downgrading.`,
    );
  }
  for (let v = current; v < upTo; v++) {
    db.transaction(() => {
      MIGRATIONS[v]!(db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export const nowIso = (): string => new Date().toISOString();

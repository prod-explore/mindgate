import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { LATEST_SCHEMA_VERSION, migrate, schemaVersion } from '../db.js';

const addKey = (db: Database.Database, id: string, allowed: string[] | null): void => {
  db.prepare('INSERT INTO api_keys (id, name, prefix, hash, allowed_models) VALUES (?, ?, ?, ?, ?)').run(id, `key-${id}`, 'mg-xx', `hash-${id}`, allowed === null ? null : JSON.stringify(allowed));
};
const allowedOf = (db: Database.Database, id: string): unknown => {
  const row = db.prepare('SELECT allowed_models FROM api_keys WHERE id = ?').get(id) as { allowed_models: string | null };
  return row.allowed_models === null ? null : JSON.parse(row.allowed_models);
};

describe('migration: aliases are removed', () => {
  const before = (): Database.Database => {
    const db = new Database(':memory:');
    migrate(db, LATEST_SCHEMA_VERSION - 1);
    assert.equal(schemaVersion(db), LATEST_SCHEMA_VERSION - 1);
    return db;
  };

  it('drops the table and leaves a database that was never using aliases alone', () => {
    const db = before();
    addKey(db, 'a', null);
    addKey(db, 'b', ['cloud/gpt', 'home/*']);
    migrate(db);
    assert.equal(schemaVersion(db), LATEST_SCHEMA_VERSION);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'aliases'").get()!['n' as never], 0);
    assert.equal(allowedOf(db, 'a'), null);
    assert.deepEqual(allowedOf(db, 'b'), ['cloud/gpt', 'home/*']);
  });

  it('a key limited to an alias keeps access to the models the alias pointed at, and to nothing else', () => {
    const db = before();
    db.prepare('INSERT INTO aliases (name, targets) VALUES (?, ?)').run('free', JSON.stringify(['pc/gemma', 'openrouter/llama:free']));
    db.prepare('INSERT INTO aliases (name, targets) VALUES (?, ?)').run('smart', JSON.stringify(['cloud/big']));
    addKey(db, 'only-alias', ['free']);
    addKey(db, 'mixed', ['home/*', 'smart', 'free', 'pc/gemma']);
    addKey(db, 'plain', ['cloud/other']);
    migrate(db);
    assert.deepEqual(allowedOf(db, 'only-alias'), ['pc/gemma', 'openrouter/llama:free']);
    assert.deepEqual(allowedOf(db, 'mixed'), ['home/*', 'cloud/big', 'pc/gemma', 'openrouter/llama:free'], 'duplicates are folded');
    assert.deepEqual(allowedOf(db, 'plain'), ['cloud/other']);
  });

  it('an alias that cannot be read grants nothing, and the migration still completes', () => {
    const db = before();
    db.prepare('INSERT INTO aliases (name, targets) VALUES (?, ?)').run('broken', 'not json');
    addKey(db, 'k', ['broken', 'home/*']);
    migrate(db);
    assert.equal(schemaVersion(db), LATEST_SCHEMA_VERSION);
    assert.deepEqual(allowedOf(db, 'k'), ['broken', 'home/*'], 'the name stays; it matches no model id, so it opens nothing');
  });
});

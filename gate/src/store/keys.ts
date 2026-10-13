import { generateApiKey, keyPrefix, randomId, sha256Hex } from '../crypto.js';
import type { Db } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import type { ApiKeyRecord } from '../types.js';
import { finiteNumber, parseJson } from '../util.js';

interface Row {
  id: string;
  name: string;
  prefix: string;
  hash: string;
  default_priority: number;
  min_priority: number;
  max_priority: number;
  local_only: number;
  allowed_models: string | null;
  rpm: number | null;
  rpd: number | null;
  tokens_per_day: number | null;
  tokens_per_month: number | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const toRecord = (r: Row): ApiKeyRecord => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  hash: r.hash,
  defaultPriority: r.default_priority,
  minPriority: r.min_priority,
  maxPriority: r.max_priority,
  localOnly: r.local_only === 1,
  allowedModels: r.allowed_models === null ? null : parseJson<string[]>(r.allowed_models, []),
  rpm: r.rpm,
  rpd: r.rpd,
  tokensPerDay: r.tokens_per_day,
  tokensPerMonth: r.tokens_per_month,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
});

export interface KeyInput {
  name: string;
  /** Use this exact key (migrating a key clients already hold). Otherwise one is generated. */
  key?: string;
  defaultPriority?: number;
  minPriority?: number;
  maxPriority?: number;
  localOnly?: boolean;
  allowedModels?: string[] | null;
  rpm?: number | null;
  rpd?: number | null;
  tokensPerDay?: number | null;
  tokensPerMonth?: number | null;
}

export type KeyPatch = Partial<Omit<KeyInput, 'key'>>;

function limit(v: unknown, name: string): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const n = finiteNumber(v);
  if (n === undefined || !Number.isInteger(n) || n < 1) throw badRequest('invalid_limit', `${name} must be a positive integer or null (no limit)`, name);
  return n;
}

function priorities(min: number, def: number, max: number): void {
  for (const [n, v] of [['min_priority', min], ['default_priority', def], ['max_priority', max]] as const) {
    if (!Number.isInteger(v) || v < 1 || v > 5) throw badRequest('invalid_priority', `${n} must be an integer from 1 to 5`, n);
  }
  if (!(min <= def && def <= max)) throw badRequest('invalid_priority', 'priorities must satisfy min_priority <= default_priority <= max_priority');
}

function allowList(v: unknown): string[] | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x || x.length > 250)) {
    throw badRequest('invalid_allowed_models', 'allowed_models must be an array of model ids, alias names or "provider/*", or null for everything', 'allowed_models');
  }
  return [...new Set(v as string[])];
}

const TOUCH_EVERY_MS = 60_000;

export class KeyStore {
  private readonly touched = new Map<string, number>();

  constructor(private readonly db: Db) {}

  list(): ApiKeyRecord[] {
    return (this.db.prepare('SELECT * FROM api_keys ORDER BY created_at, name').all() as Row[]).map(toRecord);
  }

  get(id: string): ApiKeyRecord | undefined {
    const r = this.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  require(idOrName: string): ApiKeyRecord {
    const r = this.db.prepare('SELECT * FROM api_keys WHERE id = ? OR name = ?').get(idOrName, idOrName) as Row | undefined;
    if (!r) throw notFound('key_not_found', `No API key "${idOrName}"`);
    return toRecord(r);
  }

  /** The active key that this secret belongs to. Only the hash is stored, so this is a lookup by hash. */
  authenticate(secret: string): ApiKeyRecord | undefined {
    const r = this.db.prepare('SELECT * FROM api_keys WHERE hash = ? AND revoked_at IS NULL').get(sha256Hex(secret)) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  create(input: KeyInput): { record: ApiKeyRecord; key: string } {
    if (typeof input.name !== 'string' || !/^[\w .@-]{1,64}$/.test(input.name.trim())) {
      throw badRequest('invalid_key_name', 'name must be 1-64 characters (letters, digits, space, . _ @ -)', 'name');
    }
    const name = input.name.trim();
    if (this.db.prepare('SELECT 1 FROM api_keys WHERE name = ?').get(name)) throw conflict('key_exists', `An API key named "${name}" already exists`);

    let key: string;
    let prefix: string;
    let hash: string;
    if (input.key !== undefined) {
      if (typeof input.key !== 'string' || input.key.length < 16 || input.key.length > 300 || /\s/.test(input.key)) {
        throw badRequest('invalid_key', 'a supplied key must be 16-300 characters without whitespace', 'key');
      }
      key = input.key;
      prefix = keyPrefix(key);
      hash = sha256Hex(key);
      if (this.db.prepare('SELECT 1 FROM api_keys WHERE hash = ?').get(hash)) throw conflict('key_exists', 'That key is already registered');
    } else {
      ({ key, prefix, hash } = generateApiKey());
    }

    const min = input.minPriority ?? 1;
    const max = input.maxPriority ?? 5;
    const def = input.defaultPriority ?? Math.min(Math.max(3, min), max);
    priorities(min, def, max);
    const id = randomId('key');
    this.db
      .prepare(
        `INSERT INTO api_keys (id, name, prefix, hash, default_priority, min_priority, max_priority, local_only, allowed_models,
                               rpm, rpd, tokens_per_day, tokens_per_month)
         VALUES (@id, @name, @prefix, @hash, @def, @min, @max, @local_only, @allowed, @rpm, @rpd, @tpd, @tpm)`,
      )
      .run({
        id,
        name,
        prefix,
        hash,
        def,
        min,
        max,
        local_only: input.localOnly ? 1 : 0,
        allowed: allowList(input.allowedModels) ? JSON.stringify(allowList(input.allowedModels)) : null,
        rpm: limit(input.rpm, 'rpm') ?? null,
        rpd: limit(input.rpd, 'rpd') ?? null,
        tpd: limit(input.tokensPerDay, 'tokens_per_day') ?? null,
        tpm: limit(input.tokensPerMonth, 'tokens_per_month') ?? null,
      });
    return { record: this.get(id)!, key };
  }

  update(idOrName: string, patch: KeyPatch): ApiKeyRecord {
    const current = this.require(idOrName);
    const sets: string[] = [];
    const params: Record<string, unknown> = { id: current.id };
    const set = (col: string, v: unknown) => {
      sets.push(`${col} = @${col}`);
      params[col] = v;
    };
    if (patch.name !== undefined) {
      if (typeof patch.name !== 'string' || !/^[\w .@-]{1,64}$/.test(patch.name.trim())) throw badRequest('invalid_key_name', 'name must be 1-64 characters', 'name');
      const taken = this.db.prepare('SELECT id FROM api_keys WHERE name = ? AND id <> ?').get(patch.name.trim(), current.id);
      if (taken) throw conflict('key_exists', `An API key named "${patch.name.trim()}" already exists`);
      set('name', patch.name.trim());
    }
    if (patch.minPriority !== undefined || patch.defaultPriority !== undefined || patch.maxPriority !== undefined) {
      const min = patch.minPriority ?? current.minPriority;
      const max = patch.maxPriority ?? current.maxPriority;
      const def = patch.defaultPriority ?? Math.min(Math.max(current.defaultPriority, min), max);
      priorities(min, def, max);
      set('min_priority', min);
      set('default_priority', def);
      set('max_priority', max);
    }
    if (patch.localOnly !== undefined) set('local_only', patch.localOnly ? 1 : 0);
    if (patch.allowedModels !== undefined) {
      const list = allowList(patch.allowedModels);
      set('allowed_models', list ? JSON.stringify(list) : null);
    }
    for (const [field, col, label] of [
      ['rpm', 'rpm', 'rpm'],
      ['rpd', 'rpd', 'rpd'],
      ['tokensPerDay', 'tokens_per_day', 'tokens_per_day'],
      ['tokensPerMonth', 'tokens_per_month', 'tokens_per_month'],
    ] as const) {
      const v = limit(patch[field], label);
      if (v !== undefined) set(col, v);
    }
    if (sets.length) this.db.prepare(`UPDATE api_keys SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return this.get(current.id)!;
  }

  revoke(idOrName: string): ApiKeyRecord {
    const k = this.require(idOrName);
    this.db.prepare(`UPDATE api_keys SET revoked_at = COALESCE(revoked_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id = ?`).run(k.id);
    return this.get(k.id)!;
  }

  delete(idOrName: string): void {
    const k = this.require(idOrName);
    this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(k.id);
  }

  /** Remembers when a key was last used, at most once a minute so a busy client does not turn every call into a write. */
  touch(id: string, now = Date.now()): void {
    const last = this.touched.get(id) ?? 0;
    if (now - last < TOUCH_EVERY_MS) return;
    this.touched.set(id, now);
    this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(new Date(now).toISOString(), id);
  }
}

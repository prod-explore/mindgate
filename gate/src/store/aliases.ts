import type { Db } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import type { AliasRecord } from '../types.js';
import { parseJson, stringArray } from '../util.js';
import type { ModelStore } from './models.js';

/** Alias names cannot contain "/", which is what tells them apart from provider/model ids. */
export const ALIAS_NAME = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/;
export const MAX_TARGETS = 8;

interface Row {
  name: string;
  description: string;
  tags: string;
  targets: string;
  enabled: number;
}

const toRecord = (r: Row): AliasRecord => ({
  name: r.name,
  description: r.description,
  tags: parseJson<string[]>(r.tags, []),
  targets: parseJson<string[]>(r.targets, []),
  enabled: r.enabled === 1,
});

export interface AliasInput {
  name: string;
  description?: string;
  tags?: string[];
  targets: string[];
  enabled?: boolean;
}

export class AliasStore {
  constructor(
    private readonly db: Db,
    private readonly models: ModelStore,
  ) {}

  list(): AliasRecord[] {
    return (this.db.prepare('SELECT * FROM aliases ORDER BY name').all() as Row[]).map(toRecord);
  }

  get(name: string): AliasRecord | undefined {
    const r = this.db.prepare('SELECT * FROM aliases WHERE name = ?').get(name) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  private validateTargets(targets: unknown): string[] {
    if (!Array.isArray(targets) || targets.length === 0 || targets.some(t => typeof t !== 'string')) {
      throw badRequest('invalid_targets', 'targets must be a non-empty array of model ids', 'targets');
    }
    if (targets.length > MAX_TARGETS) throw badRequest('invalid_targets', `an alias can chain at most ${MAX_TARGETS} models`, 'targets');
    const unique = [...new Set(targets as string[])];
    for (const t of unique) {
      if (!this.models.getRecord(t)) throw badRequest('unknown_target', `"${t}" is not a model known to this hub (model ids look like provider/model)`, 'targets');
    }
    return unique;
  }

  create(input: AliasInput): AliasRecord {
    if (typeof input.name !== 'string' || !ALIAS_NAME.test(input.name)) {
      throw badRequest('invalid_alias_name', 'alias names are 1-64 characters (letters, digits, . _ : + -) and cannot contain "/"', 'name');
    }
    if (this.get(input.name)) throw conflict('alias_exists', `An alias "${input.name}" already exists`);
    const targets = this.validateTargets(input.targets);
    this.db
      .prepare(`INSERT INTO aliases (name, description, tags, targets, enabled) VALUES (?, ?, ?, ?, ?)`)
      .run(input.name, (input.description ?? '').slice(0, 400), JSON.stringify(stringArray(input.tags) ?? []), JSON.stringify(targets), input.enabled === false ? 0 : 1);
    return this.get(input.name)!;
  }

  update(name: string, patch: Partial<Omit<AliasInput, 'name'>>): AliasRecord {
    const current = this.get(name);
    if (!current) throw notFound('alias_not_found', `No alias "${name}"`);
    const next = {
      description: patch.description !== undefined ? String(patch.description).slice(0, 400) : current.description,
      tags: patch.tags !== undefined ? (stringArray(patch.tags) ?? []) : current.tags,
      targets: patch.targets !== undefined ? this.validateTargets(patch.targets) : current.targets,
      enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
    };
    this.db
      .prepare(`UPDATE aliases SET description = ?, tags = ?, targets = ?, enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE name = ?`)
      .run(next.description, JSON.stringify(next.tags), JSON.stringify(next.targets), next.enabled ? 1 : 0, name);
    return this.get(name)!;
  }

  delete(name: string): void {
    if (!this.get(name)) throw notFound('alias_not_found', `No alias "${name}"`);
    this.db.prepare('DELETE FROM aliases WHERE name = ?').run(name);
  }
}

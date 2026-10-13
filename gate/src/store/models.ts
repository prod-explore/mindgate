import type { Db } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import {
  SUPPORTS,
  isLocality,
  isModelKind,
  type ModelFields,
  type ModelOverrides,
  type ModelRecord,
  type ProviderRecord,
  type ResolvedModel,
  type Support,
} from '../types.js';
import { finiteNumber, guessKind, isPlainObject, parseJson, stringArray } from '../util.js';
import type { ProviderStore } from './providers.js';

export interface DiscoveredModel {
  upstreamId: string;
  fields: ModelFields;
}

export interface ModelPatch {
  name?: string | null;
  description?: string | null;
  kind?: string | null;
  tags?: string[] | null;
  contextLength?: number | null;
  maxOutputTokens?: number | null;
  supports?: string[] | null;
  locality?: string | null;
  enabled?: boolean;
}

export const canonicalId = (providerId: string, upstreamId: string): string => `${providerId}/${upstreamId}`;

export function validUpstreamId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\s\u0000-\u001f]/.test(id);
}

/** Reads what an upstream or the owner says about a model, dropping anything malformed. */
export function sanitizeFields(raw: unknown): ModelFields {
  if (!isPlainObject(raw)) return {};
  const f: ModelFields = {};
  if (typeof raw['name'] === 'string' && raw['name'].trim()) f.name = raw['name'].trim().slice(0, 120);
  if (typeof raw['description'] === 'string' && raw['description'].trim()) f.description = raw['description'].trim().slice(0, 400);
  if (isModelKind(raw['kind'])) f.kind = raw['kind'];
  const tags = stringArray(raw['tags']);
  if (tags) f.tags = tags;
  const ctx = finiteNumber(raw['contextLength']);
  if (ctx !== undefined && ctx > 0) f.contextLength = Math.trunc(ctx);
  const out = finiteNumber(raw['maxOutputTokens']);
  if (out !== undefined && out > 0) f.maxOutputTokens = Math.trunc(out);
  if (Array.isArray(raw['supports'])) f.supports = raw['supports'].filter((s): s is Support => (SUPPORTS as readonly string[]).includes(s as string));
  if (isLocality(raw['locality'])) f.locality = raw['locality'];
  return f;
}

function toOverrides(raw: unknown): ModelOverrides {
  const o: ModelOverrides = sanitizeFields(raw);
  if (isPlainObject(raw) && typeof raw['enabled'] === 'boolean') o.enabled = raw['enabled'];
  return o;
}

interface Row {
  id: string;
  provider_id: string;
  upstream_id: string;
  source: 'synced' | 'manual';
  reported: string;
  overrides: string;
  present: number;
}

const toRecord = (r: Row): ModelRecord => ({
  id: r.id,
  providerId: r.provider_id,
  upstreamId: r.upstream_id,
  source: r.source,
  reported: sanitizeFields(parseJson(r.reported, {})),
  overrides: toOverrides(parseJson(r.overrides, {})),
  present: r.present === 1,
});

/**
 * Reported fields first, the owner's overrides on top.
 *
 * Locality is the one field with a safety rule: the owner's override wins; otherwise a model whose provider says it
 * runs in the cloud stays in the cloud, and everything else inherits the provider's setting. A provider can only
 * *lower* a model to "cloud" by reporting it, never raise it to "local" — that takes the owner's say-so.
 */
export function resolveModel(rec: ModelRecord, provider: ProviderRecord): ResolvedModel {
  const rep = rec.reported;
  const ov = rec.overrides;
  const tags = ov.tags ?? rep.tags ?? [];
  return {
    id: rec.id,
    providerId: rec.providerId,
    upstreamId: rec.upstreamId,
    source: rec.source,
    name: ov.name ?? rep.name ?? rec.upstreamId,
    description: ov.description ?? rep.description ?? '',
    kind: ov.kind ?? rep.kind ?? guessKind(rec.upstreamId),
    tags: [...new Set(tags)],
    contextLength: ov.contextLength ?? rep.contextLength ?? null,
    maxOutputTokens: ov.maxOutputTokens ?? rep.maxOutputTokens ?? null,
    supports: ov.supports ?? rep.supports ?? null,
    locality: ov.locality ?? (rep.locality === 'cloud' ? 'cloud' : provider.locality),
    enabled: ov.enabled ?? true,
    present: rec.present,
  };
}

export class ModelStore {
  constructor(
    private readonly db: Db,
    private readonly providers: ProviderStore,
  ) {}

  getRecord(id: string): ModelRecord | undefined {
    const r = this.db.prepare('SELECT * FROM models WHERE id = ?').get(id) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  get(id: string): ResolvedModel | undefined {
    const rec = this.getRecord(id);
    if (!rec) return undefined;
    const provider = this.providers.get(rec.providerId);
    return provider ? resolveModel(rec, provider) : undefined;
  }

  require(id: string): ResolvedModel {
    const m = this.get(id);
    if (!m) throw notFound('model_not_found', `No model "${id}"`);
    return m;
  }

  records(providerId?: string): ModelRecord[] {
    const rows = providerId
      ? (this.db.prepare('SELECT * FROM models WHERE provider_id = ? ORDER BY upstream_id').all(providerId) as Row[])
      : (this.db.prepare('SELECT * FROM models ORDER BY provider_id, upstream_id').all() as Row[]);
    return rows.map(toRecord);
  }

  list(providerId?: string): ResolvedModel[] {
    const providers = new Map(this.providers.list().map(p => [p.id, p]));
    const out: ResolvedModel[] = [];
    for (const rec of this.records(providerId)) {
      const p = providers.get(rec.providerId);
      if (p) out.push(resolveModel(rec, p));
    }
    return out;
  }

  /**
   * Applies a fresh model list from the upstream: new models appear, known ones get their reported fields refreshed,
   * models the upstream no longer lists are marked absent (kept, so the owner's overrides survive a flaky listing).
   */
  syncProvider(providerId: string, discovered: DiscoveredModel[], opts: { autoEnable: boolean }): { added: number; updated: number; absent: number } {
    const provider = this.providers.require(providerId);
    let added = 0;
    let updated = 0;
    let absent = 0;
    const seen = new Set<string>();
    const find = this.db.prepare('SELECT * FROM models WHERE id = ?');
    const insert = this.db.prepare(
      `INSERT INTO models (id, provider_id, upstream_id, source, reported, overrides, present) VALUES (?, ?, ?, 'synced', ?, ?, 1)`,
    );
    const refresh = this.db.prepare(
      `UPDATE models SET reported = ?, present = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    );
    this.db.transaction(() => {
      for (const d of discovered) {
        if (!validUpstreamId(d.upstreamId)) continue;
        const id = canonicalId(provider.id, d.upstreamId);
        if (seen.has(id)) continue;
        seen.add(id);
        const existing = find.get(id) as Row | undefined;
        if (existing) {
          refresh.run(JSON.stringify(d.fields), id);
          updated++;
        } else {
          insert.run(id, provider.id, d.upstreamId, JSON.stringify(d.fields), JSON.stringify(opts.autoEnable ? {} : { enabled: false }));
          added++;
        }
      }
      const rows = this.db.prepare(`SELECT id FROM models WHERE provider_id = ? AND source = 'synced' AND present = 1`).all(provider.id) as { id: string }[];
      for (const { id } of rows) {
        if (!seen.has(id)) {
          this.db.prepare(`UPDATE models SET present = 0 WHERE id = ?`).run(id);
          absent++;
        }
      }
    })();
    return { added, updated, absent };
  }

  addManual(providerId: string, upstreamId: unknown, raw: unknown): ResolvedModel {
    const provider = this.providers.require(providerId);
    if (!validUpstreamId(upstreamId)) throw badRequest('invalid_model_id', 'model id must be 1-200 characters without whitespace', 'id');
    const id = canonicalId(provider.id, upstreamId);
    if (this.getRecord(id)) throw conflict('model_exists', `Model "${id}" already exists`);
    this.db
      .prepare(`INSERT INTO models (id, provider_id, upstream_id, source, reported, overrides, present) VALUES (?, ?, ?, 'manual', '{}', ?, 1)`)
      .run(id, provider.id, upstreamId, JSON.stringify(sanitizeFields(raw)));
    return this.require(id);
  }

  /** Changes the owner's overrides. `null` removes an override and lets the reported value show through again. */
  patch(id: string, patch: ModelPatch): ResolvedModel {
    const rec = this.getRecord(id);
    if (!rec) throw notFound('model_not_found', `No model "${id}"`);
    const next: Record<string, unknown> = { ...rec.overrides };
    const apply = (key: keyof ModelPatch, value: unknown, valid: boolean, message: string) => {
      if (value === null) delete next[key];
      else if (!valid) throw badRequest('invalid_model_field', message, key);
      else next[key] = value;
    };
    if (patch.name !== undefined) apply('name', typeof patch.name === 'string' ? patch.name.trim().slice(0, 120) : patch.name, patch.name === null || (typeof patch.name === 'string' && patch.name.trim() !== ''), 'name must be a non-empty string');
    if (patch.description !== undefined) apply('description', typeof patch.description === 'string' ? patch.description.trim().slice(0, 400) : patch.description, patch.description === null || typeof patch.description === 'string', 'description must be a string');
    if (patch.kind !== undefined) apply('kind', patch.kind, patch.kind === null || isModelKind(patch.kind), 'kind must be chat, embedding, image, tts or stt');
    if (patch.tags !== undefined) apply('tags', patch.tags === null ? null : stringArray(patch.tags), patch.tags === null || Array.isArray(patch.tags), 'tags must be an array of strings');
    for (const key of ['contextLength', 'maxOutputTokens'] as const) {
      const v = patch[key];
      if (v === undefined) continue;
      if (v === null) {
        delete next[key];
        continue;
      }
      const n = finiteNumber(v);
      if (n === undefined || n <= 0) throw badRequest('invalid_model_field', `${key} must be a positive number`, key);
      next[key] = Math.trunc(n);
    }
    if (patch.supports !== undefined) {
      const ok = patch.supports === null || (Array.isArray(patch.supports) && patch.supports.every(s => (SUPPORTS as readonly string[]).includes(s)));
      apply('supports', patch.supports, ok, `supports may contain: ${SUPPORTS.join(', ')}`);
    }
    if (patch.locality !== undefined) apply('locality', patch.locality, patch.locality === null || isLocality(patch.locality), 'locality must be "local" or "cloud"');
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') throw badRequest('invalid_model_field', 'enabled must be a boolean', 'enabled');
      next['enabled'] = patch.enabled;
    }
    this.db.prepare(`UPDATE models SET overrides = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(JSON.stringify(next), id);
    return this.require(id);
  }

  /** Deletes a manual model. A synced one would only come back with the next sync, so it is disabled instead. */
  delete(id: string): { deleted: boolean } {
    const rec = this.getRecord(id);
    if (!rec) throw notFound('model_not_found', `No model "${id}"`);
    if (rec.source === 'synced') {
      this.patch(id, { enabled: false });
      return { deleted: false };
    }
    this.db.prepare('DELETE FROM models WHERE id = ?').run(id);
    return { deleted: true };
  }
}

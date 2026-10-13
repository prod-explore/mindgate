import { SecretBox, SecretError } from '../crypto.js';
import type { Db } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import {
  AUTH_SCHEMES,
  PROVIDER_TYPES,
  type AuthScheme,
  type Locality,
  type NodeConfig,
  type ProviderOptions,
  type ProviderRecord,
  type ProviderType,
  isLocality,
} from '../types.js';
import { finiteNumber, isPlainObject, parseJson } from '../util.js';

export const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const MAC = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;

/** Headers the hub sets itself; letting the owner override them would only produce confusing failures. */
const RESERVED_HEADERS = new Set(['content-length', 'content-type', 'host', 'connection', 'transfer-encoding', 'authorization', 'x-api-key']);

export interface ProviderInput {
  id: string;
  name?: string;
  type: ProviderType;
  baseUrl: string;
  locality?: Locality;
  authScheme?: AuthScheme;
  authHeader?: string | null;
  /** string = set, null = remove, undefined = leave as it is. */
  apiKey?: string | null;
  extraHeaders?: Record<string, string>;
  options?: ProviderOptions;
  maxConcurrency?: number | null;
  node?: Partial<NodeConfig> | null;
  enabled?: boolean;
  position?: number;
}

export type ProviderPatch = Partial<Omit<ProviderInput, 'id'>>;

interface Row {
  id: string;
  name: string;
  type: ProviderType;
  base_url: string;
  locality: Locality;
  auth_scheme: AuthScheme;
  auth_header: string | null;
  secret_enc: string | null;
  secret_hint: string | null;
  extra_headers: string;
  options: string;
  max_concurrency: number | null;
  node: string | null;
  enabled: number;
  position: number;
  models_synced_at: string | null;
  last_sync_error: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(r: Row): ProviderRecord {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    baseUrl: r.base_url,
    locality: r.locality,
    authScheme: r.auth_scheme,
    authHeader: r.auth_header,
    hasSecret: r.secret_enc !== null,
    secretHint: r.secret_hint,
    extraHeaders: parseJson(r.extra_headers, {}),
    options: parseJson(r.options, {}),
    maxConcurrency: r.max_concurrency,
    node: r.node ? parseJson<NodeConfig | null>(r.node, null) : null,
    enabled: r.enabled === 1,
    position: r.position,
    modelsSyncedAt: r.models_synced_at,
    lastSyncError: r.last_sync_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function normalizeBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw badRequest('invalid_base_url', 'base_url is required', 'base_url');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw badRequest('invalid_base_url', `"${raw}" is not a valid URL`, 'base_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw badRequest('invalid_base_url', 'base_url must be http or https', 'base_url');
  if (url.username || url.password) throw badRequest('invalid_base_url', 'put credentials in api_key, not in the URL', 'base_url');
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

function intIn(v: unknown, name: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = finiteNumber(v);
  if (n === undefined || !Number.isInteger(n) || n < min || n > max) throw badRequest('invalid_option', `${name} must be an integer between ${min} and ${max}`, name);
  return n;
}

function safePath(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !v.startsWith('/') || v.includes('..') || v.length > 200) throw badRequest('invalid_option', `${name} must be a path starting with /`, name);
  return v;
}

export function normalizeOptions(raw: unknown): ProviderOptions {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) throw badRequest('invalid_option', 'options must be an object', 'options');
  const o: ProviderOptions = {};
  const fb = intIn(raw['firstByteTimeoutMs'], 'firstByteTimeoutMs', 1000, 3_600_000);
  if (fb !== undefined) o.firstByteTimeoutMs = fb;
  const idle = intIn(raw['idleTimeoutMs'], 'idleTimeoutMs', 1000, 3_600_000);
  if (idle !== undefined) o.idleTimeoutMs = idle;
  if (typeof raw['streamUsage'] === 'boolean') o.streamUsage = raw['streamUsage'];
  const dm = intIn(raw['defaultMaxTokens'], 'defaultMaxTokens', 1, 1_000_000);
  if (dm !== undefined) o.defaultMaxTokens = dm;
  for (const k of ['modelsPath', 'chatPath', 'embeddingsPath'] as const) {
    const p = safePath(raw[k], k);
    if (p) o[k] = p;
  }
  if (typeof raw['anthropicVersion'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw['anthropicVersion'])) o.anthropicVersion = raw['anthropicVersion'];
  if (typeof raw['autoEnableModels'] === 'boolean') o.autoEnableModels = raw['autoEnableModels'];
  return o;
}

export function normalizeNode(raw: unknown): NodeConfig | null {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) throw badRequest('invalid_node', 'node must be an object', 'node');
  const mac = raw['mac'];
  if (typeof mac !== 'string' || !MAC.test(mac)) throw badRequest('invalid_node', 'node.mac must look like AA:BB:CC:DD:EE:FF', 'node.mac');
  const broadcast = raw['broadcast'];
  if (typeof broadcast !== 'string' || !/^[0-9a-zA-Z.:-]{3,253}$/.test(broadcast)) throw badRequest('invalid_node', 'node.broadcast must be an IP address or host name', 'node.broadcast');
  const n: NodeConfig = {
    mac: mac.toUpperCase().replace(/-/g, ':'),
    broadcast,
    port: intIn(raw['port'], 'node.port', 1, 65535) ?? 9,
    bootTimeoutMs: intIn(raw['bootTimeoutMs'], 'node.bootTimeoutMs', 1000, 3_600_000) ?? 120_000,
    pollIntervalMs: intIn(raw['pollIntervalMs'], 'node.pollIntervalMs', 100, 60_000) ?? 2000,
    minWakePriority: intIn(raw['minWakePriority'], 'node.minWakePriority', 1, 5) ?? 3,
  };
  if (raw['healthUrl'] !== undefined && raw['healthUrl'] !== null && raw['healthUrl'] !== '') n.healthUrl = normalizeUrlLoose(raw['healthUrl'], 'node.healthUrl');
  const idle = intIn(raw['idleShutdownMinutes'], 'node.idleShutdownMinutes', 1, 10_080);
  if (idle !== undefined) {
    n.idleShutdownMinutes = idle;
    if (raw['shutdownUrl'] === undefined || raw['shutdownUrl'] === null || raw['shutdownUrl'] === '') throw badRequest('invalid_node', 'node.shutdownUrl is required with idleShutdownMinutes', 'node.shutdownUrl');
  }
  if (raw['shutdownUrl'] !== undefined && raw['shutdownUrl'] !== null && raw['shutdownUrl'] !== '') n.shutdownUrl = normalizeUrlLoose(raw['shutdownUrl'], 'node.shutdownUrl');
  return n;
}

function normalizeUrlLoose(v: unknown, name: string): string {
  try {
    const u = new URL(String(v));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
    return u.toString();
  } catch {
    throw badRequest('invalid_url', `${name} must be an http(s) URL`, name);
  }
}

function normalizeHeaders(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) throw badRequest('invalid_headers', 'extra_headers must be an object of strings', 'extra_headers');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!HEADER_NAME.test(k) || RESERVED_HEADERS.has(k.toLowerCase())) throw badRequest('invalid_headers', `header "${k}" is not allowed`, 'extra_headers');
    if (typeof v !== 'string' || v.length > 500 || /[\r\n]/.test(v)) throw badRequest('invalid_headers', `header "${k}" must be a short single-line string`, 'extra_headers');
    out[k] = v;
  }
  return out;
}

export type ProviderListener = (id: string) => void;

export class ProviderStore {
  private readonly secrets = new Map<string, { sealed: string; value: string }>();
  private readonly listeners = new Set<ProviderListener>();

  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
  ) {}

  /** Called after a provider is created, changed or deleted (the router and the node monitor drop their caches). */
  onChange(fn: ProviderListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(id: string): void {
    this.secrets.delete(id);
    for (const fn of this.listeners) fn(id);
  }

  list(): ProviderRecord[] {
    return (this.db.prepare('SELECT * FROM providers ORDER BY position, id').all() as Row[]).map(toRecord);
  }

  get(id: string): ProviderRecord | undefined {
    const r = this.db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  require(id: string): ProviderRecord {
    const p = this.get(id);
    if (!p) throw notFound('provider_not_found', `No provider "${id}"`);
    return p;
  }

  create(input: ProviderInput): ProviderRecord {
    if (typeof input.id !== 'string' || !SLUG.test(input.id)) {
      throw badRequest('invalid_provider_id', 'id must be 1-32 characters: lowercase letters, digits and dashes', 'id');
    }
    if (this.get(input.id)) throw conflict('provider_exists', `A provider "${input.id}" already exists`);
    if (!PROVIDER_TYPES.includes(input.type)) throw badRequest('invalid_provider_type', `type must be one of ${PROVIDER_TYPES.join(', ')}`, 'type');
    const authScheme = input.authScheme ?? 'bearer';
    if (!AUTH_SCHEMES.includes(authScheme)) throw badRequest('invalid_auth_scheme', `auth_scheme must be one of ${AUTH_SCHEMES.join(', ')}`, 'auth_scheme');
    if (authScheme === 'header' && (!input.authHeader || !HEADER_NAME.test(input.authHeader))) {
      throw badRequest('invalid_auth_header', 'auth_header (a header name) is required with auth_scheme "header"', 'auth_header');
    }
    if (input.locality !== undefined && !isLocality(input.locality)) throw badRequest('invalid_locality', 'locality must be "local" or "cloud"', 'locality');
    const maxConcurrency = input.maxConcurrency ?? null;
    if (maxConcurrency !== null && (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 256)) {
      throw badRequest('invalid_option', 'max_concurrency must be an integer between 1 and 256 (or null)', 'max_concurrency');
    }
    const node = normalizeNode(input.node);
    const seal = this.sealKey(input.id, input.apiKey);
    const position = input.position ?? (this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM providers').get() as { n: number }).n;

    this.db
      .prepare(
        `INSERT INTO providers (id, name, type, base_url, locality, auth_scheme, auth_header, secret_enc, secret_hint,
                                extra_headers, options, max_concurrency, node, enabled, position)
         VALUES (@id, @name, @type, @base_url, @locality, @auth_scheme, @auth_header, @secret_enc, @secret_hint,
                 @extra_headers, @options, @max_concurrency, @node, @enabled, @position)`,
      )
      .run({
        id: input.id,
        name: (input.name ?? input.id).trim().slice(0, 80) || input.id,
        type: input.type,
        base_url: normalizeBaseUrl(input.baseUrl),
        locality: input.locality ?? 'cloud',
        auth_scheme: authScheme,
        auth_header: authScheme === 'header' ? input.authHeader : null,
        secret_enc: seal?.sealed ?? null,
        secret_hint: seal?.hint ?? null,
        extra_headers: JSON.stringify(normalizeHeaders(input.extraHeaders)),
        options: JSON.stringify(normalizeOptions(input.options)),
        max_concurrency: maxConcurrency,
        node: node ? JSON.stringify(node) : null,
        enabled: input.enabled === false ? 0 : 1,
        position,
      });
    this.emit(input.id);
    return this.require(input.id);
  }

  update(id: string, patch: ProviderPatch): ProviderRecord {
    const current = this.require(id);
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    const set = (col: string, value: unknown) => {
      sets.push(`${col} = @${col}`);
      params[col] = value;
    };

    if (patch.name !== undefined) set('name', String(patch.name).trim().slice(0, 80) || current.id);
    if (patch.type !== undefined) {
      if (!PROVIDER_TYPES.includes(patch.type)) throw badRequest('invalid_provider_type', `type must be one of ${PROVIDER_TYPES.join(', ')}`, 'type');
      set('type', patch.type);
    }
    if (patch.baseUrl !== undefined) set('base_url', normalizeBaseUrl(patch.baseUrl));
    if (patch.locality !== undefined) {
      if (!isLocality(patch.locality)) throw badRequest('invalid_locality', 'locality must be "local" or "cloud"', 'locality');
      set('locality', patch.locality);
    }
    const scheme = patch.authScheme ?? current.authScheme;
    if (patch.authScheme !== undefined) {
      if (!AUTH_SCHEMES.includes(patch.authScheme)) throw badRequest('invalid_auth_scheme', `auth_scheme must be one of ${AUTH_SCHEMES.join(', ')}`, 'auth_scheme');
      set('auth_scheme', patch.authScheme);
    }
    if (patch.authScheme !== undefined || patch.authHeader !== undefined) {
      const header = patch.authHeader !== undefined ? patch.authHeader : current.authHeader;
      if (scheme === 'header' && (!header || !HEADER_NAME.test(header))) {
        throw badRequest('invalid_auth_header', 'auth_header (a header name) is required with auth_scheme "header"', 'auth_header');
      }
      set('auth_header', scheme === 'header' ? header : null);
    }
    if (patch.apiKey !== undefined) {
      const seal = this.sealKey(id, patch.apiKey);
      set('secret_enc', seal?.sealed ?? null);
      set('secret_hint', seal?.hint ?? null);
    }
    if (patch.extraHeaders !== undefined) set('extra_headers', JSON.stringify(normalizeHeaders(patch.extraHeaders)));
    if (patch.options !== undefined) set('options', JSON.stringify(normalizeOptions(patch.options)));
    if (patch.maxConcurrency !== undefined) {
      const m = patch.maxConcurrency;
      if (m !== null && (!Number.isInteger(m) || m < 1 || m > 256)) throw badRequest('invalid_option', 'max_concurrency must be an integer between 1 and 256 (or null)', 'max_concurrency');
      set('max_concurrency', m);
    }
    if (patch.node !== undefined) {
      const n = normalizeNode(patch.node);
      set('node', n ? JSON.stringify(n) : null);
    }
    if (patch.enabled !== undefined) set('enabled', patch.enabled ? 1 : 0);
    if (patch.position !== undefined) set('position', Math.trunc(Number(patch.position)) || 0);

    if (sets.length) {
      this.db.prepare(`UPDATE providers SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = @id`).run(params);
      this.emit(id);
    }
    return this.require(id);
  }

  delete(id: string): void {
    this.require(id);
    this.db.prepare('DELETE FROM providers WHERE id = ?').run(id);
    this.emit(id);
  }

  setSyncResult(id: string, error: string | null): void {
    this.db
      .prepare(`UPDATE providers SET models_synced_at = CASE WHEN @error IS NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE models_synced_at END, last_sync_error = @error WHERE id = @id`)
      .run({ id, error: error ? error.slice(0, 500) : null });
  }

  /** The decrypted API key, or null when none is stored. Throws SecretError when it cannot be opened. */
  secret(id: string): string | null {
    const row = this.db.prepare('SELECT secret_enc FROM providers WHERE id = ?').get(id) as { secret_enc: string | null } | undefined;
    if (!row?.secret_enc) return null;
    const cached = this.secrets.get(id);
    if (cached && cached.sealed === row.secret_enc) return cached.value;
    const value = this.box.open(aad(id), row.secret_enc);
    this.secrets.set(id, { sealed: row.secret_enc, value });
    return value;
  }

  /** True when a stored key exists but cannot be decrypted with the current master key. */
  secretBroken(id: string): boolean {
    try {
      this.secret(id);
      return false;
    } catch (e) {
      return e instanceof SecretError;
    }
  }

  private sealKey(id: string, apiKey: string | null | undefined): { sealed: string; hint: string } | null {
    if (apiKey === undefined || apiKey === null || apiKey === '') return null;
    if (typeof apiKey !== 'string' || apiKey.length > 2000 || /[\r\n]/.test(apiKey)) throw badRequest('invalid_api_key', 'api_key must be a single-line string', 'api_key');
    return { sealed: this.box.seal(aad(id), apiKey), hint: apiKey.slice(-4) };
  }
}

const aad = (id: string): string => `mindgate:provider:${id}:secret`;

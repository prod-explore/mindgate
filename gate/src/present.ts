import type { Hub } from './context.js';
import type { ApiKeyRecord, ModelFields, ModelOverrides, ProviderRecord, ResolvedModel, ModelRecord } from './types.js';

/** How the admin API shows stored records: snake_case JSON, with the live state (node status, queue, usage) added. */

/** The admin API speaks snake_case JSON; the code inside uses camelCase. These two convert, shallowly. */
const snake = (k: string): string => k.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
const camel = (k: string): string => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

export function snakeKeys<T extends object>(o: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [snake(k), v]));
}

export function camelKeys(o: unknown): Record<string, unknown> {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return {};
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [camel(k), v]));
}

export function providerView(hub: Hub, p: ProviderRecord): Record<string, unknown> {
  const models = hub.models.list(p.id);
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    kind: p.node ? 'node' : p.type,
    base_url: p.baseUrl,
    locality: p.locality,
    auth_scheme: p.authScheme,
    auth_header: p.authHeader,
    has_api_key: p.hasSecret,
    api_key_hint: p.secretHint,
    api_key_unreadable: p.hasSecret && hub.providers.secretBroken(p.id),
    extra_headers: p.extraHeaders,
    options: snakeKeys(p.options),
    max_concurrency: p.maxConcurrency,
    node: p.node ? snakeKeys(p.node) : null,
    enabled: p.enabled,
    position: p.position,
    status: hub.nodes.status(p) ?? (p.enabled ? 'online' : 'disabled'),
    last_error: hub.nodes.lastError(p.id),
    queue: hub.registry.queueState(p.id),
    model_count: models.length,
    models_enabled: models.filter(m => m.enabled).length,
    models_synced_at: p.modelsSyncedAt,
    last_sync_error: p.lastSyncError,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

const fieldsView = (f: ModelFields | ModelOverrides): Record<string, unknown> => snakeKeys(f);

export function modelView(m: ResolvedModel, rec?: ModelRecord): Record<string, unknown> {
  return {
    id: m.id,
    provider: m.providerId,
    upstream_id: m.upstreamId,
    source: m.source,
    name: m.name,
    description: m.description,
    kind: m.kind,
    tags: m.tags,
    context_length: m.contextLength,
    max_output_tokens: m.maxOutputTokens,
    supports: m.supports,
    locality: m.locality,
    enabled: m.enabled,
    present: m.present,
    ...(rec ? { reported: fieldsView(rec.reported), overrides: fieldsView(rec.overrides) } : {}),
  };
}

export function keyView(hub: Hub, k: ApiKeyRecord): Record<string, unknown> {
  const snap = hub.limits.snapshot(k);
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    default_priority: k.defaultPriority,
    min_priority: k.minPriority,
    max_priority: k.maxPriority,
    local_only: k.localOnly,
    allowed_models: k.allowedModels,
    rpm: k.rpm,
    rpd: k.rpd,
    tokens_per_day: k.tokensPerDay,
    tokens_per_month: k.tokensPerMonth,
    created_at: k.createdAt,
    last_used_at: k.lastUsedAt,
    revoked_at: k.revokedAt,
    usage: { requests_today: snap.requests.today, tokens_today: snap.tokens.today.total, tokens_month: snap.tokens.month.total, resets_at: snap.resetsAt },
  };
}

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { adapterFor } from './adapters/index.js';
import { authenticateAdmin, type AuthThrottle } from './auth.js';
import type { Hub } from './context.js';
import { HubError, badRequest } from './errors.js';
import { withDeadline } from './upstream.js';
import { aliasView, camelKeys, keyView, modelView, providerView } from './present.js';
import { PRESETS } from './presets.js';
import type { ProviderInput, ProviderPatch } from './store/providers.js';
import { dayKey } from './time.js';
import type { AuthScheme, Locality, NodeConfig, ProviderOptions, ProviderType } from './types.js';
import { isPlainObject } from './util.js';
import type { ModelPatch } from './store/models.js';
import type { KeyInput, KeyPatch } from './store/keys.js';

type Body = Record<string, unknown>;

function body(req: FastifyRequest): Body {
  if (!isPlainObject(req.body)) throw badRequest('invalid_request', 'A JSON object body is required');
  return req.body;
}

const has = (b: Body, k: string): boolean => Object.prototype.hasOwnProperty.call(b, k);

function str(b: Body, k: string): string | undefined {
  if (!has(b, k) || b[k] === undefined) return undefined;
  if (typeof b[k] !== 'string') throw badRequest('invalid_request', `${k} must be a string`, k);
  return b[k] as string;
}

function bool(b: Body, k: string): boolean | undefined {
  if (!has(b, k) || b[k] === undefined) return undefined;
  if (typeof b[k] !== 'boolean') throw badRequest('invalid_request', `${k} must be true or false`, k);
  return b[k] as boolean;
}

/** `null` is meaningful in a PATCH (clear the value), so it is kept apart from "not sent". */
function numOrNull(b: Body, k: string): number | null | undefined {
  if (!has(b, k) || b[k] === undefined) return undefined;
  if (b[k] === null) return null;
  if (typeof b[k] !== 'number') throw badRequest('invalid_request', `${k} must be a number or null`, k);
  return b[k] as number;
}

function providerFields(b: Body): ProviderPatch {
  const p: ProviderPatch = {};
  const set = <K extends keyof ProviderPatch>(k: K, v: ProviderPatch[K] | undefined) => {
    if (v !== undefined) p[k] = v;
  };
  set('name', str(b, 'name'));
  set('type', str(b, 'type') as ProviderType | undefined);
  set('baseUrl', str(b, 'base_url'));
  set('locality', str(b, 'locality') as Locality | undefined);
  set('authScheme', str(b, 'auth_scheme') as AuthScheme | undefined);
  if (has(b, 'auth_header')) p.authHeader = b['auth_header'] === null ? null : str(b, 'auth_header')!;
  if (has(b, 'api_key')) {
    if (b['api_key'] !== null && typeof b['api_key'] !== 'string') throw badRequest('invalid_request', 'api_key must be a string or null', 'api_key');
    p.apiKey = b['api_key'] as string | null;
  }
  if (has(b, 'extra_headers')) p.extraHeaders = (b['extra_headers'] ?? {}) as Record<string, string>;
  if (has(b, 'options')) p.options = camelKeys(b['options']) as ProviderOptions;
  set('maxConcurrency', numOrNull(b, 'max_concurrency'));
  if (has(b, 'node')) p.node = b['node'] === null ? null : (camelKeys(b['node']) as Partial<NodeConfig>);
  set('enabled', bool(b, 'enabled'));
  set('position', numOrNull(b, 'position') as number | undefined);
  return p;
}

function modelPatch(b: Body): ModelPatch {
  const p: ModelPatch = {};
  for (const [api, field] of [
    ['name', 'name'],
    ['description', 'description'],
    ['kind', 'kind'],
    ['tags', 'tags'],
    ['context_length', 'contextLength'],
    ['max_output_tokens', 'maxOutputTokens'],
    ['supports', 'supports'],
    ['locality', 'locality'],
  ] as const) {
    if (has(b, api)) (p as Record<string, unknown>)[field] = b[api];
  }
  const enabled = bool(b, 'enabled');
  if (enabled !== undefined) p.enabled = enabled;
  return p;
}

function keyFields(b: Body): KeyPatch {
  const k: KeyPatch = {};
  const name = str(b, 'name');
  if (name !== undefined) k.name = name;
  for (const [api, field] of [
    ['default_priority', 'defaultPriority'],
    ['min_priority', 'minPriority'],
    ['max_priority', 'maxPriority'],
  ] as const) {
    const v = numOrNull(b, api);
    if (v !== undefined && v !== null) k[field] = v;
  }
  const lo = bool(b, 'local_only');
  if (lo !== undefined) k.localOnly = lo;
  if (has(b, 'allowed_models')) k.allowedModels = b['allowed_models'] as string[] | null;
  for (const [api, field] of [
    ['rpm', 'rpm'],
    ['rpd', 'rpd'],
    ['tokens_per_day', 'tokensPerDay'],
    ['tokens_per_month', 'tokensPerMonth'],
  ] as const) {
    const v = numOrNull(b, api);
    if (v !== undefined) k[field] = v;
  }
  return k;
}

export function registerAdmin(app: FastifyInstance, hub: Hub, throttle: AuthThrottle): void {
  app.register(
    async admin => {
      admin.addHook('onRequest', async (req, reply) => {
        authenticateAdmin(hub, throttle, req);
        reply.header('Cache-Control', 'no-store');
      });

      admin.get('/status', async () => ({
        version: '2.0.0',
        uptime_seconds: Math.floor(process.uptime()),
        providers: hub.providers.list().map(p => ({ id: p.id, status: hub.nodes.status(p) ?? (p.enabled ? 'online' : 'disabled'), queue: hub.registry.queueState(p.id) })),
        counts: {
          providers: hub.providers.list().length,
          models: hub.models.list().length,
          aliases: hub.aliases.list().length,
          keys: hub.keys.list().filter(k => !k.revokedAt).length,
        },
        time_zone: hub.config.usageTz,
      }));

      admin.get('/presets', async () => ({ data: PRESETS }));

      // ── providers ────────────────────────────────────────────────────────
      admin.get('/providers', async () => ({ data: hub.providers.list().map(p => providerView(hub, p)) }));

      admin.post('/providers', async (req, reply) => {
        const b = body(req);
        const id = str(b, 'id');
        if (!id) throw badRequest('invalid_request', 'id is required', 'id');
        const fields = providerFields(b);
        if (!fields.type || !fields.baseUrl) throw badRequest('invalid_request', 'type and base_url are required');
        const created = hub.providers.create({ id, ...fields, type: fields.type, baseUrl: fields.baseUrl } as ProviderInput);
        // best effort: a provider that is reachable gets its model list straight away
        let sync: unknown = null;
        if (created.enabled && !created.node && bool(b, 'sync') !== false) {
          try {
            sync = await hub.sync.syncOne(created.id);
          } catch (e) {
            sync = { error: e instanceof Error ? e.message : String(e) };
          }
        }
        return reply.code(201).send({ ...providerView(hub, hub.providers.require(created.id)), sync });
      });

      admin.get('/providers/:id', async req => providerView(hub, hub.providers.require((req.params as { id: string }).id)));

      admin.patch('/providers/:id', async req => {
        const { id } = req.params as { id: string };
        const updated = hub.providers.update(id, providerFields(body(req)));
        return providerView(hub, updated);
      });

      admin.delete('/providers/:id', async (req, reply) => {
        const { id } = req.params as { id: string };
        const ids = hub.aliases.list().filter(a => a.targets.some(t => t.startsWith(`${id}/`)));
        hub.providers.delete(id);
        return reply.send({ deleted: true, id, aliases_affected: ids.map(a => a.name) });
      });

      /** Connectivity check: asks the upstream for its model list without changing anything. */
      admin.post('/providers/:id/test', async req => {
        const provider = hub.providers.require((req.params as { id: string }).id);
        const started = Date.now();
        try {
          const found = await withDeadline(30_000, provider.id, signal => adapterFor(provider.type).listModels(hub.registry.runtime(provider), signal));
          return { ok: true, latency_ms: Date.now() - started, models: found.length, sample: found.slice(0, 5).map(m => m.upstreamId) };
        } catch (e) {
          return { ok: false, latency_ms: Date.now() - started, code: e instanceof HubError ? e.code : 'error', error: e instanceof Error ? e.message : String(e) };
        }
      });

      admin.post('/providers/:id/sync', async req => {
        const id = (req.params as { id: string }).id;
        return withDeadline(60_000, id, signal => hub.sync.syncOne(id, signal));
      });

      admin.post('/providers/:id/wake', async req => {
        const provider = hub.providers.require((req.params as { id: string }).id);
        if (!provider.node) throw badRequest('not_a_node', `"${provider.id}" has no node settings (Wake-on-LAN)`);
        await hub.nodes.wake(provider);
        return { status: hub.nodes.status(provider) };
      });

      // ── models ───────────────────────────────────────────────────────────
      admin.get('/models', async req => {
        const q = req.query as { provider?: string };
        const records = new Map(hub.models.records(q.provider).map(r => [r.id, r]));
        return { data: hub.models.list(q.provider).map(m => modelView(m, records.get(m.id))) };
      });

      admin.post('/models', async (req, reply) => {
        const b = body(req);
        const provider = str(b, 'provider');
        const id = str(b, 'id');
        if (!provider || !id) throw badRequest('invalid_request', 'provider and id are required');
        const created = hub.models.addManual(provider, id, camelKeys(b));
        return reply.code(201).send(modelView(created, hub.models.getRecord(created.id)));
      });

      admin.patch('/models/*', async req => {
        const id = (req.params as { '*': string })['*'];
        const m = hub.models.patch(id, modelPatch(body(req)));
        return modelView(m, hub.models.getRecord(m.id));
      });

      admin.delete('/models/*', async req => {
        const id = (req.params as { '*': string })['*'];
        return { id, ...hub.models.delete(id) };
      });

      // ── aliases ──────────────────────────────────────────────────────────
      admin.get('/aliases', async () => ({ data: hub.aliases.list().map(a => aliasView(a, hub)) }));

      admin.post('/aliases', async (req, reply) => {
        const b = body(req);
        const created = hub.aliases.create({
          name: str(b, 'name') ?? '',
          ...(has(b, 'description') ? { description: str(b, 'description')! } : {}),
          ...(has(b, 'tags') ? { tags: b['tags'] as string[] } : {}),
          targets: b['targets'] as string[],
          ...(has(b, 'enabled') ? { enabled: bool(b, 'enabled')! } : {}),
        });
        return reply.code(201).send(aliasView(created, hub));
      });

      admin.patch('/aliases/:name', async req => {
        const b = body(req);
        const updated = hub.aliases.update((req.params as { name: string }).name, {
          ...(has(b, 'description') ? { description: str(b, 'description')! } : {}),
          ...(has(b, 'tags') ? { tags: b['tags'] as string[] } : {}),
          ...(has(b, 'targets') ? { targets: b['targets'] as string[] } : {}),
          ...(has(b, 'enabled') ? { enabled: bool(b, 'enabled')! } : {}),
        });
        return aliasView(updated, hub);
      });

      admin.delete('/aliases/:name', async (req, reply) => {
        const { name } = req.params as { name: string };
        hub.aliases.delete(name);
        return reply.send({ deleted: true, name });
      });

      // ── client keys ──────────────────────────────────────────────────────
      admin.get('/keys', async () => ({ data: hub.keys.list().map(k => keyView(hub, k)) }));

      admin.post('/keys', async (req, reply) => {
        const b = body(req);
        const fields = keyFields(b) as KeyInput;
        const supplied = str(b, 'key');
        const { record, key } = hub.keys.create({ ...fields, name: fields.name ?? '', ...(supplied ? { key: supplied } : {}) });
        // the only time the full key is ever shown
        return reply.code(201).send({ ...keyView(hub, record), key });
      });

      admin.patch('/keys/:id', async req => keyView(hub, hub.keys.update((req.params as { id: string }).id, keyFields(body(req)))));

      admin.post('/keys/:id/revoke', async req => keyView(hub, hub.keys.revoke((req.params as { id: string }).id)));

      admin.delete('/keys/:id', async (req, reply) => {
        hub.keys.delete((req.params as { id: string }).id);
        return reply.send({ deleted: true });
      });

      // ── usage and log ────────────────────────────────────────────────────
      admin.get('/usage', async req => {
        const q = req.query as { from?: string; to?: string; key?: string; model?: string };
        const today = dayKey(hub.clock(), hub.config.usageTz);
        const from = q.from ?? dayKey(new Date(hub.clock().getTime() - 29 * 86_400_000), hub.config.usageTz);
        const to = q.to ?? today;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw badRequest('invalid_request', 'from and to must look like 2026-10-13');
        const keyId = q.key ? hub.keys.require(q.key).id : undefined;
        const rows = hub.usage.rows({ fromDay: from, toDay: to, ...(keyId ? { keyId } : {}), ...(q.model ? { modelId: q.model } : {}) });
        return {
          from,
          to,
          time_zone: hub.config.usageTz,
          data: rows.map(r => ({ day: r.day, key_id: r.keyId, model: r.modelId, requests: r.requests, errors: r.errors, input_tokens: r.inputTokens, output_tokens: r.outputTokens })),
        };
      });

      admin.get('/log', async req => {
        const q = req.query as { limit?: string; before?: string; key?: string; errors?: string };
        const limit = Math.min(500, Math.max(1, Number(q.limit ?? 100) || 100));
        const keyId = q.key ? hub.keys.require(q.key).id : undefined;
        const rows = hub.usage.recentLog({ limit, ...(q.before ? { beforeId: Number(q.before) } : {}), ...(keyId ? { keyId } : {}), errorsOnly: q.errors === '1' || q.errors === 'true' });
        return {
          data: rows.map(r => ({
            id: r.id,
            ts: r.ts,
            request_id: r.requestId,
            key: r.keyName,
            endpoint: r.endpoint,
            requested_model: r.requestedModel,
            model: r.modelId,
            provider: r.providerId,
            status: r.status,
            error_code: r.errorCode,
            stream: r.stream,
            priority: r.priority,
            local_only: r.localOnly,
            tag: r.tag,
            attempts: r.attempts,
            queue_ms: r.queueMs,
            ttfb_ms: r.ttfbMs,
            latency_ms: r.latencyMs,
            input_tokens: r.inputTokens,
            output_tokens: r.outputTokens,
            estimated: r.estimated,
          })),
        };
      });

      admin.setNotFoundHandler((req, reply) => {
        reply.code(404).send({ error: { message: `Unknown admin endpoint: ${req.method} ${req.url.split('?')[0]}`, type: 'invalid_request_error', code: 'unknown_endpoint' } });
      });
    },
    { prefix: '/admin/api' },
  );
}

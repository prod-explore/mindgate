import type { FastifyInstance } from 'fastify';
import { authenticateClient, type AuthThrottle } from './auth.js';
import { runRequest } from './chat.js';
import type { Hub } from './context.js';
import { notFound } from './errors.js';
import type { ListedModel } from './routing.js';
import { dayKey, monthStartKey } from './time.js';

const truthy = (v: string | undefined): boolean => v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());

/** A model as GET /v1/models shows it: the OpenAI fields, plus OpenRouter-style extras clients may ignore. */
export function modelEntry(hub: Hub, m: ListedModel): Record<string, unknown> {
  const e: Record<string, unknown> = {
    id: m.id,
    object: 'model',
    created: Math.floor(Date.parse(m.primary.provider.createdAt) / 1000) || 0,
    owned_by: m.providerId,
    name: m.name,
    description: m.description,
    kind: m.kind,
    tags: m.tags,
    locality: m.locality,
    status: hub.nodes.status(m.primary.provider) ?? 'online',
  };
  if (m.contextLength !== null) e['context_length'] = m.contextLength;
  // Capabilities are reported only when known: leaving the fields out means "unknown", not "no tools".
  if (m.supports) {
    e['supports'] = m.supports;
    e['supported_parameters'] = [
      'temperature',
      'top_p',
      'max_tokens',
      'stop',
      ...(m.supports.includes('tools') ? ['tools', 'tool_choice'] : []),
      ...(m.supports.includes('reasoning_effort') ? ['reasoning', 'reasoning_effort'] : []),
    ];
    e['architecture'] = { input_modalities: ['text', ...(m.supports.includes('vision') ? ['image'] : [])], output_modalities: ['text'] };
  }
  return e;
}

export function registerV1(app: FastifyInstance, hub: Hub, throttle: AuthThrottle): void {
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/v1/models', async (req, reply) => {
    const key = authenticateClient(hub, throttle, req);
    const localOnly = key.localOnly || truthy(req.headers['x-mindgate-local-only'] as string | undefined);
    const data = hub.router.list(key, { localOnly }).map(m => modelEntry(hub, m));
    return reply.send({ object: 'list', data });
  });

  app.get('/v1/models/*', async (req, reply) => {
    const key = authenticateClient(hub, throttle, req);
    const id = (req.params as { '*': string })['*'];
    const localOnly = key.localOnly || truthy(req.headers['x-mindgate-local-only'] as string | undefined);
    const found = hub.router.list(key, { localOnly }).find(m => m.id === id);
    if (!found) throw notFound('model_not_found', `The model "${id}" does not exist`);
    return reply.send(modelEntry(hub, found));
  });

  app.post('/v1/chat/completions', async (req, reply) => {
    const key = authenticateClient(hub, throttle, req);
    await runRequest({ hub, req, reply, key, endpoint: 'chat' });
    return reply;
  });

  app.post('/v1/embeddings', async (req, reply) => {
    const key = authenticateClient(hub, throttle, req);
    await runRequest({ hub, req, reply, key, endpoint: 'embeddings' });
    return reply;
  });

  /** What this key has used and what it may still use. */
  app.get('/v1/usage', async (req, reply) => {
    const key = authenticateClient(hub, throttle, req);
    const snap = hub.limits.snapshot(key);
    const now = hub.clock();
    const today = dayKey(now, hub.config.usageTz);
    const byModel = hub.usage.byModel(key.id, monthStartKey(now, hub.config.usageTz), today);
    return reply.send({
      object: 'usage',
      key: { id: key.id, name: key.name, prefix: key.prefix, local_only: key.localOnly },
      period: { day: snap.day, resets_at: snap.resetsAt, month_resets_at: snap.monthResetsAt, time_zone: hub.config.usageTz },
      requests: { today: snap.requests.today, per_day: snap.requests.perDay, last_minute: snap.requests.lastMinute, per_minute: snap.requests.perMinute },
      tokens: {
        today: { input: snap.tokens.today.input, output: snap.tokens.today.output, total: snap.tokens.today.total, limit: snap.tokens.perDay },
        month: { input: snap.tokens.month.input, output: snap.tokens.month.output, total: snap.tokens.month.total, limit: snap.tokens.perMonth },
      },
      by_model: byModel.map(r => ({ model: r.modelId, requests: r.requests, errors: r.errors, input_tokens: r.inputTokens, output_tokens: r.outputTokens })),
    });
  });
}

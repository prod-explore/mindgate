import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type HubConfig } from '../config.js';
import { createHub, silentLogger, type Hub, type HubOverrides } from '../context.js';
import { buildServer } from '../server.js';

export const MASTER = 'm'.repeat(8) + 'aB3dE5gH7jK9mN1pQ3rS5tU7vW9xY1zA';
export const ADMIN = 'adm-' + 'Zy9Xw7Vu5Ts3Rq1Po9Nm7Lk5Ji3Hg1Fe';

export type Json = Record<string, any>;

export interface Recorded {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Json | null;
  raw: string;
}

export interface Upstream {
  url: string;
  port: number;
  requests: Recorded[];
  close(): Promise<void>;
}

export type Handler = (req: Recorded, res: ServerResponse) => void | Promise<void>;

/** A throw-away HTTP server standing in for an upstream. */
export async function startUpstream(handler: Handler, port = 0): Promise<Upstream> {
  const requests: Recorded[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Json | null = null;
      try {
        body = raw ? (JSON.parse(raw) as Json) : null;
      } catch {
        /* not json */
      }
      const rec: Recorded = { method: req.method ?? 'GET', path: (req.url ?? '').split('?')[0]!, headers: req.headers, body, raw };
      requests.push(rec);
      Promise.resolve(handler(rec, res)).catch(err => {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(err));
      });
    });
  });
  await new Promise<void>(r => server.listen(port, '127.0.0.1', r));
  const p = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${p}`,
    port: p,
    requests,
    close: () =>
      new Promise<void>(r => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export const sendJson = (res: ServerResponse, status: number, json: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(json));
};

export type SseItem = Json | string | { comment: string } | { event: string; data: Json };

export function sendSse(res: ServerResponse, items: SseItem[], opts: { gapMs?: number } = {}): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  return (async () => {
    for (const it of items) {
      if (typeof it === 'string') res.write(`data: ${it}\n\n`);
      else if ('comment' in it && Object.keys(it).length === 1) res.write(`: ${it.comment}\n\n`);
      else if ('event' in it && 'data' in it && Object.keys(it).length === 2) res.write(`event: ${it.event}\ndata: ${JSON.stringify(it.data)}\n\n`);
      else res.write(`data: ${JSON.stringify(it)}\n\n`);
      if (opts.gapMs) await new Promise(r => setTimeout(r, opts.gapMs));
    }
    res.end();
  })();
}

// ─── OpenAI-style fake ───────────────────────────────────────────────────────

export const completion = (content: string | null, extra: Json = {}): Json => ({
  id: 'chatcmpl-fake',
  object: 'chat.completion',
  created: 1,
  model: 'fake-model',
  choices: [{ index: 0, message: { role: 'assistant', content, ...(extra['message'] ?? {}) }, finish_reason: extra['finish_reason'] ?? 'stop' }],
  usage: extra['usage'] ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

export const chunk = (delta: Json, finish: string | null = null): Json => ({
  id: 'chatcmpl-fake',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'fake-model',
  choices: [{ index: 0, delta, finish_reason: finish }],
});

export const usageChunk = (p = 10, c = 5): Json => ({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [], usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c } });

export const textStream = (words: string[], withUsage = true): SseItem[] => [
  chunk({ role: 'assistant', content: '' }),
  ...words.map(w => chunk({ content: w })),
  chunk({}, 'stop'),
  ...(withUsage ? [usageChunk()] : []),
  '[DONE]',
];

export interface OpenAIFakeOptions {
  /** Runs before everything else; returning true means the request was dealt with (a machine that is switched off, say). */
  intercept?: (req: Recorded, res: ServerResponse) => boolean;
  models?: Json[];
  chat?: (req: Recorded, res: ServerResponse) => void | Promise<void>;
}

export const lastUserText = (body: Json | null): string => {
  const msgs = (body?.['messages'] ?? []) as Json[];
  const last = [...msgs].reverse().find(m => m.role === 'user');
  return typeof last?.content === 'string' ? last.content : '';
};

/** Answers `echo: <last user message>`, streamed word by word when asked to stream. */
export const echoChat: NonNullable<OpenAIFakeOptions['chat']> = async (req, res) => {
  const text = `echo: ${lastUserText(req.body)}`;
  if (req.body?.['stream']) {
    const wantsUsage = req.body['stream_options']?.include_usage === true;
    await sendSse(res, textStream(text.split(/(?<= )/), wantsUsage));
  } else {
    sendJson(res, 200, completion(text));
  }
};

export function openaiUpstream(opts: OpenAIFakeOptions = {}, port = 0): Promise<Upstream> {
  return startUpstream(async (req, res) => {
    if (opts.intercept?.(req, res)) return;
    if (req.method === 'GET' && req.path === '/v1/models') {
      return sendJson(res, 200, { object: 'list', data: opts.models ?? [{ id: 'fake-model', object: 'model' }] });
    }
    if (req.method === 'POST' && req.path === '/v1/chat/completions') return (opts.chat ?? echoChat)(req, res);
    if (req.method === 'POST' && req.path === '/v1/embeddings') {
      return sendJson(res, 200, { object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }], model: req.body?.['model'], usage: { prompt_tokens: 3, total_tokens: 3 } });
    }
    sendJson(res, 404, { error: { message: 'no such route', code: 'not_found' } });
  }, port);
}

// ─── Hub under test ──────────────────────────────────────────────────────────

export interface TestHub {
  hub: Hub;
  app: FastifyInstance;
  base: string;
  /** A client key with default settings, already created. */
  key: string;
  /** Calls the hub with the client key (or another token). */
  api(method: string, path: string, body?: unknown, headers?: Record<string, string>, token?: string | null): Promise<{ status: number; json: Json; headers: Headers; text: string }>;
  admin(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json; headers: Headers }>;
  /** Raw streaming request: returns the response so the test can read it piece by piece. */
  raw(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  close(): Promise<void>;
}

export interface TestHubOptions {
  env?: Record<string, string>;
  hub?: HubOverrides;
  /** Called after the hub exists and before the server starts: add providers, keys... */
  setup?: (hub: Hub) => void | Promise<void>;
}

export async function startHub(opts: TestHubOptions = {}): Promise<TestHub> {
  const config: HubConfig = loadConfig({ MINDGATE_MASTER_KEY: MASTER, MINDGATE_ADMIN_TOKEN: ADMIN, MINDGATE_DB: ':memory:', MINDGATE_KEEPALIVE_AFTER_MS: '150', MINDGATE_KEEPALIVE_INTERVAL_MS: '150', ...opts.env }, () => undefined);
  const hub = createHub(config, silentLogger, opts.hub);
  const { key } = hub.keys.create({ name: 'test' });
  await opts.setup?.(hub);
  const app = await buildServer(hub);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const call = async (method: string, path: string, body: unknown, headers: Record<string, string>) => {
    const res = await fetch(base + path, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let json: Json = {};
    try {
      json = text ? (JSON.parse(text) as Json) : {};
    } catch {
      /* sse or text */
    }
    return { status: res.status, json, headers: res.headers, text };
  };

  return {
    hub,
    app,
    base,
    key,
    api: (method, path, body, headers = {}, token) => call(method, path, body, { ...(token === null ? {} : { Authorization: `Bearer ${token ?? key.valueOf()}` }), ...headers }),
    admin: (method, path, body) => call(method, `/admin/api${path}`, body, { Authorization: `Bearer ${ADMIN}` }),
    raw: (method, path, body, headers = {}) =>
      fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
    close: async () => {
      hub.nodes.stop();
      hub.sync.stop();
      await app.close();
      hub.db.close();
    },
  };
}

/** Adds an OpenAI-type provider that points at a fake and syncs its models. */
export async function addProvider(h: Hub, id: string, up: Upstream, extra: Record<string, unknown> = {}): Promise<void> {
  h.providers.create({ id, name: id, type: 'openai', baseUrl: `${up.url}/v1`, apiKey: 'sk-test-key-1234', ...extra } as never);
  await h.sync.syncOne(id);
}

/** SSE body -> list of data payloads (JSON parsed, or the literal "[DONE]") and comments. */
export function parseSse(text: string): Array<Json | string> {
  const out: Array<Json | string> = [];
  for (const block of text.split(/\n\n/)) {
    const line = block.trim();
    if (!line) continue;
    if (line.startsWith(':')) {
      out.push(line);
      continue;
    }
    const data = line.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (data === '[DONE]') out.push('[DONE]');
    else if (data) out.push(JSON.parse(data) as Json);
  }
  return out;
}

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

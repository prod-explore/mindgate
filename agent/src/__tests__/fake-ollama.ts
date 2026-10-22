import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for Ollama that speaks enough of its API (native and OpenAI-compatible) for the agent, the hub and the
 * end-to-end test to run against it. It also records what it was asked, and whether a client walked away mid-answer.
 */

export interface FakeModel {
  name: string;
  size?: number;
  family?: string;
  families?: string[];
  parameterSize?: string;
  quantization?: string;
  contextLength?: number;
  /** null = an old Ollama that does not report capabilities. */
  capabilities?: string[] | null;
}

export interface Rec {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: any;
  raw: string;
}

export interface FakeOllama {
  url: string;
  port: number;
  models: Map<string, FakeModel>;
  loaded: Map<string, { expiresAt: string }>;
  requests: Rec[];
  /** Paths of requests whose client left before the answer was complete. */
  aborted: string[];
  /** Makes the next pulls wait half way until the returned function is called. */
  holdPulls(): () => void;
  /** Makes streamed chat answers wait after the first chunk until the returned function is called. */
  holdChat(): () => void;
  /** Makes chat requests wait before answering at all (a model that is still loading) until the returned function is called. */
  holdChatHeaders(): () => void;
  addModel(m: FakeModel): void;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function startFakeOllama(initial: FakeModel[] = [], port = 0, version = '0.0.0-fake'): Promise<FakeOllama> {
  const models = new Map<string, FakeModel>();
  for (const m of initial) models.set(m.name, m);
  const loaded = new Map<string, { expiresAt: string }>();
  const requests: Rec[] = [];
  const aborted: string[] = [];
  let pullGate: Promise<void> | null = null;
  let chatGate: Promise<void> | null = null;
  let headerGate: Promise<void> | null = null;

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const handle = async (rec: Rec, res: ServerResponse): Promise<void> => {
    const { method, path, body } = rec;
    const name: string | undefined = body?.model ?? body?.name;

    if (method === 'GET' && path === '/api/version') return json(res, 200, { version });

    if (method === 'GET' && path === '/api/tags') {
      return json(res, 200, {
        models: [...models.values()].map(m => ({
          name: m.name,
          model: m.name,
          modified_at: '2026-10-01T10:00:00Z',
          size: m.size ?? 1_000_000,
          digest: `sha256:${Buffer.from(m.name + (m.size ?? '')).toString('hex')}`,
          details: { family: m.family ?? 'llama', families: m.families ?? [m.family ?? 'llama'], parameter_size: m.parameterSize ?? '4B', quantization_level: m.quantization ?? 'Q4_K_M' },
        })),
      });
    }

    if (method === 'POST' && path === '/api/show') {
      const m = name ? models.get(name) : undefined;
      if (!m) return json(res, 404, { error: `model '${name}' not found` });
      const arch = m.family ?? 'llama';
      return json(res, 200, {
        details: { family: arch, parameter_size: m.parameterSize ?? '4B', quantization_level: m.quantization ?? 'Q4_K_M' },
        model_info: { 'general.architecture': arch, [`${arch}.context_length`]: m.contextLength ?? 32768 },
        ...(m.capabilities === null ? {} : { capabilities: m.capabilities ?? ['completion'] }),
      });
    }

    if (method === 'GET' && path === '/api/ps') {
      return json(res, 200, { models: [...loaded].map(([n, l]) => ({ name: n, model: n, size: 3_000_000_000, size_vram: 2_500_000_000, expires_at: l.expiresAt })) });
    }

    if (method === 'DELETE' && path === '/api/delete') {
      if (!name || !models.delete(name)) return json(res, 404, { error: `model '${name}' not found` });
      loaded.delete(name);
      return json(res, 200, {});
    }

    if (method === 'POST' && (path === '/api/generate' || path === '/api/embed')) {
      const m = name ? models.get(name) : undefined;
      if (!m) return json(res, 404, { error: `model '${name}' not found` });
      const embedding = (m.capabilities ?? []).includes('embedding') && !(m.capabilities ?? []).includes('completion');
      if (path === '/api/generate' && embedding) return json(res, 400, { error: `"${name}" does not support generate` });
      if (body.keep_alive === 0) loaded.delete(m.name);
      else loaded.set(m.name, { expiresAt: new Date(Date.now() + 300_000).toISOString() });
      return json(res, 200, path === '/api/embed' ? { model: m.name, embeddings: [[0.1]] } : { model: m.name, done: true, response: '' });
    }

    if (method === 'POST' && path === '/api/pull') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      const line = (o: unknown) => res.write(`${JSON.stringify(o)}\n`);
      line({ status: 'pulling manifest' });
      if (!name || /^fail\//.test(name)) {
        line({ error: 'pull model manifest: file does not exist' });
        return void res.end();
      }
      line({ status: 'pulling aaa', digest: 'sha256:aaa', total: 100, completed: 50 });
      line({ status: 'pulling bbb', digest: 'sha256:bbb', total: 300, completed: 0 });
      if (pullGate) await pullGate;
      line({ status: 'pulling aaa', digest: 'sha256:aaa', total: 100, completed: 100 });
      line({ status: 'pulling bbb', digest: 'sha256:bbb', total: 300, completed: 200 });
      await sleep(5);
      line({ status: 'pulling bbb', digest: 'sha256:bbb', total: 300, completed: 300 });
      line({ status: 'verifying sha256 digest' });
      line({ status: 'success' });
      models.set(name, { name, capabilities: ['completion', 'tools'] });
      return void res.end();
    }

    if (path === '/v1/models') return json(res, 200, { object: 'list', data: [...models.keys()].map(id => ({ id, object: 'model' })) });

    if (method === 'POST' && path === '/v1/chat/completions') {
      if (headerGate) await headerGate;
      if (res.destroyed) return;
      if (!name || !models.has(name)) return json(res, 404, { error: { message: `model '${name}' not found`, type: 'api_error', param: null, code: null } });
      const last = String(body.messages?.at(-1)?.content ?? '');
      if (!body.stream) {
        return json(res, 200, {
          id: 'chatcmpl-fake',
          object: 'chat.completion',
          created: 1,
          model: name,
          choices: [{ index: 0, message: { role: 'assistant', content: `echo:${last}` }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 1, model: name, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: 'assistant', content: 'one ' }));
      if (chatGate) await chatGate;
      res.write(chunk({ content: `two:${last}` }));
      res.write(chunk({}, 'stop'));
      res.write('data: [DONE]\n\n');
      return void res.end();
    }

    if (method === 'POST' && path === '/v1/embeddings') {
      if (!name || !models.has(name)) return json(res, 404, { error: { message: `model '${name}' not found`, type: 'api_error', param: null, code: null } });
      return json(res, 200, { object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }], model: name, usage: { prompt_tokens: 3, total_tokens: 3 } });
    }

    json(res, 404, { error: 'not found' });
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: any = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        /* not json */
      }
      const rec: Rec = { method: req.method ?? 'GET', path: (req.url ?? '').split('?')[0]!, headers: req.headers, body, raw };
      requests.push(rec);
      res.on('close', () => {
        if (!res.writableFinished) aborted.push(rec.path);
      });
      handle(rec, res).catch(err => {
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
    models,
    loaded,
    requests,
    aborted,
    holdPulls() {
      let release!: () => void;
      pullGate = new Promise<void>(r => {
        release = () => {
          pullGate = null;
          r();
        };
      });
      return release;
    },
    holdChat() {
      let release!: () => void;
      chatGate = new Promise<void>(r => {
        release = () => {
          chatGate = null;
          r();
        };
      });
      return release;
    },
    holdChatHeaders() {
      let release!: () => void;
      headerGate = new Promise<void>(r => {
        release = () => {
          headerGate = null;
          r();
        };
      });
      return release;
    },
    addModel(m) {
      models.set(m.name, m);
    },
    close: () =>
      new Promise<void>(r => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

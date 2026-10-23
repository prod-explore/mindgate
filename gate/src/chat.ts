import type { ServerResponse } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { adapterFor } from './adapters/index.js';
import { usageOf, type Json, type StreamItem } from './adapters/types.js';
import type { Hub } from './context.js';
import { estimateInput, estimated, roughTokens } from './estimate.js';
import { HubError, badRequest, isHubError } from './errors.js';
import type { Candidate } from './routing.js';
import { dayKey } from './time.js';
import type { ApiKeyRecord, Usage } from './types.js';
import { ClientAbort } from './upstream.js';
import { isPlainObject } from './util.js';

/**
 * One client request, from authentication to the last byte.
 *
 *   resolve the model -> admit against the key's limits ->
 *     wake the node if needed -> wait for a free slot -> call the upstream -> relay the answer
 *   Nothing is retried on another model: when a call fails the client gets the error (with `fallback: true` when it failed
 *   before any of the answer went out, so the app may pick another model by its tags) and decides for itself.
 *
 * What gets stored about a request is who, what model, how long, how many tokens and what went wrong — never the text.
 */

type Endpoint = 'chat' | 'embeddings';

interface Attempt {
  model: string;
  outcome: string;
}

const TAG = /^[\w.:@/-]{1,64}$/;
const truthy = (v: string | undefined): boolean => v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());

export function parsePriority(raw: string | undefined, key: ApiKeyRecord): number {
  if (raw === undefined || raw === '') return key.defaultPriority;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw badRequest('invalid_priority', 'X-MindGate-Priority must be an integer from 1 to 5', 'X-MindGate-Priority');
  return Math.max(key.minPriority, Math.min(key.maxPriority, n));
}

/** Writes to a response and waits for the socket to drain, so a slow client cannot make the hub buffer a whole answer. */
function write(res: ServerResponse, data: string): Promise<void> {
  if (res.destroyed || res.writableEnded) return Promise.reject(new ClientAbort());
  if (res.write(data)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
    };
    const onDrain = () => {
      done();
      resolve();
    };
    const onClose = () => {
      done();
      reject(new ClientAbort());
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

class Sink {
  headersSent = false;
  /** The first byte of the model's answer has gone out; from here on a failure can no longer be handed to a fallback. */
  contentStarted = false;
  lastWrite = Date.now();

  constructor(
    private readonly reply: FastifyReply,
    private readonly requestId: string,
  ) {}

  get raw(): ServerResponse {
    return this.reply.raw;
  }

  startSse(extra: Record<string, string> = {}): void {
    if (this.headersSent) return;
    this.reply.hijack();
    this.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Request-Id': this.requestId,
      ...extra,
    });
    this.raw.flushHeaders();
    this.headersSent = true;
  }

  async data(payload: unknown): Promise<void> {
    await write(this.raw, `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
    this.lastWrite = Date.now();
  }

  async comment(text: string): Promise<void> {
    await write(this.raw, `: ${text}\n\n`);
    this.lastWrite = Date.now();
  }

  end(): void {
    if (!this.raw.writableEnded) this.raw.end();
  }
}

function sniffOutputChars(chunk: Json): number {
  let n = 0;
  for (const c of (Array.isArray(chunk['choices']) ? chunk['choices'] : []) as Json[]) {
    const d = (c?.['delta'] ?? {}) as Json;
    if (typeof d['content'] === 'string') n += d['content'].length;
    if (typeof d['reasoning_content'] === 'string') n += d['reasoning_content'].length;
    for (const t of (Array.isArray(d['tool_calls']) ? d['tool_calls'] : []) as Json[]) {
      const f = t?.['function'] as Json | undefined;
      if (f && typeof f['arguments'] === 'string') n += f['arguments'].length;
      if (f && typeof f['name'] === 'string') n += f['name'].length;
    }
  }
  return n;
}

function completionChars(json: Json): number {
  let n = 0;
  for (const c of (Array.isArray(json['choices']) ? json['choices'] : []) as Json[]) {
    const m = (c?.['message'] ?? {}) as Json;
    if (typeof m['content'] === 'string') n += m['content'].length;
    if (typeof m['reasoning_content'] === 'string') n += m['reasoning_content'].length;
    if (Array.isArray(m['tool_calls'])) n += JSON.stringify(m['tool_calls']).length;
  }
  return n;
}

function withContext(e: HubError, c: Candidate): HubError {
  if (e.extra['provider']) return e;
  return new HubError({ status: e.status, code: e.code, message: e.message, ...(e.param ? { param: e.param } : {}), extra: { ...e.extra, provider: c.provider.id, model: c.model.id }, headers: e.headers, fallback: e.fallback });
}

export interface RunParams {
  hub: Hub;
  req: FastifyRequest;
  reply: FastifyReply;
  key: ApiKeyRecord;
  endpoint: Endpoint;
}

export async function runRequest({ hub, req, reply, key, endpoint }: RunParams): Promise<void> {
  const started = Date.now();
  const requestId = req.id;
  const headers = req.headers as Record<string, string | undefined>;
  const sink = new Sink(reply, requestId);
  const ac = new AbortController();
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) ac.abort();
  });

  const body = (isPlainObject(req.body) ? req.body : {}) as Json;
  const stream = endpoint === 'chat' && body['stream'] === true;
  const attempts: Attempt[] = [];
  let keepalive: NodeJS.Timeout | null = null;

  let priority: number | null = null;
  let localOnly = key.localOnly;
  let requestedModel: string | null = null;
  let finalCandidate: Candidate | null = null;
  let usage: Usage | null = null;
  let queueMs = 0;
  let ttfbMs: number | null = null;
  let status = 200;
  let errorCode: string | null = null;
  let admission: { release(): void } | null = null;
  const tag = headers['x-mindgate-tag'] && TAG.test(headers['x-mindgate-tag']) ? headers['x-mindgate-tag'] : null;

  try {
    // ── Validate ────────────────────────────────────────────────────────────
    const named = headers['x-mindgate-model'] || body['model'];
    if (typeof named !== 'string' || !named.trim()) throw badRequest('missing_model', 'Specify the model in the "model" field (or the X-MindGate-Model header)', 'model');
    requestedModel = named.trim();
    if (endpoint === 'chat') {
      if (!Array.isArray(body['messages']) || body['messages'].length === 0) throw badRequest('invalid_messages', '"messages" must be a non-empty array', 'messages');
      if (body['stream'] !== undefined && typeof body['stream'] !== 'boolean') throw badRequest('invalid_request', '"stream" must be a boolean', 'stream');
      if (body['stream_options'] !== undefined && !isPlainObject(body['stream_options'])) throw badRequest('invalid_request', '"stream_options" must be an object', 'stream_options');
    } else if (body['input'] === undefined) {
      throw badRequest('invalid_request', '"input" is required', 'input');
    }
    priority = parsePriority(headers['x-mindgate-priority'], key);
    localOnly = key.localOnly || truthy(headers['x-mindgate-local-only']);
    const clientWantsUsage = stream && isPlainObject(body['stream_options']) && body['stream_options']['include_usage'] === true;

    // ── Route and admit ─────────────────────────────────────────────────────
    const resolution = hub.router.resolve(requestedModel, key, { localOnly, kind: endpoint === 'chat' ? 'chat' : 'embedding' });
    admission = hub.limits.admit(key);
    hub.keys.touch(key.id);
    const inputEstimate = estimateInput(body);

    if (stream) {
      // A model that takes a while to load must not make proxies in front of the hub give up on a silent connection.
      keepalive = setInterval(() => {
        if (ac.signal.aborted || sink.raw.writableEnded) return;
        const quiet = Date.now() - sink.lastWrite;
        if (!sink.headersSent && Date.now() - started < hub.config.keepaliveAfterMs) return;
        if (quiet < hub.config.keepaliveIntervalMs && sink.headersSent) return;
        try {
          sink.startSse();
          void sink.comment('waiting for the model').catch(() => undefined);
        } catch {
          /* the client is gone; the abort handler deals with it */
        }
      }, Math.min(1000, hub.config.keepaliveIntervalMs));
      keepalive.unref();
    }

    // ── Call the model ──────────────────────────────────────────────────────
    const c = resolution.candidate;
    finalCandidate = c;
    try {
      await attempt(c);
    } catch (e) {
      if (e instanceof ClientAbort || ac.signal.aborted) throw new ClientAbort();
      const he = withContext(toHubError(e, hub, requestId), c);
      attempts.push({ model: c.model.id, outcome: he.code });
      throw he;
    }

    // ── The answer is out; account for it ───────────────────────────────────
    async function attempt(c: Candidate): Promise<void> {
      const provider = c.provider;
      const adapter = adapterFor(provider.type);
      for (let pass = 0; ; pass++) {
        try {
          await once();
          return;
        } catch (e) {
          const lost = isHubError(e) && e.code === 'upstream_unreachable' && provider.node;
          if (lost && pass === 0 && !sink.contentStarted && !ac.signal.aborted) {
            // The machine was trusted to be up but is not (power cut, sleep): look again, wake it if allowed, retry once.
            hub.nodes.markDown(provider.id, e.message);
            continue;
          }
          if (lost) {
            throw new HubError({
              status: 502,
              code: 'node_connection_lost',
              message: `The machine behind "${provider.name}" lost the connection — it may have lost power or restarted. A new request wakes it again.`,
              extra: { provider: provider.id },
              fallback: true,
            });
          }
          throw e;
        }
      }

      async function once(): Promise<void> {
        await hub.nodes.ensure(provider, priority!, ac.signal);
        const limiter = hub.registry.limiter(provider);
        const waitFrom = Date.now();
        const release = limiter ? await limiter.acquire(priority!, ac.signal) : () => undefined;
        queueMs += Date.now() - waitFrom;
        hub.nodes.begin(provider.id);
        try {
          const rt = hub.registry.runtime(provider);
          const callStart = Date.now();
          const call = { runtime: rt, model: c.model, body, stream, signal: ac.signal };

          if (endpoint === 'embeddings') {
            if (!adapter.embeddings) throw new HubError({ status: 400, code: 'unsupported_endpoint', message: `"${provider.name}" does not offer embeddings` });
            const json = await adapter.embeddings(call);
            ttfbMs = Date.now() - callStart;
            usage = usageOf(json) ?? estimated(inputEstimate, 0);
            json['model'] = c.model.id;
            attempts.push({ model: c.model.id, outcome: 'ok' });
            reply.code(200).headers(responseHeaders(c)).send({ ...json, mindgate: info(c) });
            hub.nodes.markUp(provider.id);
            return;
          }

          const result = await adapter.chat(call);
          if (!result.stream) {
            ttfbMs = Date.now() - callStart;
            const json = result.json;
            json['model'] = c.model.id;
            usage = usageOf(json) ?? estimated(inputEstimate, completionChars(json));
            if (!json['usage']) json['usage'] = { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens };
            attempts.push({ model: c.model.id, outcome: 'ok' });
            reply.code(200).headers(responseHeaders(c)).send({ ...json, mindgate: { ...info(c), ...(usage.estimated ? { usage_estimated: true } : {}) } });
            hub.nodes.markUp(provider.id);
            return;
          }

          const it = result.events[Symbol.asyncIterator]();
          try {
            let first: IteratorResult<StreamItem, void>;
            do {
              first = await it.next();
            } while (!first.done && first.value.kind === 'comment');
            if (first.done) {
              throw new HubError({ status: 502, code: 'upstream_empty_response', message: `"${provider.name}" ended the answer without saying anything`, extra: { provider: provider.id }, fallback: true });
            }
            ttfbMs = Date.now() - callStart;
            hub.nodes.markUp(provider.id);
            sink.startSse(responseHeaders(c));

            let outChars = 0;
            let reported: Usage | null = null;
            let usageSent = false;
            const relay = async (item: StreamItem): Promise<void> => {
              if (item.kind === 'comment') {
                await sink.comment(item.text);
                return;
              }
              const chunk = item.chunk;
              chunk['model'] = c.model.id;
              const u = usageOf(chunk);
              if (u) reported = u;
              outChars += sniffOutputChars(chunk);
              const usageOnly = Array.isArray(chunk['choices']) && chunk['choices'].length === 0;
              if (usageOnly && !clientWantsUsage) return; // counted, but the client did not ask to see it
              if (usageOnly || chunk['usage']) usageSent = true;
              sink.contentStarted = true;
              await sink.data(chunk);
            };
            await relay(first.value);
            for (;;) {
              const next = await it.next();
              if (next.done) break;
              await relay(next.value);
            }
            usage = reported ?? estimated(inputEstimate, outChars);
            if (clientWantsUsage && !usageSent) {
              await sink.data({
                id: `chatcmpl-${requestId}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: c.model.id,
                choices: [],
                usage: { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens },
              });
            }
            attempts.push({ model: c.model.id, outcome: 'ok' });
            await sink.data('[DONE]');
            sink.end();
          } catch (e) {
            // a half-finished answer still used tokens
            if (sink.contentStarted) usage = usage ?? estimated(inputEstimate, 0);
            throw e;
          } finally {
            await it.return?.(undefined as never).catch(() => undefined);
          }
        } finally {
          hub.nodes.end(provider.id);
          release();
        }
      }
    }

    function info(c: Candidate): Json {
      return { requested: requestedModel, model: c.model.id, provider: c.provider.id, attempts };
    }
    function responseHeaders(c: Candidate): Record<string, string> {
      return {
        'X-Request-Id': requestId,
        'X-MindGate-Model': c.model.id,
        'X-MindGate-Provider': c.provider.id,
      };
    }
  } catch (e) {
    if (e instanceof ClientAbort || ac.signal.aborted) {
      status = 499;
      errorCode = 'client_closed_request';
      if (sink.contentStarted) usage = usage ?? estimated(estimateInput(body), 0);
    } else {
      const he = toHubError(e, hub, requestId);
      status = he.status;
      errorCode = he.code;
      if (sink.headersSent) {
        // The status line has gone out already; the error travels inside the stream, as the OpenAI API does it.
        status = 200;
        try {
          const payload = he.payload();
          // Half an answer has gone out, so another model cannot simply take over: the app must not read this as "try again elsewhere".
          if (sink.contentStarted) delete payload.error['fallback'];
          await sink.data(payload);
          await sink.data('[DONE]');
        } catch {
          /* client gone */
        }
        sink.end();
      } else if (!reply.sent) {
        reply.code(he.status).headers({ 'X-Request-Id': requestId, ...he.headers }).send(he.payload());
      }
    }
  } finally {
    if (keepalive) clearInterval(keepalive);
    const latency = Date.now() - started;
    const isError = status >= 400 && status !== 499 ? true : errorCode !== null && errorCode !== 'client_closed_request';
    try {
      if (finalCandidate && (usage || isError || status === 499)) {
        const u = usage as Usage | null;
        hub.usage.record(dayKey(hub.clock(), hub.config.usageTz), key.id, finalCandidate.model.id, {
          requests: 1,
          errors: isError ? 1 : 0,
          inputTokens: u?.inputTokens ?? 0,
          outputTokens: u?.outputTokens ?? 0,
        });
      }
      hub.usage.log({
        ts: new Date(started).toISOString(),
        requestId,
        keyId: key.id,
        keyName: key.name,
        endpoint: endpoint === 'chat' ? '/v1/chat/completions' : '/v1/embeddings',
        requestedModel,
        modelId: finalCandidate?.model.id ?? null,
        providerId: finalCandidate?.provider.id ?? null,
        status,
        errorCode,
        stream,
        priority,
        localOnly,
        tag,
        attempts,
        queueMs: queueMs || null,
        ttfbMs,
        latencyMs: latency,
        usage,
      });
    } catch (e) {
      hub.log.error({ requestId, err: e instanceof Error ? e.message : String(e) }, 'could not record usage');
    }
    admission?.release();
    hub.log.info({ requestId, key: key.name, model: requestedModel, served: finalCandidate?.model.id, status, error: errorCode, stream, ms: latency, tokens: usage ? usage.inputTokens + usage.outputTokens : undefined }, 'request finished');
  }
}

function toHubError(e: unknown, hub: Hub, requestId: string): HubError {
  if (isHubError(e)) return e;
  hub.log.error({ requestId, err: e instanceof Error ? (e.stack ?? e.message) : String(e) }, 'unexpected error');
  return new HubError({ status: 500, code: 'internal_error', message: 'Internal error in the hub (see its log)' });
}

export { roughTokens };

import type { ServerResponse } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { adapterFor } from './adapters/index.js';
import { usageOf, type Json, type StreamItem } from './adapters/types.js';
import type { Hub } from './context.js';
import { estimateInput, estimated } from './estimate.js';
import { HubError, badRequest, isHubError } from './errors.js';
import type { Candidate } from './routing.js';
import { dayKey } from './time.js';
import type { ApiKeyRecord, Usage } from './types.js';
import { ClientAbort } from './upstream.js';
import { isPlainObject } from './util.js';

/**
 * One authenticated client request, from routing to the last byte of the answer.
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

/** The X-MindGate-Priority header, clamped to the range the key allows; the key's default when there is none. */
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

/** The response side of one request: a plain JSON reply, or a server-sent event stream once the headers are out. */
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

/** Characters of model output in one stream chunk: the basis of a token estimate when the upstream reports no usage. */
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

/** The same count for a whole (non-streamed) completion. */
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

/** Names the provider and model in an error that does not name them yet. */
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

export async function runRequest(params: RunParams): Promise<void> {
  await new RequestRun(params).execute();
}

/** A call into an adapter: which runtime, which model, the client's body, and whether to stream. */
type AdapterCall = Parameters<ReturnType<typeof adapterFor>['chat']>[0];

/** The state of one request while it travels through the hub. Everything that ends up in the usage log is kept here. */
class RequestRun {
  private readonly hub: Hub;
  private readonly reply: FastifyReply;
  private readonly key: ApiKeyRecord;
  private readonly endpoint: Endpoint;
  private readonly requestId: string;
  private readonly started = Date.now();
  private readonly headers: Record<string, string | undefined>;
  private readonly sink: Sink;
  private readonly ac = new AbortController();
  private readonly body: Json;
  private readonly stream: boolean;
  private readonly tag: string | null;
  private readonly attempts: Attempt[] = [];

  private keepalive: NodeJS.Timeout | null = null;
  private priority: number | null = null;
  private localOnly: boolean;
  private requestedModel: string | null = null;
  private clientWantsUsage = false;
  private inputEstimate = 0;
  private finalCandidate: Candidate | null = null;
  private usage: Usage | null = null;
  private queueMs = 0;
  private ttfbMs: number | null = null;
  private status = 200;
  private errorCode: string | null = null;
  private admission: { release(): void } | null = null;

  constructor({ hub, req, reply, key, endpoint }: RunParams) {
    this.hub = hub;
    this.reply = reply;
    this.key = key;
    this.endpoint = endpoint;
    this.requestId = req.id;
    this.headers = req.headers as Record<string, string | undefined>;
    this.sink = new Sink(reply, this.requestId);
    this.body = (isPlainObject(req.body) ? req.body : {}) as Json;
    this.stream = endpoint === 'chat' && this.body['stream'] === true;
    const tag = this.headers['x-mindgate-tag'];
    this.tag = tag && TAG.test(tag) ? tag : null;
    this.localOnly = key.localOnly;
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) this.ac.abort();
    });
  }

  async execute(): Promise<void> {
    try {
      this.validate();
      const candidate = this.routeAndAdmit();
      if (this.stream) this.startKeepalive();
      await this.callModel(candidate);
    } catch (e) {
      await this.fail(e);
    } finally {
      this.finish();
    }
  }

  private validate(): void {
    const { body, headers, endpoint, key } = this;
    const named = headers['x-mindgate-model'] || body['model'];
    if (typeof named !== 'string' || !named.trim()) throw badRequest('missing_model', 'Specify the model in the "model" field (or the X-MindGate-Model header)', 'model');
    this.requestedModel = named.trim();
    if (endpoint === 'chat') {
      if (!Array.isArray(body['messages']) || body['messages'].length === 0) throw badRequest('invalid_messages', '"messages" must be a non-empty array', 'messages');
      if (body['stream'] !== undefined && typeof body['stream'] !== 'boolean') throw badRequest('invalid_request', '"stream" must be a boolean', 'stream');
      if (body['stream_options'] !== undefined && !isPlainObject(body['stream_options'])) throw badRequest('invalid_request', '"stream_options" must be an object', 'stream_options');
    } else if (body['input'] === undefined) {
      throw badRequest('invalid_request', '"input" is required', 'input');
    }
    this.priority = parsePriority(headers['x-mindgate-priority'], key);
    this.localOnly = key.localOnly || truthy(headers['x-mindgate-local-only']);
    this.clientWantsUsage = this.stream && isPlainObject(body['stream_options']) && body['stream_options']['include_usage'] === true;
  }

  private routeAndAdmit(): Candidate {
    const { hub, key } = this;
    const resolution = hub.router.resolve(this.requestedModel!, key, { localOnly: this.localOnly, kind: this.endpoint === 'chat' ? 'chat' : 'embedding' });
    this.admission = hub.limits.admit(key);
    hub.keys.touch(key.id);
    this.inputEstimate = estimateInput(this.body);
    return resolution.candidate;
  }

  /** A model that takes a while to load must not make proxies in front of the hub give up on a silent connection. */
  private startKeepalive(): void {
    const { hub, sink, ac } = this;
    this.keepalive = setInterval(() => {
      if (ac.signal.aborted || sink.raw.writableEnded) return;
      const quiet = Date.now() - sink.lastWrite;
      if (!sink.headersSent && Date.now() - this.started < hub.config.keepaliveAfterMs) return;
      if (quiet < hub.config.keepaliveIntervalMs && sink.headersSent) return;
      try {
        sink.startSse();
        void sink.comment('waiting for the model').catch(() => undefined);
      } catch {
        /* the client is gone; the abort handler deals with it */
      }
    }, Math.min(1000, hub.config.keepaliveIntervalMs));
    this.keepalive.unref();
  }

  private async callModel(c: Candidate): Promise<void> {
    this.finalCandidate = c;
    try {
      await this.attempt(c);
    } catch (e) {
      if (e instanceof ClientAbort || this.ac.signal.aborted) throw new ClientAbort();
      const he = withContext(toHubError(e, this.hub, this.requestId), c);
      this.attempts.push({ model: c.model.id, outcome: he.code });
      throw he;
    }
  }

  /** One call, and — only for a machine that turns out to be down — one more after waking it. */
  private async attempt(c: Candidate): Promise<void> {
    const provider = c.provider;
    for (let pass = 0; ; pass++) {
      try {
        await this.callOnce(c);
        return;
      } catch (e) {
        const lost = isHubError(e) && e.code === 'upstream_unreachable' && provider.node;
        if (lost && pass === 0 && !this.sink.contentStarted && !this.ac.signal.aborted) {
          // The machine was trusted to be up but is not (power cut, sleep): look again, wake it if allowed, retry once.
          this.hub.nodes.markDown(provider.id, e.message);
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
  }

  /** Wake the node, wait for a free slot, call the upstream, relay what comes back. */
  private async callOnce(c: Candidate): Promise<void> {
    const { hub, ac } = this;
    const provider = c.provider;
    const adapter = adapterFor(provider.type);
    await hub.nodes.ensure(provider, this.priority!, ac.signal);
    const limiter = hub.registry.limiter(provider);
    const waitFrom = Date.now();
    const release = limiter ? await limiter.acquire(this.priority!, ac.signal) : () => undefined;
    this.queueMs += Date.now() - waitFrom;
    hub.nodes.begin(provider.id);
    try {
      const call: AdapterCall = { runtime: hub.registry.runtime(provider), model: c.model, body: this.body, stream: this.stream, signal: ac.signal };
      const callStart = Date.now();
      if (this.endpoint === 'embeddings') await this.answerEmbeddings(c, adapter, call, callStart);
      else await this.answerChat(c, adapter, call, callStart);
    } finally {
      hub.nodes.end(provider.id);
      release();
    }
  }

  private async answerEmbeddings(c: Candidate, adapter: ReturnType<typeof adapterFor>, call: AdapterCall, callStart: number): Promise<void> {
    if (!adapter.embeddings) throw new HubError({ status: 400, code: 'unsupported_endpoint', message: `"${c.provider.name}" does not offer embeddings` });
    const json = await adapter.embeddings(call);
    this.ttfbMs = Date.now() - callStart;
    this.usage = usageOf(json) ?? estimated(this.inputEstimate, 0);
    json['model'] = c.model.id;
    this.attempts.push({ model: c.model.id, outcome: 'ok' });
    this.reply.code(200).headers(this.responseHeaders(c)).send({ ...json, mindgate: this.info(c) });
    this.hub.nodes.markUp(c.provider.id);
  }

  private async answerChat(c: Candidate, adapter: ReturnType<typeof adapterFor>, call: AdapterCall, callStart: number): Promise<void> {
    const result = await adapter.chat(call);
    if (result.stream) {
      await this.relayStream(c, result.events, callStart);
      return;
    }
    this.ttfbMs = Date.now() - callStart;
    const json = result.json;
    json['model'] = c.model.id;
    const usage = usageOf(json) ?? estimated(this.inputEstimate, completionChars(json));
    this.usage = usage;
    if (!json['usage']) json['usage'] = { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens };
    this.attempts.push({ model: c.model.id, outcome: 'ok' });
    this.reply.code(200).headers(this.responseHeaders(c)).send({ ...json, mindgate: { ...this.info(c), ...(usage.estimated ? { usage_estimated: true } : {}) } });
    this.hub.nodes.markUp(c.provider.id);
  }

  /** Relays a streamed answer chunk by chunk; the first chunk decides whether the call counts as having started. */
  private async relayStream(c: Candidate, events: AsyncIterable<StreamItem>, callStart: number): Promise<void> {
    const { sink } = this;
    const it = events[Symbol.asyncIterator]();
    try {
      let first: IteratorResult<StreamItem, void>;
      do {
        first = await it.next();
      } while (!first.done && first.value.kind === 'comment');
      if (first.done) {
        throw new HubError({ status: 502, code: 'upstream_empty_response', message: `"${c.provider.name}" ended the answer without saying anything`, extra: { provider: c.provider.id }, fallback: true });
      }
      this.ttfbMs = Date.now() - callStart;
      this.hub.nodes.markUp(c.provider.id);
      sink.startSse(this.responseHeaders(c));

      const tally = { outChars: 0, reported: null as Usage | null, usageSent: false };
      await this.relayItem(c, first.value, tally);
      for (;;) {
        const next = await it.next();
        if (next.done) break;
        await this.relayItem(c, next.value, tally);
      }
      const usage = tally.reported ?? estimated(this.inputEstimate, tally.outChars);
      this.usage = usage;
      if (this.clientWantsUsage && !tally.usageSent) {
        await sink.data({
          id: `chatcmpl-${this.requestId}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: c.model.id,
          choices: [],
          usage: { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens },
        });
      }
      this.attempts.push({ model: c.model.id, outcome: 'ok' });
      await sink.data('[DONE]');
      sink.end();
    } catch (e) {
      // a half-finished answer still used tokens
      if (sink.contentStarted) this.usage = this.usage ?? estimated(this.inputEstimate, 0);
      throw e;
    } finally {
      await it.return?.(undefined as never).catch(() => undefined);
    }
  }

  private async relayItem(c: Candidate, item: StreamItem, tally: { outChars: number; reported: Usage | null; usageSent: boolean }): Promise<void> {
    if (item.kind === 'comment') {
      await this.sink.comment(item.text);
      return;
    }
    const chunk = item.chunk;
    chunk['model'] = c.model.id;
    const u = usageOf(chunk);
    if (u) tally.reported = u;
    tally.outChars += sniffOutputChars(chunk);
    const usageOnly = Array.isArray(chunk['choices']) && chunk['choices'].length === 0;
    if (usageOnly && !this.clientWantsUsage) return; // counted, but the client did not ask to see it
    if (usageOnly || chunk['usage']) tally.usageSent = true;
    this.sink.contentStarted = true;
    await this.sink.data(chunk);
  }

  private info(c: Candidate): Json {
    return { requested: this.requestedModel, model: c.model.id, provider: c.provider.id, attempts: this.attempts };
  }

  private responseHeaders(c: Candidate): Record<string, string> {
    return { 'X-Request-Id': this.requestId, 'X-MindGate-Model': c.model.id, 'X-MindGate-Provider': c.provider.id };
  }

  private async fail(e: unknown): Promise<void> {
    const { sink, reply } = this;
    if (e instanceof ClientAbort || this.ac.signal.aborted) {
      this.status = 499;
      this.errorCode = 'client_closed_request';
      if (sink.contentStarted) this.usage = this.usage ?? estimated(estimateInput(this.body), 0);
      return;
    }
    const he = toHubError(e, this.hub, this.requestId);
    this.status = he.status;
    this.errorCode = he.code;
    if (sink.headersSent) {
      // The status line has gone out already; the error travels inside the stream, as the OpenAI API does it.
      this.status = 200;
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
      reply.code(he.status).headers({ 'X-Request-Id': this.requestId, ...he.headers }).send(he.payload());
    }
  }

  private finish(): void {
    const { hub, key, usage, finalCandidate, status, errorCode } = this;
    if (this.keepalive) clearInterval(this.keepalive);
    const latency = Date.now() - this.started;
    const isError = (status >= 400 && status !== 499) || (errorCode !== null && errorCode !== 'client_closed_request');
    try {
      if (finalCandidate && (usage || isError || status === 499)) {
        hub.usage.record(dayKey(hub.clock(), hub.config.usageTz), key.id, finalCandidate.model.id, {
          requests: 1,
          errors: isError ? 1 : 0,
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
        });
      }
      hub.usage.log({
        ts: new Date(this.started).toISOString(),
        requestId: this.requestId,
        keyId: key.id,
        keyName: key.name,
        endpoint: this.endpoint === 'chat' ? '/v1/chat/completions' : '/v1/embeddings',
        requestedModel: this.requestedModel,
        modelId: finalCandidate?.model.id ?? null,
        providerId: finalCandidate?.provider.id ?? null,
        status,
        errorCode,
        stream: this.stream,
        priority: this.priority,
        localOnly: this.localOnly,
        tag: this.tag,
        attempts: this.attempts,
        queueMs: this.queueMs || null,
        ttfbMs: this.ttfbMs,
        latencyMs: latency,
        usage,
      });
    } catch (e) {
      hub.log.error({ requestId: this.requestId, err: e instanceof Error ? e.message : String(e) }, 'could not record usage');
    }
    this.admission?.release();
    hub.log.info({ requestId: this.requestId, key: key.name, model: this.requestedModel, served: finalCandidate?.model.id, status, error: errorCode, stream: this.stream, ms: latency, tokens: usage ? usage.inputTokens + usage.outputTokens : undefined }, 'request finished');
  }
}

function toHubError(e: unknown, hub: Hub, requestId: string): HubError {
  if (isHubError(e)) return e;
  hub.log.error({ requestId, err: e instanceof Error ? (e.stack ?? e.message) : String(e) }, 'unexpected error');
  return new HubError({ status: 500, code: 'internal_error', message: 'Internal error in the hub (see its log)' });
}

import { HubError } from '../errors.js';
import type { DiscoveredModel } from '../store/models.js';
import type { ModelFields, Support } from '../types.js';
import { finiteNumber, guessKind, isPlainObject } from '../util.js';
import { fetchJson, readSse, send, upstreamError, type ProviderRuntime } from '../upstream.js';
import { authHeaders, joinUrl } from './common.js';
import { adaptRequestForGemini, isGeminiEndpoint } from './gemini.js';
import type { Adapter, ChatCall, ChatResult, Json, StreamItem } from './types.js';

/**
 * The generic upstream: anything that speaks the OpenAI HTTP API — OpenAI itself, OpenRouter, Gemini's compatibility
 * endpoint, Ollama and LM Studio (/v1), llama.cpp, vLLM, another MindGate, a subscription wrapper.
 *
 * The request goes through almost untouched (unknown parameters reach the upstream); only the model name is replaced
 * and, for streams, usage reporting is switched on so the hub can count tokens. Google's compatibility endpoint is the one
 * exception: its quirks are smoothed over in gemini.ts.
 */

const chatUrl = (rt: ProviderRuntime) => joinUrl(rt.record.baseUrl, rt.record.options.chatPath ?? '/chat/completions');

function buildBody(call: ChatCall): Json {
  const sent = isGeminiEndpoint(call.runtime.record.baseUrl) ? adaptRequestForGemini(call.body) : call.body;
  const body: Json = { ...sent, model: call.model.upstreamId, stream: call.stream };
  if (call.stream) {
    if (call.runtime.record.options.streamUsage !== false) {
      body['stream_options'] = { ...(isPlainObject(call.body['stream_options']) ? call.body['stream_options'] : {}), include_usage: true };
    }
  } else {
    delete body['stream_options'];
  }
  return body;
}

/** DeepSeek, OpenRouter and others disagree on the name; clients read `reasoning_content`. */
function normalizeReasoning(holder: Json | undefined): void {
  if (!holder || typeof holder !== 'object') return;
  if (typeof holder['reasoning'] === 'string' && holder['reasoning_content'] === undefined) holder['reasoning_content'] = holder['reasoning'];
}

function normalizeChunk(chunk: Json): void {
  if (Array.isArray(chunk['choices'])) for (const c of chunk['choices']) normalizeReasoning(c?.delta);
}

function normalizeCompletion(json: Json): void {
  if (Array.isArray(json['choices'])) for (const c of json['choices']) normalizeReasoning(c?.message);
}

function headers(rt: ProviderRuntime, stream: boolean): Record<string, string> {
  return { 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json', ...authHeaders(rt) };
}

/** A few upstreams ignore stream=true and answer with one JSON document; replay it as a one-shot stream. */
function* replayAsStream(json: Json): Generator<StreamItem> {
  normalizeCompletion(json);
  const base = { id: json['id'], object: 'chat.completion.chunk', created: json['created'], model: json['model'] };
  for (const choice of (json['choices'] ?? []) as Json[]) {
    const msg = (choice['message'] ?? {}) as Json;
    const delta: Json = { role: 'assistant' };
    if (msg['content'] != null) delta['content'] = msg['content'];
    if (msg['reasoning_content'] != null) delta['reasoning_content'] = msg['reasoning_content'];
    if (Array.isArray(msg['tool_calls'])) delta['tool_calls'] = msg['tool_calls'].map((t: Json, i: number) => ({ index: i, ...t }));
    yield { kind: 'chunk', chunk: { ...base, choices: [{ index: choice['index'] ?? 0, delta, finish_reason: choice['finish_reason'] ?? 'stop' }] } };
  }
  if (json['usage']) yield { kind: 'chunk', chunk: { ...base, choices: [], usage: json['usage'] } };
}

async function* streamEvents(res: Awaited<ReturnType<typeof send>>, call: ChatCall): AsyncGenerator<StreamItem, void, void> {
  const provider = call.runtime.record.id;
  let sawDone = false;
  let sawFinish = false;
  for await (const ev of readSse(res.body as ReadableStream<Uint8Array> | null, { idleMs: call.runtime.idleTimeoutMs, signal: call.signal, provider })) {
    if (ev.kind === 'comment') {
      yield { kind: 'comment', text: ev.text };
      continue;
    }
    if (ev.data.trim() === '[DONE]') {
      sawDone = true;
      break;
    }
    let chunk: Json;
    try {
      chunk = JSON.parse(ev.data) as Json;
    } catch {
      continue; // a malformed line is not worth failing a whole answer for
    }
    if (isPlainObject(chunk['error'])) {
      const e = chunk['error'] as Json;
      throw new HubError({
        status: 502,
        code: 'upstream_error',
        message: `${provider}: ${typeof e['message'] === 'string' ? e['message'] : 'the upstream reported an error mid-answer'}`,
        extra: { provider, model: call.model.upstreamId },
        fallback: true,
      });
    }
    normalizeChunk(chunk);
    if (Array.isArray(chunk['choices']) && chunk['choices'].some((c: Json) => c?.finish_reason)) sawFinish = true;
    yield { kind: 'chunk', chunk };
  }
  if (!sawDone && !sawFinish) {
    throw new HubError({
      status: 502,
      code: 'upstream_stream_interrupted',
      message: `The answer from "${provider}" ended before it was complete`,
      extra: { provider, model: call.model.upstreamId },
      fallback: true,
    });
  }
}

async function chat(call: ChatCall): Promise<ChatResult> {
  const rt = call.runtime;
  const provider = rt.record;
  const opts = { headers: headers(rt, call.stream), body: JSON.stringify(buildBody(call)), signal: call.signal, timeoutMs: rt.firstByteTimeoutMs };

  if (!call.stream) {
    const { json } = await fetchJson(provider, chatUrl(rt), opts, call.model.upstreamId);
    if (!isPlainObject(json) || !Array.isArray(json['choices'])) {
      throw new HubError({ status: 502, code: 'upstream_invalid_response', message: `Provider "${provider.id}" answered without choices`, extra: { provider: provider.id }, fallback: true });
    }
    normalizeCompletion(json);
    return { stream: false, json };
  }

  const res = await send(provider, chatUrl(rt), opts);
  if (!res.ok) throw await upstreamError(res, provider.id, call.model.upstreamId);
  if ((res.headers.get('content-type') ?? '').includes('application/json')) {
    const json = JSON.parse(await res.text()) as Json;
    return { stream: true, events: (async function* () { yield* replayAsStream(json); })() };
  }
  return { stream: true, events: streamEvents(res, call) };
}

async function embeddings(call: ChatCall): Promise<Json> {
  const rt = call.runtime;
  const body = { ...call.body, model: call.model.upstreamId };
  const { json } = await fetchJson(
    rt.record,
    joinUrl(rt.record.baseUrl, rt.record.options.embeddingsPath ?? '/embeddings'),
    { headers: headers(rt, false), body: JSON.stringify(body), signal: call.signal, timeoutMs: rt.firstByteTimeoutMs },
    call.model.upstreamId,
  );
  if (!isPlainObject(json)) throw new HubError({ status: 502, code: 'upstream_invalid_response', message: `Provider "${rt.record.id}" answered with an unexpected body`, extra: { provider: rt.record.id }, fallback: true });
  return json;
}

const zero = (v: unknown): boolean => (typeof v === 'string' || typeof v === 'number') && Number(v) === 0;

/** Reads one entry of GET /models. OpenAI sends little; OpenRouter, MindGate and others add context length, modalities... */
export function parseModelEntry(raw: unknown): DiscoveredModel | null {
  if (!isPlainObject(raw)) return null;
  const rawId = typeof raw['id'] === 'string' ? raw['id'] : typeof raw['name'] === 'string' ? raw['name'] : '';
  const upstreamId = rawId.trim().replace(/^models\//, '');
  if (!upstreamId || upstreamId.length > 200 || /\s/.test(upstreamId)) return null;

  const f: ModelFields = {};
  const name = typeof raw['name'] === 'string' ? raw['name'].trim().replace(/^models\//, '') : typeof raw['display_name'] === 'string' ? raw['display_name'].trim() : '';
  if (name && name !== upstreamId) f.name = name.slice(0, 120);
  if (typeof raw['description'] === 'string' && raw['description'].trim()) f.description = raw['description'].trim().slice(0, 400);

  const kinds = ['chat', 'embedding', 'image', 'tts', 'stt'];
  f.kind = typeof raw['kind'] === 'string' && kinds.includes(raw['kind']) ? (raw['kind'] as ModelFields['kind']) : guessKind(upstreamId);
  if (Array.isArray(raw['tags'])) f.tags = raw['tags'].filter((t): t is string => typeof t === 'string').slice(0, 16);

  const top = isPlainObject(raw['top_provider']) ? raw['top_provider'] : undefined;
  const ctx = finiteNumber(raw['context_length']) ?? finiteNumber(raw['context_window']) ?? finiteNumber(raw['inputTokenLimit']) ?? finiteNumber(top?.['context_length']);
  if (ctx !== undefined && ctx > 0) f.contextLength = Math.trunc(ctx);
  const out = finiteNumber(top?.['max_completion_tokens']) ?? finiteNumber(raw['max_output_tokens']) ?? finiteNumber(raw['outputTokenLimit']);
  if (out !== undefined && out > 0) f.maxOutputTokens = Math.trunc(out);

  const supports = new Set<Support>();
  let known = false;
  if (Array.isArray(raw['supports'])) {
    known = true;
    for (const s of raw['supports']) if (s === 'tools' || s === 'vision' || s === 'reasoning_effort') supports.add(s);
  }
  if (Array.isArray(raw['supported_parameters'])) {
    known = true;
    const sp = raw['supported_parameters'] as unknown[];
    if (sp.includes('tools')) supports.add('tools');
    if (sp.includes('reasoning') || sp.includes('reasoning_effort') || sp.includes('include_reasoning')) supports.add('reasoning_effort');
  }
  const arch = isPlainObject(raw['architecture']) ? raw['architecture'] : undefined;
  if (Array.isArray(arch?.['input_modalities'])) {
    known = true;
    if ((arch['input_modalities'] as unknown[]).includes('image')) supports.add('vision');
  }
  if (known) f.supports = [...supports];

  if (raw['locality'] === 'local' || raw['locality'] === 'cloud') f.locality = raw['locality'];

  // Prices are not kept (this hub counts tokens, not money). The one thing taken from them: "costs nothing" becomes a tag.
  const price = isPlainObject(raw['pricing']) ? raw['pricing'] : undefined;
  if (price && !f.tags && ((zero(price['prompt']) && zero(price['completion'])) || (zero(price['input']) && zero(price['output'])))) f.tags = ['free'];
  return { upstreamId, fields: f };
}

async function listModels(rt: ProviderRuntime, signal: AbortSignal): Promise<DiscoveredModel[]> {
  const { json } = await fetchJson(
    rt.record,
    joinUrl(rt.record.baseUrl, rt.record.options.modelsPath ?? '/models'),
    { method: 'GET', headers: { Accept: 'application/json', ...authHeaders(rt) }, signal, timeoutMs: Math.min(rt.firstByteTimeoutMs, 30_000) },
    'models',
  );
  const list = Array.isArray(json) ? json : isPlainObject(json) ? ((json['data'] ?? json['models']) as unknown) : undefined;
  if (!Array.isArray(list)) throw new HubError({ status: 502, code: 'upstream_invalid_response', message: `Provider "${rt.record.id}" returned a model list in an unknown format`, extra: { provider: rt.record.id } });
  const out: DiscoveredModel[] = [];
  for (const entry of list) {
    const m = parseModelEntry(entry);
    if (m) out.push(m);
  }
  return out;
}

export const openaiAdapter: Adapter = { chat, embeddings, listModels };

import { HubError } from '../errors.js';
import type { DiscoveredModel } from '../store/models.js';
import type { ModelFields, Support } from '../types.js';
import { isPlainObject } from '../util.js';
import { fetchJson, readSse, send, upstreamError, type ProviderRuntime } from '../upstream.js';
import { AnthropicStreamTranslator, fromAnthropicMessage, toAnthropicRequest } from './anthropic-translate.js';
import { authHeaders, joinUrl } from './common.js';
import type { Adapter, ChatCall, ChatResult, Json, StreamItem } from './types.js';

/** Anthropic's native Messages API, presented to clients as plain OpenAI chat completions. */

const DEFAULT_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

const headers = (rt: ProviderRuntime, stream: boolean): Record<string, string> => ({
  'Content-Type': 'application/json',
  Accept: stream ? 'text/event-stream' : 'application/json',
  'anthropic-version': rt.record.options.anthropicVersion ?? DEFAULT_VERSION,
  ...authHeaders(rt),
});

async function* streamEvents(res: Awaited<ReturnType<typeof send>>, call: ChatCall): AsyncGenerator<StreamItem, void, void> {
  const provider = call.runtime.record.id;
  const translator = new AnthropicStreamTranslator();
  for await (const ev of readSse(res.body as ReadableStream<Uint8Array> | null, { idleMs: call.runtime.idleTimeoutMs, signal: call.signal, provider })) {
    if (ev.kind === 'comment') continue;
    let data: Json;
    try {
      data = JSON.parse(ev.data) as Json;
    } catch {
      continue;
    }
    let chunks: Json[];
    try {
      chunks = translator.push(ev.event, data);
    } catch (e) {
      if (e instanceof HubError) throw new HubError({ status: e.status, code: e.code, message: `${provider}: ${e.message}`, extra: { provider, model: call.model.upstreamId }, fallback: e.fallback, headers: e.headers });
      throw e;
    }
    for (const chunk of chunks) yield { kind: 'chunk', chunk };
  }
  if (!translator.complete) {
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
  const { request } = toAnthropicRequest(call.body, {
    model: call.model.upstreamId,
    stream: call.stream,
    defaultMaxTokens: rt.record.options.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
    maxOutputTokens: call.model.maxOutputTokens,
  });
  const url = joinUrl(rt.record.baseUrl, rt.record.options.chatPath ?? '/messages');
  const opts = { headers: headers(rt, call.stream), body: JSON.stringify(request), signal: call.signal, timeoutMs: rt.firstByteTimeoutMs };

  if (!call.stream) {
    const { json } = await fetchJson(rt.record, url, opts, call.model.upstreamId);
    if (!isPlainObject(json) || json['type'] !== 'message') {
      throw new HubError({ status: 502, code: 'upstream_invalid_response', message: `Provider "${rt.record.id}" answered with something that is not a message`, extra: { provider: rt.record.id }, fallback: true });
    }
    return { stream: false, json: fromAnthropicMessage(json) };
  }
  const res = await send(rt.record, url, opts);
  if (!res.ok) throw await upstreamError(res, rt.record.id, call.model.upstreamId);
  return { stream: true, events: streamEvents(res, call) };
}

async function listModels(rt: ProviderRuntime, signal: AbortSignal): Promise<DiscoveredModel[]> {
  const out: DiscoveredModel[] = [];
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ limit: '1000', ...(after ? { after_id: after } : {}) });
    const { json } = await fetchJson(
      rt.record,
      `${joinUrl(rt.record.baseUrl, rt.record.options.modelsPath ?? '/models')}?${qs}`,
      { method: 'GET', headers: { Accept: 'application/json', ...headers(rt, false) }, signal, timeoutMs: Math.min(rt.firstByteTimeoutMs, 30_000) },
      'models',
    );
    if (!isPlainObject(json) || !Array.isArray(json['data'])) {
      throw new HubError({ status: 502, code: 'upstream_invalid_response', message: `Provider "${rt.record.id}" returned a model list in an unknown format`, extra: { provider: rt.record.id } });
    }
    for (const m of json['data'] as unknown[]) {
      if (!isPlainObject(m) || typeof m['id'] !== 'string') continue;
      const f: ModelFields = { kind: 'chat' };
      if (typeof m['display_name'] === 'string' && m['display_name'] !== m['id']) f.name = m['display_name'];
      if (typeof m['max_input_tokens'] === 'number') f.contextLength = m['max_input_tokens'];
      if (typeof m['max_tokens'] === 'number') f.maxOutputTokens = m['max_tokens'];
      const supports: Support[] = ['tools', 'vision'];
      const thinking = isPlainObject(m['capabilities']) && isPlainObject(m['capabilities']['thinking']) ? m['capabilities']['thinking']['supported'] : undefined;
      if (thinking !== false) supports.push('reasoning_effort');
      f.supports = supports;
      out.push({ upstreamId: m['id'], fields: f });
    }
    if (json['has_more'] === true && typeof json['last_id'] === 'string') after = json['last_id'];
    else break;
  }
  return out;
}

export const anthropicAdapter: Adapter = { chat, listModels };

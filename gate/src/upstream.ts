import { Agent, fetch } from 'undici';
import { HubError } from './errors.js';
import type { ProviderRecord } from './types.js';

/**
 * Everything that talks HTTP to an upstream goes through here, so timeouts, abort handling and error mapping are
 * written once.
 *
 * undici's own header/body timeouts are switched off (they default to 5 minutes, which is shorter than a cold 32B
 * model needs to load); the hub enforces its own: a deadline for the first byte, then a limit on silence between
 * chunks of a stream.
 */
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 15_000 }, keepAliveTimeout: 30_000 });

/** The client went away or the hub is shutting down. Not a failure of the upstream, so nothing falls back from it. */
export class ClientAbort extends Error {
  constructor() {
    super('request aborted by the client');
    this.name = 'ClientAbort';
  }
}

export interface ProviderRuntime {
  record: ProviderRecord;
  secret: string | null;
  firstByteTimeoutMs: number;
  idleTimeoutMs: number;
}

export interface FetchOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  /** Deadline for the response headers. */
  timeoutMs: number;
}

function causeCode(e: unknown): string {
  const err = e as { code?: string; cause?: { code?: string; errors?: Array<{ code?: string }> } } | undefined;
  return err?.cause?.code ?? err?.cause?.errors?.[0]?.code ?? err?.code ?? '';
}

export function unreachable(provider: string, e: unknown): HubError {
  const code = causeCode(e);
  return new HubError({
    status: 502,
    code: 'upstream_unreachable',
    message: `Provider "${provider}" is not reachable${code ? ` (${code})` : ''}`,
    extra: { provider },
    fallback: true,
  });
}

export function timedOut(provider: string, what: string): HubError {
  return new HubError({ status: 504, code: 'upstream_timeout', message: `Provider "${provider}" ${what}`, extra: { provider }, fallback: true });
}

/**
 * Runs `fn` with a deadline for the owner's own checks (connectivity test, model sync, CLI). A deadline that passes is a
 * timeout of the provider, not "the client went away", and is reported as such.
 */
export async function withDeadline<T>(ms: number, provider: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(ms);
  try {
    return await fn(signal);
  } catch (e) {
    if (e instanceof ClientAbort && signal.aborted) throw timedOut(provider, `did not answer within ${Math.round(ms / 1000)}s`);
    throw e;
  }
}

/** Sends the request and resolves once the response headers are in. The body is still unread. */
export async function send(provider: ProviderRecord, url: string, opts: FetchOptions): Promise<Awaited<ReturnType<typeof fetch>>> {
  if (opts.signal.aborted) throw new ClientAbort();
  const ac = new AbortController();
  let timedOutFlag = false;
  const onAbort = () => ac.abort();
  opts.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOutFlag = true;
    ac.abort();
  }, opts.timeoutMs);
  try {
    return await fetch(url, {
      method: opts.method ?? 'POST',
      headers: opts.headers,
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      signal: ac.signal,
      dispatcher,
    });
  } catch (e) {
    if (opts.signal.aborted) throw new ClientAbort();
    if (timedOutFlag) throw timedOut(provider.id, `did not answer within ${Math.round(opts.timeoutMs / 1000)}s`);
    throw unreachable(provider.id, e);
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener('abort', onAbort);
  }
}

type Res = Awaited<ReturnType<typeof fetch>>;

/** Reads a small body (errors, model lists) with a size cap so a misbehaving upstream cannot fill memory. */
export async function readText(res: Res, maxBytes = 1_000_000): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      chunks.push(value);
      if (size > maxBytes) {
        await reader.cancel();
        break;
      }
    }
  } catch {
    /* a body that breaks halfway is reported by the caller as an empty or partial text */
  }
  return Buffer.concat(chunks).toString('utf8');
}

function retryAfterSeconds(res: Res): string | undefined {
  const raw = res.headers.get('retry-after');
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return raw;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : String(Math.max(1, Math.ceil((at - Date.now()) / 1000)));
}

/** Pulls a human-readable message and the upstream's own error code out of whatever JSON an upstream returns. */
export function describeError(text: string): { message: string; code: string | undefined } {
  try {
    const j = JSON.parse(text) as unknown;
    const o = (Array.isArray(j) ? j[0] : j) as Record<string, unknown> | undefined;
    const err = (o?.['error'] ?? o) as Record<string, unknown> | string | undefined;
    if (typeof err === 'string') return { message: err, code: undefined };
    const message = typeof err?.['message'] === 'string' ? err['message'] : '';
    const code = typeof err?.['code'] === 'string' ? err['code'] : typeof err?.['type'] === 'string' ? err['type'] : undefined;
    if (message) return { message, code };
  } catch {
    /* not JSON */
  }
  return { message: text.trim().slice(0, 300) || 'no details', code: undefined };
}

/**
 * Upstream codes that mean the quota or credit is used up, as opposed to "too fast": `budget_exhausted` (another
 * MindGate, or a wrapper that answers in its format) and OpenAI's `insufficient_quota`.
 */
const QUOTA_CODES = new Set(['budget_exhausted', 'insufficient_quota']);

/** The moment an upstream says its quota comes back (`error.reset_at`, ISO 8601), when it says so. */
export function upstreamResetAt(text: string): string | undefined {
  try {
    const j = JSON.parse(text) as { error?: { reset_at?: unknown } } | undefined;
    const at = j?.error?.reset_at;
    return typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

/** Ollama / llama.cpp messages for a generated tool call that is not valid JSON. */
const TOOL_PARSE_ERROR = /looks like object|can'?t find closing|error parsing tool call|invalid tool call|failed to parse.*tool/i;

/** A 5xx whose body says the real problem was a 4xx of the model server's own (or an unparseable tool call). */
export function embeddedClientStatus(body: string): number | null {
  const m = /\b(?:error|status)\W{0,3}(4\d\d)\b/i.exec(body) ?? /\b(4\d\d)\s+(?:bad request|unprocessable)/i.exec(body);
  if (m) {
    const status = Number(m[1]);
    return status === 408 || status === 429 ? null : status; // those two are worth retrying
  }
  return TOOL_PARSE_ERROR.test(body) ? 400 : null;
}

/**
 * Turns a non-2xx upstream answer into the hub's error.
 *
 * Credentials the upstream rejects are the hub's problem, not the client's, so 401/403 become 502 — a 401 here would
 * look like the *client's* key was wrong. Failures that retrying elsewhere could fix allow a fallback; a request the
 * upstream rejected as invalid does not, because every target would reject it the same way.
 */
export async function upstreamError(res: Res, provider: string, model: string): Promise<HubError> {
  const text = await readText(res, 64_000);
  const { message, code } = describeError(text);
  const detail = `${provider}: ${message}`;
  const extra = { provider, model, upstream_status: res.status };
  const s = res.status;
  if (s === 429) {
    const ra = retryAfterSeconds(res);
    const headers = ra ? { headers: { 'Retry-After': ra } } : {};
    // A used-up subscription or credit is not "slow down": waiting seconds will not help, and the client can show when it comes back.
    if (code && QUOTA_CODES.has(code)) {
      const resetAt = upstreamResetAt(text);
      return new HubError({ status: 429, code: 'upstream_quota_exhausted', message: detail, extra: { ...extra, ...(resetAt ? { reset_at: resetAt } : {}) }, fallback: true, ...headers });
    }
    return new HubError({ status: 429, code: 'upstream_rate_limited', message: detail, extra, fallback: true, ...headers });
  }
  if (s === 401 || s === 403) return new HubError({ status: 502, code: 'upstream_auth_failed', message: `${provider} rejected the credentials stored for it (${message})`, extra, fallback: true });
  if (s === 404) return new HubError({ status: 404, code: 'model_not_found', message: `${provider} does not know the model "${model}" (${message})`, extra, fallback: true });
  if (s === 408 || s === 504) return new HubError({ status: 504, code: 'upstream_timeout', message: detail, extra, fallback: true });
  if (s === 503 || s === 529) return new HubError({ status: 503, code: 'upstream_overloaded', message: detail, extra, fallback: true });
  if (s >= 500) {
    // Ollama and llama.cpp answer 500 for a request that can never succeed (a generated tool call that is not valid JSON).
    // Retrying or failing over would only repeat it, so it is reported as the client error it is.
    const real = embeddedClientStatus(text);
    if (real) return new HubError({ status: 400, code: 'upstream_bad_request', message: detail, extra });
    return new HubError({ status: 502, code: 'upstream_error', message: detail, extra, fallback: true });
  }
  if (s === 400 || s === 413 || s === 422) {
    // Keep the upstream's code when it has a recognisable one (context_length_exceeded, invalid_api_key...) so
    // clients can react to it as they would against the provider directly.
    const safe = code && /^[a-z0-9_.-]{3,64}$/.test(code) ? code : 'upstream_bad_request';
    return new HubError({ status: s === 413 ? 413 : 400, code: safe, message: detail, extra });
  }
  return new HubError({ status: 502, code: 'upstream_error', message: detail, extra, fallback: true });
}

/** A request/response round trip with a JSON body, under one deadline for the whole exchange. */
export async function fetchJson(provider: ProviderRecord, url: string, opts: FetchOptions, model: string): Promise<{ json: unknown; res: Res }> {
  const res = await send(provider, url, opts);
  if (!res.ok) throw await upstreamError(res, provider.id, model);
  const text = await readText(res, 64_000_000);
  try {
    return { json: JSON.parse(text), res };
  } catch {
    throw new HubError({
      status: 502,
      code: 'upstream_invalid_response',
      message: `Provider "${provider.id}" answered with something that is not JSON`,
      extra: { provider: provider.id, model },
      fallback: true,
    });
  }
}

/** One server-sent event: a `data` event, or a comment line (an upstream's keep-alive). */
export type SseEvent = { kind: 'data'; event?: string; data: string } | { kind: 'comment'; text: string };

function parseBlock(block: string): SseEvent | null {
  let event: string | undefined;
  const data: string[] = [];
  const comments: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith(':')) comments.push(line.slice(1).trim());
    else if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(line[5] === ' ' ? 6 : 5));
  }
  if (data.length) return { kind: 'data', ...(event ? { event } : {}), data: data.join('\n') };
  if (comments.length) return { kind: 'comment', text: comments.join(' ') };
  return null;
}

/** Splits a byte stream into SSE events. Gives up with `upstream_timeout` when the stream goes silent for `idleMs`. */
export async function* readSse(body: ReadableStream<Uint8Array> | null, opts: { idleMs: number; signal: AbortSignal; provider: string }): AsyncGenerator<SseEvent, void, void> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const onAbort = () => void reader.cancel().catch(() => undefined);
  opts.signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      let timer: NodeJS.Timeout | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timedOut(opts.provider, `went silent for ${Math.round(opts.idleMs / 1000)}s mid-answer`)), opts.idleMs);
      });
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await Promise.race([reader.read(), stalled]);
      } catch (e) {
        if (opts.signal.aborted) throw new ClientAbort();
        if (e instanceof HubError) throw e;
        throw new HubError({ status: 502, code: 'upstream_stream_interrupted', message: `The connection to "${opts.provider}" broke mid-answer`, extra: { provider: opts.provider }, fallback: true });
      } finally {
        clearTimeout(timer);
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const m = /\r?\n\r?\n/.exec(buf);
        if (!m) break;
        const block = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const ev = parseBlock(block);
        if (ev) yield ev;
      }
    }
    buf += decoder.decode();
    if (buf.trim()) {
      const ev = parseBlock(buf);
      if (ev) yield ev;
    }
  } finally {
    opts.signal.removeEventListener('abort', onAbort);
    void reader.cancel().catch(() => undefined);
  }
}

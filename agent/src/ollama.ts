import type { ChildProcess } from 'node:child_process';
import { Agent, fetch, type Response } from 'undici';
import { AgentError } from './errors.js';
import { findOllamaBinary, killProcess, spawnOllama } from './ollama-process.js';
import type { LoadedModel, PullProgress, Runtime, RuntimeHealth, RuntimeModel } from './runtime.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Ollama's JSON is read field by field, each one checked at runtime
type Json = Record<string, any>;

export interface OllamaOptions {
  url: string;
  binaryPath?: string | undefined;
  manage: boolean;
  startTimeoutMs: number;
  /** Environment given to a process the agent starts. */
  env?: NodeJS.ProcessEnv;
  /** Finds the binary (tests replace it, so a real Ollama on the machine is never started by accident). */
  findBinary?: (explicit: string | undefined, log: (m: string, o?: object) => void) => string | null;
  log?: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; debug: (o: object, m?: string) => void };
}

const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 5000 }, keepAliveTimeout: 30_000 });
const quiet = { info: () => undefined, warn: () => undefined, debug: () => undefined };
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** "abliterated" and "uncensored" are how such models announce themselves in their names. */
export const UNCENSORED = /abliterat|uncensor/i;

/** The Runtime for Ollama: adopts a running server or starts one, and speaks its native API (/api/*). */
export class OllamaRuntime implements Runtime {
  readonly name = 'ollama';
  readonly url: string;
  readonly openaiBase: string;
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private lastError: string | null = null;
  private readonly show = new Map<string, Json | null>(); // by digest: what /api/show said
  private readonly log: NonNullable<OllamaOptions['log']>;

  constructor(private readonly opts: OllamaOptions) {
    this.url = opts.url.replace(/\/+$/, '');
    this.openaiBase = `${this.url}/v1`;
    this.log = opts.log ?? quiet;
  }

  private async reachable(timeoutMs = 2000): Promise<{ ok: boolean; version: string | null }> {
    try {
      const res = await fetch(`${this.url}/api/version`, { dispatcher, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        void res.body?.cancel().catch(() => undefined);
        return { ok: false, version: null };
      }
      const j = (await res.json()) as Json;
      return { ok: true, version: typeof j['version'] === 'string' ? j['version'] : null };
    } catch {
      return { ok: false, version: null };
    }
  }

  ensureRunning(): Promise<void> {
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<void> {
    if ((await this.reachable()).ok) {
      if (!this.child) this.log.info({ url: this.url }, 'adopted a running Ollama');
      this.lastError = null;
      return;
    }
    if (!this.opts.manage) throw this.fail(`Ollama does not answer at ${this.url} and MINDGATE_MANAGE_OLLAMA is off`);

    const binary = (this.opts.findBinary ?? findOllamaBinary)(this.opts.binaryPath, (m, o) => this.log.warn(o ?? {}, m));
    if (!binary) throw this.fail('Ollama is not installed here (install it from https://ollama.com or set OLLAMA_PATH)');

    const host = new URL(this.url).host;
    this.log.info({ binary, host }, 'starting Ollama');
    const proc = spawnOllama(binary, host, this.opts.env ?? process.env, line => this.log.debug({ src: 'ollama' }, line));
    this.child = proc.child;
    let exit: string | null = null;
    void proc.exited.then(why => {
      exit = why;
      if (this.child === proc.child) this.child = null;
      this.log.warn({ why }, 'the Ollama process ended');
    });

    const deadline = Date.now() + this.opts.startTimeoutMs;
    while (Date.now() < deadline) {
      if (exit) throw this.fail(`Ollama ${exit} right after starting`);
      if ((await this.reachable(1000)).ok) {
        this.lastError = null;
        this.log.info({}, 'Ollama is ready');
        return;
      }
      await new Promise(r => setTimeout(r, 250));
    }
    killProcess(proc.child);
    this.child = null;
    throw this.fail(`Ollama did not answer within ${Math.round(this.opts.startTimeoutMs / 1000)}s after it was started`);
  }

  private fail(message: string): AgentError {
    this.lastError = message;
    return new AgentError(503, 'runtime_unavailable', message);
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child) {
      this.log.info({}, 'stopping the Ollama the agent started');
      killProcess(child);
    }
  }

  async health(): Promise<RuntimeHealth> {
    const r = await this.reachable(2000);
    return { ok: r.ok, version: r.version, managed: this.child !== null, error: r.ok ? null : this.lastError ?? `no answer at ${this.url}` };
  }

  private async call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: Json, opts: { timeoutMs?: number; signal?: AbortSignal; stream?: boolean } = {}): Promise<Response> {
    const signals = [AbortSignal.timeout(opts.timeoutMs ?? 30_000)];
    if (opts.signal) signals.push(opts.signal);
    try {
      return await fetch(`${this.url}${path}`, {
        method,
        dispatcher,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : null,
        signal: AbortSignal.any(opts.stream && opts.signal ? [opts.signal] : signals),
      });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      const why = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
      throw new AgentError(503, 'runtime_unavailable', `Ollama does not answer at ${this.url}: ${why}`);
    }
  }

  private async json(method: 'GET' | 'POST' | 'DELETE', path: string, body?: Json, timeoutMs?: number): Promise<Json> {
    const res = await this.call(method, path, body, timeoutMs ? { timeoutMs } : {});
    const text = await res.text();
    if (!res.ok) throw this.mapError(res.status, text);
    if (!text.trim()) return {};
    try {
      const j = JSON.parse(text) as unknown;
      return isObj(j) ? j : {};
    } catch {
      throw new AgentError(502, 'runtime_invalid_response', `Ollama answered ${path} with something that is not JSON`);
    }
  }

  private mapError(status: number, text: string): AgentError {
    let message = text.trim().slice(0, 300);
    try {
      const j = JSON.parse(text) as Json;
      if (typeof j['error'] === 'string') message = j['error'];
    } catch {
      /* plain text */
    }
    if (status === 404) return new AgentError(404, 'model_not_found', message || 'model not found');
    return new AgentError(status >= 500 ? 502 : 400, 'runtime_error', message || `Ollama answered ${status}`);
  }

  async listModels(): Promise<RuntimeModel[]> {
    const tags = await this.json('GET', '/api/tags');
    const raw = Array.isArray(tags['models']) ? (tags['models'] as unknown[]).filter(isObj) : [];
    const out: RuntimeModel[] = new Array(raw.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let i = next++; i < raw.length; i = next++) out[i] = await this.describe(raw[i]!);
    };
    await Promise.all(Array.from({ length: Math.min(4, raw.length) }, worker));
    return out;
  }

  /** One /api/tags entry, completed with what /api/show knows (cached by digest: a model's facts do not change). */
  private async describe(entry: Json): Promise<RuntimeModel> {
    const id = String(entry['name'] ?? entry['model'] ?? '');
    const digest = typeof entry['digest'] === 'string' ? entry['digest'] : null;
    const details = isObj(entry['details']) ? entry['details'] : {};

    let info: Json | null | undefined = digest ? this.show.get(digest) : undefined;
    if (info === undefined) {
      try {
        info = await this.json('POST', '/api/show', { model: id, name: id }, 15_000);
      } catch (e) {
        this.log.warn({ model: id, err: e instanceof Error ? e.message : String(e) }, 'could not read the details of a model');
        info = null;
      }
      if (digest && info) this.show.set(digest, info);
    }

    const caps = info && Array.isArray(info['capabilities']) ? (info['capabilities'] as unknown[]).filter((c): c is string => typeof c === 'string') : null;
    const mi = info && isObj(info['model_info']) ? info['model_info'] : {};
    const arch = typeof mi['general.architecture'] === 'string' ? mi['general.architecture'] : undefined;
    const ctx = arch && typeof mi[`${arch}.context_length`] === 'number' ? (mi[`${arch}.context_length`] as number) : null;
    const family = typeof details['family'] === 'string' ? details['family'] : arch ?? null;
    const families = Array.isArray(details['families']) ? (details['families'] as unknown[]) : [];

    let kind: RuntimeModel['kind'] = 'chat';
    if (caps) {
      if (caps.includes('embedding') && !caps.includes('completion')) kind = 'embedding';
    } else if (/bert/i.test(String(family)) || /embed/i.test(id)) {
      kind = 'embedding';
    }

    // Old Ollama does not list capabilities; a CLIP projector in the families is still a sure sign of vision.
    const capabilities = caps ?? (families.includes('clip') ? ['completion', 'vision'] : null);

    const tags: string[] = [];
    if (UNCENSORED.test(id)) tags.push('uncensored');

    return {
      id,
      sizeBytes: typeof entry['size'] === 'number' ? entry['size'] : null,
      digest,
      modifiedAt: typeof entry['modified_at'] === 'string' ? entry['modified_at'] : null,
      family: family || null,
      parameterSize: typeof details['parameter_size'] === 'string' ? details['parameter_size'] : null,
      quantization: typeof details['quantization_level'] === 'string' ? details['quantization_level'] : null,
      contextLength: ctx,
      capabilities,
      kind,
      tags,
    };
  }

  async loaded(): Promise<LoadedModel[]> {
    const ps = await this.json('GET', '/api/ps', undefined, 5000);
    const list = Array.isArray(ps['models']) ? (ps['models'] as unknown[]).filter(isObj) : [];
    return list.map(m => ({
      id: String(m['name'] ?? m['model'] ?? ''),
      sizeBytes: typeof m['size'] === 'number' ? m['size'] : null,
      vramBytes: typeof m['size_vram'] === 'number' ? m['size_vram'] : null,
      expiresAt: typeof m['expires_at'] === 'string' ? m['expires_at'] : null,
    }));
  }

  async pull(name: string, onProgress: (p: PullProgress) => void, signal: AbortSignal): Promise<void> {
    const res = await this.call('POST', '/api/pull', { model: name, name, stream: true }, { signal, stream: true });
    if (!res.ok) throw this.mapError(res.status, await res.text());
    if (!res.body) throw new AgentError(502, 'runtime_invalid_response', 'Ollama sent no progress for the download');

    // Ollama reports each layer (blob) separately; the total is the sum over the layers seen so far.
    const layers = new Map<string, { total: number; completed: number }>();
    let success = false;
    const handle = (line: string): void => {
      if (!line.trim()) return;
      let j: Json;
      try {
        j = JSON.parse(line) as Json;
      } catch {
        return;
      }
      if (typeof j['error'] === 'string') throw new AgentError(502, 'pull_failed', j['error']);
      const status = typeof j['status'] === 'string' ? j['status'] : '';
      if (status === 'success') success = true;
      if (typeof j['digest'] === 'string' && typeof j['total'] === 'number') {
        layers.set(j['digest'], { total: j['total'], completed: typeof j['completed'] === 'number' ? j['completed'] : (layers.get(j['digest'])?.completed ?? 0) });
      }
      let total = 0;
      let completed = 0;
      for (const l of layers.values()) {
        total += l.total;
        completed += l.completed;
      }
      onProgress({ phase: status, completed: layers.size ? completed : null, total: layers.size ? total : null });
    };

    const decoder = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk as Uint8Array, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          handle(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      }
      handle(buf + decoder.decode());
    } catch (e) {
      if (signal.aborted) throw e;
      if (e instanceof AgentError) throw e;
      throw new AgentError(502, 'pull_failed', `The download was interrupted: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!success) throw new AgentError(502, 'pull_failed', 'Ollama ended the download without confirming it');
    this.show.clear();
  }

  async remove(name: string): Promise<void> {
    await this.json('DELETE', '/api/delete', { model: name, name });
    this.show.clear();
  }

  /** Embedding models cannot "generate", so they are loaded and unloaded through /api/embed. */
  private async isEmbedding(name: string): Promise<boolean> {
    try {
      return (await this.listModels()).find(m => m.id === name)?.kind === 'embedding';
    } catch {
      return false;
    }
  }

  async load(name: string, keepAlive?: string): Promise<void> {
    const ka = keepAlive === undefined ? {} : { keep_alive: /^-?\d+$/.test(keepAlive) ? Number(keepAlive) : keepAlive };
    if (await this.isEmbedding(name)) await this.json('POST', '/api/embed', { model: name, input: ' ', ...ka }, 600_000);
    else await this.json('POST', '/api/generate', { model: name, ...ka }, 600_000);
  }

  async unload(name: string): Promise<void> {
    if (await this.isEmbedding(name)) await this.json('POST', '/api/embed', { model: name, input: ' ', keep_alive: 0 }, 60_000);
    else await this.json('POST', '/api/generate', { model: name, keep_alive: 0 }, 60_000);
  }
}

import { authHeaders, joinUrl } from './adapters/common.js';
import { HubError, badRequest } from './errors.js';
import type { NodeManager } from './node.js';
import type { Registry } from './registry.js';
import type { ProviderStore } from './store/providers.js';
import type { ModelSync } from './sync.js';
import type { ProviderRecord } from './types.js';
import { readText, send } from './upstream.js';
import { isPlainObject, sleep } from './util.js';

/**
 * Talks to the MindGate agent on a node: what is on the machine, downloading and removing models, loading them
 * into memory, switching the machine off. The agent has its own small API for this (`/node/*`, docs/05-nodes.md).
 *
 * The provider's credentials are the node secret. Nothing here wakes a sleeping machine: a person looking at the
 * panel should see that it sleeps and decide, not have the page itself power the PC on.
 */

export type Json = Record<string, unknown>;

export interface PullJob extends Json {
  id: string;
  name: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
}

const FINISHED = new Set(['succeeded', 'failed', 'cancelled']);

/** Path of a model name in a URL: slashes stay, everything else is escaped ("hf.co/a/b:Q4" -> "hf.co/a/b%3AQ4"). */
const modelPath = (name: string): string => name.split('/').map(encodeURIComponent).join('/');

export class NodeClient {
  /** Downloads whose result was already put into the model catalog (provider/job). */
  private readonly synced = new Set<string>();
  private readonly watching = new Set<string>();
  private readonly stopper = new AbortController();

  constructor(
    private readonly providers: ProviderStore,
    private readonly registry: Registry,
    private readonly nodes: NodeManager,
    private readonly sync: ModelSync,
    private readonly log: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void },
    private readonly pollMs = 2000,
  ) {}

  stop(): void {
    this.stopper.abort();
  }

  /** Where the agent listens, or a clear refusal when the provider has none. */
  controlBase(provider: ProviderRecord): string {
    const url = provider.node?.controlUrl;
    if (!url) {
      throw badRequest('no_agent', `"${provider.id}" has no MindGate agent configured. Set node.control_url (for example http://pc.lan:3001) to manage its models from here.`);
    }
    return url;
  }

  private async call(provider: ProviderRecord, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, timeoutMs = 15_000): Promise<Json> {
    const url = joinUrl(this.controlBase(provider), path);
    const rt = this.registry.runtime(provider);
    const res = await send(provider, url, {
      method,
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...authHeaders(rt) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: new AbortController().signal,
      timeoutMs,
    });
    const text = await readText(res, 8_000_000);
    if (!res.ok) throw agentError(res.status, text, provider);
    this.nodes.markUp(provider.id);
    if (!text.trim()) return {};
    try {
      const j = JSON.parse(text) as unknown;
      return isPlainObject(j) ? (j as Json) : {};
    } catch {
      throw new HubError({ status: 502, code: 'agent_invalid_response', message: `The agent on "${provider.id}" answered ${path} with something that is not JSON`, extra: { provider: provider.id } });
    }
  }

  status(provider: ProviderRecord): Promise<Json> {
    return this.call(provider, 'GET', '/node/status', undefined, 10_000);
  }

  async models(provider: ProviderRecord): Promise<Json[]> {
    const r = await this.call(provider, 'GET', '/node/models', undefined, 60_000);
    return Array.isArray(r['data']) ? (r['data'] as Json[]) : [];
  }

  async pulls(provider: ProviderRecord): Promise<PullJob[]> {
    const r = await this.call(provider, 'GET', '/node/pulls');
    const jobs = Array.isArray(r['data']) ? (r['data'] as PullJob[]) : [];
    for (const j of jobs) void this.afterFinished(provider, j);
    return jobs;
  }

  async pull(provider: ProviderRecord, name: string): Promise<PullJob> {
    const job = (await this.call(provider, 'POST', '/node/pulls', { name })) as PullJob;
    this.watch(provider, job.id);
    return job;
  }

  async pullStatus(provider: ProviderRecord, id: string): Promise<PullJob> {
    const job = (await this.call(provider, 'GET', `/node/pulls/${encodeURIComponent(id)}`)) as PullJob;
    void this.afterFinished(provider, job);
    return job;
  }

  cancelPull(provider: ProviderRecord, id: string): Promise<Json> {
    return this.call(provider, 'DELETE', `/node/pulls/${encodeURIComponent(id)}`);
  }

  /** Removes a model from the machine and from the catalog. */
  async removeModel(provider: ProviderRecord, name: string): Promise<Json> {
    const r = await this.call(provider, 'DELETE', `/node/models/${modelPath(name)}`, undefined, 60_000);
    await this.refresh(provider);
    return r;
  }

  load(provider: ProviderRecord, name: string, keepAlive?: string | number): Promise<Json> {
    return this.call(provider, 'POST', '/node/models/load', { name, ...(keepAlive !== undefined ? { keep_alive: keepAlive } : {}) }, 10 * 60_000);
  }

  unload(provider: ProviderRecord, name: string): Promise<Json> {
    return this.call(provider, 'POST', '/node/models/unload', { name }, 60_000);
  }

  /** A person's decision (`force`) or the same checks as an idle shutdown. */
  async shutdown(provider: ProviderRecord, force: boolean): Promise<Json> {
    const r = await this.call(provider, 'POST', '/node/power/shutdown', { force }, 20_000);
    if (r['allow'] === true) this.nodes.wentToSleep(provider.id);
    return r;
  }

  /** Brings the catalog in step with the machine. Best effort: the node's own answer is what matters to the caller. */
  async refresh(provider: ProviderRecord): Promise<void> {
    try {
      await this.sync.syncOne(provider.id);
    } catch (e) {
      this.log.warn({ provider: provider.id, err: e instanceof Error ? e.message : String(e) }, 'could not refresh the model list after a change on the node');
    }
  }

  /** A finished download puts its model into the catalog — once. */
  private async afterFinished(provider: ProviderRecord, job: PullJob): Promise<void> {
    if (job.status !== 'succeeded') return;
    const key = `${provider.id}/${job.id}`;
    if (this.synced.has(key)) return;
    this.synced.add(key);
    await this.refresh(provider);
  }

  /** Follows a download the hub started, so the model shows up in the catalog even if nobody has the panel open. */
  private watch(provider: ProviderRecord, jobId: string): void {
    const key = `${provider.id}/${jobId}`;
    if (this.watching.has(key)) return;
    this.watching.add(key);
    void (async () => {
      let failures = 0;
      try {
        for (;;) {
          await sleep(this.pollMs, this.stopper.signal);
          const current = this.providers.get(provider.id);
          if (!current?.node?.controlUrl) return;
          try {
            const job = (await this.call(current, 'GET', `/node/pulls/${encodeURIComponent(jobId)}`)) as PullJob;
            failures = 0;
            if (FINISHED.has(job.status)) {
              await this.afterFinished(current, job);
              return;
            }
          } catch (e) {
            // the machine may be restarting; give up when it stays gone or the agent has forgotten the job
            if (e instanceof HubError && e.status === 404) return;
            if (++failures >= 30) return;
          }
        }
      } catch {
        /* the hub is stopping */
      } finally {
        this.watching.delete(key);
      }
    })();
  }
}

/** The agent's `{error:{message,code}}` as the hub's own error. */
export function agentError(status: number, text: string, provider: ProviderRecord): HubError {
  let message = text.trim().slice(0, 300) || `answered ${status}`;
  let code: string | undefined;
  try {
    const j = JSON.parse(text) as { error?: { message?: unknown; code?: unknown } };
    if (typeof j.error?.message === 'string') message = j.error.message;
    if (typeof j.error?.code === 'string') code = j.error.code;
  } catch {
    /* plain text */
  }
  const extra = { provider: provider.id };
  if (status === 401 || status === 403) {
    return new HubError({ status: 502, code: 'node_auth_failed', message: `The agent on "${provider.id}" rejected the node secret stored for this provider`, extra });
  }
  if (status === 404 && code && code !== 'unknown_endpoint') return new HubError({ status: 404, code, message, extra });
  if (status === 404) {
    return new HubError({ status: 502, code: 'agent_missing', message: `"${provider.id}" does not answer like a MindGate agent (${message}). Is the agent running, and is node.control_url its address?`, extra });
  }
  if (status >= 500) return new HubError({ status: status === 503 ? 503 : 502, code: code ?? 'agent_error', message: `${provider.id}: ${message}`, extra });
  return new HubError({ status: status === 413 ? 413 : 400, code: code ?? 'agent_rejected', message: `${provider.id}: ${message}`, extra });
}

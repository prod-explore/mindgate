import dgram from 'node:dgram';
import { authHeaders, joinUrl } from './adapters/common.js';
import { HubError } from './errors.js';
import type { Registry } from './registry.js';
import type { ProviderStore } from './store/providers.js';
import type { NodeConfig, ProviderRecord } from './types.js';
import { ClientAbort, send } from './upstream.js';
import { sleep } from './util.js';

/**
 * A "node" is a provider on a machine that sleeps — the PC with the GPU. The hub keeps track of whether it is up,
 * wakes it with a Wake-on-LAN packet when a request needs it, and (if configured) asks it to shut down after a while
 * without work.
 *
 * Only requests that need that provider wait for the machine. A request for a cloud model never does.
 */

export type NodeStatus = 'online' | 'asleep' | 'waking' | 'unknown';

interface State {
  status: NodeStatus;
  lastProbeAt: number;
  lastActivityAt: number;
  inflight: number;
  waking: Promise<void> | null;
  lastError: string | null;
  /** After the node said "not now" to a shutdown, the hub does not ask again before this moment. */
  shutdownRetryAt: number;
}

/** How long a successful probe or request is trusted before the next request probes again. */
const TRUST_MS = 30_000;
const MONITOR_MS = 30_000;
const RESEND_MAGIC_MS = 10_000;
/** How long to leave a node alone after it refused a shutdown (someone is using it, a download is running...). */
const SHUTDOWN_RETRY_MS = 5 * 60_000;

/** The URL that answers while the machine is up. */
export function healthUrlOf(provider: ProviderRecord): string {
  const cfg = provider.node;
  if (cfg?.healthUrl) return cfg.healthUrl;
  if (cfg?.controlUrl) return joinUrl(cfg.controlUrl, '/health');
  return joinUrl(provider.baseUrl, provider.options.modelsPath ?? '/models');
}

/** The URL the hub asks "may I switch you off?" at, if any. */
export function shutdownUrlOf(provider: ProviderRecord): string | undefined {
  const cfg = provider.node;
  if (cfg?.shutdownUrl) return cfg.shutdownUrl;
  return cfg?.controlUrl ? joinUrl(cfg.controlUrl, '/node/power/shutdown-request') : undefined;
}

export function magicPacket(mac: string): Buffer {
  const bytes = Buffer.from(mac.split(/[:-]/).map(h => parseInt(h, 16)));
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => bytes)]);
}

export function sendMagicPacket(cfg: Pick<NodeConfig, 'mac' | 'broadcast' | 'port'>): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', err => {
      socket.close();
      reject(err);
    });
    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
      } catch {
        /* unicast targets do not need it */
      }
      socket.send(magicPacket(cfg.mac), cfg.port, cfg.broadcast, err => {
        socket.close();
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

export interface NodeDeps {
  sendMagic?: (cfg: NodeConfig) => Promise<void>;
  log?: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };
  now?: () => number;
}

export class NodeManager {
  private readonly states = new Map<string, State>();
  private timer: NodeJS.Timeout | null = null;
  private readonly sendMagic: (cfg: NodeConfig) => Promise<void>;
  private readonly now: () => number;
  private readonly log: NonNullable<NodeDeps['log']>;

  constructor(
    private readonly providers: ProviderStore,
    private readonly registry: Registry,
    deps: NodeDeps = {},
  ) {
    this.sendMagic = deps.sendMagic ?? sendMagicPacket;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? { info: () => undefined, warn: () => undefined };
    providers.onChange(id => {
      const p = this.providers.get(id);
      if (!p?.node) this.states.delete(id);
    });
  }

  private state(id: string): State {
    let s = this.states.get(id);
    if (!s) {
      s = { status: 'unknown', lastProbeAt: 0, lastActivityAt: this.now(), inflight: 0, waking: null, lastError: null, shutdownRetryAt: 0 };
      this.states.set(id, s);
    }
    return s;
  }

  /** online / asleep / waking for a node; undefined for a provider that is not a node. */
  status(provider: ProviderRecord): NodeStatus | undefined {
    return provider.node ? this.state(provider.id).status : undefined;
  }

  lastError(providerId: string): string | null {
    return this.states.get(providerId)?.lastError ?? null;
  }

  /** A request started or finished on this node: keeps the idle-shutdown clock honest. */
  begin(providerId: string): void {
    const s = this.state(providerId);
    s.inflight++;
    s.lastActivityAt = this.now();
  }

  end(providerId: string): void {
    const s = this.state(providerId);
    s.inflight = Math.max(0, s.inflight - 1);
    s.lastActivityAt = this.now();
  }

  /** The node answered a real request: it is up. */
  markUp(providerId: string): void {
    const s = this.state(providerId);
    s.status = 'online';
    s.lastProbeAt = this.now();
    s.lastError = null;
  }

  /** A real request found the node gone (power cut, crash, sleep). */
  markDown(providerId: string, why?: string): void {
    const s = this.state(providerId);
    s.status = 'asleep';
    s.lastProbeAt = 0;
    if (why) s.lastError = why;
  }

  /** Asks the node whether it is there. Any HTTP answer below 500 counts: the machine and its server are up. */
  async probe(provider: ProviderRecord): Promise<boolean> {
    const cfg = provider.node;
    if (!cfg) return true;
    const s = this.state(provider.id);
    const url = healthUrlOf(provider);
    let alive = false;
    try {
      const rt = this.registry.runtime(provider);
      const res = await send(provider, url, {
        method: 'GET',
        headers: { Accept: '*/*', ...authHeaders(rt) },
        signal: new AbortController().signal,
        timeoutMs: 5000,
      });
      void res.body?.cancel().catch(() => undefined);
      alive = res.status < 500;
      s.lastError = alive ? null : `health check answered ${res.status}`;
    } catch (e) {
      s.lastError = e instanceof Error ? e.message : String(e);
    }
    s.lastProbeAt = this.now();
    if (alive) {
      if (s.status !== 'online') this.log.info({ provider: provider.id }, 'node is online');
      s.status = 'online';
    } else if (s.status !== 'waking') {
      if (s.status === 'online') this.log.warn({ provider: provider.id }, 'node went away');
      s.status = 'asleep';
    }
    return alive;
  }

  /**
   * Makes sure the node can take a request, waking it if that is allowed for this priority.
   * Low-priority requests do not wake the machine: they fail fast with `node_asleep`, which lets a fallback answer.
   */
  async ensure(provider: ProviderRecord, priority: number, signal: AbortSignal): Promise<void> {
    const cfg = provider.node;
    if (!cfg) return;
    const s = this.state(provider.id);
    if (s.status === 'online' && this.now() - s.lastProbeAt < TRUST_MS) return;
    if (s.waking) return raceAbort(s.waking, signal);
    if (await this.probe(provider)) return;
    if (priority < cfg.minWakePriority) {
      throw new HubError({
        status: 503,
        code: 'node_asleep',
        message: `"${provider.name}" is asleep and requests of priority ${priority} do not wake it (the minimum is ${cfg.minWakePriority}). Retry with a higher X-MindGate-Priority, or wake it first.`,
        extra: { provider: provider.id },
        fallback: true,
      });
    }
    return raceAbort(this.wake(provider), signal);
  }

  /** Sends Wake-on-LAN and waits for the node to answer. One wake serves every request waiting for it. */
  wake(provider: ProviderRecord): Promise<void> {
    const cfg = provider.node;
    if (!cfg) return Promise.resolve();
    const s = this.state(provider.id);
    if (s.waking) return s.waking;
    s.status = 'waking';
    s.lastError = null;
    const run = async () => {
      const started = this.now();
      let lastMagic = 0;
      this.log.info({ provider: provider.id, mac: cfg.mac }, 'waking node');
      try {
        while (this.now() - started < cfg.bootTimeoutMs) {
          if (this.now() - lastMagic >= RESEND_MAGIC_MS || lastMagic === 0) {
            lastMagic = this.now();
            try {
              await this.sendMagic(cfg);
            } catch (e) {
              throw new HubError({
                status: 503,
                code: 'wol_failed',
                message: `Could not send the Wake-on-LAN packet for "${provider.name}": ${e instanceof Error ? e.message : String(e)}`,
                extra: { provider: provider.id },
                fallback: true,
              });
            }
          }
          await sleep(cfg.pollIntervalMs);
          if (await this.probeDuringWake(provider)) {
            this.log.info({ provider: provider.id, seconds: Math.round((this.now() - started) / 1000) }, 'node woke up');
            return;
          }
        }
        s.status = 'asleep';
        throw new HubError({
          status: 503,
          code: 'node_unavailable',
          message: `"${provider.name}" did not come online within ${Math.round(cfg.bootTimeoutMs / 1000)}s after Wake-on-LAN`,
          extra: { provider: provider.id },
          fallback: true,
        });
      } catch (e) {
        if (s.status === 'waking') s.status = 'asleep';
        throw e;
      } finally {
        s.waking = null;
      }
    };
    s.waking = run();
    s.waking.catch(() => undefined); // the callers that await it report the failure; this keeps an unwatched one quiet
    return s.waking;
  }

  private async probeDuringWake(provider: ProviderRecord): Promise<boolean> {
    this.state(provider.id).status = 'waking';
    return this.probe(provider);
  }

  /** Starts watching nodes: refreshes their status and shuts down the ones that sat idle too long. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), MONITOR_MS);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    for (const p of this.providers.list()) {
      if (!p.node || !p.enabled) continue;
      const s = this.state(p.id);
      if (s.waking) continue;
      await this.probe(p);
      const idleMin = p.node.idleShutdownMinutes;
      if (idleMin && s.status === 'online' && s.inflight === 0 && this.now() >= s.shutdownRetryAt && this.now() - s.lastActivityAt >= idleMin * 60_000) {
        await this.requestShutdown(p, Math.floor((this.now() - s.lastActivityAt) / 60_000));
      }
    }
  }

  /**
   * Asks the node's agent to shut the machine down. The agent may say no (someone is using the PC, a download is
   * running): only a "yes" counts as a shutdown, and after a "no" the hub leaves the node alone for a while.
   */
  async requestShutdown(provider: ProviderRecord, idleMinutes: number): Promise<boolean> {
    const url = shutdownUrlOf(provider);
    if (!url) return false;
    const s = this.state(provider.id);
    try {
      const rt = this.registry.runtime(provider);
      const res = await send(provider, url, {
        headers: { 'Content-Type': 'application/json', ...authHeaders(rt) },
        body: JSON.stringify({ idle_minutes: idleMinutes }),
        signal: new AbortController().signal,
        timeoutMs: 10_000,
      });
      const verdict = res.ok ? await readVerdict(res) : { allow: false, reason: `answered ${res.status}` };
      if (!res.ok) void res.body?.cancel().catch(() => undefined);
      this.log.info({ provider: provider.id, status: res.status, idleMinutes, allow: verdict.allow, reason: verdict.reason }, verdict.allow ? 'the node is shutting down' : 'the node did not shut down');
      if (verdict.allow) this.wentToSleep(provider.id);
      else s.shutdownRetryAt = this.now() + SHUTDOWN_RETRY_MS;
      return verdict.allow;
    } catch (e) {
      s.shutdownRetryAt = this.now() + SHUTDOWN_RETRY_MS;
      this.log.warn({ provider: provider.id, err: e instanceof Error ? e.message : String(e) }, 'shutdown request failed');
      return false;
    }
  }

  /** The node agreed to shut down: forget that it was up, so the next request probes (and wakes it) instead of trusting a stale state. */
  wentToSleep(providerId: string): void {
    const s = this.state(providerId);
    s.status = 'unknown';
    s.lastProbeAt = 0;
  }
}

/** Lets one waiting request stop waiting without cancelling the wake that other requests are waiting for. */
function raceAbort(p: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new ClientAbort());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new ClientAbort());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      e => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** The agent answers `{allow, reason}`. An endpoint that just says 200 (a custom script) is taken as "yes". */
async function readVerdict(res: Awaited<ReturnType<typeof send>>): Promise<{ allow: boolean; reason: string | null }> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    /* an unreadable body from a 2xx answer */
  }
  try {
    const j = JSON.parse(text) as { allow?: unknown; reason?: unknown };
    if (typeof j.allow === 'boolean') return { allow: j.allow, reason: typeof j.reason === 'string' ? j.reason : null };
  } catch {
    /* not JSON */
  }
  return { allow: true, reason: null };
}

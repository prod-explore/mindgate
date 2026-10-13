import { adapterFor } from './adapters/index.js';
import type { NodeManager } from './node.js';
import type { Registry } from './registry.js';
import type { ModelStore } from './store/models.js';
import type { ProviderStore } from './store/providers.js';
import { HubError, notFound } from './errors.js';

export interface SyncResult {
  provider: string;
  added: number;
  updated: number;
  absent: number;
}

/** Keeps the hub's model catalog in step with what each upstream lists at GET /models. */
export class ModelSync {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly providers: ProviderStore,
    private readonly models: ModelStore,
    private readonly registry: Registry,
    private readonly nodes: NodeManager,
    private readonly log: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void },
  ) {}

  /** Throws on failure (and remembers the failure on the provider) so an admin request can report it. */
  async syncOne(providerId: string, signal: AbortSignal = new AbortController().signal): Promise<SyncResult> {
    const provider = this.providers.get(providerId);
    if (!provider) throw notFound('provider_not_found', `No provider "${providerId}"`);
    try {
      const adapter = adapterFor(provider.type);
      const found = await adapter.listModels(this.registry.runtime(provider), signal);
      const r = this.models.syncProvider(provider.id, found, { autoEnable: provider.options.autoEnableModels !== false });
      this.providers.setSyncResult(provider.id, null);
      this.log.info({ provider: provider.id, ...r }, 'models synced');
      return { provider: provider.id, ...r };
    } catch (e) {
      const message = e instanceof HubError ? e.message : e instanceof Error ? e.message : String(e);
      this.providers.setSyncResult(provider.id, message);
      throw e;
    }
  }

  /** Every enabled provider, one after another; a sleeping node is left alone rather than woken for a model list. */
  async syncAll(opts: { onlyNeverSynced?: boolean } = {}): Promise<void> {
    for (const p of this.providers.list()) {
      if (!p.enabled) continue;
      if (opts.onlyNeverSynced && p.modelsSyncedAt) continue;
      if (p.node && this.nodes.status(p) !== 'online') {
        if (!(await this.nodes.probe(p))) continue;
      }
      try {
        await this.syncOne(p.id);
      } catch (e) {
        this.log.warn({ provider: p.id, err: e instanceof Error ? e.message : String(e) }, 'model sync failed');
      }
    }
  }

  start(intervalHours: number): void {
    void this.syncAll({ onlyNeverSynced: true });
    if (intervalHours <= 0 || this.timer) return;
    this.timer = setInterval(() => void this.syncAll(), intervalHours * 3_600_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

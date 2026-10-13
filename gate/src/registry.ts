import type { HubConfig } from './config.js';
import { HubError } from './errors.js';
import { SecretError } from './crypto.js';
import { PriorityLimiter } from './queue.js';
import type { ProviderStore } from './store/providers.js';
import type { ProviderRecord } from './types.js';
import type { ProviderRuntime } from './upstream.js';

/** Turns stored providers into what the request path needs: decrypted key, timeouts, concurrency limiter. */
export class Registry {
  private readonly limiters = new Map<string, PriorityLimiter>();

  constructor(
    private readonly providers: ProviderStore,
    private readonly config: HubConfig,
  ) {
    providers.onChange(id => this.limiters.delete(id));
  }

  runtime(provider: ProviderRecord): ProviderRuntime {
    let secret: string | null;
    try {
      secret = this.providers.secret(provider.id);
    } catch (e) {
      if (e instanceof SecretError) {
        throw new HubError({
          status: 502,
          code: 'provider_secret_unreadable',
          message: `The API key stored for "${provider.id}" cannot be decrypted (was MINDGATE_MASTER_KEY changed?). Enter the key again.`,
          extra: { provider: provider.id },
        });
      }
      throw e;
    }
    return {
      record: provider,
      secret,
      firstByteTimeoutMs: provider.options.firstByteTimeoutMs ?? this.config.defaultFirstByteTimeoutMs,
      idleTimeoutMs: provider.options.idleTimeoutMs ?? this.config.defaultIdleTimeoutMs,
    };
  }

  /** The waiting line for a provider that limits concurrency; null for one that does not. */
  limiter(provider: ProviderRecord): PriorityLimiter | null {
    if (provider.maxConcurrency === null) return null;
    let l = this.limiters.get(provider.id);
    if (!l || l.max !== provider.maxConcurrency) {
      l = new PriorityLimiter(provider.maxConcurrency, this.config.queueMax, this.config.queueTimeoutMs, provider.id);
      this.limiters.set(provider.id, l);
    }
    return l;
  }

  queueState(providerId: string): { running: number; queued: number } {
    const l = this.limiters.get(providerId);
    return { running: l?.running ?? 0, queued: l?.queued ?? 0 };
  }
}

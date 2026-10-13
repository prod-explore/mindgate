import { HubError } from './errors.js';
import { ClientAbort } from './upstream.js';

export type Release = () => void;

interface Waiter {
  priority: number;
  grant: () => void;
  fail: (e: Error) => void;
  timer: NodeJS.Timeout | null;
  onAbort: () => void;
  signal: AbortSignal;
}

/**
 * A limit on how many requests a provider handles at once, with a waiting line ordered by priority (5 first), first
 * come first served within a priority. Used for providers that can only do so much at a time — one GPU, one model.
 * Providers without a limit never queue.
 */
export class PriorityLimiter {
  private active = 0;
  private readonly waiting: Waiter[] = [];

  constructor(
    readonly max: number,
    private readonly maxQueue: number,
    private readonly timeoutMs: number,
    private readonly provider: string,
  ) {}

  get running(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  acquire(priority: number, signal: AbortSignal): Promise<Release> {
    if (signal.aborted) return Promise.reject(new ClientAbort());
    if (this.active < this.max && this.waiting.length === 0) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    if (this.waiting.length >= this.maxQueue) {
      return Promise.reject(
        new HubError({
          status: 503,
          code: 'queue_full',
          message: `"${this.provider}" is busy and ${this.maxQueue} requests are already waiting`,
          extra: { provider: this.provider },
          headers: { 'Retry-After': '10' },
          fallback: true,
        }),
      );
    }
    return new Promise<Release>((resolve, reject) => {
      const w: Waiter = {
        priority,
        signal,
        timer: null,
        grant: () => {
          this.detach(w);
          this.active++;
          resolve(this.releaser());
        },
        fail: e => {
          this.detach(w);
          reject(e);
        },
        onAbort: () => {
          const i = this.waiting.indexOf(w);
          if (i !== -1) this.waiting.splice(i, 1);
          w.fail(new ClientAbort());
        },
      };
      if (this.timeoutMs > 0) {
        w.timer = setTimeout(() => {
          const i = this.waiting.indexOf(w);
          if (i !== -1) this.waiting.splice(i, 1);
          w.fail(
            new HubError({
              status: 504,
              code: 'queue_timeout',
              message: `Waited ${Math.round(this.timeoutMs / 1000)}s for "${this.provider}" and it never freed up`,
              extra: { provider: this.provider },
              fallback: true,
            }),
          );
        }, this.timeoutMs);
      }
      signal.addEventListener('abort', w.onAbort, { once: true });
      // after the last waiter whose priority is at least ours
      let at = this.waiting.length;
      while (at > 0 && this.waiting[at - 1]!.priority < priority) at--;
      this.waiting.splice(at, 0, w);
    });
  }

  private detach(w: Waiter): void {
    if (w.timer) clearTimeout(w.timer);
    w.signal.removeEventListener('abort', w.onAbort);
  }

  private releaser(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.pump();
    };
  }

  private pump(): void {
    while (this.active < this.max && this.waiting.length) {
      const next = this.waiting.shift()!;
      next.grant();
    }
  }
}

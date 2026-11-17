import { HubError } from './errors.js';
import { ClientAbort } from './upstream.js';

/** The window upstream quotas are counted in: "per minute" is the last 60 seconds, sliding. */
const WINDOW_MS = 60_000;

/** A place in the pace of a provider. Tell it what the request really cost once the upstream has said. */
export interface Reservation {
  /** Replaces the estimate with the prompt tokens the upstream reported (frees room for the next request if it was too high). */
  settle(promptTokens: number): void;
}

interface Entry {
  at: number;
  tokens: number;
}

interface Waiter {
  priority: number;
  tokens: number;
  deadline: number;
  signal: AbortSignal;
  grant: () => void;
  fail: (e: Error) => void;
  timer: NodeJS.Timeout | null;
  onAbort: () => void;
}

export interface PaceLimits {
  rpm: number | null;
  tpm: number | null;
}

/**
 * Keeps a provider under its requests-per-minute and prompt-tokens-per-minute quota, so the hub waits a little instead
 * of being told "429" by an upstream that has a free tier.
 *
 * A request is let through when the last 60 seconds hold fewer than `rpm` requests and, together with its estimated
 * prompt size, no more than `tpm` tokens. Until then it waits in a line ordered like the concurrency queue
 * (priority 5 first, first come first served within a priority). The estimate is replaced by the upstream's own count when
 * the answer reports one (`Reservation.settle`). A request that is larger than `tpm` on its own would never fit, so it
 * goes through when nothing else is in the window.
 *
 * The window is kept in memory; a restart forgets it, which can only let a burst through, as with the key limits.
 */
export class Pacer {
  private entries: Entry[] = [];
  private readonly waiting: Waiter[] = [];
  private timer: NodeJS.Timeout | null = null;
  private limits: PaceLimits;

  /**
   * @param maxWaitMs longest a request waits for its turn (0 = for as long as it takes)
   */
  constructor(
    limits: PaceLimits,
    private readonly maxQueue: number,
    private readonly maxWaitMs: number,
    private readonly provider: string,
    private readonly now: () => number = Date.now,
  ) {
    this.limits = { ...limits };
  }

  /** The owner changed the limits of a provider: the window and the line stay, the new numbers apply from now on. */
  configure(limits: PaceLimits): void {
    this.limits = { ...limits };
    this.pump();
  }

  get queued(): number {
    return this.waiting.length;
  }

  /** What the last minute holds, as the pacer counts it. */
  get used(): { requests: number; tokens: number } {
    this.prune();
    return { requests: this.entries.length, tokens: this.entries.reduce((n, e) => n + e.tokens, 0) };
  }

  acquire(priority: number, tokens: number, signal: AbortSignal): Promise<Reservation> {
    if (signal.aborted) return Promise.reject(new ClientAbort());
    if (this.waiting.length === 0 && this.waitFor(tokens) === 0) return Promise.resolve(this.take(tokens));
    if (this.waiting.length >= this.maxQueue) {
      return Promise.reject(
        new HubError({
          status: 503,
          code: 'queue_full',
          message: `"${this.provider}" is paced and ${this.maxQueue} requests are already waiting for their turn`,
          extra: { provider: this.provider },
          headers: { 'Retry-After': '10' },
          fallback: true,
        }),
      );
    }
    return new Promise<Reservation>((resolve, reject) => {
      const w: Waiter = {
        priority,
        tokens,
        deadline: this.maxWaitMs > 0 ? this.now() + this.maxWaitMs : Infinity,
        signal,
        timer: null,
        grant: () => {
          this.detach(w);
          resolve(this.take(w.tokens));
        },
        fail: e => {
          this.detach(w);
          reject(e);
        },
        onAbort: () => {
          this.remove(w);
          w.fail(new ClientAbort());
          this.pump(); // the next in line may be smaller, or the one that was being waited for
        },
      };
      if (this.maxWaitMs > 0) {
        w.timer = setTimeout(() => {
          this.pump(); // a turn that comes at this very moment still counts
          if (!this.waiting.includes(w)) return;
          this.remove(w);
          w.fail(this.timeout(w.tokens));
          this.pump();
        }, this.maxWaitMs);
      }
      signal.addEventListener('abort', w.onAbort, { once: true });
      // after the last waiter whose priority is at least ours
      let at = this.waiting.length;
      while (at > 0 && this.waiting[at - 1]!.priority < priority) at--;
      this.waiting.splice(at, 0, w);
      this.pump();
    });
  }

  private take(tokens: number): Reservation {
    const entry: Entry = { at: this.now(), tokens };
    this.entries.push(entry);
    let settled = false;
    return {
      settle: promptTokens => {
        if (settled || !Number.isFinite(promptTokens)) return;
        settled = true;
        entry.tokens = Math.max(0, Math.trunc(promptTokens));
        this.pump();
      },
    };
  }

  private prune(): void {
    const cutoff = this.now() - WINDOW_MS;
    let n = 0;
    while (n < this.entries.length && this.entries[n]!.at <= cutoff) n++;
    if (n) this.entries.splice(0, n);
  }

  /** Milliseconds until a request of `tokens` fits; 0 = it fits now. */
  private waitFor(tokens: number): number {
    this.prune();
    const { rpm, tpm } = this.limits;
    const at = this.now();
    let until = at;
    if (rpm !== null && this.entries.length >= rpm) until = Math.max(until, this.entries[this.entries.length - rpm]!.at + WINDOW_MS);
    if (tpm !== null && this.entries.length > 0) {
      if (tokens > tpm) {
        until = Math.max(until, this.entries[this.entries.length - 1]!.at + WINDOW_MS); // alone in the window, or not at all
      } else {
        let sum = this.entries.reduce((n, e) => n + e.tokens, 0);
        let i = 0;
        while (sum + tokens > tpm && i < this.entries.length) sum -= this.entries[i++]!.tokens;
        if (i > 0) until = Math.max(until, this.entries[i - 1]!.at + WINDOW_MS);
      }
    }
    return until - at;
  }

  private timeout(tokens: number): HubError {
    const wait = Math.max(1, Math.ceil(this.waitFor(tokens) / 1000));
    return new HubError({
      status: 503,
      code: 'pacing_timeout',
      message: `"${this.provider}" is limited to its requests and tokens per minute, and this request would have to wait ${wait}s or more for its turn`,
      extra: { provider: this.provider },
      headers: { 'Retry-After': String(wait) },
      fallback: true,
    });
  }

  /** Lets the head of the line through while it fits; fails it at once when its turn is further away than it may wait. */
  private pump(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.waiting.length) {
      const head = this.waiting[0]!;
      const wait = this.waitFor(head.tokens);
      if (wait === 0) {
        this.waiting.shift();
        head.grant();
        continue;
      }
      if (this.now() + wait > head.deadline) {
        this.waiting.shift();
        head.fail(this.timeout(head.tokens));
        continue;
      }
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, wait);
      this.timer.unref();
      return;
    }
  }

  private remove(w: Waiter): void {
    const i = this.waiting.indexOf(w);
    if (i !== -1) this.waiting.splice(i, 1);
  }

  private detach(w: Waiter): void {
    if (w.timer) clearTimeout(w.timer);
    w.signal.removeEventListener('abort', w.onAbort);
  }
}

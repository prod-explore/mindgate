import { HubError } from './errors.js';
import type { UsageStore } from './store/usage.js';
import { dayKey, monthStartKey, nextDayStart, nextMonthStart } from './time.js';
import type { ApiKeyRecord } from './types.js';

export interface Admission {
  /** Call once the request has finished (and its usage has been recorded). */
  release(): void;
}

export interface UsageSnapshot {
  day: string;
  resetsAt: string;
  monthResetsAt: string;
  requests: { today: number; perDay: number | null; lastMinute: number; perMinute: number | null };
  tokens: {
    today: { input: number; output: number; total: number };
    month: { input: number; output: number; total: number };
    perDay: number | null;
    perMonth: number | null;
  };
}

/**
 * Per-key limits, checked before a request is dispatched.
 *
 * - `rpm` is a sliding 60-second window kept in memory (a restart forgets it, which only ever lets a burst through).
 * - `rpd` counts finished requests from the database plus the ones in flight.
 * - Token budgets (day, month) count finished requests, so requests already running can push a key a little past its
 *   budget; the next request is refused.
 *
 * A refused request answers 429 with one of two codes the client can tell apart:
 *   rate_limited     — too fast, try again in `Retry-After` seconds
 *   budget_exhausted — the day's or month's allowance is used up; `reset_at` says when it comes back
 */
export class Limits {
  private readonly window = new Map<string, number[]>();
  private readonly pending = new Map<string, number>();

  constructor(
    private readonly usage: UsageStore,
    private readonly tz: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  admit(key: ApiKeyRecord): Admission {
    const now = this.clock();
    const day = dayKey(now, this.tz);

    if (key.rpd !== null) {
      const used = this.usage.totals(key.id, day, day).requests + (this.pending.get(key.id) ?? 0);
      if (used >= key.rpd) throw this.exhausted('requests_per_day', key.rpd, nextDayStart(now, this.tz));
    }
    if (key.tokensPerDay !== null) {
      const t = this.usage.totals(key.id, day, day);
      if (t.inputTokens + t.outputTokens >= key.tokensPerDay) throw this.exhausted('tokens_per_day', key.tokensPerDay, nextDayStart(now, this.tz));
    }
    if (key.tokensPerMonth !== null) {
      const t = this.usage.totals(key.id, monthStartKey(now, this.tz), day);
      if (t.inputTokens + t.outputTokens >= key.tokensPerMonth) throw this.exhausted('tokens_per_month', key.tokensPerMonth, nextMonthStart(now, this.tz));
    }

    const stamps = this.recent(key.id, now.getTime());
    if (key.rpm !== null && stamps.length >= key.rpm) {
      const wait = Math.max(1, Math.ceil((stamps[0]! + 60_000 - now.getTime()) / 1000));
      throw new HubError({
        status: 429,
        code: 'rate_limited',
        message: `Too many requests for key "${key.name}": the limit is ${key.rpm} per minute. Try again in ${wait}s.`,
        extra: { limit: 'requests_per_minute', retry_after: wait },
        headers: { 'Retry-After': String(wait) },
      });
    }
    stamps.push(now.getTime());
    this.pending.set(key.id, (this.pending.get(key.id) ?? 0) + 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.pending.set(key.id, Math.max(0, (this.pending.get(key.id) ?? 1) - 1));
      },
    };
  }

  private recent(keyId: string, nowMs: number): number[] {
    const arr = this.window.get(keyId) ?? [];
    const cutoff = nowMs - 60_000;
    while (arr.length && arr[0]! <= cutoff) arr.shift();
    this.window.set(keyId, arr);
    return arr;
  }

  private exhausted(limit: string, value: number, resetAt: Date): HubError {
    return new HubError({
      status: 429,
      code: 'budget_exhausted',
      message: `The ${limit.replace(/_/g, ' ')} allowance (${value}) of this key is used up. It resets at ${resetAt.toISOString()}.`,
      extra: { limit, reset_at: resetAt.toISOString() },
    });
  }

  snapshot(key: ApiKeyRecord): UsageSnapshot {
    const now = this.clock();
    const day = dayKey(now, this.tz);
    const today = this.usage.totals(key.id, day, day);
    const month = this.usage.totals(key.id, monthStartKey(now, this.tz), day);
    return {
      day,
      resetsAt: nextDayStart(now, this.tz).toISOString(),
      monthResetsAt: nextMonthStart(now, this.tz).toISOString(),
      requests: { today: today.requests, perDay: key.rpd, lastMinute: this.recent(key.id, now.getTime()).length, perMinute: key.rpm },
      tokens: {
        today: { input: today.inputTokens, output: today.outputTokens, total: today.inputTokens + today.outputTokens },
        month: { input: month.inputTokens, output: month.outputTokens, total: month.inputTokens + month.outputTokens },
        perDay: key.tokensPerDay,
        perMonth: key.tokensPerMonth,
      },
    };
  }
}

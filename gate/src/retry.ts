import { ClientAbort } from './upstream.js';
import type { HubError } from './errors.js';

/**
 * The failures worth trying again against the same model: the upstream says "not now" (a rate limit, an overload) or did
 * not answer in time. A used-up quota (`upstream_quota_exhausted`) is not among them: waiting seconds will not bring it back.
 */
const RETRYABLE = new Set(['upstream_rate_limited', 'upstream_overloaded', 'upstream_timeout']);

/** However generous the budget, a request that keeps failing is not tried forever. */
export const MAX_RETRIES = 6;

const BACKOFF_BASE_MS = 1000;
/** Up to this much is added to every wait so that requests which failed together do not come back together. */
const JITTER = 0.25;
const RETRY_AFTER_JITTER_MS = 250;

export const isRetryable = (e: HubError): boolean => RETRYABLE.has(e.code);

/**
 * How long to wait before trying again, or null when the error should go to the client as it is.
 *
 * The upstream's own `Retry-After` is honoured; without one the wait doubles from one second (1s, 2s, 4s...). A wait
 * that no longer fits in `remainingMs` is not started: the client gets the error at once, with that `Retry-After`, and
 * can decide for itself.
 */
export function retryDelayMs(e: HubError, retried: number, remainingMs: number, random: () => number = Math.random): number | null {
  if (!isRetryable(e) || retried >= MAX_RETRIES || remainingMs <= 0) return null;
  const header = e.headers['Retry-After'];
  const seconds = header === undefined ? NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    const wait = seconds * 1000;
    return wait > remainingMs ? null : Math.min(remainingMs, wait + random() * RETRY_AFTER_JITTER_MS);
  }
  const backoff = BACKOFF_BASE_MS * 2 ** retried;
  return backoff > remainingMs ? null : Math.min(remainingMs, backoff * (1 + random() * JITTER));
}

/** Sleeps for `ms`, or throws ClientAbort as soon as the client goes away. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new ClientAbort());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ClientAbort());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

import type { LogRow } from '../api/types';

/** Joins two pages of the request log into one list, newest first, each request once. */
export function mergeLog(a: LogRow[], b: LogRow[]): LogRow[] {
  const byId = new Map<number, LogRow>();
  for (const r of a) byId.set(r.id, r);
  for (const r of b) byId.set(r.id, r);
  return [...byId.values()].sort((x, y) => y.id - x.id);
}

/** 2xx is fine, 4xx is the client's doing, 5xx is ours or the provider's. */
export const statusTone = (status: number): 'ok' | 'warn' | 'bad' => (status < 400 ? 'ok' : status < 500 ? 'warn' : 'bad');

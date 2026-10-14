import type { Locality, Provider, UsageRow } from '../api/types';

export type Metric = 'requests' | 'tokens' | 'errors';

/** Every day from `from` to `to` (inclusive), as 2026-10-13 strings. Dates are counted in UTC, so no time zone shifts a day. */
export function daysBetween(from: string, to: string): string[] {
  const parse = (d: string) => {
    const [y, m, day] = d.split('-').map(Number);
    return Date.UTC(y ?? 1970, (m ?? 1) - 1, day ?? 1);
  };
  const out: string[] = [];
  for (let t = parse(from); t <= parse(to) && out.length < 400; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** Today's date, minus `days`, in the hub's time zone (the hub counts its days there). */
export function dayInZone(now: Date, timeZone: string, minusDays = 0): string {
  const shifted = new Date(now.getTime() - minusDays * 86_400_000);
  try {
    // en-CA formats as 2026-10-13
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(shifted);
  } catch {
    return shifted.toISOString().slice(0, 10);
  }
}

/** Where a model runs: by its provider (`openrouter/…` -> the provider called `openrouter`). Unknown means cloud. */
export function localityResolver(providers: Provider[]): (modelId: string) => Locality {
  const byId = new Map(providers.map(p => [p.id, p.locality]));
  return modelId => byId.get(modelId.split('/')[0] ?? '') ?? 'cloud';
}

export const rowValue = (row: UsageRow, metric: Metric): number => (metric === 'requests' ? row.requests : metric === 'errors' ? row.errors : row.input_tokens + row.output_tokens);

export interface DayPoint {
  day: string;
  local: number;
  cloud: number;
}

export function byDay(rows: UsageRow[], days: string[], metric: Metric, localityOf: (modelId: string) => Locality): DayPoint[] {
  const points = new Map<string, DayPoint>(days.map(d => [d, { day: d, local: 0, cloud: 0 }]));
  for (const r of rows) {
    const p = points.get(r.day);
    if (p) p[localityOf(r.model)] += rowValue(r, metric);
  }
  return [...points.values()];
}

export interface Totals {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
}

export const emptyTotals = (): Totals => ({ requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 });

export function addRow(t: Totals, r: UsageRow): Totals {
  t.requests += r.requests;
  t.errors += r.errors;
  t.inputTokens += r.input_tokens;
  t.outputTokens += r.output_tokens;
  return t;
}

export function totals(rows: UsageRow[]): Totals {
  return rows.reduce(addRow, emptyTotals());
}

/** Totals per model or per key, biggest first. */
export function groupBy(rows: UsageRow[], pick: (r: UsageRow) => string): Array<{ id: string } & Totals> {
  const map = new Map<string, Totals>();
  for (const r of rows) {
    const k = pick(r);
    map.set(k, addRow(map.get(k) ?? emptyTotals(), r));
  }
  return [...map.entries()].map(([id, t]) => ({ id, ...t })).sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) || b.requests - a.requests);
}

/** A "nice" axis maximum and ticks: 0, 25, 50, 75, 100 rather than 0, 23.4, 46.8… */
export function niceTicks(max: number, target = 4): { max: number; ticks: number[] } {
  if (!(max > 0)) return { max: 1, ticks: [0, 1] };
  const rough = max / target;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / pow;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * pow;
  const round = (v: number) => Math.round(v * 1e6) / 1e6; // 0.1 * 6 is 0.6000000000000001
  const top = round(Math.ceil(max / step - 1e-9) * step);
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(round(v));
  return { max: top, ticks };
}

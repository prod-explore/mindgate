const locale = (): string => 'en-GB';

const fmt = new Map<string, Intl.NumberFormat>();
function nf(opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale()}|${JSON.stringify(opts)}`;
  let f = fmt.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale(), opts);
    fmt.set(key, f);
  }
  return f;
}

export const dash = '–';

export const num = (n: number | null | undefined): string => (n === null || n === undefined || Number.isNaN(n) ? dash : nf({}).format(n));

/**
 * 1 234 567 -> "1.2M". The suffixes are written here, not taken from Intl's compact notation:
 * their case differs between ICU builds (Node on a CI runner gave "1.2m", a desktop gave "1.2M"),
 * and a figure that changes with the machine is not worth the saved lines.
 */
export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return dash;
  const sign = n < 0 ? -1 : 1;
  const abs = Math.abs(n);
  const units: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  const one = nf({ maximumFractionDigits: 1 });
  for (let i = 0; i < units.length; i++) {
    const [size, suffix] = units[i]!;
    if (abs < size) continue;
    // 999 950 rounds to "1000K": that is "1M"
    const rounded = Math.round((abs / size) * 10) / 10;
    if (rounded >= 1000 && i > 0) return `${one.format(sign)}${units[i - 1]![1]}`;
    return `${one.format(sign * rounded)}${suffix}`;
  }
  return one.format(sign * abs);
}

/** Decimal units, like disks and Ollama: 2 600 000 000 -> "2.6 GB". */
export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return dash;
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  const digits = i === 0 || v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${nf({ maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(n < 0 ? -v : v)} ${units[i]}`;
}

export const percent = (n: number | null | undefined, digits = 0): string => (n === null || n === undefined ? dash : `${nf({ maximumFractionDigits: digits }).format(n)}%`);

/** 850 -> "850 ms", 4200 -> "4.2 s", 125000 -> "2 min 5 s" */
export function ms(n: number | null | undefined): string {
  if (n === null || n === undefined) return dash;
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 10_000) return `${nf({ maximumFractionDigits: 1 }).format(n / 1000)} s`;
  if (n < 60_000) return `${Math.round(n / 1000)} s`;
  const min = Math.floor(n / 60_000);
  const s = Math.round((n % 60_000) / 1000);
  return s ? `${min} min ${s} s` : `${min} min`;
}

/** 93784 s -> "1 d 2 h", 300 s -> "5 min" */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return dash;
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return dash;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return dash;
  return new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'medium' }).format(d);
}

export function relative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return dash;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return dash;
  const diff = Math.round((then - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 45) return rtf.format(0, 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86_400 * 30) return rtf.format(Math.round(diff / 86_400), 'day');
  return rtf.format(Math.round(diff / (86_400 * 30)), 'month');
}

/** "2026-10-13" -> "13 Oct" for chart axes. */
export function shortDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  return new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** A limit as the person typed it: empty means "no limit". */
export const limit = (n: number | null | undefined): string => (n === null || n === undefined ? '∞' : num(n));

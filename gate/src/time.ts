/**
 * "A day" and "a month" for usage limits start at midnight in MINDGATE_USAGE_TZ, so a daily budget resets when the
 * owner's day starts rather than at 02:00 local time.
 */

interface Ymd {
  y: number;
  m: number;
  d: number;
}

function formatter(tz: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}

const cache = new Map<string, Intl.DateTimeFormat>();
const fmt = (tz: string): Intl.DateTimeFormat => {
  let f = cache.get(tz);
  if (!f) cache.set(tz, (f = formatter(tz)));
  return f;
};

function wallClock(date: Date, tz: string): Ymd & { h: number; mi: number; s: number } {
  const p: Record<string, number> = {};
  for (const part of fmt(tz).formatToParts(date)) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return { y: p['year']!, m: p['month']!, d: p['day']!, h: p['hour']!, mi: p['minute']!, s: p['second']! };
}

/** Milliseconds the zone is ahead of UTC at this instant. */
function offsetMs(date: Date, tz: string): number {
  const w = wallClock(date, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant at which the wall clock in `tz` reads midnight on y-m-d. */
function midnightUtc({ y, m, d }: Ymd, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetMs(new Date(guess), tz);
  t = guess - offsetMs(new Date(t), tz); // second pass settles days that contain a DST change
  return new Date(t);
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `2026-10-13` — the day `date` falls on in `tz`. */
export function dayKey(date: Date, tz: string): string {
  const w = wallClock(date, tz);
  return `${w.y}-${pad(w.m)}-${pad(w.d)}`;
}

/** First day of the month `date` falls in, as a day key. */
export function monthStartKey(date: Date, tz: string): string {
  const w = wallClock(date, tz);
  return `${w.y}-${pad(w.m)}-01`;
}

/** When the current day ends (= the next one starts). */
export function nextDayStart(date: Date, tz: string): Date {
  const w = wallClock(date, tz);
  const next = new Date(Date.UTC(w.y, w.m - 1, w.d + 1));
  return midnightUtc({ y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate() }, tz);
}

/** When the current month ends. */
export function nextMonthStart(date: Date, tz: string): Date {
  const w = wallClock(date, tz);
  const next = new Date(Date.UTC(w.y, w.m, 1));
  return midnightUtc({ y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: 1 }, tz);
}

import { beforeEach, describe, expect, it } from 'vitest';
import { setLang } from '../i18n';
import { bytes, compact, dash, dateTime, duration, limit, ms, num, percent, relative, shortDay } from './format';

beforeEach(() => setLang('en'));

describe('numbers', () => {
  it('groups digits and shows a dash for nothing', () => {
    expect(num(1234567)).toBe('1,234,567');
    expect(num(null)).toBe(dash);
    expect(num(undefined)).toBe(dash);
    expect(num(Number.NaN)).toBe(dash);
  });

  it('shortens big numbers', () => {
    expect(compact(1234567)).toBe('1.2M');
    expect(compact(950)).toBe('950');
    expect(compact(null)).toBe(dash);
    expect(compact(5000)).toBe('5K');
    expect(compact(32768)).toBe('32.8K');
    expect(compact(2_500_000_000)).toBe('2.5B');
    expect(compact(999_950)).toBe('1M'); // not "1000K"
    expect(compact(-1500)).toBe('-1.5K');
    expect(compact(Number.NaN)).toBe(dash);
  });

  it('writes the same suffixes whatever the ICU build says, and the decimal comma in Polish', () => {
    setLang('pl');
    expect(compact(1234567)).toBe('1,2M');
    expect(compact(50_000)).toBe('50K');
  });

  it('follows the language of the panel', () => {
    setLang('pl');
    // Polish groups with a (non-breaking) space and decimals with a comma
    expect(num(1234567).replace(/\s/g, ' ')).toBe('1 234 567');
    expect(percent(12.5, 1)).toBe('12,5%');
  });

  it('writes a limit, with infinity for none', () => {
    expect(limit(null)).toBe('∞');
    expect(limit(1000)).toBe('1,000');
  });

  it('percent', () => {
    expect(percent(42)).toBe('42%');
    expect(percent(0.456, 1)).toBe('0.5%');
    expect(percent(null)).toBe(dash);
  });
});

describe('bytes', () => {
  it('uses decimal units, like disks and Ollama', () => {
    expect(bytes(0)).toBe('0 B');
    expect(bytes(999)).toBe('999 B');
    expect(bytes(1500)).toBe('1.5 kB');
    expect(bytes(2_600_000_000)).toBe('2.6 GB');
    expect(bytes(12_345_678)).toBe('12.3 MB');
    expect(bytes(100_000)).toBe('100 kB');
    expect(bytes(4e9)).toBe('4 GB');
    expect(bytes(2e12)).toBe('2 TB');
  });
  it('has nothing to say about nothing', () => {
    expect(bytes(null)).toBe(dash);
    expect(bytes(Number.NaN)).toBe(dash);
  });
});

describe('durations', () => {
  it('ms', () => {
    expect(ms(850)).toBe('850 ms');
    expect(ms(4200)).toBe('4.2 s');
    expect(ms(30_000)).toBe('30 s');
    expect(ms(125_000)).toBe('2 min 5 s');
    expect(ms(120_000)).toBe('2 min');
    expect(ms(null)).toBe(dash);
  });
  it('duration', () => {
    expect(duration(59)).toBe('59 s');
    expect(duration(300)).toBe('5 min');
    expect(duration(3600)).toBe('1 h');
    expect(duration(3660)).toBe('1 h 1 min');
    expect(duration(93_784)).toBe('1 d 2 h');
    expect(duration(86_400)).toBe('1 d');
    expect(duration(-5)).toBe('0 s');
    expect(duration(null)).toBe(dash);
  });
});

describe('time', () => {
  it('relative', () => {
    const now = Date.parse('2026-10-14T10:05:00Z');
    expect(relative('2026-10-14T10:00:00Z', now)).toBe('5 minutes ago');
    expect(relative('2026-10-14T10:04:40Z', now)).toBe('now');
    expect(relative('2026-10-14T07:05:00Z', now)).toBe('3 hours ago');
    expect(relative('2026-10-13T10:05:00Z', now)).toBe('yesterday');
    expect(relative('2026-10-14T10:10:00Z', now)).toBe('in 5 minutes');
    expect(relative(null, now)).toBe(dash);
    expect(relative('not a date', now)).toBe(dash);
  });
  it('shortDay does not shift with the time zone of the browser', () => {
    expect(shortDay('2026-10-13')).toBe('13 Oct');
    expect(shortDay('2026-01-01')).toBe('1 Jan');
    expect(shortDay('garbage')).toBe('garbage');
  });
  it('dateTime', () => {
    expect(dateTime(null)).toBe(dash);
    expect(dateTime('nonsense')).toBe(dash);
    expect(dateTime('2026-10-14T09:00:00Z')).toMatch(/2026/);
  });
});

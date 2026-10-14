import { describe, expect, it } from 'vitest';
import type { UsageRow } from '../api/types';
import { provider, cloud } from '../test/fixtures';
import { byDay, dayInZone, daysBetween, groupBy, localityResolver, niceTicks, rowValue, totals } from './usage';

const row = (over: Partial<UsageRow> = {}): UsageRow => ({ day: '2026-10-14', key_id: 'k1', model: 'home/qwen3:4b', requests: 1, errors: 0, input_tokens: 10, output_tokens: 5, ...over });

describe('days', () => {
  it('lists every day, both ends included, across month ends', () => {
    expect(daysBetween('2026-10-12', '2026-10-14')).toEqual(['2026-10-12', '2026-10-13', '2026-10-14']);
    expect(daysBetween('2026-02-27', '2026-03-02')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
    expect(daysBetween('2028-02-28', '2028-03-01')).toEqual(['2028-02-28', '2028-02-29', '2028-03-01']);
    expect(daysBetween('2026-10-14', '2026-10-14')).toEqual(['2026-10-14']);
    expect(daysBetween('2026-10-15', '2026-10-14')).toEqual([]);
  });

  it('counts the day where the hub counts it', () => {
    const late = new Date('2026-10-14T22:30:00Z');
    expect(dayInZone(late, 'UTC')).toBe('2026-10-14');
    expect(dayInZone(late, 'Europe/Warsaw')).toBe('2026-10-15'); // already past midnight there
    expect(dayInZone(late, 'Europe/Warsaw', 1)).toBe('2026-10-14');
    expect(dayInZone(late, 'America/Los_Angeles')).toBe('2026-10-14');
    expect(dayInZone(late, 'Not/AZone')).toBe('2026-10-14');
  });
});

describe('where a model runs', () => {
  const of = localityResolver([provider(), cloud()]);
  it('comes from its provider', () => {
    expect(of('home/qwen3:4b')).toBe('local');
    expect(of('openrouter/deepseek/deepseek-chat')).toBe('cloud');
  });
  it('is cloud when nobody knows the provider (a deleted one)', () => {
    expect(of('gone/model')).toBe('cloud');
    expect(of('plain')).toBe('cloud');
  });
});

describe('aggregation', () => {
  const of = localityResolver([provider(), cloud()]);
  const rows = [
    row({ day: '2026-10-13', requests: 2, input_tokens: 100, output_tokens: 50 }),
    row({ day: '2026-10-14', model: 'openrouter/x/y', requests: 3, errors: 1, input_tokens: 30, output_tokens: 20 }),
    row({ day: '2026-10-14', key_id: 'k2', requests: 4, input_tokens: 1, output_tokens: 1 }),
    row({ day: '2026-09-01', requests: 99 }), // outside the range
  ];

  it('splits each day into local and cloud, and fills days with nothing', () => {
    const days = ['2026-10-12', '2026-10-13', '2026-10-14'];
    expect(byDay(rows, days, 'requests', of)).toEqual([
      { day: '2026-10-12', local: 0, cloud: 0 },
      { day: '2026-10-13', local: 2, cloud: 0 },
      { day: '2026-10-14', local: 4, cloud: 3 },
    ]);
    expect(byDay(rows, days, 'tokens', of)[2]).toEqual({ day: '2026-10-14', local: 2, cloud: 50 });
    expect(byDay(rows, days, 'errors', of)[2]).toEqual({ day: '2026-10-14', local: 0, cloud: 1 });
  });

  it('rowValue', () => {
    expect(rowValue(row({ requests: 7, errors: 2, input_tokens: 3, output_tokens: 4 }), 'tokens')).toBe(7);
    expect(rowValue(row({ requests: 7 }), 'requests')).toBe(7);
  });

  it('totals', () => {
    expect(totals(rows.slice(0, 3))).toEqual({ requests: 9, errors: 1, inputTokens: 131, outputTokens: 71 });
    expect(totals([])).toEqual({ requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 });
  });

  it('groups by model or key, the heaviest first', () => {
    const byModel = groupBy(rows.slice(0, 3), r => r.model);
    expect(byModel.map(m => m.id)).toEqual(['home/qwen3:4b', 'openrouter/x/y']);
    expect(byModel[0]).toMatchObject({ requests: 6, inputTokens: 101, outputTokens: 51 });
    expect(groupBy(rows.slice(0, 3), r => r.key_id).map(k => [k.id, k.requests])).toEqual([
      ['k1', 5],
      ['k2', 4],
    ]);
  });
});

describe('niceTicks', () => {
  it('rounds the top of the axis up to a round number', () => {
    expect(niceTicks(0)).toEqual({ max: 1, ticks: [0, 1] });
    expect(niceTicks(7)).toEqual({ max: 8, ticks: [0, 2, 4, 6, 8] });
    expect(niceTicks(23)).toEqual({ max: 30, ticks: [0, 10, 20, 30] });
    expect(niceTicks(100)).toEqual({ max: 100, ticks: [0, 50, 100] });
    expect(niceTicks(1_234_567).max).toBeGreaterThanOrEqual(1_234_567);
  });
  it('never puts the biggest value above the axis', () => {
    for (const v of [1, 2, 3, 9, 11, 99, 101, 999, 4321, 0.5, 12.5]) {
      const { max, ticks } = niceTicks(v);
      expect(max).toBeGreaterThanOrEqual(v);
      expect(ticks[0]).toBe(0);
      expect(ticks[ticks.length - 1]).toBe(max);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { logRow } from '../test/fixtures';
import { mergeLog, statusTone } from './log';

const ids = (rows: { id: number }[]) => rows.map(r => r.id);

describe('mergeLog', () => {
  it('puts the newest first', () => {
    expect(ids(mergeLog([logRow({ id: 2 }), logRow({ id: 1 })], [logRow({ id: 5 }), logRow({ id: 4 })]))).toEqual([5, 4, 2, 1]);
  });

  it('shows a request once, and the later copy wins (its status may have settled since)', () => {
    const merged = mergeLog([logRow({ id: 3, status: 200 }), logRow({ id: 2 })], [logRow({ id: 3, status: 502 }), logRow({ id: 1 })]);
    expect(ids(merged)).toEqual([3, 2, 1]);
    expect(merged[0]!.status).toBe(502);
  });

  it('copes with empty lists and does not touch its arguments', () => {
    const a = [logRow({ id: 1 })];
    expect(mergeLog([], [])).toEqual([]);
    expect(ids(mergeLog(a, []))).toEqual([1]);
    expect(mergeLog(a, [])).not.toBe(a);
  });
});

describe('statusTone', () => {
  it('tells success from the client’s doing from a failure on our side', () => {
    expect([200, 204, 302].map(statusTone)).toEqual(['ok', 'ok', 'ok']);
    expect([400, 401, 429].map(statusTone)).toEqual(['warn', 'warn', 'warn']);
    expect([500, 502, 504].map(statusTone)).toEqual(['bad', 'bad', 'bad']);
  });
});

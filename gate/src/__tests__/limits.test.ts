import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { parsePriority } from '../chat.js';
import { dayKey, monthStartKey, nextDayStart, nextMonthStart } from '../time.js';
import type { ApiKeyRecord } from '../types.js';
import { addProvider, chunk, completion, openaiUpstream, parseSse, sendJson, sendSse, sleep, startHub, usageChunk, type Json, type TestHub, type Upstream } from './helpers.js';

describe('time zones for daily and monthly budgets', () => {
  const TZ = 'Europe/Warsaw';

  it('a day starts at local midnight, not at UTC midnight', () => {
    assert.equal(dayKey(new Date('2026-10-13T21:59:00Z'), TZ), '2026-10-13');
    assert.equal(dayKey(new Date('2026-10-13T22:00:00Z'), TZ), '2026-10-14');
    assert.equal(nextDayStart(new Date('2026-10-13T20:00:00Z'), TZ).toISOString(), '2026-10-13T22:00:00.000Z');
  });

  it('a day with a clock change is 25 hours long and still ends at local midnight', () => {
    // 2026-10-25: summer time ends in Poland at 03:00 -> 02:00
    assert.equal(nextDayStart(new Date('2026-10-24T22:30:00Z'), TZ).toISOString(), '2026-10-25T23:00:00.000Z');
    assert.equal(dayKey(new Date('2026-10-25T22:59:00Z'), TZ), '2026-10-25');
    assert.equal(dayKey(new Date('2026-10-25T23:00:00Z'), TZ), '2026-10-26');
    // and in spring (2026-03-29) the day is 23 hours long
    assert.equal(nextDayStart(new Date('2026-03-28T23:30:00Z'), TZ).toISOString(), '2026-03-29T22:00:00.000Z');
  });

  it('a month ends at local midnight on the first, across the clock change', () => {
    assert.equal(monthStartKey(new Date('2026-10-13T12:00:00Z'), TZ), '2026-10-01');
    assert.equal(nextMonthStart(new Date('2026-10-13T12:00:00Z'), TZ).toISOString(), '2026-10-31T23:00:00.000Z');
    assert.equal(nextMonthStart(new Date('2026-12-31T22:59:00Z'), TZ).toISOString(), '2026-12-31T23:00:00.000Z');
    assert.equal(nextMonthStart(new Date('2026-12-15T12:00:00Z'), 'UTC').toISOString(), '2027-01-01T00:00:00.000Z');
  });
});

describe('priorities', () => {
  const key = (min: number, def: number, max: number) => ({ minPriority: min, defaultPriority: def, maxPriority: max }) as ApiKeyRecord;

  it('uses the key default, clamps to its range and rejects nonsense', () => {
    assert.equal(parsePriority(undefined, key(1, 3, 5)), 3);
    assert.equal(parsePriority('5', key(1, 3, 5)), 5);
    assert.equal(parsePriority('5', key(1, 2, 3)), 3, 'a key cannot claim more than its maximum');
    assert.equal(parsePriority('1', key(2, 3, 4)), 2, 'nor less than its minimum');
    assert.throws(() => parsePriority('urgent', key(1, 3, 5)), /integer from 1 to 5/);
    assert.throws(() => parsePriority('9', key(1, 3, 5)), /integer from 1 to 5/);
    assert.throws(() => parsePriority('2.5', key(1, 3, 5)), /integer from 1 to 5/);
  });
});

describe('per-key limits', () => {
  let up: Upstream;
  let h: TestHub;
  let now = new Date('2026-10-13T20:00:00Z'); // 22:00 on the 13th in Warsaw
  let slow = false;

  before(async () => {
    up = await openaiUpstream({
      chat: async (req, res) => {
        if (slow) await sleep(150);
        if (req.body?.['stream']) return void (await sendSse(res, [chunk({ role: 'assistant', content: 'hi' }), chunk({}, 'stop'), usageChunk(100, 50), '[DONE]']));
        sendJson(res, 200, completion('hi'));
      },
    });
    h = await startHub({
      env: { MINDGATE_USAGE_TZ: 'Europe/Warsaw' },
      hub: { clock: () => now },
      setup: hub => addProvider(hub, 'p', up),
    });
  });

  after(async () => {
    await h.close();
    await up.close();
  });

  const send = (token: string, extra: Json = {}) =>
    h.api('POST', '/v1/chat/completions', { model: 'p/fake-model', messages: [{ role: 'user', content: 'x' }], ...extra }, {}, token);
  const upstreamCalls = () => up.requests.filter(r => r.path === '/v1/chat/completions').length;

  it('requests per minute: refuses with rate_limited and Retry-After, then recovers', async () => {
    const k = h.hub.keys.create({ name: 'rpm', rpm: 2 }).key;
    now = new Date('2026-10-13T20:00:00Z');
    assert.equal((await send(k)).status, 200);
    now = new Date('2026-10-13T20:00:20Z');
    assert.equal((await send(k)).status, 200);
    now = new Date('2026-10-13T20:00:30Z');
    const before = upstreamCalls();
    const r = await send(k);
    assert.equal(r.status, 429);
    assert.equal(r.json.error.code, 'rate_limited');
    assert.equal(r.headers.get('retry-after'), '30', 'the oldest request leaves the window 30s from now');
    assert.equal(r.json.error.retry_after, 30);
    assert.equal(upstreamCalls(), before, 'a refused request never reaches the model');
    now = new Date('2026-10-13T20:01:01Z');
    assert.equal((await send(k)).status, 200);
  });

  it('requests per day: budget_exhausted with the moment it comes back', async () => {
    const k = h.hub.keys.create({ name: 'rpd', rpd: 2 }).key;
    now = new Date('2026-10-13T20:00:00Z');
    assert.equal((await send(k)).status, 200);
    assert.equal((await send(k)).status, 200);
    const r = await send(k);
    assert.equal(r.status, 429);
    assert.equal(r.json.error.code, 'budget_exhausted');
    assert.equal(r.json.error.limit, 'requests_per_day');
    assert.equal(r.json.error.reset_at, '2026-10-13T22:00:00.000Z');
    assert.equal(r.headers.get('retry-after'), null, 'this is not "try again in a moment"');
    now = new Date('2026-10-13T22:00:01Z');
    assert.equal((await send(k)).status, 200, 'the next local day has a fresh allowance');
  });

  it('tokens per day: counts what was really used, refuses the next request', async () => {
    const k = h.hub.keys.create({ name: 'tpd', tokensPerDay: 20 }).key;
    now = new Date('2026-10-14T10:00:00Z');
    assert.equal((await send(k)).status, 200); // 15 tokens used
    assert.equal((await send(k)).status, 200); // 30 used: over, but the check happens before the request
    const r = await send(k);
    assert.equal(r.status, 429);
    assert.equal(r.json.error.code, 'budget_exhausted');
    assert.equal(r.json.error.limit, 'tokens_per_day');
    assert.equal(r.json.error.reset_at, '2026-10-14T22:00:00.000Z');
  });

  it('tokens per month: adds up over days and resets on the first', async () => {
    const k = h.hub.keys.create({ name: 'tpm', tokensPerMonth: 40 }).key;
    now = new Date('2026-10-15T10:00:00Z');
    await send(k);
    now = new Date('2026-10-16T10:00:00Z');
    await send(k);
    now = new Date('2026-10-17T10:00:00Z');
    await send(k); // 45 tokens, spread over three days
    now = new Date('2026-10-18T10:00:00Z');
    const r = await send(k);
    assert.equal(r.status, 429);
    assert.equal(r.json.error.limit, 'tokens_per_month');
    assert.equal(r.json.error.reset_at, '2026-10-31T23:00:00.000Z');
    now = new Date('2026-10-31T23:00:01Z'); // November in Warsaw
    assert.equal((await send(k)).status, 200);
  });

  it('streamed answers are counted from the usage the model reports', async () => {
    const k = h.hub.keys.create({ name: 'stream-count', tokensPerDay: 100000 });
    now = new Date('2026-10-20T10:00:00Z');
    const r = await h.raw('POST', '/v1/chat/completions', { model: 'p/fake-model', stream: true, messages: [{ role: 'user', content: 'x' }] }, { Authorization: `Bearer ${k.key}` });
    const events = parseSse(await r.text());
    assert.equal(events.at(-1), '[DONE]');
    assert.ok(!events.some(e => typeof e === 'object' && e.choices?.length === 0), 'the usage-only chunk is hidden unless the client asks for it');
    const u = await h.api('GET', '/v1/usage', undefined, {}, k.key);
    assert.equal(u.json.tokens.today.input, 100);
    assert.equal(u.json.tokens.today.output, 50);
    assert.equal(u.json.tokens.today.limit, 100000);
  });

  it('one key running out does not affect another', async () => {
    const a = h.hub.keys.create({ name: 'a-tight', rpd: 1 }).key;
    const b = h.hub.keys.create({ name: 'b-free' }).key;
    now = new Date('2026-10-21T10:00:00Z');
    await send(a);
    assert.equal((await send(a)).status, 429);
    assert.equal((await send(b)).status, 200);
  });

  it('requests that are still running count against the daily request limit', async () => {
    const k = h.hub.keys.create({ name: 'inflight', rpd: 1 }).key;
    now = new Date('2026-10-22T10:00:00Z');
    slow = true;
    try {
      const [x, y] = await Promise.all([send(k), send(k)]);
      assert.deepEqual([x.status, y.status].sort(), [200, 429]);
    } finally {
      slow = false;
    }
  });

  it('requests refused before dispatch cost nothing, served ones count', async () => {
    const k = h.hub.keys.create({ name: 'errors', rpd: 1 }).key;
    now = new Date('2026-10-23T10:00:00Z');
    const bad = await send(k, { model: 'p/does-not-exist' });
    assert.equal(bad.status, 404, 'unknown models are refused before they cost anything');
    assert.equal((await send(k)).status, 200);
    assert.equal((await send(k)).status, 429);
  });

  it('GET /v1/usage shows what was used and what is left', async () => {
    const k = h.hub.keys.create({ name: 'report', rpm: 30, rpd: 100, tokensPerDay: 1000, tokensPerMonth: 5000 });
    now = new Date('2026-10-24T10:00:00Z');
    await send(k.key);
    await send(k.key);
    const r = await h.api('GET', '/v1/usage', undefined, {}, k.key);
    assert.equal(r.status, 200);
    assert.equal(r.json.object, 'usage');
    assert.equal(r.json.key.name, 'report');
    assert.equal(r.json.key.prefix, k.record.prefix);
    assert.ok(!JSON.stringify(r.json).includes(k.key), 'the key itself is never echoed');
    assert.deepEqual(r.json.requests, { today: 2, per_day: 100, last_minute: 2, per_minute: 30 });
    assert.deepEqual(r.json.tokens.today, { input: 20, output: 10, total: 30, limit: 1000 });
    assert.deepEqual(r.json.tokens.month, { input: 20, output: 10, total: 30, limit: 5000 });
    assert.equal(r.json.period.day, '2026-10-24');
    assert.equal(r.json.period.resets_at, '2026-10-24T22:00:00.000Z');
    assert.equal(r.json.period.month_resets_at, '2026-10-31T23:00:00.000Z');
    assert.equal(r.json.period.time_zone, 'Europe/Warsaw');
    assert.deepEqual(r.json.by_model, [{ model: 'p/fake-model', requests: 2, errors: 0, input_tokens: 20, output_tokens: 10 }]);
  });

  it('GET /v1/usage works for a key that has hit its limit (so a client can see why)', async () => {
    const k = h.hub.keys.create({ name: 'blocked', rpd: 1 }).key;
    now = new Date('2026-10-25T10:00:00Z');
    await send(k);
    assert.equal((await send(k)).status, 429);
    assert.equal((await h.api('GET', '/v1/usage', undefined, {}, k)).status, 200);
  });

  it('limits can be changed or removed while the hub runs', async () => {
    const k = h.hub.keys.create({ name: 'live', rpd: 1 });
    now = new Date('2026-10-26T10:00:00Z');
    await send(k.key);
    assert.equal((await send(k.key)).status, 429);
    h.hub.keys.update(k.record.id, { rpd: null });
    assert.equal((await send(k.key)).status, 200);
  });
});

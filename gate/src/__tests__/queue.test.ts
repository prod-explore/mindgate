import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { isHubError } from '../errors.js';
import { PriorityLimiter } from '../queue.js';
import { ClientAbort } from '../upstream.js';
import { addProvider, completion, openaiUpstream, sendJson, sleep, startHub, type Json, type TestHub, type Upstream } from './helpers.js';

const signal = () => new AbortController();

describe('PriorityLimiter', () => {
  it('lets requests through up to the limit, then queues', async () => {
    const l = new PriorityLimiter(2, 10, 0, 'gpu');
    const a = await l.acquire(3, signal().signal);
    const b = await l.acquire(3, signal().signal);
    assert.equal(l.running, 2);
    let third = false;
    const pending = l.acquire(3, signal().signal).then(r => {
      third = true;
      return r;
    });
    await sleep(10);
    assert.equal(third, false);
    assert.equal(l.queued, 1);
    a();
    const c = await pending;
    assert.equal(l.running, 2);
    assert.equal(l.queued, 0);
    b();
    c();
    assert.equal(l.running, 0);
  });

  it('serves higher priorities first and the oldest first within a priority', async () => {
    const l = new PriorityLimiter(1, 10, 0, 'gpu');
    const first = await l.acquire(3, signal().signal);
    const order: string[] = [];
    const wait = (name: string, p: number) =>
      l.acquire(p, signal().signal).then(release => {
        order.push(name);
        release();
      });
    const all = [wait('low-1', 1), wait('normal-1', 3), wait('low-2', 1), wait('urgent', 5), wait('normal-2', 3)];
    await sleep(10);
    first();
    await Promise.all(all);
    assert.deepEqual(order, ['urgent', 'normal-1', 'normal-2', 'low-1', 'low-2']);
  });

  it('releasing twice frees only one slot', async () => {
    const l = new PriorityLimiter(1, 10, 0, 'gpu');
    const r = await l.acquire(3, signal().signal);
    r();
    r();
    assert.equal(l.running, 0);
    const x = await l.acquire(3, signal().signal);
    assert.equal(l.running, 1);
    x();
  });

  it('a waiter that gives up leaves the line and never takes a slot', async () => {
    const l = new PriorityLimiter(1, 10, 0, 'gpu');
    const hold = await l.acquire(3, signal().signal);
    const ac = signal();
    const waiting = l.acquire(3, ac.signal);
    const caught = assert.rejects(waiting, ClientAbort);
    ac.abort();
    await caught;
    assert.equal(l.queued, 0);
    hold();
    assert.equal(l.running, 0);
    (await l.acquire(3, signal().signal))();
  });

  it('an already cancelled request is not even queued', async () => {
    const l = new PriorityLimiter(1, 10, 0, 'gpu');
    const ac = signal();
    ac.abort();
    await assert.rejects(l.acquire(3, ac.signal), ClientAbort);
    assert.equal(l.running, 0);
  });

  it('refuses when the line is full (503 queue_full, may fall back)', async () => {
    const l = new PriorityLimiter(1, 2, 0, 'gpu');
    const hold = await l.acquire(3, signal().signal);
    const w1 = l.acquire(3, signal().signal);
    const w2 = l.acquire(3, signal().signal);
    await assert.rejects(l.acquire(5, signal().signal), (e: unknown) => isHubError(e) && e.status === 503 && e.code === 'queue_full' && e.fallback);
    hold();
    (await w1)();
    (await w2)();
  });

  it('gives up after the timeout (504 queue_timeout, may fall back)', async () => {
    const l = new PriorityLimiter(1, 5, 40, 'gpu');
    const hold = await l.acquire(3, signal().signal);
    await assert.rejects(l.acquire(3, signal().signal), (e: unknown) => isHubError(e) && e.status === 504 && e.code === 'queue_timeout' && e.fallback);
    assert.equal(l.queued, 0);
    hold();
  });
});

describe('providers that can only do so much at once', () => {
  let up: Upstream;
  let h: TestHub;
  let inFlight = 0;
  let peak = 0;
  const order: string[] = [];
  let releaseAll: (() => void) | null = null;
  let gate: Promise<void>;

  const resetGate = () => {
    gate = new Promise<void>(r => {
      releaseAll = r;
    });
  };

  before(async () => {
    resetGate();
    up = await openaiUpstream({
      chat: async (req, res) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        order.push(String(req.body?.['messages']?.[0]?.content));
        const m = req.body?.['messages']?.[0]?.content;
        if (m === 'hold') await gate;
        else await sleep(20);
        inFlight--;
        sendJson(res, 200, completion('done'));
      },
    });
    h = await startHub({ setup: hub => addProvider(hub, 'gpu', up, { maxConcurrency: 1, locality: 'local' }) });
  });

  after(async () => {
    releaseAll?.();
    await h.close();
    await up.close();
  });

  const ask = (content: string, priority?: number): Promise<{ status: number; json: Json }> =>
    h.api('POST', '/v1/chat/completions', { model: 'gpu/fake-model', messages: [{ role: 'user', content }] }, priority ? { 'X-MindGate-Priority': String(priority) } : {});

  it('never runs more than the limit at once and serves the line by priority', async () => {
    order.length = 0;
    peak = 0;
    resetGate();
    const holder = ask('hold');
    await sleep(60);
    const waiting = [ask('low', 1), ask('normal', 3), ask('urgent', 5)];
    await sleep(40);
    assert.deepEqual(h.hub.registry.queueState('gpu'), { running: 1, queued: 3 });
    releaseAll!();
    const results = await Promise.all([holder, ...waiting]);
    assert.ok(results.every(r => r.status === 200));
    assert.equal(peak, 1, 'the model was never asked to do two things at once');
    assert.deepEqual(order, ['hold', 'urgent', 'normal', 'low']);
    assert.deepEqual(h.hub.registry.queueState('gpu'), { running: 0, queued: 0 });
  });

  it('a client that disconnects while waiting does not leave a slot taken', async () => {
    order.length = 0;
    resetGate();
    const holder = ask('hold');
    await sleep(60);
    const ac = new AbortController();
    const abandoned = fetch(`${h.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.key}` },
      body: JSON.stringify({ model: 'gpu/fake-model', messages: [{ role: 'user', content: 'abandoned' }] }),
      signal: ac.signal,
    }).catch(() => null);
    await sleep(50);
    assert.equal(h.hub.registry.queueState('gpu').queued, 1);
    ac.abort();
    await abandoned;
    await sleep(50);
    assert.equal(h.hub.registry.queueState('gpu').queued, 0);
    releaseAll!();
    assert.equal((await holder).status, 200);
    assert.ok(!order.includes('abandoned'), 'the abandoned request never reached the model');
    assert.equal((await ask('after')).status, 200);
  });

  it('a full line answers 503 with Retry-After', async () => {
    resetGate();
    h.hub.providers.update('gpu', { maxConcurrency: 1 });
    // shrink the line through config for this test
    (h.hub.config as { queueMax: number }).queueMax = 1;
    h.hub.providers.update('gpu', { maxConcurrency: 2 }); // makes the registry build a new limiter with the new size
    h.hub.providers.update('gpu', { maxConcurrency: 1 });
    try {
      const a = ask('hold');
      await sleep(50);
      const b = ask('queued');
      await sleep(50);
      const c = await ask('too many');
      assert.equal(c.status, 503);
      assert.equal(c.json.error.code, 'queue_full');
      releaseAll!();
      assert.equal((await a).status, 200);
      assert.equal((await b).status, 200);
    } finally {
      (h.hub.config as { queueMax: number }).queueMax = 100;
    }
  });
});

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import Database from 'better-sqlite3';
import { isHubError } from '../errors.js';
import { LATEST_SCHEMA_VERSION, migrate } from '../db.js';
import { Pacer } from '../pacer.js';
import { ClientAbort } from '../upstream.js';
import { addProvider, completion, openaiUpstream, sendJson, sendSse, sleep, startHub, textStream, type Json, type TestHub, type Upstream } from './helpers.js';

const flush = (): Promise<void> => new Promise(r => setImmediate(r));
const ac = () => new AbortController();

/** Settles into "pending / granted / failed" so a test can look at a promise without waiting for it. */
function watch<T>(p: Promise<T>): { state: 'pending' | 'granted' | 'failed'; value?: T; error?: unknown } {
  const w: { state: 'pending' | 'granted' | 'failed'; value?: T; error?: unknown } = { state: 'pending' };
  p.then(
    v => ((w.state = 'granted'), (w.value = v)),
    e => ((w.state = 'failed'), (w.error = e)),
  );
  return w;
}

describe('Pacer', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 }));
  afterEach(() => mock.timers.reset());

  const tick = async (ms: number): Promise<void> => {
    mock.timers.tick(ms);
    await flush();
  };
  const pacer = (rpm: number | null, tpm: number | null, maxWaitMs = 0, maxQueue = 100) => new Pacer({ rpm, tpm }, maxQueue, maxWaitMs, 'gemini', () => Date.now());

  it('lets requests through under the limit and holds the next until the oldest leaves the window', async () => {
    const p = pacer(2, null);
    await p.acquire(3, 0, ac().signal);
    await tick(10_000);
    await p.acquire(3, 0, ac().signal);
    const third = watch(p.acquire(3, 0, ac().signal));
    await flush();
    assert.equal(third.state, 'pending');
    assert.equal(p.queued, 1);
    await tick(49_999);
    assert.equal(third.state, 'pending', 'the first request is still inside its minute');
    await tick(1);
    assert.equal(third.state, 'granted');
    assert.equal(p.queued, 0);
    assert.equal(p.used.requests, 2);
  });

  it('counts prompt tokens, and a request that does not fit waits for enough of the window to expire', async () => {
    const p = pacer(null, 1000);
    await p.acquire(3, 600, ac().signal);
    await tick(20_000);
    await p.acquire(3, 300, ac().signal);
    const big = watch(p.acquire(3, 500, ac().signal)); // 600 + 300 + 500 > 1000: needs the first one gone
    await flush();
    assert.equal(big.state, 'pending');
    await tick(39_999);
    assert.equal(big.state, 'pending');
    await tick(1);
    assert.equal(big.state, 'granted');
    assert.equal(p.used.tokens, 800);
  });

  it('applies both limits at once', async () => {
    const p = pacer(5, 100);
    await p.acquire(3, 80, ac().signal);
    const second = watch(p.acquire(3, 30, ac().signal)); // fine for rpm, over tpm
    await flush();
    assert.equal(second.state, 'pending');
    await tick(60_000);
    assert.equal(second.state, 'granted');
  });

  it('replaces the estimate with the reported prompt size, which can free room', async () => {
    const p = pacer(null, 1000);
    const a = await p.acquire(3, 900, ac().signal);
    const b = watch(p.acquire(3, 500, ac().signal));
    await flush();
    assert.equal(b.state, 'pending');
    a.settle(100);
    await flush();
    assert.equal(b.state, 'granted');
    assert.equal(p.used.tokens, 600);
  });

  it('...or take it away when the prompt was bigger than estimated; settling twice changes nothing', async () => {
    const p = pacer(null, 1000);
    const a = await p.acquire(3, 100, ac().signal);
    a.settle(900);
    a.settle(0);
    assert.equal(p.used.tokens, 900);
    const b = watch(p.acquire(3, 200, ac().signal));
    await flush();
    assert.equal(b.state, 'pending');
    a.settle(Number.NaN);
    assert.equal(p.used.tokens, 900);
    await tick(60_000);
    assert.equal(b.state, 'granted');
  });

  it('lets a request that is larger than the whole limit through when the window is empty, and nothing beside it', async () => {
    const p = pacer(null, 1000);
    const huge = await p.acquire(3, 5000, ac().signal);
    assert.ok(huge);
    const small = watch(p.acquire(3, 10, ac().signal));
    await flush();
    assert.equal(small.state, 'pending', 'the window is full of the big one');
    await tick(60_000);
    assert.equal(small.state, 'granted');
    // and a big one behind a small one waits until the window is empty
    const again = watch(p.acquire(3, 5000, ac().signal));
    await flush();
    assert.equal(again.state, 'pending');
    await tick(59_999);
    assert.equal(again.state, 'pending');
    await tick(1);
    assert.equal(again.state, 'granted');
  });

  it('serves the line by priority, first come first served within one', async () => {
    const p = pacer(1, null);
    await p.acquire(3, 0, ac().signal);
    const order: string[] = [];
    const wait = (name: string, priority: number) => p.acquire(priority, 0, ac().signal).then(() => void order.push(name));
    const all = [wait('low-1', 1), wait('normal-1', 3), wait('low-2', 1), wait('urgent', 5), wait('normal-2', 3)];
    for (let i = 0; i < 5; i++) await tick(60_000);
    await Promise.all(all);
    assert.deepEqual(order, ['urgent', 'normal-1', 'normal-2', 'low-1', 'low-2']);
  });

  it('a request that gives up leaves the line, and the next one is looked at again', async () => {
    const p = pacer(null, 1000);
    await p.acquire(3, 900, ac().signal);
    const gone = ac();
    const head = watch(p.acquire(3, 800, gone.signal));
    const small = watch(p.acquire(3, 50, ac().signal)); // 900 + 50 fits, but it is behind the one that does not
    await flush();
    assert.equal(small.state, 'pending', 'strictly in order');
    gone.abort();
    await flush();
    assert.equal(head.state, 'failed');
    assert.ok(head.error instanceof ClientAbort);
    assert.equal(small.state, 'granted');
    assert.equal(p.queued, 0);
  });

  it('refuses a request that has already been abandoned', async () => {
    const gone = ac();
    gone.abort();
    await assert.rejects(pacer(1, null).acquire(3, 0, gone.signal), ClientAbort);
  });

  it('answers 503 pacing_timeout at once when the turn is further away than the request may wait', async () => {
    const p = pacer(1, null, 10_000);
    await p.acquire(3, 0, ac().signal);
    await tick(5000);
    const late = watch(p.acquire(3, 0, ac().signal)); // its turn is in 55s, it may wait 10s
    await flush();
    assert.equal(late.state, 'failed');
    const e = late.error;
    assert.ok(isHubError(e) && e.status === 503 && e.code === 'pacing_timeout' && e.fallback);
    assert.equal(isHubError(e) && e.headers['Retry-After'], '55');
    assert.equal(p.queued, 0);
  });

  it('waits when the turn comes within the limit', async () => {
    const p = pacer(1, null, 60_000);
    await p.acquire(3, 0, ac().signal);
    const next = watch(p.acquire(3, 0, ac().signal));
    await tick(59_999);
    assert.equal(next.state, 'pending');
    await tick(1);
    assert.equal(next.state, 'granted');
  });

  it('gives up on a request at its own deadline even while another one is ahead of it', async () => {
    const p = pacer(1, null, 50_000);
    await p.acquire(3, 0, ac().signal);
    const low = watch(p.acquire(1, 0, ac().signal)); // its turn is in 60s: fails at once
    await flush();
    assert.equal(low.state, 'failed');
    // Now one that fits when it arrives, and a later, more urgent one that goes ahead of it.
    await tick(30_000);
    const patient = watch(p.acquire(1, 0, ac().signal)); // turn in 30s, may wait 50s
    await tick(5_000);
    const urgent = watch(p.acquire(5, 0, ac().signal)); // goes first: turn in 25s
    await flush();
    assert.equal(patient.state, 'pending');
    assert.equal(urgent.state, 'pending');
    await tick(25_000);
    assert.equal(urgent.state, 'granted');
    // the urgent one is now in the window until t+60s: the patient one cannot be served before its own deadline (at 30s+50s)
    await flush();
    assert.equal(patient.state, 'failed');
    assert.ok(isHubError(patient.error) && patient.error.code === 'pacing_timeout');
  });

  it('fails a waiter by timer when its deadline passes while a more urgent one holds up the line', async () => {
    const p = pacer(null, 1000, 45_000);
    await p.acquire(3, 600, ac().signal); // t=0
    await tick(10_000);
    await p.acquire(3, 300, ac().signal); // t=10
    await tick(6_000);
    const low = watch(p.acquire(1, 500, ac().signal)); // t=16: its turn is at 60 (when the first leaves), it may wait until 61
    await tick(30_000);
    const urgent = watch(p.acquire(5, 1000, ac().signal)); // t=46: needs the whole window empty, so its turn is at 70
    await flush();
    assert.equal(low.state, 'pending');
    assert.equal(urgent.state, 'pending');
    await tick(14_999); // t=60.999
    assert.equal(low.state, 'pending');
    await tick(1);
    assert.equal(low.state, 'failed', 'it cannot be served before its deadline, so it does not keep the client waiting');
    assert.ok(isHubError(low.error) && low.error.code === 'pacing_timeout' && low.error.status === 503);
    assert.equal(urgent.state, 'pending');
    await tick(9_000);
    assert.equal(urgent.state, 'granted');
    assert.equal(p.queued, 0);
  });

  it('with no time limit waits for as long as it takes', async () => {
    const p = pacer(1, null, 0);
    await p.acquire(3, 0, ac().signal);
    const next = watch(p.acquire(3, 0, ac().signal));
    await tick(60_000);
    assert.equal(next.state, 'granted');
  });

  it('refuses to line up more requests than the queue holds', async () => {
    const p = pacer(1, null, 0, 2);
    await p.acquire(3, 0, ac().signal);
    watch(p.acquire(3, 0, ac().signal));
    watch(p.acquire(3, 0, ac().signal));
    const third = watch(p.acquire(3, 0, ac().signal));
    await flush();
    assert.equal(third.state, 'failed');
    assert.ok(isHubError(third.error) && third.error.status === 503 && third.error.code === 'queue_full' && third.error.fallback);
  });

  it('applies new limits at once and keeps what the last minute holds', async () => {
    const p = pacer(1, null);
    await p.acquire(3, 0, ac().signal);
    const next = watch(p.acquire(3, 0, ac().signal));
    await flush();
    assert.equal(next.state, 'pending');
    p.configure({ rpm: 2, tpm: null });
    await flush();
    assert.equal(next.state, 'granted');
    assert.equal(p.used.requests, 2);
  });
});

describe('migration: provider pace', () => {
  it('adds rpm and tpm to existing providers, empty', () => {
    const db = new Database(':memory:');
    migrate(db, LATEST_SCHEMA_VERSION - 1);
    db.prepare("INSERT INTO providers (id, name, type, base_url) VALUES ('old', 'Old', 'openai', 'http://x/v1')").run();
    migrate(db);
    assert.deepEqual(db.prepare("SELECT rpm, tpm FROM providers WHERE id = 'old'").get(), { rpm: null, tpm: null });
    db.prepare("UPDATE providers SET rpm = 15, tpm = 250000 WHERE id = 'old'").run();
    assert.deepEqual(db.prepare("SELECT rpm, tpm FROM providers WHERE id = 'old'").get(), { rpm: 15, tpm: 250000 });
  });
});

describe('provider pace in the hub', () => {
  let up: Upstream | undefined;
  let h: TestHub | undefined;
  afterEach(async () => {
    await h?.close();
    await up?.close();
    h = up = undefined;
  });

  const body = (content = 'hi', extra: Json = {}) => ({ model: 'fake/fake-model', messages: [{ role: 'user', content }], ...extra });
  const chatCalls = () => up!.requests.filter(r => r.path === '/v1/chat/completions');

  async function boot(provider: Record<string, unknown>, env: Record<string, string> = {}, promptTokens = 10): Promise<void> {
    up = await openaiUpstream({
      chat: async (req, res) => {
        if (req.body?.['stream']) return sendSse(res, textStream(['a', 'b'], true));
        sendJson(res, 200, completion('ok', { usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 } }));
      },
    });
    h = await startHub({ env, setup: hub => addProvider(hub, 'fake', up!, provider) });
  }

  it('answers 503 pacing_timeout, before calling the upstream, when the turn is too far away', async () => {
    await boot({ rpm: 1 }, { MINDGATE_PACING_MAX_WAIT_MS: '5000' });
    assert.equal((await h!.api('POST', '/v1/chat/completions', body())).status, 200);
    const r = await h!.api('POST', '/v1/chat/completions', body());
    assert.equal(r.status, 503);
    assert.equal(r.json.error.code, 'pacing_timeout');
    assert.equal(r.json.error.fallback, true);
    assert.equal(r.json.error.provider, 'fake');
    const wait = Number(r.headers.get('retry-after'));
    assert.ok(wait >= 58 && wait <= 60, `Retry-After says when the minute is over (${wait})`);
    assert.equal(chatCalls().length, 1, 'the second request never reached the upstream');
    const log = h!.hub.usage.recentLog({ limit: 1 })[0]!;
    assert.equal(log.errorCode, 'pacing_timeout');
    assert.deepEqual(log.attempts, [{ model: 'fake/fake-model', outcome: 'pacing_timeout' }]);
  });

  it('is not retried by the hub: the wait is the pace, not an upstream failure', async () => {
    await boot({ rpm: 1 }, { MINDGATE_PACING_MAX_WAIT_MS: '5000', MINDGATE_UPSTREAM_RETRY_MS: '45000' });
    await h!.api('POST', '/v1/chat/completions', body());
    const t = Date.now();
    assert.equal((await h!.api('POST', '/v1/chat/completions', body())).status, 503);
    assert.ok(Date.now() - t < 500);
  });

  it('MINDGATE_QUEUE_TIMEOUT_MS, when set, is the limit instead', async () => {
    await boot({ rpm: 1 }, { MINDGATE_PACING_MAX_WAIT_MS: '1000', MINDGATE_QUEUE_TIMEOUT_MS: '90000' });
    await h!.api('POST', '/v1/chat/completions', body());
    const abandoned = new AbortController();
    const waiting = fetch(`${h!.base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h!.key}` }, body: JSON.stringify(body()), signal: abandoned.signal }).then(
      r => r.status,
      () => 'aborted',
    );
    const first = await Promise.race([waiting, sleep(700).then(() => 'still waiting')]);
    assert.equal(first, 'still waiting', 'it would have failed at once under the 1s default');
    abandoned.abort();
    assert.equal(await waiting, 'aborted');
    await sleep(100);
    assert.equal(h!.hub.usage.recentLog({ limit: 1 })[0]!.status, 499);
    assert.equal(chatCalls().length, 1, 'a client that left never takes its turn');
  });

  it('keeps a streaming client\'s connection warm while it waits for its turn', async () => {
    await boot({ rpm: 1 }, { MINDGATE_QUEUE_TIMEOUT_MS: '90000' });
    await h!.api('POST', '/v1/chat/completions', body());
    const abandoned = new AbortController();
    const res = await fetch(`${h!.base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h!.key}` }, body: JSON.stringify(body('hi', { stream: true })), signal: abandoned.signal });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    assert.ok(new TextDecoder().decode(value).startsWith(': waiting for the model'));
    abandoned.abort();
    await reader.cancel().catch(() => undefined);
    assert.equal(chatCalls().length, 1);
  });

  it('corrects the estimate with the prompt size the upstream reports', async () => {
    // Every answer says its prompt was 900 tokens, whatever the estimate (a couple of tokens) was.
    await boot({ tpm: 1000 }, { MINDGATE_PACING_MAX_WAIT_MS: '1000' }, 900);
    assert.equal((await h!.api('POST', '/v1/chat/completions', body())).status, 200);
    const hundred = 'x'.repeat(400);
    assert.equal((await h!.api('POST', '/v1/chat/completions', body(hundred))).status, 200, '900 + about 100 fits');
    const r = await h!.api('POST', '/v1/chat/completions', body(hundred));
    assert.equal(r.status, 503);
    assert.equal(r.json.error.code, 'pacing_timeout');
  });

  it('lets a request that alone exceeds tpm through when nothing else is in the last minute', async () => {
    await boot({ tpm: 100 }, { MINDGATE_PACING_MAX_WAIT_MS: '1000' }, 5000);
    const r = await h!.api('POST', '/v1/chat/completions', body('x'.repeat(4000)));
    assert.equal(r.status, 200);
    assert.equal((await h!.api('POST', '/v1/chat/completions', body())).status, 503, 'but it fills the minute');
  });

  it('paces embeddings and streams too', async () => {
    await boot({ rpm: 2 }, { MINDGATE_PACING_MAX_WAIT_MS: '1000' });
    h!.hub.models.addManual('fake', 'emb', { kind: 'embedding' });
    assert.equal((await h!.api('POST', '/v1/chat/completions', body('hi', { stream: true, stream_options: { include_usage: true } }))).status, 200);
    assert.equal((await h!.api('POST', '/v1/embeddings', { model: 'fake/emb', input: 'x' })).status, 200);
    assert.equal((await h!.api('POST', '/v1/embeddings', { model: 'fake/emb', input: 'x' })).status, 503);
  });

  it('editing the provider keeps the last minute; removing the pace removes the wait', async () => {
    await boot({ rpm: 1 }, { MINDGATE_PACING_MAX_WAIT_MS: '1000' });
    await h!.api('POST', '/v1/chat/completions', body());
    h!.hub.providers.update('fake', { name: 'Renamed' });
    assert.equal((await h!.api('POST', '/v1/chat/completions', body())).status, 503, 'a rename does not reset the window');
    h!.hub.providers.update('fake', { rpm: 2 });
    assert.equal((await h!.api('POST', '/v1/chat/completions', body())).status, 200, 'a higher limit applies at once');
    h!.hub.providers.update('fake', { rpm: null });
    assert.equal((await h!.api('POST', '/v1/chat/completions', body())).status, 200);
    assert.equal((await h!.api('POST', '/v1/chat/completions', body())).status, 200);
  });

  it('a request that fails before it is sent frees the concurrency slot it held while pacing', async () => {
    await boot({ rpm: 1, maxConcurrency: 1 }, { MINDGATE_PACING_MAX_WAIT_MS: '1000' });
    await h!.api('POST', '/v1/chat/completions', body());
    assert.equal((await h!.api('POST', '/v1/chat/completions', body())).status, 503);
    assert.deepEqual(h!.hub.registry.queueState('fake'), { running: 0, queued: 0 });
  });
});

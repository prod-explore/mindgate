import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { HubError } from '../errors.js';
import { MAX_RETRIES, isRetryable, pause, retryDelayMs } from '../retry.js';
import { ClientAbort } from '../upstream.js';
import { addProvider, completion, openaiUpstream, parseSse, sendJson, sendSse, sleep, startHub, textStream, type Json, type TestHub, type Upstream } from './helpers.js';

const err = (code: string, retryAfter?: string): HubError => new HubError({ status: 429, code, message: 'x', ...(retryAfter ? { headers: { 'Retry-After': retryAfter } } : {}) });
const noJitter = () => 0;
const fullJitter = () => 1;

describe('retryDelayMs', () => {
  it('retries only "not now" failures', () => {
    for (const code of ['upstream_rate_limited', 'upstream_overloaded', 'upstream_timeout']) assert.ok(isRetryable(err(code)), code);
    for (const code of ['upstream_quota_exhausted', 'upstream_error', 'upstream_unreachable', 'upstream_auth_failed', 'queue_full', 'pacing_timeout', 'rate_limited']) assert.ok(!isRetryable(err(code)), code);
    assert.equal(retryDelayMs(err('upstream_quota_exhausted', '1'), 0, 60_000), null);
  });

  it('honours Retry-After, plus a little jitter', () => {
    assert.equal(retryDelayMs(err('upstream_rate_limited', '37'), 0, 45_000, noJitter), 37_000);
    assert.equal(retryDelayMs(err('upstream_rate_limited', '37'), 3, 45_000, fullJitter), 37_250);
    assert.equal(retryDelayMs(err('upstream_overloaded', '2'), 0, 45_000, noJitter), 2000);
  });

  it('gives up at once when the wait it asked for does not fit in what is left', () => {
    assert.equal(retryDelayMs(err('upstream_rate_limited', '46'), 0, 45_000), null);
    assert.equal(retryDelayMs(err('upstream_rate_limited', '10'), 1, 9_999), null);
    assert.equal(retryDelayMs(err('upstream_rate_limited', '10'), 1, 10_000, noJitter), 10_000);
    assert.equal(retryDelayMs(err('upstream_rate_limited', '10'), 1, 10_000, fullJitter), 10_000, 'the jitter never overshoots the budget');
  });

  it('backs off 1s, 2s, 4s... without a Retry-After', () => {
    const waits = [0, 1, 2, 3, 4].map(n => retryDelayMs(err('upstream_timeout'), n, 600_000, noJitter));
    assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000]);
    assert.equal(retryDelayMs(err('upstream_timeout'), 0, 600_000, fullJitter), 1250);
    assert.equal(retryDelayMs(err('upstream_timeout'), 3, 7_999), null, 'the next step would not fit');
  });

  it('is bounded in count and by an empty budget', () => {
    assert.equal(retryDelayMs(err('upstream_rate_limited', '1'), MAX_RETRIES, 1_000_000), null);
    assert.notEqual(retryDelayMs(err('upstream_rate_limited', '1'), MAX_RETRIES - 1, 1_000_000), null);
    assert.equal(retryDelayMs(err('upstream_rate_limited', '1'), 0, 0), null);
  });

  it('treats a Retry-After it cannot read as absent', () => {
    assert.equal(retryDelayMs(err('upstream_rate_limited', 'soon'), 0, 45_000, noJitter), 1000);
  });
});

describe('pause', () => {
  it('waits, and stops at once when the client goes away', async () => {
    const t = Date.now();
    await pause(30, new AbortController().signal);
    assert.ok(Date.now() - t >= 25);
    const ac = new AbortController();
    const p = pause(10_000, ac.signal);
    ac.abort();
    await assert.rejects(p, ClientAbort);
    await assert.rejects(pause(10, ac.signal), ClientAbort, 'already gone: no sleep at all');
  });
});

describe('the hub retries the same model before the first byte', () => {
  let up: Upstream | undefined;
  let h: TestHub | undefined;
  afterEach(async () => {
    await h?.close();
    await up?.close();
    h = up = undefined;
  });

  const GEMINI_429 = [{ error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '1s' }] } }];
  const DAILY_429 = [{ error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } }];

  /** An upstream that answers the first `fails` calls with `fail` and every later one normally. */
  async function boot(fail: (res: import('node:http').ServerResponse, n: number) => void | Promise<void>, fails: number, env: Record<string, string> = {}, provider: Record<string, unknown> = {}): Promise<void> {
    let n = 0;
    up = await openaiUpstream({
      chat: async (req, res) => {
        n++;
        if (n <= fails) return fail(res, n);
        if (req.body?.['stream']) return sendSse(res, textStream(['hel', 'lo'], true));
        sendJson(res, 200, completion(`ok after ${n - 1} failures`));
      },
    });
    h = await startHub({ env: { MINDGATE_UPSTREAM_RETRY_MS: '45000', ...env }, setup: hub => addProvider(hub, 'fake', up!, provider) });
  }

  const chatCalls = () => up!.requests.filter(r => r.path === '/v1/chat/completions');
  const ask = (body: Json = {}, headers: Record<string, string> = {}) => h!.api('POST', '/v1/chat/completions', { model: 'fake/fake-model', messages: [{ role: 'user', content: 'hi' }], ...body }, headers);

  it('waits for the Retry-After of a 429 and then succeeds, recording every try', async () => {
    await boot((res, n) => sendJson(res, 429, { error: { message: `slow ${n}` } }, { 'Retry-After': '1' }), 2);
    const t = Date.now();
    const r = await ask();
    assert.equal(r.status, 200);
    assert.equal(r.json.choices[0].message.content, 'ok after 2 failures');
    assert.equal(chatCalls().length, 3);
    assert.ok(Date.now() - t >= 2000, 'it waited the 1s the upstream asked for, twice');
    assert.deepEqual(r.json.mindgate.attempts, [
      { model: 'fake/fake-model', outcome: 'upstream_rate_limited' },
      { model: 'fake/fake-model', outcome: 'upstream_rate_limited' },
      { model: 'fake/fake-model', outcome: 'ok' },
    ]);
    const log = h!.hub.usage.recentLog({ limit: 1 })[0]!;
    assert.equal(log.status, 200);
    assert.deepEqual(log.attempts.map(a => a.outcome), ['upstream_rate_limited', 'upstream_rate_limited', 'ok']);
  });

  it('takes the wait from the body of a Gemini 429', async () => {
    await boot(res => sendJson(res, 429, GEMINI_429), 1);
    const r = await ask();
    assert.equal(r.status, 200);
    assert.equal(chatCalls().length, 2);
  });

  it('backs off on an overload that says nothing about how long', async () => {
    await boot(res => sendJson(res, 503, { error: { message: 'overloaded' } }), 1);
    const t = Date.now();
    const r = await ask();
    assert.equal(r.status, 200);
    const took = Date.now() - t;
    assert.ok(took >= 1000 && took < 1900, `waited about a second (${took}ms)`);
    assert.deepEqual(r.json.mindgate.attempts.map((a: Json) => a.outcome), ['upstream_overloaded', 'ok']);
  });

  it('answers at once, with its Retry-After, when the wait is longer than the budget', async () => {
    await boot(res => sendJson(res, 429, { error: { message: 'slow' } }, { 'Retry-After': '60' }), 5);
    const t = Date.now();
    const r = await ask();
    assert.equal(r.status, 429);
    assert.equal(r.json.error.code, 'upstream_rate_limited');
    assert.equal(r.headers.get('retry-after'), '60');
    assert.equal(r.json.error.fallback, true);
    assert.ok(Date.now() - t < 500);
    assert.equal(chatCalls().length, 1);
    assert.deepEqual(h!.hub.usage.recentLog({ limit: 1 })[0]!.attempts.map(a => a.outcome), ['upstream_rate_limited']);
  });

  it('gives up when the tries run out of budget and reports the last failure', async () => {
    await boot(res => sendJson(res, 429, { error: { message: 'slow' } }, { 'Retry-After': '1' }), 99, { MINDGATE_UPSTREAM_RETRY_MS: '2500' });
    const r = await ask();
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('retry-after'), '1');
    assert.equal(chatCalls().length, 3, 'first try, then two waits of a second fit in 2.5s');
    assert.equal(h!.hub.usage.recentLog({ limit: 1 })[0]!.attempts.length, 3);
  });

  it('does not retry a used-up daily quota', async () => {
    await boot(res => sendJson(res, 429, DAILY_429), 1);
    const r = await ask();
    assert.equal(r.status, 429);
    assert.equal(r.json.error.code, 'upstream_quota_exhausted');
    assert.ok(r.json.error.reset_at);
    assert.equal(chatCalls().length, 1);
  });

  it('does not retry failures that another try cannot fix', async () => {
    await boot(res => sendJson(res, 500, { error: { message: 'boom' } }), 1);
    const r = await ask();
    assert.equal(r.status, 502);
    assert.equal(chatCalls().length, 1);
  });

  it('is switched off by MINDGATE_UPSTREAM_RETRY_MS=0', async () => {
    await boot(res => sendJson(res, 429, { error: { message: 'slow' } }, { 'Retry-After': '1' }), 1, { MINDGATE_UPSTREAM_RETRY_MS: '0' });
    const r = await ask();
    assert.equal(r.status, 429);
    assert.equal(chatCalls().length, 1);
  });

  it('retries a first byte that never comes', async () => {
    await boot(() => undefined, 1, {}, { options: { firstByteTimeoutMs: 1000 } });
    const r = await ask();
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.mindgate.attempts.map((a: Json) => a.outcome), ['upstream_timeout', 'ok']);
  });

  it('never retries once the answer has started', async () => {
    let calls = 0;
    up = await openaiUpstream({
      chat: async (_req, res) => {
        calls++;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'half' }, finish_reason: null }] })}\n\n`);
        // and then silence: the idle timeout fires after the content began
      },
    });
    h = await startHub({ env: { MINDGATE_UPSTREAM_RETRY_MS: '45000' }, setup: hub => addProvider(hub, 'fake', up!, { options: { idleTimeoutMs: 1000 } }) });
    const r = await ask({ stream: true });
    const err = parseSse(r.text).find((e): e is Json => typeof e !== 'string' && 'error' in e)!;
    assert.equal(err.error.code, 'upstream_timeout');
    assert.equal(err.error.fallback, undefined);
    assert.equal(calls, 1);
  });

  it('stops waiting when the client disconnects', async () => {
    await boot(res => sendJson(res, 429, { error: { message: 'slow' } }, { 'Retry-After': '2' }), 1);
    const ac = new AbortController();
    const p = fetch(`${h!.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h!.key}` },
      body: JSON.stringify({ model: 'fake/fake-model', messages: [{ role: 'user', content: 'hi' }] }),
      signal: ac.signal,
    }).catch(() => null);
    await sleep(300);
    ac.abort();
    await p;
    await sleep(2300);
    assert.equal(chatCalls().length, 1, 'the retry never went out');
    const log = h!.hub.usage.recentLog({ limit: 1 })[0]!;
    assert.equal(log.status, 499);
  });

  it('keeps a streaming client\'s connection warm while it waits, then streams the answer', async () => {
    await boot(res => sendJson(res, 429, { error: { message: 'slow' } }, { 'Retry-After': '1' }), 1);
    const r = await ask({ stream: true, stream_options: { include_usage: true } });
    assert.equal(r.status, 200);
    assert.ok(/^: waiting for the model$/m.test(r.text), 'a keep-alive comment went out during the wait');
    const text = parseSse(r.text)
      .filter((e): e is Json => typeof e !== 'string' && Array.isArray(e['choices']))
      .map(c => c.choices[0]?.delta?.content ?? '')
      .join('');
    assert.equal(text, 'hello');
    assert.equal(parseSse(r.text).at(-1), '[DONE]');
    assert.deepEqual(h!.hub.usage.recentLog({ limit: 1 })[0]!.attempts.map(a => a.outcome), ['upstream_rate_limited', 'ok']);
  });

  it('gives the concurrency slot back while it waits, so others are served', async () => {
    let n = 0;
    up = await openaiUpstream({
      chat: async (req, res) => {
        n++;
        const who = String(req.body?.['messages']?.[0]?.content);
        if (who === 'first' && n === 1) return sendJson(res, 429, { error: { message: 'slow' } }, { 'Retry-After': '2' });
        sendJson(res, 200, completion(`answer for ${who}`));
      },
    });
    h = await startHub({ env: { MINDGATE_UPSTREAM_RETRY_MS: '45000' }, setup: hub => addProvider(hub, 'fake', up!, { maxConcurrency: 1 }) });
    const t = Date.now();
    const first = ask({ messages: [{ role: 'user', content: 'first' }] });
    await sleep(400);
    assert.deepEqual(h.hub.registry.queueState('fake'), { running: 0, queued: 0 }, 'the waiting request holds no slot');
    const second = await ask({ messages: [{ role: 'user', content: 'second' }] });
    assert.equal(second.json.choices[0].message.content, 'answer for second');
    assert.ok(Date.now() - t < 1500, 'the other request did not wait for the retry');
    const a = await first;
    assert.equal(a.json.choices[0].message.content, 'answer for first');
    assert.deepEqual(h.hub.registry.queueState('fake'), { running: 0, queued: 0 });
  });

  it('charges the key\'s requests-per-minute once, however many tries it takes', async () => {
    await boot(res => sendJson(res, 429, { error: { message: 'slow' } }, { 'Retry-After': '1' }), 2);
    const limited = h!.hub.keys.create({ name: 'limited', rpm: 1 }).key;
    const ok = await h!.api('POST', '/v1/chat/completions', { model: 'fake/fake-model', messages: [{ role: 'user', content: 'hi' }] }, {}, limited);
    assert.equal(ok.status, 200, 'three upstream calls fit in a limit of one request');
    assert.equal(chatCalls().length, 3);
    const again = await h!.api('POST', '/v1/chat/completions', { model: 'fake/fake-model', messages: [{ role: 'user', content: 'hi' }] }, {}, limited);
    assert.equal(again.status, 429);
    assert.equal(again.json.error.code, 'rate_limited', 'the limit itself still holds');
    const today = h!.hub.usage.recentLog({ limit: 5 }).filter(l => l.keyName === 'limited' && l.status === 200);
    assert.equal(today.length, 1);
  });
});

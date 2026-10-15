import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { SECRET, sleep, startAgent, until, type TestAgent } from './harness.js';

describe('/v1 goes through to the runtime untouched', () => {
  let t: TestAgent;
  before(async () => {
    t = await startAgent({ models: [{ name: 'tiny:1b', capabilities: ['completion'] }, { name: 'embed:1', capabilities: ['embedding'] }] });
  });
  after(() => t.close());

  const chat = (extra: object = {}) => ({ model: 'tiny:1b', messages: [{ role: 'user', content: 'hello' }], ...extra });

  it('forwards the request body byte for byte and returns the answer', async () => {
    const body = '{"model":"tiny:1b",  "messages":[{"role":"user","content":"naïve café 日本語 🙂"}],"temperature":0.2}';
    const res = await fetch(`${t.base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }, body });
    assert.equal(res.status, 200);
    const j = (await res.json()) as any;
    assert.equal(j.choices[0].message.content, 'echo:naïve café 日本語 🙂');
    const seen = t.ollama.requests.filter(r => r.path === '/v1/chat/completions').at(-1)!;
    assert.equal(seen.raw, body, 'not re-serialised, not rewritten');
  });

  it('never passes the node secret on to the runtime', async () => {
    await t.api('POST', '/v1/chat/completions', chat());
    for (const r of t.ollama.requests) {
      assert.equal(r.headers['authorization'], undefined);
      assert.equal(r.headers['x-mindgate-secret'], undefined);
    }
  });

  it('streams: the first chunk arrives while the model is still talking, in the order it was sent', async () => {
    const release = t.ollama.holdChat();
    const res = await t.raw('POST', '/v1/chat/completions', chat({ stream: true }));
    try {
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
      const reader = res.body!.getReader();
      const first = await reader.read();
      const text = new TextDecoder().decode(first.value);
      assert.match(text, /one /, 'the first chunk is not held back until the end');
      assert.doesNotMatch(text, /two:/);
      release();
      let rest = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest += new TextDecoder().decode(value);
      }
      assert.match(rest, /two:hello/);
      assert.match(rest, /\[DONE\]\s*$/);
    } finally {
      release();
    }
  });

  it('counts requests while they run (so an idle shutdown waits) and stops counting when they end', async () => {
    const release = t.ollama.holdChat();
    const res = await t.raw('POST', '/v1/chat/completions', chat({ stream: true }));
    try {
      await res.body!.getReader().read();
      assert.equal(t.agent.activity.inFlight, 1);
      assert.equal((await t.api('GET', '/node/status')).json.in_flight, 1);
      assert.equal((await t.api('GET', '/health')).json.in_flight, 1);
    } finally {
      release();
      await res.body!.cancel().catch(() => undefined);
    }
    await until(() => t.agent.activity.inFlight === 0, 'the request to be forgotten');
  });

  it('when the hub hangs up, the runtime is told to stop', async () => {
    const release = t.ollama.holdChat();
    const before = t.ollama.aborted.length;
    const ac = new AbortController();
    const res = await fetch(`${t.base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }, body: JSON.stringify(chat({ stream: true })), signal: ac.signal });
    await res.body!.getReader().read();
    ac.abort();
    await until(() => t.ollama.aborted.length > before, 'the runtime to see the request cancelled');
    assert.ok(t.ollama.aborted.includes('/v1/chat/completions'));
    await until(() => t.agent.activity.inFlight === 0, 'the request to be forgotten');
    release();
  });

  it('when the hub gives up while the model is still loading (no byte sent yet), the runtime is told to stop too', async () => {
    const release = t.ollama.holdChatHeaders();
    const before = t.ollama.aborted.length;
    const seen = t.ollama.requests.length;
    const ac = new AbortController();
    const pending = fetch(`${t.base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }, body: JSON.stringify(chat({ stream: true })), signal: ac.signal }).catch(() => null);
    try {
      await until(() => t.ollama.requests.length > seen && t.agent.activity.inFlight === 1, 'the runtime to receive the request');
      ac.abort();
      await pending;
      await until(() => t.ollama.aborted.length > before, 'the runtime to see the request cancelled');
      await until(() => t.agent.activity.inFlight === 0, 'the request to be forgotten');
    } finally {
      release();
    }
  });

  it("passes the runtime's own errors through, status and body", async () => {
    const r = await t.api('POST', '/v1/chat/completions', chat({ model: 'ghost:1b' }));
    assert.equal(r.status, 404);
    assert.equal(r.json.error.message, "model 'ghost:1b' not found");
    assert.equal(r.json.error.type, 'api_error');
  });

  it('embeddings and the query string go through too', async () => {
    const r = await t.api('POST', '/v1/embeddings', { model: 'embed:1', input: 'x' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data[0].embedding, [0.1, 0.2]);
    await t.api('GET', '/v1/something?x=1&y=two');
    assert.equal(t.ollama.requests.at(-1)?.path, '/v1/something');
  });

  it('/v1/models is answered by the agent, not by the runtime', async () => {
    t.ollama.requests.length = 0;
    const r = await t.api('GET', '/v1/models');
    assert.equal(r.status, 200);
    assert.ok(!t.ollama.requests.some(q => q.path === '/v1/models'));
    assert.ok(t.ollama.requests.some(q => q.path === '/api/tags'));
  });

  it('a runtime that cannot be reached is a clean 503 the hub can fall back from', async () => {
    const down = await startAgent({ env: { OLLAMA_URL: 'http://127.0.0.1:1' } });
    try {
      for (const [method, path, body] of [['POST', '/v1/chat/completions', chat()], ['GET', '/v1/models', undefined]] as const) {
        const r = await down.api(method, path, body);
        assert.equal(r.status, 503, path);
        assert.equal(r.json.error.code, 'runtime_unavailable');
        assert.match(r.json.error.message, /Ollama/);
      }
      assert.equal(down.agent.activity.inFlight, 0);
    } finally {
      await down.close();
    }
  });

  it('a large request body is accepted (images travel as base64)', async () => {
    const big = 'x'.repeat(5 * 1024 * 1024);
    const r = await t.api('POST', '/v1/chat/completions', chat({ messages: [{ role: 'user', content: big }] }));
    assert.equal(r.status, 200);
    assert.equal(r.json.choices[0].message.content.length, big.length + 5);
  });

  it('control endpoints are small-body only', async () => {
    const r = await t.api('POST', '/node/pulls', { name: 'x'.repeat(2 * 1024 * 1024) });
    assert.equal(r.status, 413);
    await sleep(0);
  });
});

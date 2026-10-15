import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AuthThrottle } from '../auth.js';
import { loadConfig } from '../config.js';
import { createHub, silentLogger } from '../context.js';
import { buildServer } from '../server.js';
import { ADMIN, MASTER, addProvider, openaiUpstream, startHub, type Json, type TestHub, type Upstream } from './helpers.js';

describe('HTTP basics', () => {
  let up: Upstream;
  let h: TestHub;

  before(async () => {
    up = await openaiUpstream();
    h = await startHub({ env: { MINDGATE_BODY_LIMIT_MB: '1' }, setup: hub => addProvider(hub, 'p', up) });
  });
  after(async () => {
    await h.close();
    await up.close();
  });

  const chatBody = { model: 'p/fake-model', messages: [{ role: 'user', content: 'hi' }] };

  it('/health needs no key and says nothing about the setup', async () => {
    const r = await h.api('GET', '/health', undefined, {}, null);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { status: 'ok' });
  });

  it('marks responses nosniff and warns once about X-Forwarded-For without MINDGATE_TRUST_PROXY', async () => {
    const warnings: string[] = [];
    const orig = h.hub.log.warn.bind(h.hub.log);
    (h.hub.log as { warn: unknown }).warn = (...a: unknown[]) => { warnings.push(String(a[a.length - 1])); };
    try {
      const r1 = await h.api('GET', '/health', undefined, { 'X-Forwarded-For': '203.0.113.9' }, null);
      await h.api('GET', '/health', undefined, { 'X-Forwarded-For': '203.0.113.9' }, null);
      assert.equal(r1.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(warnings.filter(w => w.includes('MINDGATE_TRUST_PROXY')).length, 1);
    } finally {
      (h.hub.log as { warn: unknown }).warn = orig;
    }
  });

  it('authentication errors are explicit and in the OpenAI error format', async () => {
    const none = await h.api('POST', '/v1/chat/completions', chatBody, {}, null);
    assert.equal(none.status, 401);
    assert.equal(none.json.error.code, 'missing_auth_header');
    assert.equal(none.json.error.type, 'authentication_error');
    assert.ok(none.json.error.message);

    const format = await h.api('POST', '/v1/chat/completions', chatBody, { Authorization: 'Token abc' }, null);
    assert.equal(format.json.error.code, 'invalid_auth_format');

    const wrong = await h.api('POST', '/v1/chat/completions', chatBody, {}, 'mg-this-is-not-a-key');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error.code, 'invalid_api_key');
    assert.ok(!JSON.stringify(wrong.json).includes('mg-this-is-not-a-key'), 'a wrong key is not echoed back');
  });

  it('every endpoint under /v1 is protected', async () => {
    for (const [method, path] of [['GET', '/v1/models'], ['GET', '/v1/models/p/fake-model'], ['POST', '/v1/chat/completions'], ['POST', '/v1/embeddings'], ['GET', '/v1/usage']] as const) {
      const r = await h.api(method, path, method === 'POST' ? {} : undefined, {}, null);
      assert.equal(r.status, 401, `${method} ${path}`);
    }
  });

  it('broken JSON is a 400 invalid_json, not a 500', async () => {
    const res = await fetch(`${h.base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.key}` }, body: '{"model": ' });
    assert.equal(res.status, 400);
    const j = (await res.json()) as Json;
    assert.equal(j.error.code, 'invalid_json');
    assert.equal(j.error.type, 'invalid_request_error');
  });

  it('validates the request before spending anything', async () => {
    const noMessages = await h.api('POST', '/v1/chat/completions', { model: 'p/fake-model' });
    assert.equal(noMessages.json.error.code, 'invalid_messages');
    assert.equal(noMessages.json.error.param, 'messages');
    const badStream = await h.api('POST', '/v1/chat/completions', { ...chatBody, stream: 'yes' });
    assert.equal(badStream.status, 400);
    assert.equal((await h.api('POST', '/v1/chat/completions', { ...chatBody, stream_options: 5 })).status, 400);
    assert.equal((await h.api('POST', '/v1/chat/completions', { ...chatBody }, { 'X-MindGate-Priority': 'high' })).json.error.code, 'invalid_priority');
    assert.equal((await h.api('POST', '/v1/embeddings', { model: 'p/fake-model' })).json.error.code, 'invalid_request');
    assert.equal(up.requests.filter(r => r.path === '/v1/chat/completions').length, 0, 'none of that reached the model');
  });

  it('a body over the limit is refused with 413', async () => {
    const big = { ...chatBody, messages: [{ role: 'user', content: 'x'.repeat(1_200_000) }] };
    const r = await h.api('POST', '/v1/chat/completions', big);
    assert.equal(r.status, 413);
    assert.equal(r.json.error.code, 'request_too_large');
  });

  it('unknown routes are 404s in the same format', async () => {
    const r = await h.api('GET', '/v1/nothing-here');
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, 'unknown_endpoint');
    assert.equal((await h.api('GET', '/')).status, 404);
  });

  it('echoes a sane X-Request-Id and makes one up otherwise', async () => {
    const mine = await h.api('GET', '/v1/models', undefined, { 'X-Request-Id': 'trace-abc-123' });
    assert.equal(mine.headers.get('x-request-id'), 'trace-abc-123');
    const made = await h.api('GET', '/v1/models');
    assert.match(made.headers.get('x-request-id') ?? '', /^req_[0-9a-f]{16}$/);
    const hostile = await h.api('GET', '/v1/models', undefined, { 'X-Request-Id': 'a b\tc' });
    assert.match(hostile.headers.get('x-request-id') ?? '', /^req_/);
    const failing = await h.api('POST', '/v1/chat/completions', {}, { 'X-Request-Id': 'trace-fail-1' });
    assert.equal(failing.headers.get('x-request-id'), 'trace-fail-1', 'errors carry it too');
    const log = h.hub.db.prepare("SELECT request_id FROM request_log WHERE request_id = 'trace-fail-1'").get();
    assert.ok(log, 'and it is in the log, so a request can be followed');
  });

  it('the answer says which model, provider and request served it', async () => {
    const r = await h.api('POST', '/v1/chat/completions', chatBody, { 'X-Request-Id': 'trace-ok-0001' });
    assert.equal(r.headers.get('x-request-id'), 'trace-ok-0001');
    assert.equal(r.headers.get('x-mindgate-model'), 'p/fake-model');
    assert.equal(r.headers.get('x-mindgate-provider'), 'p');
  });
});

describe('failed logins', () => {
  it('lock a client address out for a while, whatever it was guessing', async () => {
    const h = await startHub();
    try {
      for (let i = 0; i < 20; i++) assert.equal((await h.api('GET', '/v1/models', undefined, {}, `guess-${i}`)).status, 401);
      const locked = await h.api('GET', '/v1/models');
      assert.equal(locked.status, 429);
      assert.equal(locked.json.error.code, 'too_many_auth_failures');
      assert.ok(Number(locked.headers.get('retry-after')) >= 1);
      assert.equal((await h.api('GET', '/admin/api/status', undefined, {}, ADMIN)).status, 429, 'the admin door is locked as well');
    } finally {
      await h.close();
    }
  });

  it('the counter forgets old failures', () => {
    const t = new AuthThrottle(3, 60_000);
    for (const at of [0, 1000, 2000]) t.fail('1.2.3.4', at);
    assert.throws(() => t.check('1.2.3.4', 3000), /Too many/);
    assert.doesNotThrow(() => t.check('1.2.3.4', 61_001), 'the first failure aged out');
    assert.doesNotThrow(() => t.check('9.9.9.9', 3000), 'other addresses are unaffected');
  });
});

describe('a database on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mindgate-db-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'nested', 'mindgate.db');
  const env = (master: string) => ({ MINDGATE_MASTER_KEY: master, MINDGATE_ADMIN_TOKEN: ADMIN, MINDGATE_DB: file });
  const OTHER_MASTER = 'q'.repeat(4) + 'Zx8Cv6Bn4Mm2Lk0Jh8Gf6Ds4Sa2Pq0Wo';
  let key = '';

  it('is created private, and keeps providers, keys and secrets across restarts', async () => {
    const up = await openaiUpstream();
    try {
      const hub = createHub(loadConfig(env(MASTER), () => undefined), silentLogger);
      await addProvider(hub, 'p', up);
      key = hub.keys.create({ name: 'persisted', rpm: 7 }).key;
      assert.equal(statSync(file).mode & 0o077, 0, 'owner-only permissions');
      hub.db.close();

      const again = createHub(loadConfig(env(MASTER), () => undefined), silentLogger);
      const app = await buildServer(again);
      await app.listen({ host: '127.0.0.1', port: 0 });
      try {
        const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
        const res = await fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: 'p/fake-model', messages: [{ role: 'user', content: 'after restart' }] }),
        });
        assert.equal(res.status, 200);
        assert.equal(((await res.json()) as Json).choices[0].message.content, 'echo: after restart');
        assert.equal(again.keys.list()[0]!.rpm, 7);
      } finally {
        await app.close();
        again.db.close();
      }
    } finally {
      await up.close();
    }
  });

  it('with another master key the provider secrets cannot be read, and the hub says so instead of guessing', async () => {
    const hub = createHub(loadConfig(env(OTHER_MASTER), () => undefined), silentLogger);
    const app = await buildServer(hub);
    await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: 'p/fake-model', messages: [{ role: 'user', content: 'x' }] }),
      });
      assert.equal(res.status, 502);
      assert.equal(((await res.json()) as Json).error.code, 'provider_secret_unreadable');
      const admin = await fetch(`${base}/admin/api/providers/p`, { headers: { Authorization: `Bearer ${ADMIN}` } });
      assert.equal(((await admin.json()) as Json).api_key_unreadable, true);
    } finally {
      await app.close();
      hub.db.close();
    }
  });
});

describe('configuration', () => {
  const ok = { MINDGATE_MASTER_KEY: MASTER, MINDGATE_ADMIN_TOKEN: ADMIN };

  it('has safe defaults', () => {
    const c = loadConfig(ok, () => undefined);
    assert.equal(c.port, 3000);
    assert.equal(c.usageTz, 'UTC');
    assert.equal(c.trustProxy, false);
    assert.equal(c.bodyLimitBytes, 20 * 1024 * 1024);
    assert.equal(c.logRetentionDays, 30);
  });
});

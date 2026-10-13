import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { isHubError } from '../errors.js';
import { ClientAbort, send, withDeadline } from '../upstream.js';
import { ADMIN, openaiUpstream, startHub, startUpstream, type Json, type TestHub, type Upstream } from './helpers.js';

const SECRET = 'sk-live-SECRET-0123456789-WXYZ'; // gitleaks:allow — made-up fixture

describe('admin API', () => {
  let up: Upstream;
  let h: TestHub;

  before(async () => {
    up = await openaiUpstream({ models: [{ id: 'fake-model', context_length: 8000 }, { id: 'other', object: 'model' }] });
    h = await startHub();
  });
  after(async () => {
    await h.close();
    await up.close();
  });

  const call = (method: string, path: string, body?: unknown) => h.admin(method, path, body);
  const makeProvider = (id: string, extra: Json = {}) => call('POST', '/providers', { id, type: 'openai', base_url: `${up.url}/v1`, api_key: SECRET, ...extra });

  describe('authentication', () => {
    it('requires the admin token', async () => {
      assert.equal((await h.api('GET', '/admin/api/status', undefined, {}, null)).status, 401);
      const wrong = await h.api('GET', '/admin/api/status', undefined, {}, 'not-the-token');
      assert.equal(wrong.status, 401);
      assert.equal(wrong.json.error.code, 'invalid_admin_token');
      assert.equal((await h.api('GET', '/admin/api/status', undefined, {}, ADMIN)).status, 200);
    });

    it('a client key is not an admin credential, and the admin token is not a client key', async () => {
      assert.equal((await h.api('GET', '/admin/api/providers', undefined, {}, h.key)).status, 401);
      const r = await h.api('GET', '/v1/models', undefined, {}, ADMIN);
      assert.equal(r.status, 401);
      assert.equal(r.json.error.code, 'invalid_api_key');
    });

    it('answers are never cached', async () => {
      const r = await h.admin('GET', '/status');
      assert.equal(r.headers.get('cache-control'), 'no-store');
    });

    it('unknown admin endpoints are JSON 404s', async () => {
      const r = await call('GET', '/nope');
      assert.equal(r.status, 404);
      assert.equal(r.json.error.code, 'unknown_endpoint');
    });
  });

  describe('providers', () => {
    it('creates a provider, syncs its models and never shows the API key again', async () => {
      const r = await makeProvider('alpha', { name: 'Alpha', locality: 'local' });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      assert.equal(r.json.id, 'alpha');
      assert.equal(r.json.locality, 'local');
      assert.equal(r.json.has_api_key, true);
      assert.equal(r.json.api_key_hint, 'WXYZ');
      assert.equal(r.json.model_count, 2);
      assert.equal(r.json.sync.added, 2);
      for (const view of [r.json, (await call('GET', '/providers')).json, (await call('GET', '/providers/alpha')).json]) {
        assert.ok(!JSON.stringify(view).includes(SECRET), 'the key must not appear in any answer');
        assert.ok(!JSON.stringify(view).includes('SECRET-0123'));
      }
    });

    it('stores the key encrypted: the database file never contains it', async () => {
      const rows = JSON.stringify(h.hub.db.prepare('SELECT * FROM providers').all());
      assert.ok(!rows.includes(SECRET));
      assert.ok(!rows.includes('SECRET-0123'));
      const sealed = (h.hub.db.prepare("SELECT secret_enc FROM providers WHERE id = 'alpha'").get() as { secret_enc: string }).secret_enc;
      assert.ok(sealed.length > 40);
    });

    it('the stored key reaches the upstream as a bearer token', async () => {
      await call('POST', '/providers/alpha/sync');
      assert.equal(up.requests.at(-1)!.headers['authorization'], `Bearer ${SECRET}`);
    });

    it('rejects bad input with a useful code', async () => {
      assert.equal((await makeProvider('Bad Id!')).json.error.code, 'invalid_provider_id');
      assert.equal((await call('POST', '/providers', { id: 'ftp', type: 'openai', base_url: 'ftp://x/v1' })).status, 400);
      assert.equal((await call('POST', '/providers', { id: 'weird', type: 'cohere', base_url: `${up.url}/v1` })).status, 400);
      assert.equal((await call('POST', '/providers', { id: 'nourl', type: 'openai' })).status, 400);
      assert.equal((await makeProvider('alpha')).status, 409, 'the same id twice');
      assert.equal((await makeProvider('hdr', { extra_headers: { Authorization: 'x' } })).status, 400, 'reserved headers cannot be overridden');
      assert.equal((await makeProvider('loc', { locality: 'mars' })).status, 400);
      assert.equal((await makeProvider('conc', { max_concurrency: 0 })).status, 400);
      assert.equal((await makeProvider('keynl', { api_key: 'abc\ndef' })).status, 400);
      assert.equal((await call('POST', '/providers', 'nope')).status, 400);
    });

    it('a provider that cannot be reached is still created; the sync error is reported', async () => {
      const r = await call('POST', '/providers', { id: 'offline', type: 'openai', base_url: 'http://127.0.0.1:9/v1', auth_scheme: 'none' });
      assert.equal(r.status, 201);
      assert.ok(r.json.sync.error);
      assert.ok((await call('GET', '/providers/offline')).json.last_sync_error);
    });

    it('tests connectivity without changing anything', async () => {
      const ok = await call('POST', '/providers/alpha/test');
      assert.equal(ok.json.ok, true);
      assert.equal(ok.json.models, 2);
      const bad = await call('POST', '/providers/offline/test');
      assert.equal(bad.json.ok, false);
      assert.equal(bad.json.code, 'upstream_unreachable');
    });

    it('updates fields, replaces and removes the key', async () => {
      const r = await call('PATCH', '/providers/alpha', { name: 'Alpha 2', locality: 'cloud', enabled: false, max_concurrency: 2 });
      assert.equal(r.status, 200);
      assert.equal(r.json.name, 'Alpha 2');
      assert.equal(r.json.locality, 'cloud');
      assert.equal(r.json.enabled, false);
      assert.equal(r.json.status, 'disabled');
      assert.equal(r.json.max_concurrency, 2);
      assert.equal(r.json.has_api_key, true, 'a patch without api_key leaves the key alone');
      await call('PATCH', '/providers/alpha', { enabled: true, max_concurrency: null });
      const swapped = await call('PATCH', '/providers/alpha', { api_key: 'sk-second-key-ABCDEFGH12345' }); // gitleaks:allow — made-up fixture
      assert.equal(swapped.json.api_key_hint, '2345');
      await call('POST', '/providers/alpha/sync');
      assert.equal(up.requests.at(-1)!.headers['authorization'], 'Bearer sk-second-key-ABCDEFGH12345');
      const removed = await call('PATCH', '/providers/alpha', { api_key: null });
      assert.equal(removed.json.has_api_key, false);
      assert.equal(removed.json.api_key_hint, null);
    });

    it('a node configuration is validated', async () => {
      const bad = await call('PATCH', '/providers/alpha', { node: { mac: 'nonsense', broadcast: '192.168.1.255' } });
      assert.equal(bad.status, 400);
      assert.equal(bad.json.error.code, 'invalid_node');
      const needsAgent = await call('PATCH', '/providers/alpha', { node: { mac: 'AA:BB:CC:DD:EE:02', broadcast: '192.168.1.255', idle_shutdown_minutes: 5 } });
      assert.equal(needsAgent.status, 400, 'idle shutdown needs somewhere to send the request');
      const ok = await call('PATCH', '/providers/alpha', { node: { mac: 'aa-bb-cc-dd-ee-02', broadcast: '192.168.1.255', boot_timeout_ms: 90000 } });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.node.mac, 'AA:BB:CC:DD:EE:02');
      assert.equal(ok.json.node.boot_timeout_ms, 90000);
      assert.equal(ok.json.kind, 'node');
      assert.equal((await call('PATCH', '/providers/alpha', { node: null })).json.node, null);
    });

    it('waking a provider that is not a node is a clear error', async () => {
      const r = await call('POST', '/providers/alpha/wake');
      assert.equal(r.status, 400);
      assert.equal(r.json.error.code, 'not_a_node');
    });

    it('lists presets for the usual providers', async () => {
      const ids = ((await call('GET', '/presets')).json.data as Json[]).map(p => p.id);
      for (const id of ['openrouter', 'gemini', 'anthropic', 'openai', 'ollama', 'lmstudio']) assert.ok(ids.includes(id), id);
    });

    it('deleting a provider removes its models and says which aliases lost a target', async () => {
      await makeProvider('temp');
      await call('POST', '/aliases', { name: 'uses-temp', targets: ['temp/fake-model', 'alpha/fake-model'] });
      const r = await call('DELETE', '/providers/temp');
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.aliases_affected, ['uses-temp']);
      assert.equal((await call('GET', '/providers/temp')).status, 404);
      assert.equal((await call('GET', '/models?provider=temp')).json.data.length, 0);
      const alias = (await call('GET', '/aliases')).json.data.find((a: Json) => a.name === 'uses-temp');
      assert.deepEqual(alias.missing_targets, ['temp/fake-model'], 'the alias shows that one of its targets is gone');
      await call('DELETE', '/aliases/uses-temp');
    });
  });

  describe('models', () => {
    it('lists models with what the provider reported and what the owner overrode', async () => {
      const r = await call('GET', '/models?provider=alpha');
      const m = (r.json.data as Json[]).find(x => x.id === 'alpha/fake-model')!;
      assert.equal(m.upstream_id, 'fake-model');
      assert.equal(m.source, 'synced');
      assert.equal(m.context_length, 8000);
      assert.equal(m.reported.context_length, 8000);
      assert.deepEqual(m.overrides, {});
    });

    it('overrides win and null puts the reported value back', async () => {
      const r = await call('PATCH', '/models/alpha/fake-model', { context_length: 4000, tags: ['fast'], description: 'my words', locality: 'local' });
      assert.equal(r.status, 200);
      assert.equal(r.json.context_length, 4000);
      assert.equal(r.json.reported.context_length, 8000);
      assert.equal(r.json.locality, 'local');
      const back = await call('PATCH', '/models/alpha/fake-model', { context_length: null, locality: null });
      assert.equal(back.json.context_length, 8000);
      assert.equal(back.json.locality, 'cloud');
      assert.equal((await call('PATCH', '/models/alpha/fake-model', { context_length: -5 })).status, 400);
      assert.equal((await call('PATCH', '/models/alpha/fake-model', { kind: 'telepathy' })).status, 400);
      assert.equal((await call('PATCH', '/models/alpha/nothing', { name: 'x' })).status, 404);
    });

    it('a model switched off is not offered to clients', async () => {
      await call('PATCH', '/models/alpha/other', { enabled: false });
      const ids = ((await h.api('GET', '/v1/models')).json.data as Json[]).map(m => m.id);
      assert.ok(ids.includes('alpha/fake-model'));
      assert.ok(!ids.includes('alpha/other'));
      const direct = await h.api('POST', '/v1/chat/completions', { model: 'alpha/other', messages: [{ role: 'user', content: 'x' }] });
      assert.equal(direct.status, 503);
      await call('PATCH', '/models/alpha/other', { enabled: true });
    });

    it('adds a model by hand, which a later sync leaves alone; deleting a synced model only hides it', async () => {
      const added = await call('POST', '/models', { provider: 'alpha', id: 'secret-sauce', name: 'Secret sauce', kind: 'chat', context_length: 1000 });
      assert.equal(added.status, 201);
      assert.equal(added.json.source, 'manual');
      assert.equal((await call('POST', '/models', { provider: 'alpha', id: 'secret-sauce' })).status, 409);
      await call('POST', '/providers/alpha/sync');
      assert.ok(((await call('GET', '/models?provider=alpha')).json.data as Json[]).some(m => m.id === 'alpha/secret-sauce'));
      assert.equal((await call('DELETE', '/models/alpha/secret-sauce')).json.deleted, true);
      assert.equal((await call('DELETE', '/models/alpha/other')).json.deleted, false);
      assert.equal(((await call('GET', '/models?provider=alpha')).json.data as Json[]).find(m => m.id === 'alpha/other')!.enabled, false);
      await call('PATCH', '/models/alpha/other', { enabled: true });
    });

    it('model ids that contain slashes work in the URL', async () => {
      await call('POST', '/models', { provider: 'alpha', id: 'meta/llama-3/70b' });
      const r = await call('PATCH', '/models/alpha/meta/llama-3/70b', { name: 'Llama' });
      assert.equal(r.status, 200);
      assert.equal(r.json.name, 'Llama');
      assert.equal((await call('DELETE', '/models/alpha/meta/llama-3/70b')).status, 200);
    });
  });

  describe('aliases', () => {
    it('creates, reorders and deletes an alias', async () => {
      const created = await call('POST', '/aliases', { name: 'best', description: 'the good one', tags: ['smart'], targets: ['alpha/fake-model', 'alpha/other'] });
      assert.equal(created.status, 201);
      assert.deepEqual(created.json.targets, ['alpha/fake-model', 'alpha/other']);
      const reordered = await call('PATCH', '/aliases/best', { targets: ['alpha/other', 'alpha/fake-model'] });
      assert.deepEqual(reordered.json.targets, ['alpha/other', 'alpha/fake-model']);
      assert.equal((await h.api('GET', '/v1/models/best')).json.alias_of[0], 'alpha/other', 'clients see the new order at once');
      assert.equal((await call('DELETE', '/aliases/best')).status, 200);
      assert.equal((await call('DELETE', '/aliases/best')).status, 404);
    });

    it('refuses bad names and unknown targets', async () => {
      assert.equal((await call('POST', '/aliases', { name: 'a/b', targets: ['alpha/fake-model'] })).json.error.code, 'invalid_alias_name');
      assert.equal((await call('POST', '/aliases', { name: 'x', targets: ['alpha/ghost'] })).json.error.code, 'unknown_target');
      assert.equal((await call('POST', '/aliases', { name: 'x', targets: [] })).json.error.code, 'invalid_targets');
      await call('POST', '/aliases', { name: 'dup', targets: ['alpha/fake-model'] });
      assert.equal((await call('POST', '/aliases', { name: 'dup', targets: ['alpha/fake-model'] })).status, 409);
      await call('DELETE', '/aliases/dup');
    });
  });

  describe('client keys', () => {
    it('shows the full key exactly once', async () => {
      const created = await call('POST', '/keys', { name: 'laptop', rpm: 30, local_only: true, allowed_models: ['alpha/*'], max_priority: 4 });
      assert.equal(created.status, 201, JSON.stringify(created.json));
      const key = created.json.key as string;
      assert.match(key, /^mg-[A-Za-z0-9_-]{43}$/);
      assert.equal(created.json.prefix, key.slice(0, 9));
      assert.equal(created.json.local_only, true);
      assert.deepEqual(created.json.allowed_models, ['alpha/*']);
      assert.equal(created.json.max_priority, 4);

      const list = JSON.stringify((await call('GET', '/keys')).json);
      assert.ok(!list.includes(key), 'not in the list');
      assert.ok(!list.includes('"hash"'));
      assert.ok(!JSON.stringify((await call('GET', '/status')).json).includes(key));
      const stored = JSON.stringify(h.hub.db.prepare('SELECT * FROM api_keys').all());
      assert.ok(!stored.includes(key), 'not in the database either: only a hash is');
      assert.equal((await h.api('GET', '/v1/models', undefined, {}, key)).status, 200);
    });

    it('revoking stops the key at once but keeps its history', async () => {
      const k = (await call('POST', '/keys', { name: 'short-lived' })).json;
      assert.equal((await h.api('GET', '/v1/models', undefined, {}, k.key)).status, 200);
      const revoked = await call('POST', `/keys/${k.id}/revoke`);
      assert.ok(revoked.json.revoked_at);
      const denied = await h.api('GET', '/v1/models', undefined, {}, k.key);
      assert.equal(denied.status, 401);
      assert.equal(denied.json.error.code, 'invalid_api_key');
      assert.ok(((await call('GET', '/keys')).json.data as Json[]).some(x => x.id === k.id), 'still listed');
    });

    it('limits and restrictions can be changed later; null removes a limit', async () => {
      const k = (await call('POST', '/keys', { name: 'tunable', rpd: 5 })).json;
      const r = await call('PATCH', `/keys/${k.id}`, { rpd: null, tokens_per_month: 100000, local_only: true, allowed_models: null });
      assert.equal(r.json.rpd, null);
      assert.equal(r.json.tokens_per_month, 100000);
      assert.equal(r.json.local_only, true);
      assert.equal(r.json.allowed_models, null);
      assert.equal((await call('PATCH', `/keys/${k.id}`, { rpm: 0 })).json.error.code, 'invalid_limit');
      assert.equal((await call('PATCH', `/keys/${k.id}`, { min_priority: 4, max_priority: 2 })).json.error.code, 'invalid_priority');
    });

    it('rejects duplicates and nonsense; a key can be supplied to keep one clients already hold', async () => {
      assert.equal((await call('POST', '/keys', { name: 'laptop' })).status, 409);
      assert.equal((await call('POST', '/keys', { name: '' })).status, 400);
      assert.equal((await call('POST', '/keys', { name: 'bad', default_priority: 9 })).json.error.code, 'invalid_priority');
      const mine = 'legacy-key-that-clients-already-have-123';
      const r = await call('POST', '/keys', { name: 'legacy', key: mine });
      assert.equal(r.status, 201);
      assert.equal((await h.api('GET', '/v1/models', undefined, {}, mine)).status, 200);
      assert.equal((await call('POST', '/keys', { name: 'legacy2', key: mine })).status, 409, 'the same key twice');
      assert.equal((await call('POST', '/keys', { name: 'short', key: 'abc' })).status, 400);
    });

    it('deleting removes the key', async () => {
      const k = (await call('POST', '/keys', { name: 'to-delete' })).json;
      assert.equal((await call('DELETE', `/keys/${k.id}`)).status, 200);
      assert.equal((await call('DELETE', `/keys/${k.id}`)).status, 404);
      assert.equal((await h.api('GET', '/v1/models', undefined, {}, k.key)).status, 401);
    });
  });

  describe('usage and log', () => {
    it('shows what was used, per key and model, and a log without any text', async () => {
      const k = (await call('POST', '/keys', { name: 'metered' })).json;
      const ask = (model: string) => h.api('POST', '/v1/chat/completions', { model, messages: [{ role: 'user', content: 'my private words' }] }, { 'X-MindGate-Tag': 'unit-test' }, k.key);
      assert.equal((await ask('alpha/fake-model')).status, 200);
      assert.equal((await ask('alpha/ghost')).status, 404);

      const usage = await call('GET', `/usage?key=${k.id}`);
      assert.equal(usage.json.data.length, 1);
      assert.equal(usage.json.data[0].model, 'alpha/fake-model');
      assert.equal(usage.json.data[0].requests, 1);
      assert.equal(usage.json.data[0].input_tokens, 10);

      const log = await call('GET', `/log?key=${k.id}`);
      assert.ok(log.json.data.length >= 1);
      const ok = log.json.data.find((e: Json) => e.status === 200);
      assert.equal(ok.key, 'metered');
      assert.equal(ok.tag, 'unit-test');
      assert.equal(ok.model, 'alpha/fake-model');
      assert.ok(!JSON.stringify(log.json).includes('private words'));
      const errors = await call('GET', `/log?key=${k.id}&errors=1`);
      assert.ok(errors.json.data.every((e: Json) => e.status >= 400));
      assert.ok(errors.json.data.some((e: Json) => e.error_code === 'model_not_found'));
    });

    it('validates dates', async () => {
      assert.equal((await call('GET', '/usage?from=yesterday')).status, 400);
      assert.equal((await call('GET', '/usage?key=nobody')).status, 404);
    });

    it('status gives a quick overview', async () => {
      const s = (await call('GET', '/status')).json;
      assert.equal(s.version, '2.0.0');
      assert.ok(s.counts.providers >= 2);
      assert.ok(s.counts.keys >= 1);
      assert.ok(Array.isArray(s.providers));
    });
  });
  describe('deadlines on the owner’s own checks', () => {
    it('a provider that never answers is a timeout, not "aborted by the client"', async () => {
      const hang = await startUpstream(() => new Promise<void>(() => undefined));
      try {
        await makeProvider('hang', { base_url: `${hang.url}/v1`, sync: false });
        const provider = h.hub.providers.require('hang');
        await assert.rejects(
          withDeadline(150, 'hang', signal => send(provider, `${hang.url}/v1/models`, { method: 'GET', headers: {}, signal, timeoutMs: 30_000 })),
          (e: unknown) => isHubError(e) && e.status === 504 && e.code === 'upstream_timeout' && /within \d+s/.test(e.message),
        );
      } finally {
        await hang.close();
      }
    });

    it('a real abort that is not the deadline stays an abort', async () => {
      const ac = new AbortController();
      const run = withDeadline(10_000, 'x', () => new Promise<void>((_, reject) => ac.signal.addEventListener('abort', () => reject(new ClientAbort()))));
      ac.abort();
      await assert.rejects(run, ClientAbort);
    });
  });
});

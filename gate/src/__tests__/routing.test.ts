import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { addProvider, chunk, echoChat, openaiUpstream, parseSse, sendJson, sleep, startHub, type Json, type TestHub, type Upstream } from './helpers.js';

type Behaviour = 'ok' | 'boom' | 'bad-request' | 'cut-after-content' | 'cut-before-content';

describe('routing, no silent fallback and local-only', () => {
  let cloud: Upstream;
  let backup: Upstream;
  let local: Upstream;
  let h: TestHub;
  const mode: Record<'cloud' | 'backup' | 'local', Behaviour> = { cloud: 'ok', backup: 'ok', local: 'ok' };

  const behave = (name: 'cloud' | 'backup' | 'local'): NonNullable<Parameters<typeof openaiUpstream>[0]>['chat'] => async (req, res) => {
    switch (mode[name]) {
      case 'boom':
        return sendJson(res, 500, { error: { message: 'kaboom', code: 'server_error' } });
      case 'bad-request':
        return sendJson(res, 400, { error: { message: 'maximum context length is 10 tokens', code: 'context_length_exceeded' } });
      case 'cut-before-content':
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        return void res.destroy();
      case 'cut-after-content':
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'par' }))}\n\n`);
        res.write(`data: ${JSON.stringify(chunk({ content: 'tial' }))}\n\n`);
        await sleep(40);
        return void res.destroy();
      default:
        return echoChat(req, res);
    }
  };

  before(async () => {
    cloud = await openaiUpstream({ models: [{ id: 'fake-model' }, { id: 'text-embedding-3' }], chat: behave('cloud') });
    backup = await openaiUpstream({ models: [{ id: 'fake-model' }], chat: behave('backup') });
    local = await openaiUpstream({ models: [{ id: 'llama' }], chat: behave('local') });
    h = await startHub({
      setup: async hub => {
        await addProvider(hub, 'cloud', cloud, { locality: 'cloud' });
        await addProvider(hub, 'backup', backup, { locality: 'cloud' });
        await addProvider(hub, 'home', local, { locality: 'local' });
      },
    });
  });

  after(async () => {
    await h.close();
    await Promise.all([cloud.close(), backup.close(), local.close()]);
  });

  beforeEach(() => {
    mode.cloud = mode.backup = mode.local = 'ok';
    for (const u of [cloud, backup, local]) u.requests.length = 0;
  });

  const chat = (model: string, extra: Json = {}, headers: Record<string, string> = {}, token?: string) =>
    h.api('POST', '/v1/chat/completions', { model, messages: [{ role: 'user', content: 'ping' }], ...extra }, headers, token);
  const chatCalls = (u: Upstream) => u.requests.filter(r => r.path === '/v1/chat/completions').length;

  describe('canonical ids', () => {
    it('routes provider/model to that provider and says who answered', async () => {
      const r = await chat('backup/fake-model');
      assert.equal(r.status, 200);
      assert.equal(r.json.model, 'backup/fake-model');
      assert.equal(r.headers.get('x-mindgate-provider'), 'backup');
      assert.equal(r.headers.get('x-mindgate-model'), 'backup/fake-model');
      assert.equal(r.headers.get('x-mindgate-fallback'), null);
      assert.equal(chatCalls(backup), 1);
      assert.equal(chatCalls(cloud), 0);
      // the upstream sees its own model id, not the hub's canonical one
      assert.equal(backup.requests.at(-1)!.body!['model'], 'fake-model');
    });

    it('an unknown model is a 404 in the OpenAI error format', async () => {
      const r = await chat('cloud/not-there');
      assert.equal(r.status, 404);
      assert.equal(r.json.error.code, 'model_not_found');
      assert.equal((await chat('nonsense')).json.error.code, 'model_not_found');
    });

    it('a bare name is not a model: there are no aliases, only provider/model ids', async () => {
      for (const name of ['smart', 'free', 'fake-model', '/fake-model']) {
        const r = await chat(name);
        assert.equal(r.status, 404, name);
        assert.equal(r.json.error.code, 'model_not_found');
      }
    });

    it('a missing model is a 400', async () => {
      const r = await h.api('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] });
      assert.equal(r.status, 400);
      assert.equal(r.json.error.code, 'missing_model');
    });

    it('the model can also come from the X-MindGate-Model header', async () => {
      const r = await h.api('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] }, { 'X-MindGate-Model': 'home/llama' });
      assert.equal(r.status, 200);
      assert.equal(r.json.model, 'home/llama');
    });
  });

  describe('no silent fallback', () => {
    it('a failing model answers with its own error and no other provider is tried', async () => {
      mode.cloud = 'boom';
      const r = await chat('cloud/fake-model');
      assert.equal(r.status, 502);
      assert.equal(r.json.error.code, 'upstream_error');
      assert.equal(r.json.error.provider, 'cloud');
      assert.equal(chatCalls(backup), 0, 'a model with the same name at another provider must not be used');
      assert.equal(chatCalls(cloud), 1);
    });

    it('the error tells the app it may pick another model: fallback is true when the failure was the model\'s', async () => {
      mode.cloud = 'boom';
      const r = await chat('cloud/fake-model');
      assert.equal(r.json.error.fallback, true);
    });

    it('a request the model rejects (bad input) is not marked as retryable elsewhere', async () => {
      mode.cloud = 'bad-request';
      const r = await chat('cloud/fake-model');
      assert.equal(r.status, 400);
      assert.equal(r.json.error.code, 'context_length_exceeded');
      assert.equal(r.json.error.fallback, undefined);
      assert.equal(chatCalls(backup), 0);
    });

    it('the response of a successful call has no fallback marks', async () => {
      const r = await chat('cloud/fake-model');
      assert.equal(r.headers.get('x-mindgate-fallback'), null);
      assert.deepEqual(r.json.mindgate.attempts, [{ model: 'cloud/fake-model', outcome: 'ok' }]);
      assert.equal(r.json.error, undefined);
    });

    it('streaming: a connection that dies before any content is a plain error the app can answer with another model', async () => {
      mode.cloud = 'cut-before-content';
      const r = await h.raw('POST', '/v1/chat/completions', { model: 'cloud/fake-model', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(r.status, 502, 'nothing had gone out, so the status line can still say it failed');
      const body = JSON.parse(await r.text()) as Json;
      assert.equal(body.error.provider, 'cloud');
      assert.equal(body.error.fallback, true);
      assert.equal(chatCalls(backup), 0);
    });

    it('streaming: once content has reached the client the error travels in the stream and is not marked retryable', async () => {
      mode.cloud = 'cut-after-content';
      const r = await h.raw('POST', '/v1/chat/completions', { model: 'cloud/fake-model', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(r.status, 200);
      const events = parseSse(await r.text());
      const err = events.find((e): e is Json => typeof e === 'object' && !!e.error);
      assert.ok(err, 'an error event is sent');
      assert.equal(err.error.code, 'upstream_stream_interrupted');
      assert.equal(err.error.fallback, undefined, 'half an answer cannot be taken over by another model');
      assert.equal(events.at(-1), '[DONE]');
      assert.equal(chatCalls(backup), 0, 'a half-written answer is never continued by another model');
    });

    it('a disabled provider makes its models unavailable (503), the others are untouched', async () => {
      h.hub.providers.update('cloud', { enabled: false });
      try {
        const r = await chat('cloud/fake-model');
        assert.equal(r.status, 503);
        assert.equal(r.json.error.code, 'no_available_model');
        assert.equal(chatCalls(cloud), 0);
        assert.equal((await chat('backup/fake-model')).status, 200);
      } finally {
        h.hub.providers.update('cloud', { enabled: true });
      }
    });
  });

  describe('local only', () => {
    it('a local-only key is refused on a cloud model', async () => {
      const k = h.hub.keys.create({ name: 'private', localOnly: true }).key;
      const r = await chat('cloud/fake-model', {}, {}, k);
      assert.equal(r.status, 403);
      assert.equal(r.json.error.code, 'local_only_violation');
      assert.equal(chatCalls(cloud), 0);
      assert.equal((await chat('home/llama', {}, {}, k)).status, 200);
    });

    it('the header does the same for a key that is not restricted', async () => {
      const r = await chat('cloud/fake-model', {}, { 'X-MindGate-Local-Only': 'true' });
      assert.equal(r.status, 403);
      assert.equal(r.json.error.code, 'local_only_violation');
      assert.equal((await chat('home/llama', {}, { 'X-MindGate-Local-Only': '1' })).status, 200);
      assert.equal((await chat('cloud/fake-model', {}, { 'X-MindGate-Local-Only': 'false' })).status, 200);
    });

    it('the header cannot be used to loosen a key that is local-only', async () => {
      const k = h.hub.keys.create({ name: 'private2', localOnly: true }).key;
      const r = await chat('cloud/fake-model', {}, { 'X-MindGate-Local-Only': 'false' }, k);
      assert.equal(r.status, 403);
    });

    it('the model list shows only what a local-only caller can reach', async () => {
      const k = h.hub.keys.create({ name: 'private3', localOnly: true }).key;
      const r = await h.api('GET', '/v1/models', undefined, {}, k);
      const ids = (r.json.data as Json[]).map(m => m.id);
      assert.ok(ids.includes('home/llama'));
      assert.ok(!ids.some(id => id.startsWith('cloud/') || id.startsWith('backup/')));
      const viaHeader = await h.api('GET', '/v1/models', undefined, { 'X-MindGate-Local-Only': 'true' });
      assert.deepEqual(
        (viaHeader.json.data as Json[]).map(m => m.id).sort(),
        ids.sort(),
      );
    });

    it('a model can be marked local or cloud by hand, and the override wins', async () => {
      h.hub.models.patch('cloud/fake-model', { locality: 'local' });
      try {
        const r = await chat('cloud/fake-model', {}, { 'X-MindGate-Local-Only': 'true' });
        assert.equal(r.status, 200);
      } finally {
        h.hub.models.patch('cloud/fake-model', { locality: null });
      }
      assert.equal((await chat('cloud/fake-model', {}, { 'X-MindGate-Local-Only': 'true' })).status, 403);
    });
  });

  describe('which models a key may use', () => {
    it('allowed_models accepts ids and provider wildcards', async () => {
      const k = h.hub.keys.create({ name: 'narrow', allowedModels: ['home/*', 'backup/fake-model'] }).key;
      assert.equal((await chat('home/llama', {}, {}, k)).status, 200);
      assert.equal((await chat('backup/fake-model', {}, {}, k)).status, 200);
      const denied = await chat('cloud/fake-model', {}, {}, k);
      assert.equal(denied.status, 403);
      assert.equal(denied.json.error.code, 'model_not_allowed');
      const listed = ((await h.api('GET', '/v1/models', undefined, {}, k)).json.data as Json[]).map(m => m.id).sort();
      assert.deepEqual(listed, ['backup/fake-model', 'home/llama']);
    });
  });

  describe('kinds of model', () => {
    it('a chat call to an embedding model is refused with a pointer to the right endpoint', async () => {
      const r = await chat('cloud/text-embedding-3');
      assert.equal(r.status, 400);
      assert.equal(r.json.error.code, 'wrong_model_kind');
      assert.match(r.json.error.message, /\/v1\/embeddings/);
    });

    it('embeddings go to an embedding model and a chat model is refused there', async () => {
      const ok = await h.api('POST', '/v1/embeddings', { model: 'cloud/text-embedding-3', input: 'hello' });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.model, 'cloud/text-embedding-3');
      assert.equal(ok.json.data[0].embedding.length, 2);
      const bad = await h.api('POST', '/v1/embeddings', { model: 'cloud/fake-model', input: 'hello' });
      assert.equal(bad.status, 400);
      assert.equal(bad.json.error.code, 'wrong_model_kind');
    });
  });

  describe('GET /v1/models', () => {
    it('lists models with the fields clients need', async () => {
      const r = await h.api('GET', '/v1/models');
      assert.equal(r.status, 200);
      assert.equal(r.json.object, 'list');
      const byId = new Map((r.json.data as Json[]).map(m => [m.id as string, m]));
      const m = byId.get('cloud/fake-model')!;
      assert.equal(m.object, 'model');
      assert.equal(m.owned_by, 'cloud');
      assert.equal(m.locality, 'cloud');
      assert.equal(m.kind, 'chat');
      assert.equal(byId.get('home/llama')!.locality, 'local');
      assert.equal(byId.get('cloud/text-embedding-3')!.kind, 'embedding');
      assert.ok(!(r.json.data as Json[]).some(x => 'alias_of' in x), 'there are no aliases to list');
    });

    it('a single model can be fetched by id, including ids with a slash', async () => {
      const r = await h.api('GET', '/v1/models/home/llama');
      assert.equal(r.status, 200);
      assert.equal(r.json.id, 'home/llama');
      assert.equal((await h.api('GET', '/v1/models/nope/nothing')).status, 404);
    });

    it('a provider that is switched off disappears from the list', async () => {
      h.hub.providers.update('backup', { enabled: false });
      try {
        const ids = ((await h.api('GET', '/v1/models')).json.data as Json[]).map(m => m.id as string);
        assert.ok(!ids.includes('backup/fake-model'));
      } finally {
        h.hub.providers.update('backup', { enabled: true });
      }
    });
  });

  describe('usage is recorded without the text of the conversation', () => {
    it('counts requests and tokens per key and model, and keeps no prompt', async () => {
      const k = h.hub.keys.create({ name: 'counted' });
      const secretPrompt = 'my very private question about taxes';
      const r = await chat('cloud/fake-model', { messages: [{ role: 'user', content: secretPrompt }] }, {}, k.key);
      assert.equal(r.status, 200);
      const u = await h.api('GET', '/v1/usage', undefined, {}, k.key);
      assert.equal(u.json.requests.today, 1);
      assert.equal(u.json.tokens.today.total, 15);
      assert.deepEqual(u.json.by_model, [{ model: 'cloud/fake-model', requests: 1, errors: 0, input_tokens: 10, output_tokens: 5 }]);

      const dump = JSON.stringify(h.hub.db.prepare('SELECT * FROM request_log').all()) + JSON.stringify(h.hub.db.prepare('SELECT * FROM usage_daily').all());
      assert.ok(!dump.includes('taxes'), 'the prompt must not be stored');
      assert.ok(!dump.includes('echo:'), 'the answer must not be stored');
      const row = h.hub.db.prepare('SELECT * FROM request_log WHERE key_id = ?').get(k.record.id) as Json;
      assert.equal(row.status, 200);
      assert.equal(row.model_id, 'cloud/fake-model');
      assert.equal(row.requested_model, 'cloud/fake-model');
      assert.equal(row.input_tokens, 10);
    });

    it('failed requests are counted as errors, and the single attempt is in the log', async () => {
      const k = h.hub.keys.create({ name: 'errcount' });
      mode.cloud = 'boom';
      await chat('cloud/fake-model', {}, {}, k.key);
      const u = await h.api('GET', '/v1/usage', undefined, {}, k.key);
      assert.equal(u.json.requests.today, 1);
      const row = h.hub.db.prepare('SELECT attempts FROM request_log WHERE key_id = ?').get(k.record.id) as Json;
      assert.deepEqual(JSON.parse(row.attempts), [{ model: 'cloud/fake-model', outcome: 'upstream_error' }]);
    });
  });
});

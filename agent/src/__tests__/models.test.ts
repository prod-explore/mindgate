import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startAgent, until, type Json, type TestAgent } from './harness.js';

describe('downloading models', () => {
  let t: TestAgent;
  before(async () => {
    t = await startAgent({ models: [] });
  });
  after(() => t.close());

  const job = async (id: string): Promise<Json> => (await t.api('GET', `/node/pulls/${id}`)).json;
  const finished = (id: string) => until(async () => ((await job(id)).finished_at ? await job(id) : null), `download ${id} to finish`);

  it('a download is a job: 202 at once, progress while it runs, "succeeded" at the end, and the model is there', async () => {
    const release = t.ollama.holdPulls();
    const r = await t.api('POST', '/node/pulls', { name: 'qwen3:4b' });
    assert.equal(r.status, 202);
    assert.equal(r.json.name, 'qwen3:4b');
    assert.match(r.json.id, /^[0-9a-f-]{36}$/);

    // half way: layer "aaa" 50/100 and layer "bbb" 0/300 are known
    const mid = await until(async () => {
      const j = await job(r.json.id);
      return j.total === 400 ? j : null;
    }, 'progress');
    assert.equal(mid.status, 'running');
    assert.equal(mid.completed, 50);
    assert.equal(mid.percent, 12);
    assert.match(mid.phase, /pulling/);
    assert.equal((await t.api('GET', '/node/status')).json.downloads, 1);
    assert.equal((await t.api('GET', '/node/status')).json.safe_to_shutdown, false, 'a download is work');

    release();
    const done = await finished(r.json.id);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.percent, 100);
    assert.equal(done.completed, 400);
    assert.equal(done.error, null);
    assert.ok(done.started_at && done.finished_at);

    const models = await t.api('GET', '/node/models');
    assert.ok(models.json.data.some((m: Json) => m.id === 'qwen3:4b'));
    assert.equal((await t.api('GET', '/node/status')).json.downloads, 0);
  });

  it('asking again for a model that is on its way returns the same job', async () => {
    const release = t.ollama.holdPulls();
    const a = await t.api('POST', '/node/pulls', { name: 'dup:1b' });
    try {
      const b = await t.api('POST', '/node/pulls', { name: 'dup:1b' });
      assert.equal(a.json.id, b.json.id);
      await until(() => t.ollama.requests.some(r => r.path === '/api/pull' && r.body?.model === 'dup:1b'), 'the download to start');
      await t.api('POST', '/node/pulls', { name: 'dup:1b' });
      assert.equal(t.ollama.requests.filter(r => r.path === '/api/pull' && r.body?.model === 'dup:1b').length, 1);
    } finally {
      release();
    }
    await finished(a.json.id);
  });

  it('one download at a time: the second waits its turn and can be cancelled while it waits', async () => {
    const release = t.ollama.holdPulls();
    const first = (await t.api('POST', '/node/pulls', { name: 'first:1b' })).json;
    await until(async () => (await job(first.id)).total, 'first download to start');
    const second = (await t.api('POST', '/node/pulls', { name: 'second:1b' })).json;
    const third = (await t.api('POST', '/node/pulls', { name: 'third:1b' })).json;
    assert.equal((await job(second.id)).status, 'queued');
    assert.equal(t.ollama.requests.filter(r => r.path === '/api/pull' && r.body?.model === 'second:1b').length, 0, 'it has not been started');

    const cancelled = await t.api('DELETE', `/node/pulls/${third.id}`);
    assert.equal(cancelled.status, 200);
    assert.equal((await job(third.id)).status, 'cancelled');

    release();
    assert.equal((await finished(first.id)).status, 'succeeded');
    assert.equal((await finished(second.id)).status, 'succeeded');
    assert.equal(t.ollama.requests.filter(r => r.path === '/api/pull' && r.body?.model === 'third:1b').length, 0, 'the cancelled one never started');
    assert.ok(!t.ollama.models.has('third:1b'));
  });

  it('cancelling a running download stops it at the runtime', async () => {
    const release = t.ollama.holdPulls();
    const j = (await t.api('POST', '/node/pulls', { name: 'cancelme:7b' })).json;
    await until(async () => (await job(j.id)).total, 'download to start');
    const before = t.ollama.aborted.length;
    await t.api('DELETE', `/node/pulls/${j.id}`);
    const done = await finished(j.id);
    assert.equal(done.status, 'cancelled');
    assert.equal(done.error, null);
    await until(() => t.ollama.aborted.length > before, 'the runtime to notice');
    assert.ok(!t.ollama.models.has('cancelme:7b'));
    release();
    // and the agent is not stuck: the next download goes through
    const next = (await t.api('POST', '/node/pulls', { name: 'after:1b' })).json;
    assert.equal((await finished(next.id)).status, 'succeeded');
  });

  it('a failed download says why', async () => {
    const j = (await t.api('POST', '/node/pulls', { name: 'fail/nothing:1b' })).json;
    const done = await finished(j.id);
    assert.equal(done.status, 'failed');
    assert.match(done.error, /file does not exist/);
    assert.equal((await t.api('GET', '/node/status')).json.downloads, 0, 'a failure does not leave the node "busy"');
  });

  it('a runtime that is down fails the download instead of hanging', async () => {
    const down = await startAgent({ env: { OLLAMA_URL: 'http://127.0.0.1:1' } });
    try {
      const j = (await down.api('POST', '/node/pulls', { name: 'x:1b' })).json;
      const done = await until(async () => {
        const r = (await down.api('GET', `/node/pulls/${j.id}`)).json;
        return r.finished_at ? r : null;
      }, 'failure');
      assert.equal(done.status, 'failed');
      assert.match(done.error, /Ollama/);
    } finally {
      await down.close();
    }
  });

  it('accepts Hugging Face GGUF names (this is how uncensored models are pulled)', async () => {
    const name = 'hf.co/mlabonne/gemma-3-4b-it-abliterated-GGUF:Q4_K_M';
    const j = (await t.api('POST', '/node/pulls', { name })).json;
    assert.equal((await finished(j.id)).status, 'succeeded');
    const listed = await t.api('GET', '/v1/models');
    const m = listed.json.data.find((x: Json) => x.id === name);
    assert.deepEqual(m.tags, ['uncensored']);
  });

  it('refuses names that are not model names', async () => {
    for (const name of ['', ' ', 'a b', '../etc/passwd/..', '-flag', 'x;rm -rf', 'a'.repeat(201)]) {
      const r = await t.api('POST', '/node/pulls', { name });
      assert.equal(r.status, 400, JSON.stringify(name));
      assert.equal(r.json.error.code, 'invalid_model_name');
    }
    assert.equal((await t.api('POST', '/node/pulls', {})).status, 400);
    assert.equal((await t.api('POST', '/node/pulls', { name: 42 })).status, 400);
  });

  it('lists downloads newest first and knows an unknown id', async () => {
    const list = await t.api('GET', '/node/pulls');
    assert.equal(list.status, 200);
    assert.ok(list.json.data.length >= 5);
    const times = list.json.data.map((j: Json) => j.created_at);
    assert.deepEqual([...times].sort().reverse(), times);
    assert.equal((await t.api('GET', '/node/pulls/does-not-exist')).status, 404);
    assert.equal((await t.api('DELETE', '/node/pulls/does-not-exist')).status, 404);
  });

  it('a finished download can be dismissed from the list', async () => {
    const j = (await t.api('POST', '/node/pulls', { name: 'dismiss:1b' })).json;
    await finished(j.id);
    assert.equal((await t.api('DELETE', `/node/pulls/${j.id}`)).status, 200);
    assert.equal((await t.api('GET', `/node/pulls/${j.id}`)).status, 404);
  });
});

describe('looking after models', () => {
  let t: TestAgent;
  before(async () => {
    t = await startAgent({
      models: [
        { name: 'chat:4b', capabilities: ['completion'] },
        { name: 'hf.co/user/repo-GGUF:Q4_K_M', capabilities: ['completion'] },
        { name: 'embed:latest', capabilities: ['embedding'] },
      ],
    });
  });
  after(() => t.close());

  it('deletes a model, including names with slashes and colons', async () => {
    const r = await t.api('DELETE', '/node/models/hf.co/user/repo-GGUF:Q4_K_M');
    assert.equal(r.status, 200);
    assert.equal(r.json.name, 'hf.co/user/repo-GGUF:Q4_K_M');
    assert.ok(!t.ollama.models.has('hf.co/user/repo-GGUF:Q4_K_M'));
    assert.ok(!(await t.api('GET', '/v1/models')).json.data.some((m: Json) => m.id.startsWith('hf.co')), 'and the list no longer has it');
  });

  it('deleting something that is not there is a 404 with a code the hub can act on', async () => {
    const r = await t.api('DELETE', '/node/models/ghost:1b');
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, 'model_not_found');
  });

  it('loads a model into memory and unloads it again', async () => {
    const r = await t.api('POST', '/node/models/load', { name: 'chat:4b', keep_alive: '10m' });
    assert.equal(r.status, 200);
    assert.deepEqual(t.ollama.requests.filter(q => q.path === '/api/generate').at(-1)?.body, { model: 'chat:4b', keep_alive: '10m' });
    assert.deepEqual((await t.api('GET', '/node/status')).json.loaded.map((m: Json) => m.id), ['chat:4b']);
    assert.equal((await t.api('POST', '/node/models/unload', { name: 'chat:4b' })).status, 200);
    assert.deepEqual((await t.api('GET', '/node/status')).json.loaded, []);
  });

  it('"keep forever" is passed as the number Ollama wants', async () => {
    await t.api('POST', '/node/models/load', { name: 'chat:4b', keep_alive: -1 });
    assert.strictEqual(t.ollama.requests.filter(q => q.path === '/api/generate').at(-1)?.body.keep_alive, -1);
    await t.api('POST', '/node/models/unload', { name: 'chat:4b' });
  });

  it('embedding models are loaded through the embedding endpoint', async () => {
    assert.equal((await t.api('POST', '/node/models/load', { name: 'embed:latest' })).status, 200);
    assert.ok(t.ollama.loaded.has('embed:latest'));
    assert.equal((await t.api('POST', '/node/models/unload', { name: 'embed:latest' })).status, 200);
    assert.ok(!t.ollama.loaded.has('embed:latest'));
  });

  it('loading a model that does not exist is a 404; nonsense is a 400', async () => {
    assert.equal((await t.api('POST', '/node/models/load', { name: 'ghost:1b' })).status, 404);
    assert.equal((await t.api('POST', '/node/models/load', {})).status, 400);
    assert.equal((await t.api('POST', '/node/models/load', { name: 'chat:4b', keep_alive: { a: 1 } })).status, 400);
    assert.equal((await t.api('POST', '/node/models/unload', { name: 'a b' })).status, 400);
  });
});

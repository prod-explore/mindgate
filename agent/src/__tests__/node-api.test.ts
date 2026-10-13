import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { SECRET, startAgent, type TestAgent } from './harness.js';

describe('who may talk to the agent', () => {
  let t: TestAgent;
  before(async () => {
    t = await startAgent();
  });
  after(() => t.close());

  const paths: Array<[string, string]> = [
    ['GET', '/health'],
    ['GET', '/node/status'],
    ['GET', '/node/models'],
    ['POST', '/node/pulls'],
    ['POST', '/node/power/shutdown'],
    ['GET', '/v1/models'],
    ['POST', '/v1/chat/completions'],
    ['GET', '/anything/else'],
  ];

  it('every endpoint needs the secret', async () => {
    for (const [method, path] of paths) {
      const r = await t.api(method, path, method === 'POST' ? {} : undefined, { auth: null });
      assert.equal(r.status, 401, `${method} ${path}`);
      assert.equal(r.json.error.code, 'invalid_node_secret');
    }
    assert.equal(t.ollama.requests.length, 0, 'a refused request never reaches the model runtime');
  });

  it('a wrong secret is refused, the right one is let in (Bearer or the old header)', async () => {
    assert.equal((await t.api('GET', '/health', undefined, { auth: SECRET + 'x' })).status, 401);
    assert.equal((await t.api('GET', '/health', undefined, { auth: SECRET.slice(0, -1) })).status, 401);
    assert.equal((await t.api('GET', '/health')).status, 200);
    const legacy = await fetch(`${t.base}/health`, { headers: { 'X-MindGate-Secret': SECRET } });
    assert.equal(legacy.status, 200);
    const wrongLegacy = await fetch(`${t.base}/health`, { headers: { 'X-MindGate-Secret': 'nope' } });
    assert.equal(wrongLegacy.status, 401);
  });

  it('unknown endpoints answer 404 in the usual error shape (once authenticated)', async () => {
    const r = await t.api('GET', '/node/nothing');
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, 'unknown_endpoint');
  });

  it('malformed JSON is a 400, not a crash', async () => {
    const res = await fetch(`${t.base}/node/pulls`, { method: 'POST', headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }, body: '{nope' });
    assert.equal(res.status, 400);
  });
});

describe('health and status', () => {
  let t: TestAgent;
  before(async () => {
    t = await startAgent({ models: [{ name: 'tiny:1b' }] });
  });
  after(() => t.close());

  it('/health tells the tray what it needs', async () => {
    t.ollama.loaded.set('tiny:1b', { expiresAt: '2026-10-13T12:00:00Z' });
    const r = await t.api('GET', '/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'ok');
    assert.equal(r.json.node_id, 'test-node');
    assert.equal(r.json.runtime, 'ok');
    assert.equal(r.json.in_flight, 0);
    assert.deepEqual(r.json.models_loaded, ['tiny:1b']);
    t.ollama.loaded.clear();
  });

  it('/node/status describes the machine and the runtime', async () => {
    const r = await t.api('GET', '/node/status');
    assert.equal(r.status, 200);
    assert.equal(r.json.node_id, 'test-node');
    assert.equal(r.json.runtime.name, 'ollama');
    assert.equal(r.json.runtime.ok, true);
    assert.equal(r.json.runtime.version, '0.0.0-fake');
    assert.equal(r.json.runtime.managed, false);
    assert.equal(r.json.in_flight, 0);
    assert.equal(r.json.safe_to_shutdown, true);
    assert.equal(r.json.tray_configured, false);
    assert.ok(r.json.system.memory.total_bytes > 0);
    assert.ok(Array.isArray(r.json.system.gpus));
    assert.ok(r.json.system.disk === null || r.json.system.disk.free_bytes >= 0);
  });

  it('a runtime that is down shows up as degraded, never as an error page', async () => {
    const down = await startAgent({ env: { OLLAMA_URL: 'http://127.0.0.1:1' } });
    try {
      const h = await down.api('GET', '/health');
      assert.equal(h.status, 200);
      assert.equal(h.json.status, 'degraded');
      assert.equal(h.json.runtime, 'unreachable');
      const s = await down.api('GET', '/node/status');
      assert.equal(s.status, 200);
      assert.equal(s.json.runtime.ok, false);
      assert.ok(s.json.runtime.error);
      assert.deepEqual(s.json.loaded, []);
    } finally {
      await down.close();
    }
  });

  it('the tray reports whether someone is at the PC, and the status shows it', async () => {
    assert.equal((await t.api('POST', '/node/user-active', { active: true, last_input_seconds_ago: 12 })).status, 200);
    let s = await t.api('GET', '/node/status');
    assert.equal(s.json.user_active, true);
    assert.equal(s.json.last_input_seconds_ago, 12);
    assert.equal(s.json.safe_to_shutdown, false);
    assert.ok(s.json.user_active_updated_at);
    assert.equal((await t.api('POST', '/node/user-active', { active: 'yes' })).status, 400);
    await t.api('POST', '/node/user-active', { active: false, last_input_seconds_ago: 900 });
    s = await t.api('GET', '/node/status');
    assert.equal(s.json.safe_to_shutdown, true);
  });

  it('/node/exit answers first and then asks the process to leave', async () => {
    let exited = 0;
    const e = await startAgent({ deps: { onExit: () => void exited++ } });
    try {
      assert.equal((await e.api('POST', '/node/exit', {})).status, 200);
      assert.equal(exited, 0, 'the answer goes out before the process stops');
      await new Promise(r => setTimeout(r, 700));
      assert.equal(exited, 1);
    } finally {
      await e.close();
    }
  });
});

describe('the model list the hub reads', () => {
  let t: TestAgent;
  before(async () => {
    t = await startAgent({
      models: [
        { name: 'qwen3:4b', family: 'qwen3', parameterSize: '4B', contextLength: 40960, capabilities: ['completion', 'tools', 'thinking'] },
        { name: 'gemma3:4b', family: 'gemma3', contextLength: 131072, capabilities: ['completion', 'vision'] },
        { name: 'nomic-embed-text:latest', family: 'nomic-bert', contextLength: 2048, capabilities: ['embedding'] },
        { name: 'hf.co/mlabonne/gemma-3-4b-it-abliterated-GGUF:Q4_K_M', family: 'gemma3', contextLength: 8192, capabilities: ['completion'] },
        { name: 'old:latest', capabilities: null },
        { name: 'oldvision:latest', capabilities: null, families: ['llama', 'clip'] },
      ],
    });
  });
  after(() => t.close());

  const entries = async () => {
    const r = await t.api('GET', '/v1/models');
    assert.equal(r.status, 200);
    assert.equal(r.json.object, 'list');
    return new Map<string, any>(r.json.data.map((m: any) => [m.id, m]));
  };

  it('says what each model can do, in the fields the hub already understands', async () => {
    const m = await entries();
    assert.equal(m.size, 6);
    const q = m.get('qwen3:4b');
    assert.equal(q.object, 'model');
    assert.equal(q.kind, 'chat');
    assert.equal(q.locality, 'local');
    assert.equal(q.context_length, 40960);
    assert.deepEqual(q.supported_parameters, ['tools', 'reasoning']);
    assert.deepEqual(q.architecture.input_modalities, ['text']);

    const g = m.get('gemma3:4b');
    assert.deepEqual(g.supported_parameters, []);
    assert.deepEqual(g.architecture.input_modalities, ['text', 'image']);
    assert.equal(g.context_length, 131072);
  });

  it('knows an embedding model from a chat model', async () => {
    const e = (await entries()).get('nomic-embed-text:latest');
    assert.equal(e.kind, 'embedding');
    assert.deepEqual(e.architecture.output_modalities, ['embeddings']);
  });

  it('tags abliterated and uncensored models, so they can be told apart (and kept local)', async () => {
    const m = await entries();
    assert.deepEqual(m.get('hf.co/mlabonne/gemma-3-4b-it-abliterated-GGUF:Q4_K_M').tags, ['uncensored']);
    assert.deepEqual(m.get('qwen3:4b').tags, []);
  });

  it('what an old Ollama does not say stays unknown instead of becoming "cannot"', async () => {
    const m = await entries();
    assert.equal(m.get('old:latest').supported_parameters, undefined);
    assert.equal(m.get('old:latest').architecture, undefined);
    assert.deepEqual(m.get('oldvision:latest').architecture.input_modalities, ['text', 'image']);
  });

  it('asks Ollama about a model once, not at every listing', async () => {
    await entries();
    const before = t.ollama.requests.filter(r => r.path === '/api/show').length;
    await entries();
    await entries();
    assert.equal(t.ollama.requests.filter(r => r.path === '/api/show').length, before);
  });

  it('a new model is picked up on the next listing', async () => {
    t.ollama.addModel({ name: 'added:1b', capabilities: ['completion'] });
    assert.ok((await entries()).has('added:1b'));
    t.ollama.models.delete('added:1b');
    assert.ok(!(await entries()).has('added:1b'), 'and a deleted one disappears');
  });

  it('reports the context Ollama really uses when it was configured lower than the model allows', async () => {
    const c = await startAgent({ models: [{ name: 'big:1b', contextLength: 131072, capabilities: ['completion'] }], env: { OLLAMA_CONTEXT_LENGTH: '8192' } });
    try {
      const r = await c.api('GET', '/v1/models');
      assert.equal(r.json.data[0].context_length, 8192);
    } finally {
      await c.close();
    }
  });

  it('/node/models is the richer view for the panel, with what is in memory', async () => {
    t.ollama.loaded.set('qwen3:4b', { expiresAt: '2026-10-13T12:00:00Z' });
    const r = await t.api('GET', '/node/models');
    assert.equal(r.status, 200);
    const q = r.json.data.find((m: any) => m.id === 'qwen3:4b');
    assert.equal(q.parameter_size, '4B');
    assert.equal(q.quantization, 'Q4_K_M');
    assert.equal(q.context_length, 40960);
    assert.deepEqual(q.capabilities, ['completion', 'tools', 'thinking']);
    assert.deepEqual(q.loaded, { vram_bytes: 2_500_000_000, size_bytes: 3_000_000_000, expires_at: '2026-10-13T12:00:00Z' });
    assert.equal(r.json.data.find((m: any) => m.id === 'gemma3:4b').loaded, null);
    t.ollama.loaded.clear();
  });
});

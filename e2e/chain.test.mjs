// End-to-end: the real hub -> the real agent -> a stand-in for Ollama.
// Everything between the client and the model is the code that ships; only the model runtime is faked.
//
// Run from the repo root after building both packages:  node --test e2e/
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const { loadConfig: loadHubConfig } = await import(new URL('gate/dist/config.js', root));
const { createHub, silentLogger } = await import(new URL('gate/dist/context.js', root));
const { buildServer } = await import(new URL('gate/dist/server.js', root));
const { loadConfig: loadAgentConfig } = await import(new URL('agent/dist/config.js', root));
const { buildAgent } = await import(new URL('agent/dist/server.js', root));
const { startFakeOllama } = await import(new URL('agent/dist/__tests__/fake-ollama.js', root));

const MASTER = 'e2e-master-' + 'aB3dE5gH7jK9mN1pQ3rS5tU7vW9';
const ADMIN = 'e2e-admin-' + 'Zy9Xw7Vu5Ts3Rq1Po9Nm7Lk5Ji3';
const NODE_SECRET = 'e2e-node-' + 'Hg1Fe3Dc5Ba7Zy9Xw7Vu5Ts3Rq';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

describe('hub -> agent -> Ollama', () => {
  let ollama, agent, agentUrl, hub, app, hubUrl, clientKey;
  const shutdownCommands = [];

  const admin = async (method, path, body) => {
    const res = await fetch(`${hubUrl}/admin/api${path}`, { method, headers: { Authorization: `Bearer ${ADMIN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : {} };
  };
  const chat = (model, extra = {}, headers = {}) =>
    fetch(`${hubUrl}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${clientKey}`, ...headers }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }], ...extra }) });

  before(async () => {
    ollama = await startFakeOllama([]);
    agent = await buildAgent(
      loadAgentConfig({ MINDGATE_NODE_SECRET: NODE_SECRET, OLLAMA_URL: ollama.url, MINDGATE_MANAGE_OLLAMA: 'false', MINDGATE_TRAY_URL: '', MINDGATE_NODE_ID: 'e2e-pc' }, () => undefined),
      { exec: async (command, args) => void shutdownCommands.push([command, ...args]) },
    );
    await agent.app.listen({ host: '127.0.0.1', port: 0 });
    agentUrl = `http://127.0.0.1:${agent.app.server.address().port}`;

    hub = createHub(loadHubConfig({ MINDGATE_MASTER_KEY: MASTER, MINDGATE_ADMIN_TOKEN: ADMIN, MINDGATE_DB: ':memory:' }, () => undefined), silentLogger, { nodePullPollMs: 30 });
    clientKey = hub.keys.create({ name: 'e2e' }).key;
    app = await buildServer(hub);
    await app.listen({ host: '127.0.0.1', port: 0 });
    hubUrl = `http://127.0.0.1:${app.server.address().port}`;
  });

  after(async () => {
    hub.nodes.stop();
    hub.nodeClient.stop();
    hub.sync.stop();
    await app.close();
    hub.db.close();
    await agent.close();
    await ollama.close();
  });

  it('adds the machine as a provider: node settings, secret, local', async () => {
    const r = await admin('POST', '/providers', {
      id: 'pc',
      name: 'Test PC',
      type: 'openai',
      base_url: `${agentUrl}/v1`,
      api_key: NODE_SECRET,
      auth_scheme: 'bearer',
      locality: 'local',
      max_concurrency: 1,
      node: { mac: 'AA:BB:CC:DD:EE:07', broadcast: '127.0.0.1', control_url: agentUrl, idle_shutdown_minutes: 15, poll_interval_ms: 100 },
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.kind, 'node');
  });

  it('the hub sees the machine and its agent', async () => {
    const r = await admin('GET', '/providers/pc/node');
    assert.equal(r.status, 200);
    assert.equal(r.json.agent.node_id, 'e2e-pc');
    assert.equal(r.json.agent.runtime.ok, true);
    assert.equal(r.json.agent_error, null);
    const sync = await admin('POST', '/providers/pc/sync');
    assert.equal(sync.status, 200);
    assert.equal(sync.json.added, 0, 'nothing is installed yet');
  });

  it('a wrong secret is noticed, not guessed around', async () => {
    const before = ollama.requests.length;
    const res = await fetch(`${agentUrl}/v1/models`, { headers: { Authorization: 'Bearer wrong' } });
    assert.equal(res.status, 401);
    assert.equal(ollama.requests.length, before, 'a refused request never reaches the model runtime');
  });

  it('downloads a model through the hub; it appears in the catalog by itself, with what the machine knows about it', async () => {
    const r = await admin('POST', '/providers/pc/node/pulls', { name: 'qwen3:4b' });
    assert.equal(r.status, 202, JSON.stringify(r.json));
    const rec = await until(() => hub.models.getRecord('pc/qwen3:4b'), 'the model to reach the catalog');
    assert.equal(rec.present, true);

    const m = hub.models.get('pc/qwen3:4b');
    assert.equal(m.kind, 'chat');
    assert.equal(m.locality, 'local');
    assert.equal(m.enabled, true);
    assert.equal(m.contextLength, 32768, "the machine's own report reached the catalog");
    assert.ok(m.supports.includes('tools'));

    const job = await admin('GET', `/providers/pc/node/pulls/${r.json.id}`);
    assert.equal(job.json.status, 'succeeded');
  });

  it('is served to clients like any other model, whole and streamed', async () => {
    const models = await (await fetch(`${hubUrl}/v1/models`, { headers: { Authorization: `Bearer ${clientKey}` } })).json();
    assert.ok(models.data.some(m => m.id === 'pc/qwen3:4b'));

    const whole = await chat('pc/qwen3:4b');
    assert.equal(whole.status, 200);
    assert.equal((await whole.json()).choices[0].message.content, 'echo:hello');

    const streamed = await chat('pc/qwen3:4b', { stream: true });
    const text = await streamed.text();
    assert.match(text, /one /);
    assert.match(text, /two:hello/);
    assert.match(text, /\[DONE\]/);

    const seen = ollama.requests.filter(r => r.path === '/v1/chat/completions').at(-1);
    assert.equal(seen.headers.authorization, undefined, 'the node secret stays between the hub and the agent');
  });

  it('an uncensored model pulled from Hugging Face is tagged, local, and usable', async () => {
    const name = 'hf.co/mlabonne/gemma-3-4b-it-abliterated-GGUF:Q4_K_M';
    const r = await admin('POST', '/providers/pc/node/pulls', { name });
    assert.equal(r.status, 202);
    const rec = await until(() => hub.models.getRecord(`pc/${name}`), 'the model to reach the catalog');
    assert.ok(rec);
    const m = hub.models.get(`pc/${name}`);
    assert.deepEqual(m.tags, ['uncensored']);
    assert.equal(m.locality, 'local');
    const res = await chat(`pc/${name}`);
    assert.equal(res.status, 200);
  });

  it('the node view joins what is on the machine with the hub\'s records', async () => {
    const r = await admin('GET', '/providers/pc/node/models');
    assert.equal(r.status, 200);
    const q = r.json.data.find(m => m.id === 'qwen3:4b');
    assert.equal(q.hub.id, 'pc/qwen3:4b');
    assert.equal(q.loaded, null);
    await admin('POST', '/providers/pc/node/models/load', { name: 'qwen3:4b', keep_alive: '10m' });
    const after = await admin('GET', '/providers/pc/node');
    assert.deepEqual(after.json.agent.loaded.map(m => m.id), ['qwen3:4b']);
    await admin('POST', '/providers/pc/node/models/unload', { name: 'qwen3:4b' });
    assert.deepEqual((await admin('GET', '/providers/pc/node')).json.agent.loaded, []);
  });

  it('an idle machine is shut down when the hub asks, but not while it is answering someone', async () => {
    const provider = hub.providers.require('pc');
    const release = ollama.holdChat();
    const streaming = await chat('pc/qwen3:4b', { stream: true });
    const reader = streaming.body.getReader();
    await reader.read();
    try {
      assert.equal(await hub.nodes.requestShutdown(provider, 20), false, 'the agent says no while a request is running');
      assert.equal(shutdownCommands.length, 0);
    } finally {
      release();
      await reader.cancel().catch(() => {});
    }
    await until(() => agent.activity.inFlight === 0, 'the request to end');

    assert.equal(await hub.nodes.requestShutdown(provider, 20), true);
    assert.equal(shutdownCommands.length, 1);
    assert.equal(hub.nodes.status(provider), 'unknown', 'the hub no longer assumes it is up');
  });

  it('removes a model from the disk and the catalog; asking for it afterwards fails cleanly', async () => {
    const name = 'hf.co/mlabonne/gemma-3-4b-it-abliterated-GGUF:Q4_K_M';
    const r = await admin('DELETE', `/providers/pc/node/models/${name}`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(!ollama.models.has(name));
    assert.equal(hub.models.getRecord(`pc/${name}`), undefined);
    const gone = await chat(`pc/${name}`);
    assert.ok(gone.status >= 400, 'the model has nothing to answer with any more');
  });

  it('the tray and the agent agree on the addresses and the verbs', () => {
    // The tray is plain JavaScript for Windows that cannot be started here, so check the contract from its source.
    const dir = fileURLToPath(new URL('tray/src/', root));
    const wanted = [];
    for (const f of readdirSync(dir).filter(f => f.endsWith('.js'))) {
      const src = readFileSync(dir + f, 'utf8');
      for (const m of src.matchAll(/\$\{config\.agent\.url\}(\/[\w/-]+)/g)) wanted.push({ file: f, path: m[1] });
    }
    assert.ok(wanted.length >= 3, 'the tray calls /health, /node/user-active and /node/exit');
    for (const { file, path } of wanted) {
      const ok = ['GET', 'POST'].some(method => agent.app.hasRoute({ method, url: path }));
      assert.ok(ok, `${file} calls ${path}, which the agent does not have`);
    }
    // and the other way round: the agent asks the tray at /shutdown-check, which the tray serves
    assert.match(readFileSync(dir + 'ipc.js', 'utf8'), /app\.post\('\/shutdown-check'/);
    assert.match(readFileSync(fileURLToPath(new URL('agent/src/power.ts', root)), 'utf8'), /\/shutdown-check/);
  });
});

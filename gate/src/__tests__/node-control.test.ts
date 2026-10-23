import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { addProvider, sleep, startFakeAgent, startHub, type FakeAgent, type Json, type TestHub } from './helpers.js';

const SECRET = 'node-secret-for-tests-0123456789';
const MAC = 'AA:BB:CC:DD:EE:02';

const until = async <T>(fn: () => T | Promise<T>, what: string, ms = 4000): Promise<NonNullable<T>> => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
};

describe('managing the models on a node from the hub', () => {
  let agent: FakeAgent;
  let h: TestHub;
  let clock = Date.now();

  before(async () => {
    agent = await startFakeAgent();
    h = await startHub({
      hub: { nodePullPollMs: 20, node: { now: () => clock, sendMagic: async () => assert.fail('managing a node must never wake it') } },
      setup: hub =>
        addProvider(hub, 'pc', agent, {
          locality: 'local',
          apiKey: SECRET,
          maxConcurrency: 1,
          node: { mac: MAC, broadcast: '192.168.1.255', controlUrl: `${agent.url}/`, bootTimeoutMs: 1500, pollIntervalMs: 100, idleShutdownMinutes: 10 },
        }),
    });
  });

  after(async () => {
    await h.close();
    await agent.close();
  });

  beforeEach(() => {
    agent.state.calls.length = 0;
    agent.state.secret = SECRET;
  });

  describe('where the agent is', () => {
    it('one address (control_url) is enough: health and shutdown are derived from it', async () => {
      const p = h.hub.providers.require('pc');
      assert.equal(p.node?.controlUrl, agent.url, 'trailing slash removed');
      assert.equal(p.node?.healthUrl, undefined);
      assert.equal(p.node?.shutdownUrl, undefined);
      await h.hub.nodes.probe(p);
      assert.equal(agent.state.calls.at(-1)?.path, '/health', 'the node is probed at the agent, not at /v1/models');
      assert.equal(agent.state.calls.at(-1)?.auth, `Bearer ${SECRET}`);
    });

    it('the provider view shows control_url, and it can be changed through the API', async () => {
      const r = await h.admin('GET', '/providers/pc');
      assert.equal(r.json.node.control_url, agent.url);
      const patched = await h.admin('PATCH', '/providers/pc', { node: { mac: MAC, broadcast: '192.168.1.255', control_url: `${agent.url}/`, idle_shutdown_minutes: 10 } });
      assert.equal(patched.status, 200);
      assert.equal(patched.json.node.control_url, agent.url);
    });

    it('rejects a control_url that is not a URL, and idle shutdown with nowhere to send the request', async () => {
      const bad = await h.admin('PATCH', '/providers/pc', { node: { mac: MAC, broadcast: '192.168.1.255', control_url: 'not a url' } });
      assert.equal(bad.status, 400);
      assert.equal(bad.json.error.code, 'invalid_url');
      const none = await h.admin('PATCH', '/providers/pc', { node: { mac: MAC, broadcast: '192.168.1.255', idle_shutdown_minutes: 10 } });
      assert.equal(none.status, 400);
      assert.match(none.json.error.message, /shutdownUrl|shutdown_url|controlUrl/);
    });
  });

  describe('the node overview', () => {
    it('shows the hub\'s view and the agent\'s own status', async () => {
      const r = await h.admin('GET', '/providers/pc/node');
      assert.equal(r.status, 200);
      assert.equal(r.json.provider, 'pc');
      assert.equal(r.json.agent_configured, true);
      assert.equal(r.json.agent.node_id, 'fake-pc');
      assert.equal(r.json.agent_error, null);
      assert.equal(r.json.node.control_url, agent.url);
    });

    it('a wrong node secret is reported as such (not as a client error)', async () => {
      agent.state.secret = 'a-different-secret-entirely-0000';
      const overview = await h.admin('GET', '/providers/pc/node');
      assert.equal(overview.status, 200);
      assert.equal(overview.json.agent, null);
      assert.equal(overview.json.agent_error.code, 'node_auth_failed');
      const direct = await h.admin('GET', '/providers/pc/node/models');
      assert.equal(direct.status, 502);
      assert.equal(direct.json.error.code, 'node_auth_failed');
      assert.doesNotMatch(JSON.stringify(direct.json), new RegExp(SECRET), 'the secret is never echoed');
    });

    it('a machine that does not answer shows as unreachable, and nothing wakes it', async () => {
      const dead = await startFakeAgent();
      const url = dead.url;
      await dead.close();
      h.hub.providers.create({ id: 'gone', name: 'gone', type: 'openai', baseUrl: `${url}/v1`, apiKey: SECRET, node: { mac: MAC, broadcast: '192.168.1.255', controlUrl: url } } as never);
      const overview = await h.admin('GET', '/providers/gone/node');
      assert.equal(overview.status, 200);
      assert.equal(overview.json.agent_error.code, 'upstream_unreachable');
      assert.equal((await h.admin('GET', '/providers/gone/node/models')).status, 502);
      h.hub.providers.delete('gone');
    });

    it('something that is not a MindGate agent is called out', async () => {
      const impostor = await startFakeAgent(null);
      impostor.state.status = {};
      try {
        h.hub.providers.create({ id: 'plain', name: 'plain', type: 'openai', baseUrl: `${impostor.url}/v1`, node: { mac: MAC, broadcast: '192.168.1.255', controlUrl: `${impostor.url}/wrong-prefix` } } as never);
        const r = await h.admin('GET', '/providers/plain/node/models');
        assert.equal(r.status, 502);
        assert.equal(r.json.error.code, 'agent_missing');
      } finally {
        h.hub.providers.delete('plain');
        await impostor.close();
      }
    });

    it('providers without an agent, or without node settings, get a clear refusal', async () => {
      h.hub.providers.create({ id: 'noagent', name: 'noagent', type: 'openai', baseUrl: `${agent.url}/v1`, node: { mac: MAC, broadcast: '192.168.1.255' } } as never);
      const a = await h.admin('GET', '/providers/noagent/node/models');
      assert.equal(a.status, 400);
      assert.equal(a.json.error.code, 'no_agent');
      assert.match(a.json.error.message, /control_url/);
      const b = await h.admin('GET', '/providers/noagent/node');
      assert.equal(b.json.agent_configured, false);
      h.hub.providers.create({ id: 'cloud', name: 'cloud', type: 'openai', baseUrl: `${agent.url}/v1` } as never);
      assert.equal((await h.admin('GET', '/providers/cloud/node')).json.error.code, 'not_a_node');
      assert.equal((await h.admin('GET', '/providers/cloud/node/models')).json.error.code, 'no_agent');
      h.hub.providers.delete('noagent');
      h.hub.providers.delete('cloud');
    });

    it('needs the admin token like the rest of the admin API', async () => {
      const r = await h.api('GET', '/admin/api/providers/pc/node', undefined, {}, 'wrong');
      assert.equal(r.status, 401);
    });
  });

  describe('models on the machine', () => {
    it('lists what is on the machine next to the hub\'s record of each model', async () => {
      const r = await h.admin('GET', '/providers/pc/node/models');
      assert.equal(r.status, 200);
      const tiny = r.json.data.find((m: Json) => m.id === 'tiny:1b');
      assert.equal(tiny.hub_id, 'pc/tiny:1b');
      assert.equal(tiny.hub.id, 'pc/tiny:1b');
      assert.equal(tiny.hub.enabled, true);
      assert.equal(tiny.size_bytes, 1000);
    });

    it('a model the hub has not seen yet shows hub: null', async () => {
      agent.state.models.push({ id: 'fresh:1b', object: 'model' });
      const r = await h.admin('GET', '/providers/pc/node/models');
      assert.equal(r.json.data.find((m: Json) => m.id === 'fresh:1b').hub, null);
      agent.state.models.pop();
    });

    it('loads and unloads a model', async () => {
      assert.equal((await h.admin('POST', '/providers/pc/node/models/load', { name: 'tiny:1b', keep_alive: '10m' })).status, 200);
      assert.deepEqual(agent.state.calls.at(-1)?.body, { name: 'tiny:1b', keep_alive: '10m' });
      assert.deepEqual(agent.state.loaded, ['tiny:1b']);
      assert.equal((await h.admin('POST', '/providers/pc/node/models/unload', { name: 'tiny:1b' })).status, 200);
      assert.deepEqual(agent.state.loaded, []);
      assert.equal((await h.admin('POST', '/providers/pc/node/models/load', {})).status, 400);
      assert.equal((await h.admin('POST', '/providers/pc/node/models/load', { name: 'x', keep_alive: [1] })).status, 400);
    });
  });

  describe('downloading models', () => {
    it('starts a download and, when it ends, the model is in the catalog without anyone asking', async () => {
      const r = await h.admin('POST', '/providers/pc/node/pulls', { name: 'qwen3:4b' });
      assert.equal(r.status, 202);
      assert.equal(r.json.name, 'qwen3:4b');
      assert.equal(h.hub.models.getRecord('pc/qwen3:4b'), undefined, 'not there while it downloads');

      const mid = await h.admin('GET', `/providers/pc/node/pulls/${r.json.id}`);
      assert.equal(mid.json.status, 'running');
      assert.equal((await h.admin('GET', '/providers/pc/node/pulls')).json.data[0].id, r.json.id);

      agent.finishPull(r.json.id);
      const rec = await until(() => h.hub.models.getRecord('pc/qwen3:4b'), 'the finished model to reach the catalog');
      assert.equal(rec.present, true);
      const chat = h.hub.models.list('pc').find(m => m.id === 'pc/qwen3:4b');
      assert.equal(chat?.enabled, true);
      assert.equal(chat?.locality, 'local');
    });

    it('also puts it there when somebody is watching the page rather than the hub watching the job', async () => {
      // a download the hub did not start (the agent's own CLI, a previous run of the hub)
      agent.state.pulls.set('external', { id: 'external', name: 'phi:3b', status: 'running', percent: 50, error: null });
      assert.equal((await h.admin('GET', '/providers/pc/node/pulls')).status, 200);
      assert.equal(h.hub.models.getRecord('pc/phi:3b'), undefined);
      agent.finishPull('external');
      const listed = await h.admin('GET', '/providers/pc/node/pulls');
      assert.equal(listed.json.data.find((j: Json) => j.id === 'external').status, 'succeeded');
      await until(() => h.hub.models.getRecord('pc/phi:3b'), 'the model to reach the catalog');
      const syncs = () => agent.state.calls.filter(c => c.path === '/v1/models').length;
      const before = syncs();
      await h.admin('GET', '/providers/pc/node/pulls');
      await h.admin('GET', '/providers/pc/node/pulls/external');
      await sleep(80);
      assert.equal(syncs(), before, 'a finished download is synced once, not at every look');
    });

    it('a download that fails or is cancelled adds nothing', async () => {
      const r = await h.admin('POST', '/providers/pc/node/pulls', { name: 'fail/x:1b' });
      agent.state.pulls.get(r.json.id)!['status'] = 'failed';
      agent.state.pulls.get(r.json.id)!['error'] = 'file does not exist';
      await sleep(100);
      assert.equal(h.hub.models.getRecord('pc/fail/x:1b'), undefined);

      const c = await h.admin('POST', '/providers/pc/node/pulls', { name: 'big:70b' });
      const cancelled = await h.admin('DELETE', `/providers/pc/node/pulls/${c.json.id}`);
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.json.status, 'cancelled');
      await sleep(100);
      assert.equal(h.hub.models.getRecord('pc/big:70b'), undefined);
    });

    it('relays what the agent says about a bad name or an unknown download', async () => {
      assert.equal((await h.admin('POST', '/providers/pc/node/pulls', {})).status, 400);
      assert.equal((await h.admin('GET', '/providers/pc/node/pulls/nope')).status, 404);
      assert.equal((await h.admin('GET', '/providers/pc/node/pulls/nope')).json.error.code, 'pull_not_found');
    });
  });

  describe('removing a model', () => {
    it('deletes it on the machine (names with slashes and colons intact) and forgets it', async () => {
      const name = 'hf.co/mlabonne/gemma-3-4b-it-abliterated-GGUF:Q4_K_M';
      agent.state.models.push({ id: name, object: 'model', kind: 'chat', tags: ['uncensored'], locality: 'local' });
      await h.hub.sync.syncOne('pc');
      assert.deepEqual(h.hub.models.list('pc').find(m => m.upstreamId === name)?.tags, ['uncensored']);

      const r = await h.admin('DELETE', `/providers/pc/node/models/${name}`);
      assert.equal(r.status, 200);
      assert.equal(r.json.id, `pc/${name}`);
      assert.equal(agent.state.calls.find(c => c.method === 'DELETE')?.path, `/node/models/hf.co/mlabonne/gemma-3-4b-it-abliterated-GGUF%3AQ4_K_M`);
      assert.ok(!agent.state.models.some(m => m['id'] === name));
      assert.equal(h.hub.models.getRecord(`pc/${name}`), undefined, 'gone from the catalog too, not left as a ghost');
    });

    it('a model that is not on the machine is a 404 and the catalog is left alone', async () => {
      const r = await h.admin('DELETE', '/providers/pc/node/models/ghost:1b');
      assert.equal(r.status, 404);
      assert.equal(r.json.error.code, 'model_not_found');
      assert.ok(h.hub.models.getRecord('pc/tiny:1b'));
    });
  });

  describe('switching the machine off', () => {
    it('a person can ask for it, with or without force', async () => {
      const soft = await h.admin('POST', '/providers/pc/node/shutdown', {});
      assert.deepEqual(soft.json, { allow: true, reason: 'shutdown_initiated' });
      assert.deepEqual(agent.state.calls.at(-1)?.body, { force: false });
      const forced = await h.admin('POST', '/providers/pc/node/shutdown', { force: true });
      assert.equal(forced.json.reason, 'forced');
      assert.equal(h.hub.nodes.status(h.hub.providers.require('pc')), 'unknown', 'what was known about the machine is dropped');
    });
  });

  describe('idle shutdown', () => {
    const asked = () => agent.state.calls.filter(c => c.path === '/node/power/shutdown-request');

    it('asks the agent after the idle time, with the minutes and the node secret', async () => {
      agent.state.shutdownRequest = { body: { allow: true, reason: 'shutdown_initiated' } };
      h.hub.nodes.begin('pc');
      h.hub.nodes.end('pc'); // activity "now"
      clock += 11 * 60_000;
      await h.hub.nodes.tick();
      assert.equal(asked().length, 1);
      assert.equal(asked()[0]!.auth, `Bearer ${SECRET}`);
      assert.equal((asked()[0]!.body as Json)['idle_minutes'], 11);
      assert.equal(h.hub.nodes.status(h.hub.providers.require('pc')), 'unknown', 'after a yes, the hub no longer thinks the machine is up');
    });

    it('does not ask a machine that has not been idle long enough', async () => {
      h.hub.nodes.begin('pc');
      h.hub.nodes.end('pc');
      clock += 5 * 60_000;
      await h.hub.nodes.tick();
      assert.equal(asked().length, 0);
    });

    it('a "no" from the agent is not a shutdown: the node stays online and the hub waits before asking again', async () => {
      agent.state.shutdownRequest = { body: { allow: false, reason: 'user_recently_active' } };
      h.hub.nodes.begin('pc');
      h.hub.nodes.end('pc');
      clock += 11 * 60_000;
      await h.hub.nodes.tick();
      assert.equal(asked().length, 1);
      assert.equal(h.hub.nodes.status(h.hub.providers.require('pc')), 'online', 'the machine is still there');
      clock += 60_000;
      await h.hub.nodes.tick();
      assert.equal(asked().length, 1, 'not asked again a minute later');
      clock += 6 * 60_000;
      await h.hub.nodes.tick();
      assert.equal(asked().length, 2, 'asked again after the pause');
    });

    it('a plain 200 from a custom shutdown script still counts as a yes (only an explicit allow:false is a no)', async () => {
      agent.state.shutdownRequest = { body: { ok: true } };
      h.hub.nodes.begin('pc');
      h.hub.nodes.end('pc');
      clock += 11 * 60_000;
      assert.equal(await h.hub.nodes.requestShutdown(h.hub.providers.require('pc'), 11), true);
    });

    it('an error from the agent is a no', async () => {
      agent.state.shutdownRequest = { status: 500, body: { error: 'boom' } };
      h.hub.nodes.markUp('pc');
      assert.equal(await h.hub.nodes.requestShutdown(h.hub.providers.require('pc'), 11), false);
      assert.equal(h.hub.nodes.status(h.hub.providers.require('pc')), 'online');
      agent.state.shutdownRequest = { body: { allow: true } };
    });
  });
});

import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { after, before, beforeEach, describe, it } from 'node:test';
import { magicPacket, sendMagicPacket } from '../node.js';
import type { NodeConfig } from '../types.js';
import { addProvider, chunk, completion, openaiUpstream, parseSse, sendJson, sendSse, sleep, startHub, startUpstream, usageChunk, type Json, type TestHub, type Upstream } from './helpers.js';

const MAC = 'AA:BB:CC:DD:EE:01';

describe('Wake-on-LAN packet', () => {
  it('is 6 x 0xFF followed by the MAC address 16 times', () => {
    const p = magicPacket(MAC);
    assert.equal(p.length, 102);
    assert.ok(p.subarray(0, 6).every(b => b === 0xff));
    for (let i = 0; i < 16; i++) assert.equal(p.subarray(6 + i * 6, 12 + i * 6).toString('hex'), 'aabbccddee01');
    assert.equal(magicPacket('aa-bb-cc-dd-ee-01').toString('hex'), p.toString('hex'), 'dashes and lower case are fine');
  });

  it('is really sent over UDP to the configured address and port', async () => {
    const server = dgram.createSocket('udp4');
    const got = new Promise<Buffer>(resolve => server.once('message', m => resolve(m)));
    await new Promise<void>(r => server.bind(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      await sendMagicPacket({ mac: MAC, broadcast: '127.0.0.1', port });
      assert.equal((await got).toString('hex'), magicPacket(MAC).toString('hex'));
    } finally {
      server.close();
    }
  });
});

describe('a machine that sleeps', () => {
  let pc: Upstream;
  let cloud: Upstream;
  let agent: Upstream;
  let h: TestHub;
  let awake = true;
  let wakeAfterMs = 0;
  let neverWakes = false;
  let magicFails = false;
  let chatResets = false;
  let useFakeClock = false;
  let clock = Date.now();
  const magic: NodeConfig[] = [];
  const shutdowns: Json[] = [];

  before(async () => {
    pc = await openaiUpstream({
      models: [{ id: 'llama' }],
      // a switched-off machine does not answer at all: the connection just dies
      intercept: (_req, res) => {
        if (!awake) res.socket?.destroy();
        return !awake;
      },
      chat: async (req, res) => {
        if (chatResets) return void res.socket?.destroy();
        if (req.body?.['stream']) {
          await sleep(30);
          return void (await sendSse(res, [chunk({ role: 'assistant', content: 'wake' }), chunk({ content: 'ful' }), chunk({}, 'stop'), usageChunk(), '[DONE]']));
        }
        sendJson(res, 200, completion('hello from the PC'));
      },
    });
    cloud = await openaiUpstream({ models: [{ id: 'fake-model' }] });
    agent = await startUpstream((req, res) => {
      shutdowns.push({ auth: req.headers['authorization'], body: req.body });
      sendJson(res, 200, { ok: true });
    });
    h = await startHub({
      hub: {
        node: {
          now: () => (useFakeClock ? clock : Date.now()),
          sendMagic: async cfg => {
            magic.push(cfg);
            if (magicFails) throw new Error('network unreachable');
            if (!neverWakes) setTimeout(() => (awake = true), wakeAfterMs);
          },
        },
      },
      setup: async hub => {
        await addProvider(hub, 'pc', pc, {
          locality: 'local',
          node: { mac: MAC, broadcast: '192.168.1.255', bootTimeoutMs: 1500, pollIntervalMs: 100, minWakePriority: 3, idleShutdownMinutes: 10, shutdownUrl: `${agent.url}/shutdown` },
        });
        await addProvider(hub, 'cloud', cloud);
      },
    });
  });

  after(async () => {
    await h.close();
    await Promise.all([pc.close(), cloud.close(), agent.close()]);
  });

  beforeEach(() => {
    awake = true;
    wakeAfterMs = 0;
    neverWakes = false;
    magicFails = false;
    chatResets = false;
    useFakeClock = false;
    magic.length = 0;
    shutdowns.length = 0;
    h.hub.nodes.markDown('pc'); // forget what was known about the machine
  });

  const fallAsleep = () => {
    awake = false;
    h.hub.nodes.markDown('pc');
  };
  const ask = (model: string, headers: Record<string, string> = {}, extra: Json = {}) =>
    h.api('POST', '/v1/chat/completions', { model, messages: [{ role: 'user', content: 'hi' }], ...extra }, headers);
  const pcStatus = () => h.hub.nodes.status(h.hub.providers.require('pc'));

  it('an awake machine is simply used and no packet is sent', async () => {
    const r = await ask('pc/llama');
    assert.equal(r.status, 200);
    assert.equal(r.json.choices[0].message.content, 'hello from the PC');
    assert.equal(magic.length, 0);
    assert.equal(pcStatus(), 'online');
  });

  it('a sleeping machine is woken and the request waits for it', async () => {
    fallAsleep();
    wakeAfterMs = 300;
    const t0 = Date.now();
    const r = await ask('pc/llama');
    assert.equal(r.status, 200);
    assert.ok(Date.now() - t0 >= 250, 'the answer came after the machine woke up');
    assert.equal(magic.length, 1);
    assert.equal(magic[0]!.mac, MAC);
    assert.equal(magic[0]!.broadcast, '192.168.1.255');
    assert.equal(pcStatus(), 'online');
  });

  it('requests that arrive while it boots share one wake-up', async () => {
    fallAsleep();
    wakeAfterMs = 400;
    const rs = await Promise.all([ask('pc/llama'), ask('pc/llama'), ask('pc/llama')]);
    assert.deepEqual(rs.map(r => r.status), [200, 200, 200]);
    assert.equal(magic.length, 1);
  });

  it('a request for another provider never waits for the machine', async () => {
    fallAsleep();
    neverWakes = true;
    const t0 = Date.now();
    const r = await ask('cloud/fake-model');
    assert.equal(r.status, 200);
    assert.ok(Date.now() - t0 < 500);
    assert.equal(magic.length, 0);
  });

  it('a low-priority request does not wake the machine; it fails fast with node_asleep', async () => {
    fallAsleep();
    const r = await ask('pc/llama', { 'X-MindGate-Priority': '2' });
    assert.equal(r.status, 503);
    assert.equal(r.json.error.code, 'node_asleep');
    assert.equal(magic.length, 0);
    assert.equal(pcStatus(), 'asleep');
  });

  it('...and the error says the app may pick another model, which the hub never does for it', async () => {
    fallAsleep();
    const cloudCalls = () => cloud.requests.filter(q => q.path === '/v1/chat/completions').length;
    const before = cloudCalls();
    const r = await ask('pc/llama', { 'X-MindGate-Priority': '1' });
    assert.equal(r.json.error.code, 'node_asleep');
    assert.equal(r.json.error.fallback, true);
    assert.equal(magic.length, 0);
    assert.equal(cloudCalls(), before, 'the hub does not try the cloud on its own');
  });

  it('a machine that does not come up in time gives node_unavailable, marked as a reason to try another model', async () => {
    fallAsleep();
    neverWakes = true;
    const direct = await ask('pc/llama');
    assert.equal(direct.status, 503);
    assert.equal(direct.json.error.code, 'node_unavailable');
    assert.equal(direct.json.error.fallback, true);
    assert.ok(magic.length >= 1);
  });

  it('a Wake-on-LAN packet that cannot be sent is reported as wol_failed', async () => {
    fallAsleep();
    magicFails = true;
    const r = await ask('pc/llama');
    assert.equal(r.status, 503);
    assert.equal(r.json.error.code, 'wol_failed');
    assert.match(r.json.error.message, /network unreachable/);
  });

  it('streaming: the connection is kept alive with comments while the machine boots', async () => {
    fallAsleep();
    wakeAfterMs = 700;
    const r = await h.raw('POST', '/v1/chat/completions', { model: 'pc/llama', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /text\/event-stream/);
    const events = parseSse(await r.text());
    const comments = events.filter((e): e is string => typeof e === 'string' && e.startsWith(':'));
    assert.ok(comments.length >= 1, 'at least one keepalive comment was sent before the first token');
    const text = events.filter((e): e is Json => typeof e === 'object' && !!e.choices?.length).map(e => e.choices[0].delta.content ?? '').join('');
    assert.equal(text, 'wakeful');
    assert.equal(events.at(-1), '[DONE]');
  });

  it('streaming: a machine that never wakes ends the stream with an error event, not a hang', async () => {
    fallAsleep();
    neverWakes = true;
    const r = await h.raw('POST', '/v1/chat/completions', { model: 'pc/llama', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const events = parseSse(await r.text());
    const err = events.find((e): e is Json => typeof e === 'object' && !!e.error);
    assert.ok(err);
    assert.equal(err.error.code, 'node_unavailable');
    assert.equal(events.at(-1), '[DONE]');
  });

  it('a client that leaves while the machine boots stops waiting; the machine still comes up', async () => {
    fallAsleep();
    wakeAfterMs = 600;
    const ac = new AbortController();
    const gone = fetch(`${h.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.key}` },
      body: JSON.stringify({ model: 'pc/llama', messages: [{ role: 'user', content: 'hi' }] }),
      signal: ac.signal,
    }).catch(() => null);
    await sleep(150);
    ac.abort();
    await gone;
    await sleep(1200);
    assert.equal(pcStatus(), 'online');
    assert.equal(magic.length, 1);
  });

  it('a machine that died after being trusted is noticed, woken again and the request is retried once', async () => {
    assert.equal((await ask('pc/llama')).status, 200); // now known to be online
    awake = false; // power cut: nobody told the hub
    wakeAfterMs = 300;
    const r = await ask('pc/llama');
    assert.equal(r.status, 200);
    assert.equal(magic.length, 1);
  });

  it('...but not forever: a machine that is up and still drops the connection gives node_connection_lost', async () => {
    chatResets = true;
    const r = await ask('pc/llama');
    assert.equal(r.status, 502);
    assert.equal(r.json.error.code, 'node_connection_lost');
    assert.equal(r.json.error.fallback, true);
  });

  it('the model list tells whether a machine is asleep', async () => {
    fallAsleep();
    const asleep = ((await h.api('GET', '/v1/models')).json.data as Json[]).find(m => m.id === 'pc/llama')!;
    assert.equal(asleep.status, 'asleep');
    awake = true;
    assert.equal(await h.hub.nodes.probe(h.hub.providers.require('pc')), true);
    const online = ((await h.api('GET', '/v1/models')).json.data as Json[]).find(m => m.id === 'pc/llama')!;
    assert.equal(online.status, 'online');
    const cloudEntry = ((await h.api('GET', '/v1/models')).json.data as Json[]).find(m => m.id === 'cloud/fake-model')!;
    assert.equal(cloudEntry.status, 'online');
  });

  describe('idle shutdown', () => {
    const minutes = (n: number) => n * 60_000;

    it('asks the machine to shut down only after it has been idle long enough', async () => {
      useFakeClock = true;
      clock = Date.now();
      assert.equal((await ask('pc/llama')).status, 200);
      clock += minutes(5);
      await h.hub.nodes.tick();
      assert.equal(shutdowns.length, 0, '5 minutes is not idle enough (the limit is 10)');
      clock += minutes(6);
      await h.hub.nodes.tick();
      assert.equal(shutdowns.length, 1);
      assert.equal(shutdowns[0]!.body.idle_minutes, 11);
      assert.equal(shutdowns[0]!.auth, 'Bearer sk-test-key-1234', 'the agent is called with the provider key');
    });

    it('never while a request is running', async () => {
      useFakeClock = true;
      clock = Date.now();
      h.hub.nodes.begin('pc');
      clock += minutes(30);
      await h.hub.nodes.tick();
      assert.equal(shutdowns.length, 0);
      h.hub.nodes.end('pc');
      await h.hub.nodes.tick();
      assert.equal(shutdowns.length, 0, 'finishing a request restarts the idle clock');
    });

    it('does nothing for a machine that is already off', async () => {
      useFakeClock = true;
      clock = Date.now() + minutes(60);
      fallAsleep();
      await h.hub.nodes.tick();
      assert.equal(shutdowns.length, 0);
      assert.equal(pcStatus(), 'asleep');
    });
  });
});

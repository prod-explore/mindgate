import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { networkInterfaces } from 'node:os';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../config.js';
import { createRelay } from '../wol-relay.js';
import { localBroadcasts, relaySender, type MagicTarget } from '../wol.js';
import { addProvider, openaiUpstream, startHub, type TestHub, type Upstream } from './helpers.js';

const MAC = 'AA:BB:CC:DD:EE:01';
const TOKEN = 'relay-token-0123456789abcdef';

const v4 = (address: string, netmask: string, internal = false) => ({ address, netmask, family: 'IPv4', internal, mac: '00:00:00:00:00:00', cidr: null });

describe('broadcast addresses of this machine', () => {
  it('are derived from each network; loopback and IPv6 are left out', () => {
    const fake = {
      eth0: [v4('10.1.1.43', '255.255.255.0'), { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false, mac: '00:00:00:00:00:00', cidr: null, scopeid: 1 }],
      br0: [v4('172.31.0.1', '255.255.0.0')],
      lo: [v4('127.0.0.1', '255.0.0.0', true)],
    } as unknown as ReturnType<typeof networkInterfaces>;
    assert.deepEqual([...localBroadcasts(fake)].sort(), ['10.1.1.255', '172.31.255.255', '255.255.255.255']);
  });
});

describe('the Wake-on-LAN relay', () => {
  const sent: MagicTarget[] = [];
  let failSend = false;
  let url: string;
  let server: ReturnType<typeof createRelay>;

  before(async () => {
    server = createRelay({
      token: TOKEN,
      broadcasts: () => new Set(['10.1.1.255', '255.255.255.255']),
      send: async t => {
        if (failSend) throw new Error('network is down');
        sent.push(t);
      },
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => void server.close());

  const post = (body: unknown, token: string | null = TOKEN, path = '/wake') =>
    fetch(url + path, {
      method: 'POST',
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const codeOf = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;

  it('sends the packet for a caller with the token, to a broadcast address of this machine', async () => {
    sent.length = 0;
    assert.equal((await post({ mac: MAC, broadcast: '10.1.1.255', port: 9 })).status, 204);
    assert.deepEqual(sent, [{ mac: MAC, broadcast: '10.1.1.255', port: 9 }]);
    assert.equal((await post({ mac: 'aa-bb-cc-dd-ee-01', broadcast: '255.255.255.255' })).status, 204, 'dashes are fine');
    assert.equal(sent.at(-1)!.port, 9, 'the port defaults to 9');
  });

  it('refuses a missing or wrong token without sending anything', async () => {
    sent.length = 0;
    assert.equal((await post({ mac: MAC, broadcast: '10.1.1.255' }, null)).status, 401);
    assert.equal((await post({ mac: MAC, broadcast: '10.1.1.255' }, 'nope')).status, 401);
    assert.equal(sent.length, 0);
  });

  it('is no way to fire UDP at arbitrary hosts: only broadcast addresses of its own networks are allowed', async () => {
    sent.length = 0;
    const r = await post({ mac: MAC, broadcast: '10.1.1.193' });
    assert.equal(r.status, 400);
    const e = await codeOf(r);
    assert.equal(e.code, 'invalid_broadcast');
    assert.match(e.message, /10\.1\.1\.255/);
    assert.equal((await post({ mac: MAC, broadcast: '8.8.8.8' })).status, 400);
    assert.equal(sent.length, 0);
  });

  it('validates the rest of the request', async () => {
    assert.equal((await codeOf(await post({ mac: 'AA:BB', broadcast: '10.1.1.255' }))).code, 'invalid_mac');
    assert.equal((await codeOf(await post({ mac: MAC, broadcast: '10.1.1.255', port: 0 }))).code, 'invalid_port');
    assert.equal((await codeOf(await post({ mac: MAC, broadcast: '10.1.1.255', port: '9' }))).code, 'invalid_port');
    assert.equal((await codeOf(await post('{not json'))).code, 'invalid_json');
    assert.equal((await post({}, TOKEN, '/other')).status, 404);
    assert.equal((await fetch(url + '/wake', { headers: { authorization: `Bearer ${TOKEN}` } })).status, 404, 'GET is not served');
  });

  it('answers 502 with the reason when the packet cannot be sent', async () => {
    failSend = true;
    try {
      const r = await post({ mac: MAC, broadcast: '10.1.1.255' });
      assert.equal(r.status, 502);
      assert.match((await codeOf(r)).message, /network is down/);
    } finally {
      failSend = false;
    }
  });

  it('relaySender talks to it and carries its refusals back as errors', async () => {
    sent.length = 0;
    await relaySender(url, TOKEN)({ mac: MAC, broadcast: '10.1.1.255', port: 9 });
    assert.equal(sent.length, 1);
    await assert.rejects(() => relaySender(url, 'wrong-token')({ mac: MAC, broadcast: '10.1.1.255', port: 9 }), /relay answered 401/);
    await assert.rejects(() => relaySender(url, TOKEN)({ mac: MAC, broadcast: '10.9.9.9', port: 9 }), /relay answered 400.*invalid_broadcast/);
  });
});

describe('configuration', () => {
  const base = { MINDGATE_MASTER_KEY: 'm'.repeat(8) + 'aB3dE5gH7jK9mN1pQ3rS5tU7vW9xY1zA', MINDGATE_ADMIN_TOKEN: 'adm-Zy9Xw7Vu5Ts3Rq1Po9Nm7Lk5Ji3Hg1Fe', MINDGATE_DB: ':memory:', MINDGATE_PANEL_DIR: '' };

  it('has no relay unless one is configured', () => {
    assert.equal(loadConfig(base, () => undefined).wolRelay, null);
    const cfg = loadConfig({ ...base, MINDGATE_WOL_RELAY_URL: 'http://172.17.0.1:7009', MINDGATE_WOL_RELAY_TOKEN: TOKEN }, () => undefined);
    assert.deepEqual(cfg.wolRelay, { url: 'http://172.17.0.1:7009', token: TOKEN });
  });

  it('refuses a relay URL without a token, or one that is not a URL', () => {
    assert.throws(() => loadConfig({ ...base, MINDGATE_WOL_RELAY_URL: 'http://172.17.0.1:7009' }, () => undefined), /MINDGATE_WOL_RELAY_TOKEN/);
    assert.throws(() => loadConfig({ ...base, MINDGATE_WOL_RELAY_URL: 'not a url', MINDGATE_WOL_RELAY_TOKEN: TOKEN }, () => undefined), /not a URL/);
  });
});

describe('a hub with a relay wakes the machine through it', () => {
  let pc: Upstream;
  let awake = true;
  let relay: ReturnType<typeof createRelay>;
  let h: TestHub;
  const sent: MagicTarget[] = [];
  const warnings: string[] = [];

  before(async () => {
    pc = await openaiUpstream({
      models: [{ id: 'llama' }],
      // a switched-off machine does not answer at all: the connection just dies
      intercept: (_req, res) => {
        if (!awake) res.socket?.destroy();
        return !awake;
      },
    });
    relay = createRelay({
      token: TOKEN,
      broadcasts: () => new Set(['192.168.1.255']),
      send: async t => {
        sent.push(t);
        setTimeout(() => (awake = true), 150);
      },
    });
    await new Promise<void>(r => relay.listen(0, '127.0.0.1', r));
    h = await startHub({
      env: { MINDGATE_WOL_RELAY_URL: `http://127.0.0.1:${(relay.address() as AddressInfo).port}`, MINDGATE_WOL_RELAY_TOKEN: TOKEN },
      hub: { node: { log: { info: () => undefined, warn: (_o, m) => void warnings.push(m ?? '') } } },
      setup: async hub => {
        const node = { mac: MAC, bootTimeoutMs: 2000, pollIntervalMs: 50, minWakePriority: 0 };
        await addProvider(hub, 'pc', pc, { locality: 'local', node: { ...node, broadcast: '192.168.1.255' } });
        // the machine's own address as `broadcast` (127.0.0.1 in this test): the setting that makes a packet get lost in real life
        await addProvider(hub, 'self', pc, { locality: 'local', node: { ...node, broadcast: '127.0.0.1' } });
      },
    });
  });

  after(async () => {
    await h.close();
    relay.close();
    await pc.close();
  });

  const ask = (model: string) => h.api('POST', '/v1/chat/completions', { model, messages: [{ role: 'user', content: 'hi' }] });

  it('the packet goes through the relay, not out of the hub itself', async () => {
    awake = false;
    h.hub.nodes.markDown('pc');
    const r = await ask('pc/llama');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(sent, [{ mac: MAC, broadcast: '192.168.1.255', port: 9 }]);
  });

  it("warns once when `broadcast` is the machine's own address", async () => {
    for (let i = 0; i < 2; i++) {
      awake = false;
      h.hub.nodes.markDown('self');
      await ask('self/llama'); // the relay refuses 127.0.0.1, so this fails; the warning is what is being tested
    }
    assert.equal(warnings.filter(w => /machine's own address/.test(w)).length, 1);
  });
});

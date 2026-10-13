import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { startAgent, startFakeTray, until, type Json, type TestAgent } from './harness.js';

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function withTray(answer: () => { status?: number; body?: unknown }, env: Record<string, string> = {}, extra: { execFails?: boolean } = {}): Promise<{ t: TestAgent; tray: Awaited<ReturnType<typeof startFakeTray>> }> {
  const tray = await startFakeTray(answer);
  const t = await startAgent({ env: { MINDGATE_TRAY_URL: tray.url, ...env }, ...extra });
  open.push(tray, t);
  return { t, tray };
}

describe('shutting the machine down on the hub\'s request', () => {
  it('shuts down when nothing is running and the tray agrees', async () => {
    const { t, tray } = await withTray(() => ({ body: { allow: true, reason: 'all_checks_passed' } }));
    const r = await t.api('POST', '/node/power/shutdown-request', { idle_minutes: 15 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { allow: true, reason: 'shutdown_initiated' });
    assert.deepEqual(tray.calls, [{ idle_minutes: 15 }], 'the tray is told how long the node was idle');
    assert.equal(t.execCalls.length, 1);
    const c = t.execCalls[0]!;
    if (process.platform === 'win32') {
      assert.equal(c.command, 'shutdown');
      assert.deepEqual(c.args.slice(0, 3), ['/s', '/t', '30']);
    } else if (process.getuid?.() === 0) {
      assert.equal(c.command, 'shutdown');
      assert.deepEqual(c.args.slice(0, 2), ['-h', '+1']);
    } else {
      assert.equal(c.command, 'sudo');
      assert.deepEqual(c.args.slice(0, 4), ['-n', 'shutdown', '-h', '+1']);
    }
    assert.equal((await t.api('GET', '/node/status')).json.shutting_down, true);
  });

  it('does not shut down twice for two requests', async () => {
    const { t } = await withTray(() => ({}));
    await t.api('POST', '/node/power/shutdown-request', { idle_minutes: 15 });
    const again = await t.api('POST', '/node/power/shutdown-request', { idle_minutes: 16 });
    assert.deepEqual(again.json, { allow: true, reason: 'shutdown_in_progress' });
    assert.equal(t.execCalls.length, 1);
  });

  it("the tray's \"no\" is final, with its reason", async () => {
    const { t } = await withTray(() => ({ body: { allow: false, reason: 'user_recently_active' } }));
    const r = await t.api('POST', '/node/power/shutdown-request', { idle_minutes: 15 });
    assert.deepEqual(r.json, { allow: false, reason: 'user_recently_active' });
    assert.equal(t.execCalls.length, 0);
    assert.equal((await t.api('GET', '/node/status')).json.shutting_down, false);
  });

  it('a tray that does not answer means "no": a PC someone may be using is not switched off on a guess', async () => {
    const dead = await startAgent({ env: { MINDGATE_TRAY_URL: 'http://127.0.0.1:1' } });
    open.push(dead);
    const r = await dead.api('POST', '/node/power/shutdown-request', { idle_minutes: 15 });
    assert.deepEqual(r.json, { allow: false, reason: 'tray_unreachable' });
    assert.equal(dead.execCalls.length, 0);

    const { t } = await withTray(() => ({ status: 500, body: { error: 'x' } }));
    assert.deepEqual((await t.api('POST', '/node/power/shutdown-request', {})).json, { allow: false, reason: 'tray_unreachable' });
    const { t: t2 } = await withTray(() => ({ body: { allow: 'yes please' } }));
    assert.equal((await t2.api('POST', '/node/power/shutdown-request', {})).json.allow, false, 'only a real true counts');
  });

  it('a request in flight, or a download in progress, means "no" (and the tray is not even asked)', async () => {
    const { t, tray } = await withTray(() => ({}));
    const release = t.ollama.holdChat();
    const res = await t.raw('POST', '/v1/chat/completions', { model: 'tiny:1b', stream: true, messages: [{ role: 'user', content: 'x' }] });
    try {
      await res.body!.getReader().read();
      assert.deepEqual((await t.api('POST', '/node/power/shutdown-request', { idle_minutes: 20 })).json, { allow: false, reason: 'requests_in_flight' });
    } finally {
      release();
      await res.body!.cancel().catch(() => undefined);
    }
    await until(() => t.agent.activity.inFlight === 0, 'the request to end');

    const hold = t.ollama.holdPulls();
    try {
      await t.api('POST', '/node/pulls', { name: 'big:7b' });
      assert.deepEqual((await t.api('POST', '/node/power/shutdown-request', {})).json, { allow: false, reason: 'download_in_progress' });
    } finally {
      hold();
    }
    assert.equal(tray.calls.length, 0);
    assert.equal(t.execCalls.length, 0);
  });

  it('with no tray (a headless server) the agent decides alone', async () => {
    const t = await startAgent({ env: { MINDGATE_TRAY_URL: '' } });
    open.push(t);
    assert.deepEqual((await t.api('POST', '/node/power/shutdown-request', { idle_minutes: 15 })).json, { allow: true, reason: 'shutdown_initiated' });
    assert.equal(t.execCalls.length, 1);

    const busy = await startAgent({ env: { MINDGATE_TRAY_URL: '' } });
    open.push(busy);
    await busy.api('POST', '/node/user-active', { active: true, last_input_seconds_ago: 1 });
    assert.deepEqual((await busy.api('POST', '/node/power/shutdown-request', {})).json, { allow: false, reason: 'user_active' });
  });

  it('a person pressing "shut down" in the panel overrides the guards', async () => {
    const { t, tray } = await withTray(() => ({ body: { allow: false, reason: 'user_recently_active' } }));
    const refused = await t.api('POST', '/node/power/shutdown', {});
    assert.equal(refused.json.allow, false, 'without force it is the same as the hub asking');
    const forced = await t.api('POST', '/node/power/shutdown', { force: true });
    assert.deepEqual(forced.json, { allow: true, reason: 'forced' });
    assert.equal(tray.calls.length, 1, 'the tray was asked once (the refused attempt), not for the forced one');
    assert.equal(t.execCalls.length, 1);
  });

  it('if the system refuses to shut down, the answer is "no" and the node is not marked as shutting down', async () => {
    const { t } = await withTray(() => ({}), {}, { execFails: true });
    const r = await t.api('POST', '/node/power/shutdown-request', {});
    assert.deepEqual(r.json, { allow: false, reason: 'shutdown_failed' });
    assert.equal((await t.api('GET', '/node/status')).json.shutting_down, false);
  });

  it('the delay before the machine goes down is configurable', async () => {
    const { t } = await withTray(() => ({}), { MINDGATE_SHUTDOWN_DELAY_SECONDS: '120' });
    await t.api('POST', '/node/power/shutdown-request', {});
    const args = t.execCalls[0]!.args as string[];
    assert.ok(process.platform === 'win32' ? args.includes('120') : args.includes('+2'), JSON.stringify(args));
  });

  it('idle_minutes is only information for the tray, so nonsense there changes nothing', async () => {
    const { t } = await withTray(() => ({}));
    const r: Json = (await t.api('POST', '/node/power/shutdown-request', { idle_minutes: 'soon' })).json;
    assert.equal(r.allow, true, 'idle_minutes is only information for the tray');
  });
});

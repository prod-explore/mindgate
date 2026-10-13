import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { pruneBackups, runCli } from '../cli.js';
import { createHub, silentLogger } from '../context.js';
import { loadConfig } from '../config.js';
import { ADMIN, MASTER, openaiUpstream, startUpstream, sendJson, type Json, type Upstream } from './helpers.js';

describe('command line', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  const run = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, env, { out: l => out.push(l), err: l => err.push(l) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const open = () => createHub(loadConfig(env, () => undefined), silentLogger);

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'mindgate-cli-'));
    env = { MINDGATE_MASTER_KEY: MASTER, MINDGATE_ADMIN_TOKEN: ADMIN, MINDGATE_DB: join(dir, 'data', 'mindgate.db') };
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  describe('basics', () => {
    it('prints help, and a non-zero code for nothing or nonsense', async () => {
      assert.equal((await run('help')).code, 0);
      assert.match((await run('help')).out, /import-legacy/);
      assert.equal((await run()).code, 2);
      const bad = await run('frobnicate');
      assert.equal(bad.code, 2);
      assert.match(bad.err, /Unknown command/);
    });

    it('explains a missing secret instead of crashing', async () => {
      const out: string[] = [];
      const code = await runCli(['keys', 'list'], { MINDGATE_DB: join(dir, 'x.db') }, { out: l => out.push(l), err: l => out.push(l) });
      assert.equal(code, 1);
      assert.match(out.join('\n'), /MINDGATE_MASTER_KEY is required/);
    });
  });

  describe('keys', () => {
    it('creates a key, shows it once, and the hub accepts it', async () => {
      const r = await run('keys', 'create', 'laptop', '--rpm', '30', '--tokens-day=50000', '--local-only', '--priority', '4', '--max-priority', '5', '--models', 'agent/*,smart');
      assert.equal(r.code, 0, r.err);
      const key = /(mg-[A-Za-z0-9_-]{43})/.exec(r.out)?.[1];
      assert.ok(key, 'the key is printed');
      const hub = open();
      try {
        const k = hub.keys.authenticate(key!)!;
        assert.equal(k.name, 'laptop');
        assert.equal(k.rpm, 30);
        assert.equal(k.tokensPerDay, 50000);
        assert.equal(k.localOnly, true);
        assert.equal(k.defaultPriority, 4);
        assert.deepEqual(k.allowedModels, ['agent/*', 'smart']);
      } finally {
        hub.db.close();
      }
      const list = await run('keys', 'list');
      assert.match(list.out, /laptop/);
      assert.match(list.out, /local-only/);
      assert.match(list.out, /30\/min/);
      assert.ok(!list.out.includes(key!), 'listing never shows the key');
    });

    it('revokes and deletes', async () => {
      await run('keys', 'create', 'temp');
      assert.match((await run('keys', 'revoke', 'temp')).out, /revoked/);
      assert.match((await run('keys', 'list')).out, /REVOKED/);
      assert.equal((await run('keys', 'delete', 'temp')).code, 0);
      assert.equal((await run('keys', 'revoke', 'temp')).code, 1);
    });

    it('rejects bad input without a stack trace', async () => {
      assert.equal((await run('keys', 'create')).code, 2);
      assert.equal((await run('keys', 'create', 'x', '--rpm', 'lots')).code, 2);
      assert.equal((await run('keys', 'create', 'x', '--rpm')).code, 2);
      assert.equal((await run('keys', 'create', 'laptop')).code, 1, 'duplicate name');
      assert.match((await run('keys', 'create', 'laptop')).err, /already exists/);
    });
  });

  describe('import-legacy', () => {
    const legacy = (extra = '') => `
server: { port: 3000 }
agent:
  url: "http://192.168.1.50:3001/"
  secret: "agent-shared-secret-123456"
  timeout_ms: 0
wol:
  mac: "aa-bb-cc-dd-ee-ff"
  broadcast: "192.168.1.50"
  port: 9
  min_priority: 4
  boot_timeout_ms: 90000
  poll_interval_ms: 1500
auth:
  keys:
    - { name: antigravity, key: "mg-legacy-key-antigravity-0001", default_priority: 3, min_priority: 1, max_priority: 5 }  # gitleaks:allow — made-up fixture
    - { name: webui, key: "mg-legacy-key-webui-00000002", default_priority: 2, min_priority: 1, max_priority: 4 }
    - { name: example, key: "mg-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }
queue: { max_size: 50, request_timeout_ms: 600000 }
shutdown: { idle_minutes: 15 }
models: [flash, reasoning, coding-hard]
pipelines: ["reasoning+flash"]
${extra}`;

    it('a dry run reports and writes nothing', async () => {
      const file = join(dir, 'legacy-dry.yml');
      writeFileSync(file, legacy());
      const r = await run('import-legacy', file, '--dry-run', '--provider', 'dry');
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /Dry run/);
      assert.match(r.out, /dry\/flash/);
      const hub = open();
      try {
        assert.equal(hub.providers.get('dry'), undefined);
        assert.equal(hub.keys.authenticate('mg-legacy-key-webui-00000002'), undefined);
        assert.equal(hub.aliases.get('flash'), undefined);
      } finally {
        hub.db.close();
      }
    });

    it('moves the agent, profiles, pipelines and keys into the database', async () => {
      const file = join(dir, 'legacy.yml');
      writeFileSync(file, legacy());
      const r = await run('import-legacy', file);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /skipped key "example": still the placeholder/);
      assert.match(r.out, /MINDGATE_QUEUE_MAX/);
      assert.match(r.out, /MINDGATE_QUEUE_TIMEOUT_MS/);

      const hub = open();
      try {
        const p = hub.providers.require('agent');
        assert.equal(p.baseUrl, 'http://192.168.1.50:3001/v1');
        assert.equal(p.locality, 'local');
        assert.equal(p.authScheme, 'header');
        assert.equal(p.authHeader, 'X-MindGate-Secret');
        assert.equal(hub.providers.secret('agent'), 'agent-shared-secret-123456');
        assert.equal(p.maxConcurrency, 1, 'one request at a time, like the old queue');
        assert.equal(p.options.streamUsage, false);
        assert.equal(p.options.firstByteTimeoutMs, 3_600_000);
        assert.deepEqual(p.node, {
          mac: 'AA:BB:CC:DD:EE:FF',
          broadcast: '192.168.1.50',
          port: 9,
          minWakePriority: 4,
          bootTimeoutMs: 90000,
          pollIntervalMs: 1500,
          healthUrl: 'http://192.168.1.50:3001/health',
          shutdownUrl: 'http://192.168.1.50:3001/internal/shutdown-request',
          idleShutdownMinutes: 15,
        });
        // profile names keep working for clients through aliases
        assert.deepEqual(hub.aliases.get('flash')!.targets, ['agent/flash']);
        assert.deepEqual(hub.aliases.get('pipeline:reasoning+flash')!.targets, ['agent/pipeline:reasoning+flash']);
        assert.equal(hub.models.get('agent/pipeline:reasoning+flash')!.upstreamId, 'pipeline:reasoning+flash', 'the agent still gets the text it understands');
        assert.equal(hub.models.get('agent/coding-hard')!.upstreamId, 'coding-hard');
        // keys clients already hold still work
        const k = hub.keys.authenticate('mg-legacy-key-webui-00000002')!;
        assert.equal(k.name, 'webui');
        assert.equal(k.maxPriority, 4);
        assert.equal(k.defaultPriority, 2);
        assert.equal(hub.keys.authenticate('mg-legacy-key-antigravity-0001')!.name, 'antigravity');
        assert.equal(hub.keys.list().some(x => x.name === 'example'), false);
      } finally {
        hub.db.close();
      }
    });

    it('refuses to import twice, and a missing or empty file with a clear message', async () => {
      const file = join(dir, 'legacy.yml');
      const again = await run('import-legacy', file);
      assert.equal(again.code, 2);
      assert.match(again.err, /already exists/);
      assert.equal((await run('import-legacy', join(dir, 'nope.yml'))).code, 2);
      writeFileSync(join(dir, 'empty.yml'), 'server: {}\n');
      assert.match((await run('import-legacy', join(dir, 'empty.yml'))).err, /no agent\.url/);
      assert.equal((await run('import-legacy')).code, 2);
    });

    it('the imported setup really talks to the old agent: secret header, profile name, /health for the wake-up probe', async () => {
      const seen: Array<{ path: string; secret: unknown; auth: unknown; body: Json | null }> = [];
      const agent = await startUpstream((req, res) => {
        seen.push({ path: req.path, secret: req.headers['x-mindgate-secret'], auth: req.headers['authorization'], body: req.body });
        if (req.path === '/health') return sendJson(res, 200, { status: 'ok' });
        sendJson(res, 200, { id: 'x', object: 'chat.completion', created: 1, model: 'x', choices: [{ index: 0, message: { role: 'assistant', content: 'from the agent' }, finish_reason: 'stop' }] });
      });
      try {
        const file = join(dir, 'legacy-live.yml');
        writeFileSync(file, `agent: { url: "${agent.url}", secret: "live-agent-secret-0123456789" }\nwol: { mac: "AA:BB:CC:DD:EE:01", broadcast: "127.0.0.1", poll_interval_ms: 500 }\nmodels: [flash]\n`);
        const env2 = { ...env, MINDGATE_DB: join(dir, 'live.db') };
        const out: string[] = [];
        assert.equal(await runCli(['import-legacy', file], env2, { out: l => out.push(l), err: l => out.push(l) }), 0, out.join('\n'));
        const { buildServer } = await import('../server.js');
        const hub = createHub(loadConfig(env2, () => undefined), silentLogger);
        const key = hub.keys.create({ name: 'it' }).key;
        const app = await buildServer(hub);
        try {
          const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key}` }, payload: { model: 'flash', messages: [{ role: 'user', content: 'hi' }] } });
          assert.equal(res.statusCode, 200, res.body);
          assert.equal(res.json().choices[0].message.content, 'from the agent');
          assert.equal(res.json().model, 'agent/flash');
          const chat = seen.find(s => s.path === '/v1/chat/completions')!;
          assert.equal(chat.secret, 'live-agent-secret-0123456789');
          assert.equal(chat.auth, undefined, 'no bearer token: the old agent does not use one');
          assert.equal(chat.body!['model'], 'flash', 'the agent still gets its own profile name');
          assert.ok(seen.some(s => s.path === '/health'), 'it was probed before the request');
        } finally {
          await app.close();
          hub.nodes.stop();
          hub.db.close();
        }
      } finally {
        await agent.close();
      }
    });
  });

  describe('backup', () => {
    it('writes a consistent private copy that opens and passes its integrity check', async () => {
      const target = join(dir, 'out', 'copy.db');
      const r = await run('backup', target);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /integrity ok/);
      assert.match(r.out, /MINDGATE_MASTER_KEY/);
      assert.equal(statSync(target).mode & 0o077, 0);
      assert.deepEqual(readdirSync(join(dir, 'out')), ['copy.db'], 'no WAL leftovers');
      const copy = new Database(target, { readonly: true });
      try {
        assert.ok((copy.prepare('SELECT COUNT(*) AS n FROM api_keys').get() as { n: number }).n >= 2);
      } finally {
        copy.close();
      }
    });

    it('never overwrites an existing file', async () => {
      const r = await run('backup', join(dir, 'out', 'copy.db'));
      assert.equal(r.code, 2);
      assert.match(r.err, /already exists/);
    });

    it('defaults to a backups folder next to the database; --keep removes the oldest', () => {
      const backups = join(dir, 'pruning');
      const names = ['20260101-000000', '20260102-000000', '20260103-000000', '20260104-000000'].map(d => `mindgate-${d}.db`);
      return (async () => {
        const { mkdirSync } = await import('node:fs');
        mkdirSync(backups, { recursive: true });
        for (const n of names) writeFileSync(join(backups, n), 'x');
        writeFileSync(join(backups, 'notes.txt'), 'keep me');
        assert.deepEqual(pruneBackups(backups, 2), names.slice(0, 2));
        assert.deepEqual(readdirSync(backups).sort(), [...names.slice(2), 'notes.txt'].sort());
        assert.deepEqual(pruneBackups(backups, 5), []);
      })();
    });

    it('the default location and --keep through the command', async () => {
      const r = await run('backup', '--keep', '1');
      assert.equal(r.code, 0, r.err);
      const folder = join(dir, 'data', 'backups');
      assert.ok(existsSync(folder));
      const files = readdirSync(folder).filter(f => f.endsWith('.db'));
      assert.equal(files.length, 1);
      assert.match(files[0]!, /^mindgate-\d{8}-\d{6}\.db$/);
    });
  });

  describe('check', () => {
    it('reports providers and passes when all is well', async () => {
      const r = await run('check');
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /agent\s+openai local node/);
      assert.match(r.out, /No problems found/);
    });

    it('--online calls providers that are not nodes and reports failures', async () => {
      const up: Upstream = await openaiUpstream();
      try {
        const hub = open();
        hub.providers.create({ id: 'live', type: 'openai', baseUrl: `${up.url}/v1`, apiKey: 'sk-live-0123456789abcd' } as never); // gitleaks:allow — made-up fixture
        hub.providers.create({ id: 'dead', type: 'openai', baseUrl: 'http://127.0.0.1:9/v1', authScheme: 'none' } as never);
        hub.db.close();
        const r = await run('check', '--online');
        assert.equal(r.code, 1);
        assert.match(r.out, /live .*reachable, 1 models/);
        assert.match(r.out, /dead .*FAILED/);
        assert.match(r.out, /1 problem found/);
      } finally {
        await up.close();
      }
    });

    it('notices provider keys that the current master key cannot open', async () => {
      const r = await runCli(['check'], { ...env, MINDGATE_MASTER_KEY: 'q'.repeat(4) + 'Zx8Cv6Bn4Mm2Lk0Jh8Gf6Ds4Sa2Pq0Wo' }, { out: () => undefined, err: () => undefined });
      assert.equal(r, 1);
      const lines: string[] = [];
      await runCli(['check'], { ...env, MINDGATE_MASTER_KEY: 'q'.repeat(4) + 'Zx8Cv6Bn4Mm2Lk0Jh8Gf6Ds4Sa2Pq0Wo' }, { out: l => lines.push(l), err: () => undefined });
      assert.match(lines.join('\n'), /CANNOT BE DECRYPTED/);
    });
  });
});

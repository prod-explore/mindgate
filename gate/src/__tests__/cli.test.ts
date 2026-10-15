import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { pruneBackups, runCli } from '../cli.js';
import { createHub, silentLogger } from '../context.js';
import { loadConfig } from '../config.js';
import { ADMIN, MASTER, openaiUpstream, type Upstream } from './helpers.js';

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

  describe('backup', () => {
    it('writes a consistent private copy that opens and passes its integrity check', async () => {
      assert.equal((await run('keys', 'create', 'backed-up')).code, 0);
      const target = join(dir, 'out', 'copy.db');
      const r = await run('backup', target);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /integrity ok/);
      assert.match(r.out, /MINDGATE_MASTER_KEY/);
      assert.equal(statSync(target).mode & 0o077, 0);
      assert.deepEqual(readdirSync(join(dir, 'out')), ['copy.db'], 'no WAL leftovers');
      const copy = new Database(target, { readonly: true });
      try {
        assert.ok(copy.prepare('SELECT 1 FROM api_keys WHERE name = ?').get('backed-up'), 'the key created before the backup is in the copy');
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
      const hub = open();
      hub.providers.create({ id: 'pc', type: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'node-secret-0123456789abcdef', locality: 'local', node: { mac: 'AA:BB:CC:DD:EE:FF', broadcast: '192.168.1.255', controlUrl: 'http://127.0.0.1:9' } } as never); // gitleaks:allow — made-up fixture
      hub.db.close();
      const r = await run('check');
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /pc\s+openai local node/);
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

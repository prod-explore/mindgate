import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { ADMIN, MASTER } from './helpers.js';

const ENTRY = fileURLToPath(new URL('../index.js', import.meta.url));

describe('starting the hub process', () => {
  let dir: string;
  let taken: Server;
  let port: number;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mindgate-start-'));
    taken = createServer();
    await new Promise<void>(r => taken.listen(0, '127.0.0.1', r));
    port = (taken.address() as AddressInfo).port;
  });
  after(async () => {
    await new Promise(r => taken.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  it('a port that is already taken ends the process with one clear line, not an unhandled rejection', async () => {
    const env = {
      PATH: process.env['PATH'] ?? '',
      MINDGATE_MASTER_KEY: MASTER,
      MINDGATE_ADMIN_TOKEN: ADMIN,
      MINDGATE_DB: join(dir, 'mindgate.db'),
      MINDGATE_PANEL_DIR: '',
      MINDGATE_HOST: '127.0.0.1',
      MINDGATE_PORT: String(port),
      MINDGATE_LOG_LEVEL: 'silent',
      MINDGATE_SYNC_INTERVAL_HOURS: '0',
    };
    const child = spawn(process.execPath, [ENTRY], { env, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const code = await new Promise<number | null>(r => child.on('exit', c => r(c)));

    assert.equal(code, 1);
    assert.match(stderr, /^\[mindgate\] could not start: .*EADDRINUSE/m);
    assert.doesNotMatch(stderr, /UnhandledPromiseRejection|^\s+at /m, 'no stack trace for an operator mistake');
  });
});

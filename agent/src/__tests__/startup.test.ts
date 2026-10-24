import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { SECRET } from './harness.js';

const ENTRY = fileURLToPath(new URL('../index.js', import.meta.url));

describe('starting the agent process', () => {
  let taken: Server;
  let port: number;

  before(async () => {
    taken = createServer();
    await new Promise<void>(r => taken.listen(0, '127.0.0.1', r));
    port = (taken.address() as AddressInfo).port;
  });
  after(async () => {
    await new Promise(r => taken.close(r));
  });

  it('a port that is already taken ends the process with one clear line, not an unhandled rejection', async () => {
    const env = {
      PATH: process.env['PATH'] ?? '',
      // keep a developer's own agent/.env out of the test
      MINDGATE_ENV_FILE: join(tmpdir(), 'mindgate-agent-no-such.env'),
      MINDGATE_NODE_SECRET: SECRET,
      MINDGATE_NODE_HOST: '127.0.0.1',
      MINDGATE_NODE_PORT: String(port),
      MINDGATE_MANAGE_OLLAMA: 'false',
      MINDGATE_TRAY_URL: '',
      LOG_LEVEL: 'silent',
    };
    const child = spawn(process.execPath, [ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const code = await new Promise<number | null>(r => child.on('exit', c => r(c)));

    assert.equal(code, 1);
    assert.match(stderr, /^\[mindgate-agent\] could not start: .*EADDRINUSE/m);
    assert.doesNotMatch(stderr, /UnhandledPromiseRejection|^\s+at /m, 'no stack trace for an operator mistake');
  });
});

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { isAgentError } from '../errors.js';
import { childEnv, findOllamaBinary } from '../ollama-process.js';
import { OllamaRuntime } from '../ollama.js';
import { startFakeOllama, type FakeOllama } from './fake-ollama.js';
import { SECRET, runtimeFor, sleep, startAgent, until } from './harness.js';

const posix = process.platform !== 'win32';

/** A free port: ask the OS, then give it back. */
async function freePort(): Promise<number> {
  const f = await startFakeOllama();
  const port = f.port;
  await f.close();
  return port;
}

describe('the Ollama runtime', () => {
  let ollama: FakeOllama;
  before(async () => {
    ollama = await startFakeOllama([{ name: 'a:1b', capabilities: ['completion'] }]);
  });
  after(() => ollama.close());

  it('adopts an Ollama that is already running instead of starting a second one', async () => {
    const rt = runtimeFor(ollama, { manage: true, findBinary: () => assert.fail('must not look for a binary') });
    await rt.ensureRunning();
    const h = await rt.health();
    assert.equal(h.ok, true);
    assert.equal(h.managed, false);
    assert.equal(h.version, '0.0.0-fake');
  });

  it('says what is wrong when it may not start one', async () => {
    const rt = new OllamaRuntime({ url: 'http://127.0.0.1:1', manage: false, startTimeoutMs: 1000 });
    await assert.rejects(rt.ensureRunning(), (e: unknown) => isAgentError(e) && e.status === 503 && e.code === 'runtime_unavailable' && /MINDGATE_MANAGE_OLLAMA is off/.test(e.message));
    const h = await rt.health();
    assert.equal(h.ok, false);
    assert.match(h.error ?? '', /MANAGE_OLLAMA/);
  });

  it('says so when Ollama is not installed', async () => {
    const rt = new OllamaRuntime({ url: 'http://127.0.0.1:1', manage: true, startTimeoutMs: 1000, findBinary: () => null });
    await assert.rejects(rt.ensureRunning(), /not installed here/);
  });

  it('lists the models it finds, with their details', async () => {
    ollama.addModel({ name: 'b:1b', capabilities: ['completion', 'tools'] });
    const rt = runtimeFor(ollama);
    const models = await rt.listModels();
    assert.deepEqual(models.map(m => m.id).sort(), ['a:1b', 'b:1b']);
    ollama.models.delete('b:1b');
  });
});

describe('the search for the Ollama binary', () => {
  it('OLLAMA_PATH wins when it exists', () => {
    assert.equal(findOllamaBinary(process.execPath), process.execPath);
  });

  it('does not hand out a path that does not exist', () => {
    const logged: string[] = [];
    const found = findOllamaBinary('/definitely/not/here/ollama', m => logged.push(m));
    assert.notEqual(found, '/definitely/not/here/ollama');
    assert.equal(logged.length, 1);
  });

  it("the child does not inherit the agent's own secrets", () => {
    const env = childEnv({ PATH: '/bin', MINDGATE_NODE_SECRET: SECRET, MINDGATE_TRAY_URL: 'x', OLLAMA_KEEP_ALIVE: '5m' }, '127.0.0.1:11434');
    assert.deepEqual(env, { PATH: '/bin', OLLAMA_KEEP_ALIVE: '5m', OLLAMA_HOST: '127.0.0.1:11434' });
  });
});

describe('starting and stopping Ollama', { skip: !posix && 'needs a shell script as the fake binary' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'mg-fake-ollama-'));
  const live: OllamaRuntime[] = [];
  after(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(async () => {
    while (live.length) await live.pop()!.stop();
  });

  /** An executable that behaves like `ollama serve`: listens on OLLAMA_HOST and answers /api/version. */
  function fakeBinary(name: string, body: string): string {
    const path = join(dir, name);
    writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  const serveScript = (extra = '') => `
    const http = require('node:http');
    const [host, port] = process.env.OLLAMA_HOST.split(':');
    if (process.argv[2] !== 'serve') process.exit(9);
    http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/version') return res.end(JSON.stringify({ version: '9.9.9' }));
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [] }));
      if (req.url === '/env') return res.end(JSON.stringify({ leaked: Object.keys(process.env).filter(k => k.startsWith('MINDGATE_')), host: process.env.OLLAMA_HOST, keep: process.env.OLLAMA_KEEP_ALIVE ?? null }));
      res.statusCode = 404; res.end('{}');
    }).listen(Number(port), host);
    ${extra}`;

  const make = async (binary: string, over: Partial<ConstructorParameters<typeof OllamaRuntime>[0]> = {}) => {
    const port = await freePort();
    const rt = new OllamaRuntime({ url: `http://127.0.0.1:${port}`, manage: true, startTimeoutMs: 8000, findBinary: () => binary, env: { PATH: process.env['PATH'], MINDGATE_NODE_SECRET: SECRET, OLLAMA_KEEP_ALIVE: '7m' }, ...over });
    live.push(rt);
    return { rt, port };
  };

  it('starts Ollama when it is not running, with the right address and without the agent\'s secrets', async () => {
    const { rt, port } = await make(fakeBinary('ollama-ok', serveScript()));
    await rt.ensureRunning();
    const h = await rt.health();
    assert.equal(h.ok, true);
    assert.equal(h.managed, true, 'the agent started it, so the agent stops it');
    assert.equal(h.version, '9.9.9');
    const seen = (await (await fetch(`http://127.0.0.1:${port}/env`)).json()) as any;
    assert.deepEqual(seen.leaked, []);
    assert.equal(seen.host, `127.0.0.1:${port}`);
    assert.equal(seen.keep, '7m', 'Ollama settings are passed on');
  });

  it('starts it once when several requests ask at the same time', async () => {
    let starts = 0;
    const { rt } = await make(fakeBinary('ollama-once', serveScript()), {
      findBinary: p => {
        starts++;
        return p ?? join(dir, 'ollama-once');
      },
    });
    await Promise.all([rt.ensureRunning(), rt.ensureRunning(), rt.ensureRunning()]);
    assert.equal(starts, 1);
  });

  it('stopping ends the process it started', async () => {
    const { rt, port } = await make(fakeBinary('ollama-stop', serveScript()));
    await rt.ensureRunning();
    await rt.stop();
    await until(async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/api/version`, { signal: AbortSignal.timeout(500) });
        return false;
      } catch {
        return true;
      }
    }, 'the process to be gone');
    assert.equal((await rt.health()).managed, false);
  });

  it('stopping leaves an Ollama it only adopted alone', async () => {
    const f = await startFakeOllama();
    try {
      const rt = runtimeFor(f, { manage: true, findBinary: () => null });
      await rt.ensureRunning();
      await rt.stop();
      assert.equal((await rt.health()).ok, true);
    } finally {
      await f.close();
    }
  });

  it('reports a binary that dies at once, with how it died', async () => {
    const { rt } = await make(fakeBinary('ollama-dies', 'process.exit(3)'));
    await assert.rejects(rt.ensureRunning(), (e: unknown) => isAgentError(e) && /exited with code 3 right after starting/.test(e.message));
    await assert.doesNotReject(rt.health());
  });

  it('gives up on a binary that never answers, and does not leave it running', async () => {
    const { rt } = await make(fakeBinary('ollama-silent', 'setInterval(() => {}, 1000)'), { startTimeoutMs: 1000 });
    await assert.rejects(rt.ensureRunning(), /did not answer within 1s/);
    assert.equal((await rt.health()).managed, false, 'it is stopped again');
  });

  it('a request finds the runtime down and starts it (e.g. after a crash)', async () => {
    const port = await freePort();
    const t = await startAgent({
      env: { OLLAMA_URL: `http://127.0.0.1:${port}`, MINDGATE_MANAGE_OLLAMA: 'true' },
      ollama: await startFakeOllama(),
      deps: { runtime: new OllamaRuntime({ url: `http://127.0.0.1:${port}`, manage: true, startTimeoutMs: 8000, findBinary: () => fakeBinary('ollama-lazy', serveScript()), env: { PATH: process.env['PATH'] } }) },
    });
    try {
      const r = await t.api('GET', '/v1/models');
      assert.equal(r.status, 200);
      assert.equal(r.json.object, 'list');
      assert.equal((await t.api('GET', '/node/status')).json.runtime.managed, true);
    } finally {
      await t.close();
      await t.ollama.close();
    }
    await sleep(50);
  });
});

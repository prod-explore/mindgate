import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig, type AgentConfig } from '../config.js';
import { OllamaRuntime } from '../ollama.js';
import { buildAgent, type Agent, type AgentDeps } from '../server.js';
import { startFakeOllama, type FakeModel, type FakeOllama } from './fake-ollama.js';

export const SECRET = 'node-' + 'Zy9Xw7Vu5Ts3Rq1Po9Nm7Lk5Ji3';

export type Json = Record<string, any>;

export interface TestAgent {
  agent: Agent;
  ollama: FakeOllama;
  base: string;
  config: AgentConfig;
  execCalls: Array<{ command: string; args: string[] }>;
  /** Calls the agent with the secret (as a Bearer token) unless `auth` says otherwise. */
  api(method: string, path: string, body?: unknown, opts?: { auth?: string | null; headers?: Record<string, string> }): Promise<{ status: number; json: Json; headers: Headers; text: string }>;
  raw(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  close(): Promise<void>;
}

export interface StartOptions {
  models?: FakeModel[];
  env?: Record<string, string>;
  /** An already running fake Ollama to use instead of a new one. */
  ollama?: FakeOllama;
  deps?: AgentDeps;
  execFails?: boolean;
}

export async function startAgent(opts: StartOptions = {}): Promise<TestAgent> {
  const ollama = opts.ollama ?? (await startFakeOllama(opts.models ?? [{ name: 'tiny:1b', capabilities: ['completion', 'tools'] }]));
  const config = loadConfig({ MINDGATE_NODE_SECRET: SECRET, OLLAMA_URL: ollama.url, MINDGATE_TRAY_URL: '', MINDGATE_NODE_ID: 'test-node', MINDGATE_MANAGE_OLLAMA: 'false', ...opts.env }, () => undefined);
  const execCalls: TestAgent['execCalls'] = [];
  const agent = await buildAgent(config, {
    exec: async (command, args) => {
      execCalls.push({ command, args });
      if (opts.execFails) throw new Error('no permission');
    },
    ...opts.deps,
  });
  await agent.app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(agent.app.server.address() as AddressInfo).port}`;

  const headersFor = (auth: string | null | undefined, extra: Record<string, string> = {}) => ({ ...(auth === null ? {} : { Authorization: `Bearer ${auth ?? SECRET}` }), ...extra });
  return {
    agent,
    ollama,
    base,
    config,
    execCalls,
    async api(method, path, body, o = {}) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headersFor(o.auth, o.headers) },
        body: body === undefined ? null : JSON.stringify(body),
      });
      const text = await res.text();
      let json: Json = {};
      try {
        json = text ? (JSON.parse(text) as Json) : {};
      } catch {
        /* not json */
      }
      return { status: res.status, json, headers: res.headers, text };
    },
    raw: (method, path, body, headers = {}) =>
      fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headersFor(undefined, headers) }, body: body === undefined ? null : JSON.stringify(body) }),
    async close() {
      await agent.close();
      if (!opts.ollama) await ollama.close();
    },
  };
}

/** A runtime pointed at a fake Ollama, for tests of the runtime on its own. */
export const runtimeFor = (ollama: FakeOllama, extra: Partial<ConstructorParameters<typeof OllamaRuntime>[0]> = {}): OllamaRuntime =>
  new OllamaRuntime({ url: ollama.url, manage: false, startTimeoutMs: 5000, ...extra });

/** A tiny stand-in for the tray app's /shutdown-check. */
export async function startFakeTray(answer: () => { status?: number; body?: unknown }): Promise<{ url: string; calls: Json[]; close(): Promise<void> }> {
  const calls: Json[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      try {
        calls.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Json);
      } catch {
        calls.push({});
      }
      const a = answer();
      res.writeHead(a.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(a.body ?? { allow: true, reason: 'all_checks_passed' }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    close: () =>
      new Promise<void>(r => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Polls until `fn` returns a truthy value (or fails the test after `timeoutMs`). */
export async function until<T>(fn: () => T | Promise<T>, what: string, timeoutMs = 5000): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

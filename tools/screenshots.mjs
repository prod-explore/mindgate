// Regenerates docs/img/*.png: the real hub, the real agent and the real panel, filled with demo data.
//
//   cd gate  && npm ci && npm run build
//   cd agent && npm ci && npm run build
//   cd panel && npm ci && npm run build
//   npm i --no-save playwright-core        (in the repository root; it is not a dependency of the project)
//   node tools/screenshots.mjs
//
// What is faked, and nothing else: the model runtime (the Ollama stand-in the agent's tests use), `nvidia-smi` (a shell
// script that prints one GPU), the machine's own figures (CPU, memory, disk), and the two cloud providers (a server
// that lists models). Providers, models and
// keys are created through the administrator API; the usage history and the request log are written with the hub's own
// store, thirty days of requests that look the way the hub's log does (errors, queues).
//
// Environment: OUT (default docs/img), CHROME (default: Playwright's Chromium).
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const OUT = process.env.OUT ?? fileURLToPath(new URL('docs/img/', root));
mkdirSync(OUT, { recursive: true });

// ─── a GPU for the agent to find ─────────────────────────────────────────────
const bin = mkdtempSync(join(os.tmpdir(), 'mindgate-shots-'));
writeFileSync(join(bin, 'nvidia-smi'), '#!/bin/sh\necho "NVIDIA GeForce RTX 4070 Ti, 12282, 3512, 11"\n');
chmodSync(join(bin, 'nvidia-smi'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

// ...and a machine that looks like one: the agent reads CPU, memory, disk and host name from the OS it runs on
os.cpus = () => Array.from({ length: 24 }, () => ({ model: 'AMD Ryzen 9 7900X', speed: 4700, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }));
os.totalmem = () => 32 * 1024 ** 3;
os.freemem = () => 21.4 * 1024 ** 3;
os.hostname = () => 'desktop-4070';
fsp.statfs = async () => ({ bsize: 4096, blocks: (1_000_204_886_016 / 4096) | 0, bavail: (612_300_000_000 / 4096) | 0 });
syncBuiltinESMExports();

const { loadConfig: loadHubConfig } = await import(new URL('gate/dist/config.js', root));
const { createHub, silentLogger } = await import(new URL('gate/dist/context.js', root));
const { buildServer } = await import(new URL('gate/dist/server.js', root));
const { dayKey } = await import(new URL('gate/dist/time.js', root));
const { loadConfig: loadAgentConfig } = await import(new URL('agent/dist/config.js', root));
const { buildAgent } = await import(new URL('agent/dist/server.js', root));
const { startFakeOllama } = await import(new URL('agent/dist/__tests__/fake-ollama.js', root));
const { chromium } = await import('playwright-core');

const hex = n => randomBytes(n).toString('hex');
const MASTER = hex(32);
const ADMIN = hex(32);
const NODE_SECRET = hex(32);
const TZ = 'Europe/Warsaw';

// ─── the machine: a PC with a GPU ────────────────────────────────────────────
const GB = 1_000_000_000;
const ollama = await startFakeOllama([
  { name: 'qwen3:14b', size: 9.3 * GB, family: 'qwen3', parameterSize: '14.8B', quantization: 'Q4_K_M', contextLength: 40960, capabilities: ['completion', 'tools', 'thinking'] },
  { name: 'qwen3:4b', size: 2.6 * GB, family: 'qwen3', parameterSize: '4.0B', quantization: 'Q4_K_M', contextLength: 40960, capabilities: ['completion', 'tools', 'thinking'] },
  { name: 'gemma3:12b', size: 8.1 * GB, family: 'gemma3', parameterSize: '12.2B', quantization: 'Q4_K_M', contextLength: 131072, capabilities: ['completion', 'vision'] },
  { name: 'llama3.2:3b', size: 2.0 * GB, family: 'llama', parameterSize: '3.2B', quantization: 'Q4_K_M', contextLength: 131072, capabilities: ['completion', 'tools'] },
  { name: 'nomic-embed-text:latest', size: 0.27 * GB, family: 'nomic-bert', parameterSize: '137M', quantization: 'F16', contextLength: 8192, capabilities: ['embedding'] },
], 0, '0.12.6');
ollama.loaded.set('qwen3:4b', { expiresAt: new Date(Date.now() + 25 * 60_000).toISOString() });
const agent = await buildAgent(
  loadAgentConfig({ MINDGATE_NODE_SECRET: NODE_SECRET, OLLAMA_URL: ollama.url, MINDGATE_MANAGE_OLLAMA: 'false', MINDGATE_TRAY_URL: '', MINDGATE_NODE_ID: 'desktop-4070', OLLAMA_MODELS: '/srv/ollama/models' }, () => undefined),
  { exec: async () => undefined },
);
await agent.app.listen({ host: '127.0.0.1', port: 3001 }).catch(() => agent.app.listen({ host: '127.0.0.1', port: 0 }));
const agentUrl = `http://127.0.0.1:${agent.app.server.address().port}`;

// ─── two cloud providers that only list their models ─────────────────────────
const entry = (id, name, ctx, extra = {}) => ({ id, name, context_length: ctx, supported_parameters: ['tools', 'reasoning'], architecture: { input_modalities: ['text', 'image'] }, ...extra });
const catalogs = {
  '/openrouter/v1/models': [
    entry('anthropic/claude-sonnet-4.5', 'Claude Sonnet 4.5', 1_000_000),
    entry('anthropic/claude-haiku-4.5', 'Claude Haiku 4.5', 200_000),
    entry('openai/gpt-5-mini', 'GPT-5 mini', 400_000),
    entry('deepseek/deepseek-chat-v3.1', 'DeepSeek V3.1', 131_072, { architecture: { input_modalities: ['text'] } }),
    entry('meta-llama/llama-3.3-70b-instruct', 'Llama 3.3 70B Instruct', 131_072, { architecture: { input_modalities: ['text'] } }),
    entry('qwen/qwen3-coder:free', 'Qwen3 Coder (free)', 262_144, { architecture: { input_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' } }),
    entry('mistralai/mistral-small-3.2-24b-instruct', 'Mistral Small 3.2 24B', 131_072),
  ],
  '/gemini/v1/models': [
    entry('gemini-2.5-pro', 'Gemini 2.5 Pro', 1_048_576),
    entry('gemini-2.5-flash', 'Gemini 2.5 Flash', 1_048_576),
    entry('gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite', 1_048_576),
    { id: 'text-embedding-004', name: 'Text Embedding 004', kind: 'embedding', context_length: 2048 },
  ],
};
const cloud = createServer((req, res) => {
  const list = catalogs[(req.url ?? '').split('?')[0]];
  res.writeHead(list ? 200 : 404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(list ? { data: list } : { error: { message: 'not here' } }));
});
await new Promise(r => cloud.listen(0, '127.0.0.1', r));
const cloudUrl = `http://127.0.0.1:${cloud.address().port}`;

// ─── the hub ─────────────────────────────────────────────────────────────────
const hub = createHub(
  loadHubConfig({ MINDGATE_MASTER_KEY: MASTER, MINDGATE_ADMIN_TOKEN: ADMIN, MINDGATE_DB: ':memory:', MINDGATE_USAGE_TZ: TZ, MINDGATE_PANEL_DIR: fileURLToPath(new URL('panel/dist', root)) }, () => undefined),
  silentLogger,
);
const app = await buildServer(hub);
await app.listen({ host: '127.0.0.1', port: 0 });
const hubUrl = `http://127.0.0.1:${app.server.address().port}`;

async function api(method, path, body) {
  const res = await fetch(`${hubUrl}/admin/api${path}`, { method, headers: { Authorization: `Bearer ${ADMIN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return json;
}

// providers
await api('POST', '/providers', {
  id: 'desktop', name: 'Desktop (RTX 4070 Ti)', type: 'openai', base_url: `${agentUrl}/v1`, api_key: NODE_SECRET, locality: 'local', max_concurrency: 1,
  node: { mac: 'A4:BB:6D:1C:0E:52', broadcast: '192.168.1.255', control_url: agentUrl, idle_shutdown_minutes: 15, poll_interval_ms: 1000 },
});
await api('POST', '/providers', { id: 'openrouter', name: 'OpenRouter', type: 'openai', base_url: `${cloudUrl}/openrouter/v1`, api_key: 'sk-or-v1-' + hex(24), locality: 'cloud', options: { auto_enable_models: false } });
await api('POST', '/providers', { id: 'gemini', name: 'Google Gemini', type: 'openai', base_url: `${cloudUrl}/gemini/v1`, api_key: 'AIza' + hex(18), locality: 'cloud' });

await api('POST', '/providers/desktop/sync'); // the models the agent reports

// models: OpenRouter lists everything switched off; the owner turns on the ones in use
for (const id of ['anthropic/claude-sonnet-4.5', 'anthropic/claude-haiku-4.5', 'openai/gpt-5-mini', 'deepseek/deepseek-chat-v3.1', 'qwen/qwen3-coder:free']) {
  await api('PATCH', `/models/${encodeURIComponent(`openrouter/${id}`)}`, { enabled: true });
}
await api('PATCH', `/models/${encodeURIComponent('desktop/llama3.2:3b')}`, { enabled: false });

// what each app asks for: the hub has no aliases, so these are only the models an app picks (used to simulate traffic below)
const aliases = [
  ['smart', 'Hard problems, long context. Cloud first, the PC when the cloud is down.', ['reasoning'], ['openrouter/anthropic/claude-sonnet-4.5', 'gemini/gemini-2.5-pro', 'desktop/qwen3:14b']],
  ['fast', 'Cheap and quick, for pipelines.', [], ['gemini/gemini-2.5-flash', 'openrouter/openai/gpt-5-mini', 'desktop/qwen3:4b']],
  ['private', 'Never leaves the house.', [], ['desktop/qwen3:14b', 'desktop/qwen3:4b']],
  ['vision', 'Describes images.', [], ['gemini/gemini-2.5-flash', 'desktop/gemma3:12b']],
  ['embed', 'Embeddings for search over notes.', [], ['desktop/nomic-embed-text:latest', 'gemini/text-embedding-004']],
];

// client keys
const keyDefs = [
  { name: 'everything-app', default_priority: 3, rpm: 120, tokens_per_day: 4_000_000, tokens_per_month: 60_000_000 },
  { name: 'n8n', default_priority: 4, min_priority: 3, max_priority: 5, rpm: 60, rpd: 5000, allowed_models: ['gemini/*', 'desktop/*'] },
  { name: 'obsidian-mcp', default_priority: 2, local_only: true, rpm: 30, allowed_models: ['desktop/*'] },
  { name: 'phone-shortcuts', default_priority: 1, max_priority: 2, rpm: 10, rpd: 200, allowed_models: ['gemini/gemini-2.5-flash'] },
];
const keys = {};
for (const def of keyDefs) {
  const made = await api('POST', '/keys', def);
  keys[def.name] = { id: made.id ?? made.record?.id, name: def.name };
}
const retired = await api('POST', '/keys', { name: 'old-laptop' });
await api('POST', `/keys/${retired.id ?? retired.record?.id}/revoke`);

// ─── thirty days of requests ─────────────────────────────────────────────────
let seed = 20261022; // fixed, so the pictures are the same every time
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = list => list[Math.floor(rnd() * list.length)];
const weighted = list => {
  let r = rnd() * list.reduce((s, [, w]) => s + w, 0);
  for (const [v, w] of list) if ((r -= w) < 0) return v;
  return list[0][0];
};
const between = (a, b) => Math.round(a + rnd() * (b - a));
const provOf = m => m.split('/')[0];
const isLocal = m => provOf(m) === 'desktop';
const aliasTargets = Object.fromEntries(aliases.map(([n, , , t]) => [n, t]));

const traffic = {
  'everything-app': { perDay: 95, priority: 3, aliases: [['smart', 5], ['fast', 3], ['private', 2], ['vision', 0.5]] },
  n8n: { perDay: 70, priority: 4, aliases: [['fast', 6], ['embed', 2], ['private', 1]] },
  'obsidian-mcp': { perDay: 55, priority: 2, aliases: [['embed', 5], ['private', 3]] },
  'phone-shortcuts': { perDay: 8, priority: 1, aliases: [['fast', 1]] },
};
const lastUsed = {};

/** What happened to one request, the way the hub would have routed it. `forced` replaces chance with a given outcome. */
function simulate(keyName, aliasName, at, forced) {
  const t = traffic[keyName];
  const embedding = aliasName === 'embed';
  const targets = aliasTargets[aliasName];
  const attempts = [];
  let served = null;
  let status = 200;
  let errorCode = null;
  const roll = rnd();

  if (forced === 'rate_limited' || (keyName === 'phone-shortcuts' && roll < 0.05) || (keyName === 'n8n' && roll < 0.004)) {
    status = 429; errorCode = 'rate_limited';
  } else if (forced === 'too_long' || roll > 0.998) {
    attempts.push({ model: targets[0], outcome: 'context_length_exceeded' });
    status = 400; errorCode = 'context_length_exceeded';
  } else if (forced === 'asleep' || (keyName === 'obsidian-mcp' && aliasName === 'private' && roll > 0.996)) {
    attempts.push({ model: targets[0], outcome: 'node_asleep' });
    status = 503; errorCode = 'node_asleep';
  } else {
    const target = targets[0];
    const trouble = forced === 'fallback' || forced === 'down' || roll > 0.996
      ? 'upstream_timeout'
      : !isLocal(target) && rnd() < 0.02 ? pick(['upstream_timeout', 'upstream_overloaded', 'upstream_rate_limited']) : null;
    if (trouble) {
      attempts.push({ model: target, outcome: isLocal(target) && trouble === 'upstream_timeout' ? 'node_connection_lost' : trouble });
      status = trouble === 'upstream_overloaded' ? 503 : trouble === 'upstream_rate_limited' ? 429 : 504;
      errorCode = trouble;
    } else {
      attempts.push({ model: target, outcome: 'ok' });
      served = target;
    }
  }

  const finalModel = served ?? attempts.at(-1)?.model ?? null;
  const local = finalModel ? isLocal(finalModel) : false;
  const failed = status >= 400;
  const input = embedding ? between(40, 900) : between(300, 5200);
  const output = embedding || failed ? 0 : between(60, 1100);
  const queueMs = local && !embedding && !failed && rnd() < 0.18 ? between(200, 6500) : null;
  const ttfb = failed ? null : embedding ? between(30, 140) : local ? between(350, 1900) : between(280, 1100);
  const attemptCost = Math.max(0, attempts.length - 1) * between(4000, 9000);
  const latency = failed ? between(900, 30_000) : embedding ? ttfb + between(5, 40) : ttfb + attemptCost + Math.round(output * (local ? between(14, 26) : between(5, 12)));
  return { keyName, aliasName, at, embedding, attempts, finalModel, status, errorCode, failed, input, output, queueMs, ttfb, latency, stream: !embedding && rnd() < 0.7, priority: t.priority };
}

const DAY = 86_400_000;
const now = Date.now();
const startOfToday = now - (now % DAY);
const planned = [];
for (let back = 29; back >= 0; back--) {
  const dayStart = startOfToday - back * DAY;
  const weekday = new Date(dayStart).getUTCDay();
  const weekend = weekday === 0 || weekday === 6 ? 0.45 : 1;
  const growth = 0.75 + ((29 - back) / 29) * 0.5; // the home setup gets used more over the month
  for (const [keyName, t] of Object.entries(traffic)) {
    const count = Math.round(t.perDay * weekend * growth * (0.8 + rnd() * 0.4));
    for (let i = 0; i < count; i++) {
      const hour = weighted([[7, 1], [8, 3], [9, 5], [10, 6], [11, 6], [12, 4], [13, 5], [14, 6], [15, 6], [16, 5], [17, 4], [18, 3], [19, 3], [20, 4], [21, 3], [22, 2], [23, 1], [2, 0.4], [4, 0.3]]);
      const at = dayStart + hour * 3_600_000 + between(0, 3_599_000);
      if (at < now - 20_000) planned.push({ keyName, aliasName: weighted(t.aliases), at });
    }
  }
}
// a few moments that are easy to read in the log: one of each kind, among the latest requests
const MIN = 60_000;
planned.push(
  { keyName: 'everything-app', aliasName: 'smart', at: now - 3 * MIN, forced: 'fallback' },
  { keyName: 'n8n', aliasName: 'fast', at: now - 9 * MIN, forced: 'rate_limited' },
  { keyName: 'obsidian-mcp', aliasName: 'private', at: now - 15 * MIN, forced: 'asleep' },
  { keyName: 'everything-app', aliasName: 'smart', at: now - 26 * MIN, forced: 'too_long' },
);
planned.sort((a, b) => a.at - b.at);

for (const p of planned) {
  const e = simulate(p.keyName, p.aliasName, p.at, p.forced);
  const key = keys[e.keyName];
  const countsAsUsage = e.finalModel && e.status !== 429;
  if (countsAsUsage) hub.usage.record(dayKey(new Date(e.at), TZ), key.id, e.finalModel, { requests: 1, errors: e.failed ? 1 : 0, inputTokens: e.input, outputTokens: e.output });
  hub.usage.log({
    ts: new Date(e.at).toISOString(),
    requestId: `req_${hex(6)}`,
    keyId: key.id,
    keyName: e.keyName,
    endpoint: e.embedding ? '/v1/embeddings' : '/v1/chat/completions',
    requestedModel: aliasTargets[e.aliasName][0],
    modelId: e.status === 429 ? null : e.finalModel,
    providerId: e.status === 429 || !e.finalModel ? null : provOf(e.finalModel),
    status: e.status,
    errorCode: e.errorCode,
    stream: e.stream,
    priority: e.priority,
    localOnly: e.keyName === 'obsidian-mcp',
    tag: e.keyName === 'n8n' ? pick(['nightly-digest', 'inbox-triage', 'rss-summaries']) : e.keyName === 'everything-app' && rnd() < 0.2 ? 'agent' : null,
    attempts: e.status === 429 ? [] : e.attempts,
    queueMs: e.queueMs,
    ttfbMs: e.ttfb,
    latencyMs: e.latency,
    usage: e.failed ? null : { inputTokens: e.input, outputTokens: e.output, estimated: false },
  });
  lastUsed[e.keyName] = Math.max(lastUsed[e.keyName] ?? 0, e.at);
}
for (const [name, at] of Object.entries(lastUsed)) hub.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(new Date(at).toISOString(), keys[name].id);
console.log(`seeded ${planned.length} requests`);

// the hub looks at its machines every few seconds; do that once now, or the first screen says "unknown"
await hub.nodes.tick();
// what the panel shows as the address: the real services of these providers
await api('PATCH', '/providers/openrouter', { base_url: 'https://openrouter.ai/api/v1', sync: false });
await api('PATCH', '/providers/gemini', { base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', sync: false });

// ─── the pictures ────────────────────────────────────────────────────────────
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--no-sandbox'] });

async function open(theme) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: theme });
  await ctx.addInitScript(t => { try { localStorage.setItem('mindgate.theme', t); } catch { /* storage may be unavailable */ } }, theme);
  const page = await ctx.newPage();
  await page.goto(`${hubUrl}/admin/`);
  await page.fill('input[type="password"]', ADMIN);
  await page.keyboard.press('Enter');
  await page.waitForSelector('nav[aria-label="Main"]');
  return { page, ctx };
}

async function shoot(page, hash, name, ready) {
  await page.evaluate(h => { location.hash = h; }, hash);
  if (ready) await page.waitForSelector(ready, { timeout: 15_000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log('wrote', `${name}.png`);
}

const { page, ctx } = await open('light');
await shoot(page, '#/', 'overview');
await shoot(page, '#/providers/desktop', 'machine');
await shoot(page, '#/models', 'models');
await shoot(page, '#/keys', 'keys');
await shoot(page, '#/usage', 'usage');
await shoot(page, '#/log', 'log');
await ctx.close();

const dark = await open('dark');
await shoot(dark.page, '#/', 'overview-dark');
await dark.ctx.close();

await browser.close();
hub.nodes.stop();
hub.nodeClient.stop();
hub.sync.stop();
await app.close();
hub.db.close();
await agent.close();
await ollama.close();
cloud.close();
process.exit(0);

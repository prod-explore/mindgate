import { hostname } from 'node:os';
import { assertStrongSecret } from './secret-check.js';

export interface AgentConfig {
  /** Name of this machine, as the hub's panel shows it. */
  nodeId: string;
  host: string;
  port: number;
  /** The shared secret the hub (and the tray) present as `Authorization: Bearer <secret>`. */
  secret: string;
  logLevel: string;
  bodyLimitBytes: number;
  ollama: {
    url: string;
    /** Explicit path of the ollama binary, if the automatic search is not enough. */
    path: string | undefined;
    /** Start Ollama when it is not running. Only possible for a loopback address. */
    manage: boolean;
    startTimeoutMs: number;
    /** Where Ollama keeps models (to report free disk space). */
    modelsDir: string | undefined;
    /** OLLAMA_CONTEXT_LENGTH given to the agent: the context window Ollama really uses, whatever the model could do. */
    contextCap: number | null;
  };
  /** The tray app on this machine; null on a headless server. */
  trayUrl: string | null;
  shutdownDelaySeconds: number;
}

function intVar(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max} (got "${raw}")`);
  return n;
}

function boolVar(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${name} must be true or false (got "${raw}")`);
}

function httpUrl(name: string, raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL: "${raw}"`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`${name} must start with http:// or https:// (got "${raw}")`);
  return u;
}

export const isLoopbackHost = (host: string): boolean => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host.toLowerCase());

export function loadConfig(env: NodeJS.ProcessEnv = process.env, warn: (m: string) => void = m => console.warn(`[mindgate-agent] ${m}`)): AgentConfig {
  const secret = env['MINDGATE_NODE_SECRET']?.trim();
  if (!secret) throw new Error('MINDGATE_NODE_SECRET is not set. Put it in agent/.env (see .env.example); generate one with: openssl rand -hex 32');
  assertStrongSecret('MINDGATE_NODE_SECRET', secret, env, warn);

  const ollamaUrl = httpUrl('OLLAMA_URL', env['OLLAMA_URL']?.trim() || 'http://127.0.0.1:11434');
  const local = isLoopbackHost(ollamaUrl.hostname);
  const manage = boolVar(env, 'MINDGATE_MANAGE_OLLAMA') ?? local;
  if (manage && !local) throw new Error(`MINDGATE_MANAGE_OLLAMA=true needs OLLAMA_URL on this machine (127.0.0.1), not ${ollamaUrl.hostname}`);

  let trayUrl: string | null = null;
  if (env['MINDGATE_TRAY_URL'] === undefined) trayUrl = 'http://127.0.0.1:3002';
  else if (env['MINDGATE_TRAY_URL'].trim()) trayUrl = httpUrl('MINDGATE_TRAY_URL', env['MINDGATE_TRAY_URL'].trim()).origin;

  const ctx = Number(env['OLLAMA_CONTEXT_LENGTH']);

  return {
    nodeId: env['MINDGATE_NODE_ID']?.trim() || hostname(),
    host: env['MINDGATE_NODE_HOST']?.trim() || '0.0.0.0',
    port: intVar(env, 'MINDGATE_NODE_PORT', 3001, 1, 65535),
    secret,
    logLevel: env['LOG_LEVEL']?.trim() || 'info',
    bodyLimitBytes: 64 * 1024 * 1024,
    ollama: {
      url: ollamaUrl.origin,
      path: env['OLLAMA_PATH']?.trim() || undefined,
      manage,
      startTimeoutMs: intVar(env, 'MINDGATE_OLLAMA_START_TIMEOUT_MS', 30_000, 1000, 600_000),
      modelsDir: env['OLLAMA_MODELS']?.trim() || undefined,
      contextCap: Number.isInteger(ctx) && ctx > 0 ? ctx : null,
    },
    trayUrl,
    shutdownDelaySeconds: intVar(env, 'MINDGATE_SHUTDOWN_DELAY_SECONDS', 30, 0, 3600),
  };
}

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertStrongSecret } from './secret-check.js';

/** Everything the process reads from its environment. Runtime state (providers, models, keys) lives in SQLite. */
export interface HubConfig {
  host: string;
  port: number;
  dbPath: string;
  masterKey: string;
  adminToken: string;
  logLevel: string;
  /** IANA time zone in which "a day" and "a month" start for usage limits. */
  usageTz: string;
  trustProxy: boolean;
  bodyLimitBytes: number;
  /** Longest wait line per provider that has a concurrency limit. */
  queueMax: number;
  /** How long a request may wait for a slot at a concurrency-limited provider (0 = forever). */
  queueTimeoutMs: number;
  logRetentionDays: number;
  /** A streaming request that has produced nothing after this long gets an SSE comment so proxies keep the connection. */
  keepaliveAfterMs: number;
  keepaliveIntervalMs: number;
  /** Re-sync every provider's model list this often (0 = only on demand). */
  syncIntervalHours: number;
  /** Upstream timeouts used when a provider does not set its own. */
  defaultFirstByteTimeoutMs: number;
  defaultIdleTimeoutMs: number;
  /** Where the built admin panel is (null = no panel). Served at /admin/. */
  panelDir: string | null;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min} (got "${raw}")`);
  return n;
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

export function assertTimeZone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
  } catch {
    throw new Error(`MINDGATE_USAGE_TZ "${tz}" is not a valid IANA time zone (for example Europe/Warsaw or UTC)`);
  }
}

/** The panel next to the hub in the repository: gate/dist/config.js -> panel/dist. */
const DEFAULT_PANEL_DIR = fileURLToPath(new URL('../../panel/dist', import.meta.url));

export function loadConfig(env: NodeJS.ProcessEnv = process.env, warn: (m: string) => void = m => console.warn(`[config] ${m}`)): HubConfig {
  const masterKey = env['MINDGATE_MASTER_KEY'] ?? '';
  const adminToken = env['MINDGATE_ADMIN_TOKEN'] ?? '';
  if (!masterKey) throw new Error('MINDGATE_MASTER_KEY is required: it encrypts the provider API keys stored in the database (openssl rand -hex 32)');
  if (!adminToken) throw new Error('MINDGATE_ADMIN_TOKEN is required: it protects /admin (openssl rand -hex 32)');
  assertStrongSecret('MINDGATE_MASTER_KEY', masterKey, env, warn);
  assertStrongSecret('MINDGATE_ADMIN_TOKEN', adminToken, env, warn);
  if (masterKey === adminToken) throw new Error('MINDGATE_MASTER_KEY and MINDGATE_ADMIN_TOKEN must differ');

  const usageTz = env['MINDGATE_USAGE_TZ'] || 'UTC';
  assertTimeZone(usageTz);

  return {
    host: env['MINDGATE_HOST'] || '0.0.0.0',
    port: int(env, 'MINDGATE_PORT', 3000, 1),
    dbPath: env['MINDGATE_DB'] === ':memory:' ? ':memory:' : resolve(env['MINDGATE_DB'] || './data/mindgate.db'),
    masterKey,
    adminToken,
    logLevel: env['MINDGATE_LOG_LEVEL'] || 'info',
    usageTz,
    trustProxy: bool(env, 'MINDGATE_TRUST_PROXY', false),
    bodyLimitBytes: int(env, 'MINDGATE_BODY_LIMIT_MB', 20, 1) * 1024 * 1024,
    queueMax: int(env, 'MINDGATE_QUEUE_MAX', 100, 1),
    queueTimeoutMs: int(env, 'MINDGATE_QUEUE_TIMEOUT_MS', 0),
    logRetentionDays: int(env, 'MINDGATE_LOG_RETENTION_DAYS', 30),
    keepaliveAfterMs: int(env, 'MINDGATE_KEEPALIVE_AFTER_MS', 10_000, 100),
    keepaliveIntervalMs: int(env, 'MINDGATE_KEEPALIVE_INTERVAL_MS', 10_000, 100),
    syncIntervalHours: int(env, 'MINDGATE_SYNC_INTERVAL_HOURS', 24),
    defaultFirstByteTimeoutMs: int(env, 'MINDGATE_FIRST_BYTE_TIMEOUT_MS', 300_000, 1000),
    defaultIdleTimeoutMs: int(env, 'MINDGATE_IDLE_TIMEOUT_MS', 120_000, 1000),
    // unset = the panel in this repository; empty = no panel at all
    panelDir: env['MINDGATE_PANEL_DIR'] === undefined ? DEFAULT_PANEL_DIR : env['MINDGATE_PANEL_DIR'] === '' ? null : resolve(env['MINDGATE_PANEL_DIR']),
  };
}

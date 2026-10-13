import { hostname } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { Activity } from './activity.js';
import type { AgentConfig } from './config.js';
import { AgentError } from './errors.js';
import { toNodeModel } from './models.js';
import type { Power } from './power.js';
import type { PullManager } from './pulls.js';
import { MODEL_NAME, type Runtime } from './runtime.js';
import { readSystem } from './system.js';
import { VERSION } from './version.js';

type Body = Record<string, unknown>;

function body(req: { body?: unknown }): Body {
  const b = req.body;
  return typeof b === 'object' && b !== null && !Array.isArray(b) ? (b as Body) : {};
}

function modelName(v: unknown): string {
  if (typeof v !== 'string' || !MODEL_NAME.test(v)) throw new AgentError(400, 'invalid_model_name', 'A model name is required ("name"): letters, digits and . _ - : / @ + only');
  return v;
}

export interface NodeRouteDeps {
  config: AgentConfig;
  runtime: Runtime;
  activity: Activity;
  pulls: PullManager;
  power: Power;
  startedAt: number;
  onExit: () => void;
}

/** Everything the hub (and the tray) use to look after this machine. Needs the node secret like the rest. */
export function registerNodeRoutes(app: FastifyInstance, d: NodeRouteDeps): void {
  const { config, runtime, activity, pulls, power } = d;

  /** The runtime's loaded models, or nothing when it is not running (a status page must not fail because of that). */
  const loaded = async () => {
    try {
      return await runtime.loaded();
    } catch {
      return [];
    }
  };

  app.get('/health', async () => {
    const h = await runtime.health();
    const models = h.ok ? await loaded() : [];
    return {
      status: h.ok ? 'ok' : 'degraded',
      node_id: config.nodeId,
      version: VERSION,
      runtime: h.ok ? 'ok' : 'unreachable',
      in_flight: activity.inFlight,
      downloads: pulls.active,
      models_loaded: models.map(m => m.id),
      uptime: Math.floor((Date.now() - d.startedAt) / 1000),
    };
  });

  app.get('/node/status', async () => {
    const [h, models, system] = await Promise.all([runtime.health(), loaded(), readSystem(config.ollama.modelsDir)]);
    return {
      node_id: config.nodeId,
      version: VERSION,
      platform: process.platform,
      hostname: hostname(),
      uptime_seconds: Math.floor((Date.now() - d.startedAt) / 1000),
      runtime: { name: runtime.name, url: runtime.url, ok: h.ok, version: h.version, managed: h.managed, error: h.error },
      loaded: models.map(m => ({ id: m.id, size_bytes: m.sizeBytes, vram_bytes: m.vramBytes, expires_at: m.expiresAt })),
      in_flight: activity.inFlight,
      downloads: pulls.active,
      idle_seconds: activity.idleSeconds,
      user_active: power.userActive,
      last_input_seconds_ago: power.lastInputSecondsAgo,
      user_active_updated_at: power.userActiveAt,
      safe_to_shutdown: power.safeToShutdown,
      shutting_down: power.shuttingDown,
      tray_configured: power.trayConfigured,
      system,
    };
  });

  // ─── models ────────────────────────────────────────────────────────────────

  app.get('/node/models', async () => {
    await runtime.ensureRunning();
    const [models, now] = await Promise.all([runtime.listModels(), loaded()]);
    return { object: 'list', data: models.map(m => toNodeModel(m, now)) };
  });

  app.post('/node/models/load', async req => {
    const b = body(req);
    const name = modelName(b['name']);
    const keep = b['keep_alive'];
    if (keep !== undefined && !(typeof keep === 'string' || typeof keep === 'number')) throw new AgentError(400, 'invalid_request', '"keep_alive" is a duration like "10m", or -1 for "until unloaded"');
    await runtime.ensureRunning();
    await runtime.load(name, keep === undefined ? undefined : String(keep));
    return { ok: true, name };
  });

  app.post('/node/models/unload', async req => {
    const name = modelName(body(req)['name']);
    await runtime.ensureRunning();
    await runtime.unload(name);
    return { ok: true, name };
  });

  app.delete('/node/models/*', async req => {
    const name = modelName((req.params as Record<string, string>)['*']);
    await runtime.ensureRunning();
    await runtime.remove(name);
    return { ok: true, name };
  });

  // ─── downloads ─────────────────────────────────────────────────────────────

  app.get('/node/pulls', async () => ({ object: 'list', data: pulls.list() }));

  app.post('/node/pulls', async (req, reply) => {
    const job = pulls.start(modelName(body(req)['name']));
    return reply.code(202).send(job);
  });

  app.get('/node/pulls/:id', async req => {
    const job = pulls.get((req.params as { id: string }).id);
    if (!job) throw new AgentError(404, 'pull_not_found', 'There is no such download');
    return job;
  });

  app.delete('/node/pulls/:id', async req => pulls.cancel((req.params as { id: string }).id));

  // ─── power and the person at the keyboard ──────────────────────────────────

  app.post('/node/power/shutdown-request', async req => {
    const idle = Number(body(req)['idle_minutes']);
    return power.shutdown({ idleMinutes: Number.isFinite(idle) && idle > 0 ? idle : 0 });
  });

  app.post('/node/power/shutdown', async req => power.shutdown({ force: body(req)['force'] === true }));

  app.post('/node/user-active', async req => {
    const b = body(req);
    if (typeof b['active'] !== 'boolean') throw new AgentError(400, 'invalid_request', '"active" must be true or false');
    power.setUserActive(b['active'], Number(b['last_input_seconds_ago']));
    return { ok: true };
  });

  /** The tray's "quit" asks the agent to go too. */
  app.post('/node/exit', async (_req, reply) => {
    setTimeout(d.onExit, 500).unref();
    return reply.send({ ok: true });
  });
}

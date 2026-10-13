import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import { Activity } from './activity.js';
import type { AgentConfig } from './config.js';
import { isAgentError } from './errors.js';
import { OllamaRuntime } from './ollama.js';
import { Power, type PowerOptions } from './power.js';
import { registerProxy } from './proxy.js';
import { PullManager } from './pulls.js';
import { registerNodeRoutes } from './routes-node.js';
import type { Runtime } from './runtime.js';

export interface AgentDeps {
  logger?: FastifyBaseLogger;
  /** Replace the runtime (tests do; later another engine would be chosen here). */
  runtime?: Runtime;
  exec?: PowerOptions['exec'];
  fetch?: typeof fetch;
  onExit?: () => void;
}

export interface Agent {
  app: FastifyInstance;
  runtime: Runtime;
  activity: Activity;
  pulls: PullManager;
  power: Power;
  close(): Promise<void>;
}

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

/** The secret may come as `Authorization: Bearer …` or, as the first MindGate agent expected it, `X-MindGate-Secret`. */
export function presentedSecret(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = headers['authorization'];
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1]!.trim();
  }
  const legacy = headers['x-mindgate-secret'];
  return typeof legacy === 'string' ? legacy.trim() : null;
}

/** Builds the agent around its configuration. Nothing is listening and no runtime is started until the caller says so. */
export async function buildAgent(config: AgentConfig, deps: AgentDeps = {}): Promise<Agent> {
  const log = deps.logger;
  const app = Fastify({
    ...(log ? { loggerInstance: log } : { logger: false }),
    bodyLimit: 1024 * 1024, // control calls are tiny; /v1 has its own, larger limit
    logController: new LogController({ disableRequestLogging: true }), // the tray and the hub poll; one line per poll is noise
    genReqId: () => `req_${randomBytes(6).toString('hex')}`,
  });

  const expected = digest(config.secret);
  app.addHook('onRequest', async (req, reply) => {
    const given = presentedSecret(req.headers);
    if (given === null || !timingSafeEqual(digest(given), expected)) {
      req.log.warn({ ip: req.ip, path: req.url.split('?')[0] }, 'refused a request without the right node secret');
      return reply.code(401).send({ error: { message: 'Unauthorized: send the node secret as "Authorization: Bearer <secret>"', type: 'authentication_error', code: 'invalid_node_secret' } });
    }
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: { message: `Unknown endpoint: ${req.method} ${req.url.split('?')[0]}`, type: 'invalid_request_error', code: 'unknown_endpoint' } });
  });

  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (isAgentError(err)) return reply.code(err.status).send(err.payload());
    const status = 'statusCode' in err && typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) {
      req.log.error({ err: err.stack ?? err.message }, 'unhandled error');
      return reply.code(500).send({ error: { message: 'Internal error in the agent (see its log)', type: 'server_error', code: 'internal_error' } });
    }
    return reply.code(status).send({ error: { message: status === 413 ? 'The request body is too large' : err.message, type: 'invalid_request_error', code: status === 413 ? 'request_too_large' : 'invalid_request' } });
  });

  const runtime =
    deps.runtime ??
    new OllamaRuntime({
      url: config.ollama.url,
      binaryPath: config.ollama.path,
      manage: config.ollama.manage,
      startTimeoutMs: config.ollama.startTimeoutMs,
      log: log ? { info: (o, m) => log.info(o, m), warn: (o, m) => log.warn(o, m), debug: (o, m) => log.debug(o, m) } : undefined,
    });
  const activity = new Activity();
  const pulls = new PullManager(runtime, activity, log ? { info: (o, m) => log.info(o, m), warn: (o, m) => log.warn(o, m) } : undefined);
  const power = new Power(
    { trayUrl: config.trayUrl, delaySeconds: config.shutdownDelaySeconds, ...(deps.exec ? { exec: deps.exec } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(log ? { log: { info: (o: object, m?: string) => log.info(o, m), warn: (o: object, m?: string) => log.warn(o, m) } } : {}) },
    activity,
    pulls,
  );

  registerNodeRoutes(app, { config, runtime, activity, pulls, power, startedAt: Date.now(), onExit: deps.onExit ?? (() => undefined) });
  registerProxy(app, runtime, activity, config);
  await app.ready();

  return {
    app,
    runtime,
    activity,
    pulls,
    power,
    async close() {
      pulls.abortAll();
      await app.close();
      await runtime.stop();
    },
  };
}

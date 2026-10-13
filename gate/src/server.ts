import { randomBytes } from 'node:crypto';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import { AuthThrottle } from './auth.js';
import type { Hub } from './context.js';
import { HubError, isHubError } from './errors.js';
import { registerAdmin } from './routes-admin.js';
import { registerV1 } from './routes-v1.js';

const REQUEST_ID = /^[\w.:-]{6,64}$/;

/** Builds the HTTP server around a wired Hub. Nothing is listening until the caller says so. */
export async function buildServer(hub: Hub, opts: { logger?: FastifyBaseLogger } = {}): Promise<FastifyInstance> {
  const throttle = new AuthThrottle();
  const app = Fastify({
    ...(opts.logger ? { loggerInstance: opts.logger } : { logger: false }),
    bodyLimit: hub.config.bodyLimitBytes,
    trustProxy: hub.config.trustProxy,
    // use the caller's X-Request-Id when it is sane, so a request can be followed across systems
    genReqId: req => {
      const given = req.headers['x-request-id'];
      return typeof given === 'string' && REQUEST_ID.test(given) ? given : `req_${randomBytes(8).toString('hex')}`;
    },
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Request-Id', req.id);
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: { message: `Unknown endpoint: ${req.method} ${req.url.split('?')[0]}`, type: 'invalid_request_error', code: 'unknown_endpoint' } });
  });

  app.setErrorHandler((err: FastifyError | HubError, req, reply) => {
    if (isHubError(err)) {
      return reply.code(err.status).headers(err.headers).send(err.payload());
    }
    const status = typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) {
      hub.log.error({ requestId: req.id, err: err.stack ?? err.message }, 'unhandled error');
      return reply.code(500).send({ error: { message: 'Internal error in the hub (see its log)', type: 'server_error', code: 'internal_error' } });
    }
    const code = status === 413 ? 'request_too_large' : err.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || err.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ? 'invalid_json' : 'invalid_request';
    return reply.code(status).send({ error: { message: status === 413 ? 'The request body is too large' : err.message, type: 'invalid_request_error', code } });
  });

  registerV1(app, hub, throttle);
  registerAdmin(app, hub, throttle);
  await app.ready();
  return app;
}

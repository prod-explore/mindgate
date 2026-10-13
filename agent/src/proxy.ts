import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { Agent as UndiciAgent, fetch } from 'undici';
import type { Activity } from './activity.js';
import type { AgentConfig } from './config.js';
import { AgentError, isAgentError } from './errors.js';
import { toOpenAiEntry } from './models.js';
import type { Runtime } from './runtime.js';

// The runtime may think for minutes before the first byte (a big model loading from disk); the hub owns the deadlines.
const dispatcher = new UndiciAgent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 5000 }, keepAliveTimeout: 30_000 });

const FORWARD_REQUEST = ['content-type', 'accept'];
const FORWARD_RESPONSE = ['content-type', 'cache-control'];

function sendError(reply: FastifyReply, e: unknown): FastifyReply {
  const err = isAgentError(e) ? e : new AgentError(502, 'runtime_error', e instanceof Error ? e.message : String(e));
  return reply.code(err.status).send(err.payload());
}

/**
 * `/v1/*`: the runtime's OpenAI-compatible API, behind the node's secret. Nothing is translated — the hub speaks to a
 * model on this machine exactly as it speaks to any OpenAI-compatible provider — except `GET /v1/models`, which the agent
 * answers itself because it knows more than the runtime says (what a model can do, its real context, tags).
 */
export function registerProxy(app: FastifyInstance, runtime: Runtime, activity: Activity, config: AgentConfig): void {
  void app.register(async scope => {
    // the body goes to the runtime as it came: no parsing, no re-serialising
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: config.bodyLimitBytes }, (_req, body, done) => done(null, body));

    scope.get('/v1/models', async (_req, reply) => {
      try {
        await runtime.ensureRunning();
        const models = await runtime.listModels();
        return reply.send({ object: 'list', data: models.map(m => toOpenAiEntry(m, config.ollama.contextCap, runtime.name)) });
      } catch (e) {
        return sendError(reply, e);
      }
    });

    scope.route({
      method: ['GET', 'POST'],
      url: '/v1/*',
      handler: async (req, reply) => {
        const abort = new AbortController();
        const end = activity.begin();
        // The client (the hub) went away: stop the runtime from generating for nobody.
        reply.raw.once('close', () => {
          if (!reply.raw.writableFinished) abort.abort();
          end();
        });

        try {
          await runtime.ensureRunning();
        } catch (e) {
          return sendError(reply, e);
        }

        const headers: Record<string, string> = {};
        for (const h of FORWARD_REQUEST) if (typeof req.headers[h] === 'string') headers[h] = req.headers[h];
        const target = runtime.openaiBase + req.url.slice('/v1'.length);

        let upstream;
        try {
          upstream = await fetch(target, { method: req.method as 'GET' | 'POST', headers, body: req.method === 'POST' ? ((req.body as Buffer | undefined) ?? null) : null, dispatcher, signal: abort.signal });
        } catch (e) {
          if (abort.signal.aborted) return reply; // nobody is listening any more
          const why = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
          return sendError(reply, new AgentError(503, 'runtime_unavailable', `The model runtime does not answer: ${why}`));
        }

        reply.code(upstream.status);
        for (const h of FORWARD_RESPONSE) {
          const v = upstream.headers.get(h);
          if (v) reply.header(h, v);
        }
        if (!upstream.body) return reply.send();
        return reply.send(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream));
      },
    });
  });
}

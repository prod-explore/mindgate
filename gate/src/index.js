import Fastify from 'fastify'
import { config } from './config.js'
import { authenticate } from './auth.js'
import { resolveModel, getModelList } from './router.js'
import { enqueue, getQueueLength, isQueuePaused, resumeQueue } from './queue.js'
import { ensureAwake, getAgentStatus, startHealthChecks, onAgentOnline } from './wol.js'
import { startShutdownWatcher } from './shutdown.js'

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined
  }
})

/**
 * POST /v1/chat/completions — główny endpoint OpenAI-compatible
 */
app.post('/v1/chat/completions', async (req, reply) => {
  // 1. Autentykacja
  const apiKey = authenticate(req, reply)
  if (!apiKey) return // reply already sent

  // 2. Rozpoznaj model
  const model = resolveModel(req, reply)
  if (!model) return

  // 3. Wyznacz priorytet (z zakresu dozwolonego dla klucza)
  const keyMin = apiKey.min_priority ?? 1
  const keyMax = apiKey.max_priority ?? 5

  let priority = apiKey.default_priority
  if (req.headers['x-mindgate-priority']) {
    const requested = parseInt(req.headers['x-mindgate-priority'], 10)
    if (isNaN(requested) || requested < 1 || requested > 5) {
      return reply.code(400).send({
        error: {
          message: 'Priorytet musi być liczbą 1-5',
          type: 'invalid_request_error',
          code: 'invalid_priority'
        }
      })
    }
    // Ogranicz do dozwolonego zakresu klucza
    priority = Math.max(keyMin, Math.min(keyMax, requested))
  }

  // 4. Upewnij się że agent jest dostępny (WoL jeśli potrzeba)
  const awake = await ensureAwake(priority, req, reply)
  if (!awake) return

  // 5. Wstaw do kolejki i czekaj na odpowiedź
  try {
    const response = await enqueue({ req, reply, model, priority })
    // Jeśli non-streaming, response jest obiektem JSON
    if (response) {
      return reply.send(response)
    }
    // Jeśli streaming, reply jest już wysłany przez proxy
  } catch (err) {
    if (err.message === 'queue_timeout') {
      return reply.code(504).send({
        error: {
          message: 'Żądanie przekroczyło limit czasu w kolejce',
          type: 'server_error',
          code: 'queue_timeout'
        }
      })
    }
    if (err.statusCode) {
      return reply.code(err.statusCode).send({
        error: {
          message: err.body || err.message,
          type: 'server_error',
          code: 'agent_error'
        }
      })
    }
    req.log.error({ err }, 'Nieoczekiwany błąd')
    return reply.code(500).send({
      error: {
        message: 'Wewnętrzny błąd serwera',
        type: 'server_error',
        code: 'internal_error'
      }
    })
  }
})

/**
 * GET /v1/models — lista dostępnych modeli (OpenAI-compatible)
 */
app.get('/v1/models', async (req, reply) => {
  const apiKey = authenticate(req, reply)
  if (!apiKey) return

  return reply.send(getModelList())
})

/**
 * GET /health — status Gate
 */
app.get('/health', async () => ({
  status: 'ok',
  agent: getAgentStatus(),
  queue_length: getQueueLength(),
  queue_paused: isQueuePaused(),
  uptime: Math.floor(process.uptime())
}))

// --- Uruchomienie ---

try {
  await app.listen({
    port: config.server.port,
    host: config.server.host
  })

  // Startuj background tasks
  startHealthChecks()
  startShutdownWatcher()

  // Gdy agent wraca online po awarii (np. utrata zasilania) — wznów kolejkę
  onAgentOnline(resumeQueue)

  app.log.info({
    port: config.server.port,
    agent: config.agent.url,
    keys: config.auth.keys.length
  }, '🚀 MindGate Gate uruchomiony')
} catch (err) {
  app.log.fatal(err, 'Nie udało się uruchomić Gate')
  process.exit(1)
}

// Graceful shutdown
const shutdown = async (signal) => {
  app.log.info({ signal }, 'Zamykanie Gate...')
  await app.close()
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

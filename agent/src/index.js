import express from 'express'
import { config } from './config.js'
import { resolveModel, getAvailableProfiles } from './router.js'
import { chatCompletion, chatCompletionStream, createOpenAIStreamTransformer, checkOllamaHealth, getLoadedModels } from './ollama.js'
import { executePipeline } from './pipeline.js'
import { enqueue, getQueueLength, isIdle } from './queue.js'
import { handleShutdownRequest, getStatus, setUserActive } from './shutdown.js'
import { startMcpServers, stopMcpServers, getToolsForModel, getActiveServers } from './mcp.js'
import { startOllama, stopOllama, isOllamaReady, isManaged } from './ollama-process.js'
import { Readable } from 'stream'
import pino from 'pino'
import pinoHttp from 'pino-http'

const log = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined
})

const app = express()
app.use(express.json({ limit: '10mb' }))
app.use(pinoHttp({ logger: log }))

// Middleware sprawdzający współdzielony sekret
app.use((req, res, next) => {
  if (req.headers['x-mindgate-secret'] !== config.server.secret) {
    log.warn({ ip: req.ip, path: req.path }, 'Odrzucono żądanie — niepoprawny X-MindGate-Secret')
    return res.status(401).json({ error: { message: 'Unauthorized', type: 'authentication_error' } })
  }
  next()
})

/**
 * POST /v1/chat/completions — OpenAI-compatible endpoint
 */
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const modelName = req.body.model
    if (!modelName) {
      return res.status(400).json({
        error: { message: 'Brak pola "model"', type: 'invalid_request_error' }
      })
    }

    const resolved = resolveModel(modelName)
    if (resolved.error) {
      return res.status(400).json({
        error: { message: resolved.error, type: 'invalid_request_error' }
      })
    }

    const isStream = req.body.stream === true
    const messages = req.body.messages || []
    const options = {
      temperature: req.body.temperature,
      top_p: req.body.top_p,
      tools: req.body.tools || []
    }

    // Pipeline mode
    if (resolved.isPipeline) {
      const result = await enqueue(async () => {
        return executePipeline(resolved.pipelineSteps, messages, options)
      })
      return res.json(result)
    }

    // Single model mode
    const mcpTools = getToolsForModel(resolved.profile)
    if (mcpTools.length) {
      options.tools = [...options.tools, ...mcpTools]
    }

    if (isStream) {
      // Streaming
      await enqueue(async () => {
        const ollamaStream = await chatCompletionStream(
          resolved.ollamaModel, messages, { ...options, max_tokens: resolved.maxTokens }
        )

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        })

        const transformer = createOpenAIStreamTransformer(modelName)
        const transformedStream = ollamaStream.pipeThrough(transformer)
        const reader = transformedStream.getReader()

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            res.write(value)
          }
        } finally {
          res.end()
        }
      })
    } else {
      // Non-streaming
      const result = await enqueue(async () => {
        return chatCompletion(
          resolved.ollamaModel, messages, { ...options, max_tokens: resolved.maxTokens }
        )
      })
      res.json(result)
    }
  } catch (err) {
    log.error({ err }, 'Błąd przetwarzania żądania')
    if (!res.headersSent) {
      res.status(500).json({
        error: { message: err.message, type: 'server_error' }
      })
    }
  }
})

/**
 * GET /health — status agenta
 */
app.get('/health', async (req, res) => {
  const ollamaOk = await checkOllamaHealth()
  const models = await getLoadedModels()

  res.json({
    status: ollamaOk ? 'ok' : 'degraded',
    models_loaded: getAvailableProfiles(),
    ollama_models: models,
    queue_length: getQueueLength(),
    ollama: ollamaOk ? 'ok' : 'unreachable',
    ollama_managed: isManaged(),
    mcp_servers: getActiveServers(),
    uptime: Math.floor(process.uptime())
  })
})

/**
 * POST /internal/shutdown-request — od Gate
 */
app.post('/internal/shutdown-request', async (req, res) => {
  const result = await handleShutdownRequest(req.body?.idle_minutes || 0)
  res.json(result)
})

/**
 * GET /internal/status — status dla Gate
 */
app.get('/internal/status', (req, res) => {
  res.json(getStatus())
})

/**
 * POST /internal/set-user-active — od tray app
 */
app.post('/internal/set-user-active', (req, res) => {
  const { active, last_input_seconds_ago } = req.body || {}
  setUserActive(active, last_input_seconds_ago)
  res.json({ ok: true })
})

// --- Uruchomienie ---

const PORT = config.server.port
const HOST = config.server.host

// --- Najpierw startujemy Ollamę, potem resztę ---

async function boot() {
  log.info('Uruchamiam Ollamę...')
  const ollamaStarted = await startOllama()
  if (!ollamaStarted) {
    log.error('Nie udało się uruchomić Ollamy — kontynuuję, ale żądania mogą nie działać')
  }

  const server = app.listen(PORT, HOST, async () => {
    log.info({ port: PORT, host: HOST }, '🚀 MindGate Agent uruchomiony')

    const ollamaOk = await checkOllamaHealth()
    if (ollamaOk) {
      const models = await getLoadedModels()
      log.info({ models }, 'Ollama dostępna')
    } else {
      log.warn('Ollama niedostępna — żądania będą czekać')
    }

    // Startuj MCP servers
    await startMcpServers()
  })

  // Graceful shutdown
  const shutdown = (signal) => {
    log.info({ signal }, 'Zamykanie Agent...')
    stopMcpServers()
    stopOllama()
    server.close(() => {
      log.info('Agent zamknięty')
      process.exit(0)
    })
    // Wymuś zamknięcie po 10 sekundach
    setTimeout(() => process.exit(1), 10000)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

boot()


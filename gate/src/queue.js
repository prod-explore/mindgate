import { config } from './config.js'
import { proxyToAgent, proxyStreamToAgent } from './proxy.js'

/**
 * Kolejka priorytetowa — sortuje żądania 5→1, FIFO w ramach priorytetu.
 * Jeden request na raz (serializacja przez Ollama).
 *
 * Przy nagłej utracie połączenia z agentem (np. odcięcie zasilania):
 * - Aktualnie przetwarzane żądanie dostaje błąd 502 (agent_connection_lost)
 * - Kolejne żądania w kolejce NIE są natychmiast odrzucane — zamiast tego
 *   queue pauzuje przetwarzanie i czeka na powrót agenta
 * - Health check wykryje offline i może ponownie wysłać WoL
 */

/** @typedef {{ req: object, model: string, priority: number, resolve: Function, reject: Function, timer: NodeJS.Timeout|null }} QueueItem */

/** @type {QueueItem[]} */
const queue = []
let processing = false
let lastRequestTime = Date.now()
let paused = false  // Czy przetwarzanie jest wstrzymane (agent padł)

/**
 * Wstawia żądanie do kolejki i zwraca Promise z odpowiedzią.
 */
export function enqueue({ req, reply, model, priority }) {
  lastRequestTime = Date.now()

  if (queue.length >= config.queue.max_size) {
    return reply.code(503).send({
      error: {
        message: `Kolejka pełna (${config.queue.max_size}). Spróbuj później.`,
        type: 'server_error',
        code: 'queue_full'
      }
    })
  }

  return new Promise((resolve, reject) => {
    const item = { req, reply, model, priority, resolve, reject, timer: null }

    // Timeout — max czas w kolejce (0 = bez limitu)
    if (config.queue.request_timeout_ms > 0) {
      item.timer = setTimeout(() => {
        const idx = queue.indexOf(item)
        if (idx !== -1) {
          queue.splice(idx, 1)
          reject(new Error('queue_timeout'))
        }
      }, config.queue.request_timeout_ms)
    }

    // Wstaw w odpowiednie miejsce (posortowane malejąco po priorytecie)
    let inserted = false
    for (let i = 0; i < queue.length; i++) {
      if (priority > queue[i].priority) {
        queue.splice(i, 0, item)
        inserted = true
        break
      }
    }
    if (!inserted) {
      queue.push(item)
    }

    req.log.info({
      model,
      priority,
      queuePosition: queue.indexOf(item) + 1,
      queueLength: queue.length
    }, 'Żądanie w kolejce')

    processNext()
  })
}

/**
 * Przetwarza następne żądanie z kolejki (jeśli nie ma aktywnego).
 * Przy utracie połączenia — pauzuje kolejkę i czeka na powrót agenta.
 */
async function processNext() {
  if (processing || queue.length === 0 || paused) return

  processing = true
  const item = queue.shift()
  clearTimeout(item.timer)

  try {
    item.req.log.info({ model: item.model, priority: item.priority }, 'Przetwarzanie żądania')

    const isStream = item.req.body?.stream === true

    if (isStream) {
      await proxyStreamToAgent(item.req, item.reply, item.model)
      item.resolve()
    } else {
      const response = await proxyToAgent(item.req, item.model)
      item.resolve(response)
    }
  } catch (err) {
    item.req.log.error({ err }, 'Błąd przetwarzania żądania')
    item.reject(err)

    // Jeśli to utrata połączenia — pauzuj kolejkę, nie próbuj kolejnego żądania
    if (err.isConnectionLost) {
      item.req.log.warn('Agent stracił połączenie — pauzuję kolejkę, czekam na powtórne uruchomienie')
      paused = true
      processing = false
      // Health check (co 30s) wykryje powrót agenta i wywoła resumeQueue
      return
    }
  } finally {
    processing = false
  }

  // Sprawdź kolejne żądanie (async, żeby nie blokować)
  setImmediate(processNext)
}

/**
 * Wznawia przetwarzanie kolejki (wywoływane gdy agent wraca online).
 */
export function resumeQueue() {
  if (!paused) return
  paused = false
  console.log('[queue] Wznawiam przetwarzanie kolejki — agent jest z powrotem online')
  setImmediate(processNext)
}

/**
 * Zwraca czy kolejka jest wstrzymana.
 */
export function isQueuePaused() {
  return paused
}

/**
 * Zwraca aktualną długość kolejki.
 */
export function getQueueLength() {
  return queue.length
}

/**
 * Zwraca czas ostatniego żądania (dla shutdown watchera).
 */
export function getLastRequestTime() {
  return lastRequestTime
}

/**
 * Resetuje timer ostatniego żądania (wywoływane przy nowym żądaniu).
 */
export function touchLastRequest() {
  lastRequestTime = Date.now()
}

import { config } from './config.js'
import { proxyToAgent, proxyStreamToAgent } from './proxy.js'

/**
 * Kolejka priorytetowa — sortuje żądania 5→1, FIFO w ramach priorytetu.
 * Jeden request na raz (serializacja przez Ollama).
 */

/** @typedef {{ req: object, model: string, priority: number, resolve: Function, reject: Function, timer: NodeJS.Timeout|null }} QueueItem */

/** @type {QueueItem[]} */
const queue = []
let processing = false
let lastRequestTime = Date.now()

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

    // Timeout — max czas w kolejce
    item.timer = setTimeout(() => {
      const idx = queue.indexOf(item)
      if (idx !== -1) {
        queue.splice(idx, 1)
        reject(new Error('queue_timeout'))
      }
    }, config.queue.request_timeout_ms)

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
 */
async function processNext() {
  if (processing || queue.length === 0) return

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
  } finally {
    processing = false
    // Sprawdź kolejne żądanie (async, żeby nie blokować)
    setImmediate(processNext)
  }
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

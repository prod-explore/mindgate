import { config } from './config.js'
import { getLastRequestTime } from './queue.js'
import pino from 'pino'

const log = pino({ name: 'shutdown' })

let shutdownTimer = null

/**
 * Wysyła sygnał shutdown do agenta.
 */
async function sendShutdownSignal() {
  const idleMs = Date.now() - getLastRequestTime()
  const idleMinutes = Math.floor(idleMs / 60000)

  log.info({ idleMinutes }, 'Wysyłam sygnał shutdown do agenta')

  try {
    const res = await fetch(`${config.agent.url}/internal/shutdown-request`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-MindGate-Secret': config.agent.secret
      },
      body: JSON.stringify({ idle_minutes: idleMinutes }),
      signal: AbortSignal.timeout(10000)
    })

    if (res.ok) {
      const data = await res.json()
      log.info({ response: data }, 'Agent odpowiedział na shutdown request')
    } else {
      log.warn({ status: res.status }, 'Agent odrzucił shutdown request')
    }
  } catch (err) {
    log.error({ err: err.message }, 'Nie udało się wysłać shutdown request')
  }
}

import { getAgentStatus } from './wol.js'

/**
 * Sprawdza czy minął idle_minutes od ostatniego żądania.
 */
function checkIdle() {
  const idleMs = Date.now() - getLastRequestTime()
  const thresholdMs = config.shutdown.idle_minutes * 60 * 1000

  // Wysyłaj sygnał tylko jeśli minął czas i agent jest faktycznie online
  if (idleMs >= thresholdMs && getAgentStatus() === 'online') {
    sendShutdownSignal()
  }
}

/**
 * Startuje idle watcher — sprawdza co minutę.
 */
export function startShutdownWatcher() {
  log.info({ idle_minutes: config.shutdown.idle_minutes }, 'Shutdown watcher uruchomiony')

  // Sprawdzaj co minutę
  shutdownTimer = setInterval(checkIdle, 60000)
}

/**
 * Zatrzymuje idle watcher.
 */
export function stopShutdownWatcher() {
  if (shutdownTimer) {
    clearInterval(shutdownTimer)
    shutdownTimer = null
    log.info('Shutdown watcher zatrzymany')
  }
}

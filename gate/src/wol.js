import { config } from './config.js'
import wol from 'wake_on_lan'

/**
 * Wake on LAN — budzi maszynę obliczeniową gdy potrzeba.
 */

let agentStatus = 'unknown' // 'online' | 'offline' | 'unknown'
let lastHealthCheck = 0
let _onAgentOnlineCallback = null

/**
 * Rejestruje callback wywoływany gdy agent wraca online po awarii.
 * Używane przez queue.js do wznowienia przetwarzania.
 */
export function onAgentOnline(callback) {
  _onAgentOnlineCallback = callback
}

/**
 * Sprawdza czy agent żyje (GET /health).
 */
export async function checkAgentHealth() {
  const previousStatus = agentStatus
  try {
    const res = await fetch(`${config.agent.url}/health`, {
      headers: { 'X-MindGate-Secret': config.agent.secret },
      signal: AbortSignal.timeout(5000)
    })
    if (res.ok) {
      agentStatus = 'online'

      // Agent wrócił po awarii — powiadom zainteresowanych (queue)
      if (previousStatus !== 'online' && _onAgentOnlineCallback) {
        _onAgentOnlineCallback()
      }
      return true
    }
    agentStatus = 'offline'
    return false
  } catch {
    agentStatus = 'offline'
    return false
  } finally {
    lastHealthCheck = Date.now()
  }
}

/**
 * Wysyła WoL magic packet.
 */
function sendMagicPacket() {
  return new Promise((resolve, reject) => {
    wol.wake(config.wol.mac, {
      address: config.wol.broadcast,
      port: config.wol.port
    }, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

/**
 * Czeka na pojawienie się agenta (polling).
 */
async function waitForAgent(logger) {
  const start = Date.now()
  const timeout = config.wol.boot_timeout_ms
  const interval = config.wol.poll_interval_ms

  while (Date.now() - start < timeout) {
    await new Promise(r => setTimeout(r, interval))
    const alive = await checkAgentHealth()
    if (alive) {
      logger.info('Agent jest online po WoL')
      return true
    }
    logger.debug({ elapsed: Date.now() - start }, 'Czekam na agenta...')
  }

  logger.error({ timeout }, 'Agent nie odpowiedział po WoL')
  return false
}

/**
 * Upewnia się że agent jest dostępny.
 * Jeśli priorytet >= min_priority i agent jest offline → wysyła WoL i czeka.
 */
export async function ensureAwake(priority, req, reply) {
  // Sprawdź aktualny status (jeśli nie sprawdzaliśmy ostatnio)
  if (Date.now() - lastHealthCheck > 10000) {
    await checkAgentHealth()
  }

  if (agentStatus === 'online') {
    return true
  }

  // Agent jest offline
  if (priority < config.wol.min_priority) {
    // Priorytet za niski żeby budzić — żądanie będzie czekać w kolejce
    req.log.info({ priority, min: config.wol.min_priority }, 'Priorytet za niski na WoL, czekam w kolejce')
    return true // pozwól wejść do kolejki, processNext() spróbuje
  }

  // Budzimy komputer
  req.log.info({ mac: config.wol.mac, priority }, 'Wysyłam WoL magic packet')

  try {
    await sendMagicPacket()
  } catch (err) {
    req.log.error({ err }, 'Błąd wysyłania WoL')
    reply.code(503).send({
      error: {
        message: 'Nie udało się wysłać WoL magic packet',
        type: 'server_error',
        code: 'wol_failed'
      }
    })
    return false
  }

  // Czekaj na agenta
  const alive = await waitForAgent(req.log)
  if (!alive) {
    reply.code(503).send({
      error: {
        message: 'Maszyna obliczeniowa nie odpowiada po Wake on LAN',
        type: 'server_error',
        code: 'agent_unreachable'
      }
    })
    return false
  }

  return true
}

/**
 * Zwraca aktualny status agenta.
 */
export function getAgentStatus() {
  return agentStatus
}

/**
 * Startuje periodyczny health check (co 30 sekund).
 */
export function startHealthChecks() {
  checkAgentHealth()
  setInterval(checkAgentHealth, 30000)
}

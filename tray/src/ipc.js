import express from 'express'
import { config } from './config.js'
import { getIdleSeconds } from './idle.js'
import { isWhitelistProcessRunning } from './processes.js'
import pino from 'pino'

const log = pino({ name: 'ipc' })

/**
 * IPC Server — mini serwer HTTP na localhost.
 * Obsługuje komunikację z agentem.
 */

// Stan tray'a
let userToggleActive = false // "Używam PC — NIE wyłączaj"

/**
 * Startuje IPC server na skonfigurowanym porcie.
 */
export function startIpcServer() {
  const app = express()
  app.use(express.json())

  /**
   * POST /shutdown-check — agent pyta czy można wyłączyć
   */
  app.post('/shutdown-check', (req, res) => {
    const decision = evaluateShutdown(req.body?.idle_minutes)
    log.info(decision, 'Shutdown check')
    res.json(decision)
  })

  /**
   * GET /status — aktualny stan tray'a
   */
  app.get('/status', (req, res) => {
    const idle = getIdleSeconds()
    res.json({
      user_toggle_active: userToggleActive,
      idle_seconds: idle,
      whitelist_active: isWhitelistProcessRunning(config.shutdown_guard.whitelist_processes)
    })
  })

  app.listen(config.ipc.port, '127.0.0.1', () => {
    log.info({ port: config.ipc.port }, 'IPC server uruchomiony')
  })
}

/**
 * Ocenia czy shutdown jest dozwolony.
 * Sprawdza wszystkie warunki shutdown guard.
 */
function evaluateShutdown(idleMinutes) {
  // 1. Toggle "Używam PC"
  if (userToggleActive) {
    return { allow: false, reason: 'user_toggle_active' }
  }

  // 2. Idle threshold
  const idleSeconds = getIdleSeconds()
  if (idleSeconds < config.shutdown_guard.idle_threshold_seconds) {
    return { allow: false, reason: 'user_recently_active', idle_seconds: idleSeconds }
  }

  // 3. Whitelist procesów
  if (isWhitelistProcessRunning(config.shutdown_guard.whitelist_processes)) {
    return { allow: false, reason: 'whitelist_process_running' }
  }

  // Wszystkie warunki spełnione — można wyłączyć
  return { allow: true, reason: 'all_checks_passed' }
}

/**
 * Ustawia toggle "Używam PC".
 */
export function setUserToggle(active) {
  userToggleActive = active
  log.info({ active }, 'Toggle "Używam PC" zmieniony')

  // Poinformuj agenta
  reportToAgent()
}

/**
 * Zwraca stan toggle.
 */
export function getUserToggle() {
  return userToggleActive
}

/**
 * Raportuje status do agenta.
 */
async function reportToAgent() {
  try {
    await fetch(`${config.agent.url}/internal/set-user-active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        active: userToggleActive,
        last_input_seconds_ago: getIdleSeconds()
      }),
      signal: AbortSignal.timeout(3000)
    })
  } catch {
    // Agent może być niedostępny — ignoruj
  }
}

/**
 * Startuje periodyczny raport do agenta.
 */
export function startAgentReporting() {
  setInterval(reportToAgent, config.agent.poll_interval_ms)
}

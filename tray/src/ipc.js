import express from 'express'
import { config } from './config.js'
import { getIdleSeconds } from './idle.js'
import pino from 'pino'

const log = pino({ name: 'ipc' })

/**
 * IPC server — a small HTTP server on localhost.
 * Handles the conversation with the agent.
 */

// Tray state
let userToggleActive = false // "I'm using this PC — don't shut it down"

/**
 * Starts the IPC server on the configured port.
 */
export function startIpcServer() {
  const app = express()
  app.use(express.json())

  /**
   * POST /shutdown-check — the agent asks whether the machine may be shut down
   */
  app.post('/shutdown-check', (req, res) => {
    const decision = evaluateShutdown(req.body?.idle_minutes)
    log.info(decision, 'Shutdown check')
    res.json(decision)
  })

  /**
   * GET /status — the tray's current state
   */
  app.get('/status', (req, res) => {
    const idle = getIdleSeconds()
    res.json({
      user_toggle_active: userToggleActive,
      idle_seconds: idle
    })
  })

  app.listen(config.ipc.port, '127.0.0.1', () => {
    log.info({ port: config.ipc.port }, 'IPC server started')
  })
}

/**
 * Decides whether a shutdown is allowed.
 * Checks every condition of the shutdown guard.
 */
function evaluateShutdown(idleMinutes) {
  // 1. The "I'm using this PC" toggle
  if (userToggleActive) {
    return { allow: false, reason: 'user_toggle_active' }
  }

  // 2. Idle threshold
  const idleSeconds = getIdleSeconds()
  if (idleSeconds < config.shutdown_guard.idle_threshold_seconds) {
    return { allow: false, reason: 'user_recently_active', idle_seconds: idleSeconds }
  }

  // All conditions met — shutting down is fine
  return { allow: true, reason: 'all_checks_passed' }
}

/**
 * Sets the "I'm using this PC" toggle.
 */
export function setUserToggle(active) {
  userToggleActive = active
  log.info({ active }, '"In use" toggle changed')

  // Tell the agent
  reportToAgent()
}

/**
 * Returns the toggle state.
 */
export function getUserToggle() {
  return userToggleActive
}

/**
 * Reports the status to the agent.
 */
async function reportToAgent() {
  try {
    await fetch(`${config.agent.url}/node/user-active`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.agent.secret}`
      },
      body: JSON.stringify({
        active: userToggleActive,
        last_input_seconds_ago: getIdleSeconds()
      }),
      signal: AbortSignal.timeout(3000)
    })
  } catch {
    // The agent may be unreachable — ignore
  }
}

/**
 * Checks for user activity and switches the "I'm using this PC" toggle on by itself
 * when it sees mouse or keyboard input.
 * The toggle stays on until it is switched off by hand in the tray menu.
 */
export function checkUserActivity() {
  if (userToggleActive) return false // already on — nothing to do

  const idleSeconds = getIdleSeconds()
  if (idleSeconds < config.shutdown_guard.idle_threshold_seconds) {
    userToggleActive = true
    log.info({ idle_seconds: idleSeconds }, 'User activity detected — switching the "in use" toggle on')
    reportToAgent()
    return true
  }
  return false
}

/**
 * Starts the periodic report to the agent.
 */
export function startAgentReporting() {
  setInterval(reportToAgent, config.agent.poll_interval_ms)
}

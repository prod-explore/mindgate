/**
 * The tray's side of the conversation with the agent: a small HTTP server on 127.0.0.1 that answers the agent's
 * shutdown check, and the "I'm using this PC" toggle, which is reported to the agent.
 */
import express from 'express'
import { config } from './config.js'
import { getIdleSeconds } from './idle.js'
import pino from 'pino'

const log = pino({ name: 'ipc' })

let userToggleActive = false // "I'm using this PC — don't shut it down"

/** Listens on 127.0.0.1 only: its caller is the agent on this machine. */
export function startIpcServer() {
  const app = express()

  /**
   * POST /shutdown-check — the agent asks whether the machine may be shut down
   */
  app.post('/shutdown-check', (req, res) => {
    const decision = evaluateShutdown()
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
function evaluateShutdown() {
  if (userToggleActive) {
    return { allow: false, reason: 'user_toggle_active' }
  }

  const idleSeconds = getIdleSeconds()
  if (idleSeconds < config.shutdown_guard.idle_threshold_seconds) {
    return { allow: false, reason: 'user_recently_active', idle_seconds: idleSeconds }
  }

  return { allow: true, reason: 'all_checks_passed' }
}

/**
 * Sets the "I'm using this PC" toggle.
 */
export function setUserToggle(active) {
  userToggleActive = active
  log.info({ active }, '"In use" toggle changed')
  reportToAgent()
}

export function getUserToggle() {
  return userToggleActive
}

/** Tells the agent whether someone is using the PC: the toggle, and the seconds since the last input. */
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
    // the agent may be down; the next periodic report tries again
  }
}

/**
 * Checks for user activity and switches the "I'm using this PC" toggle on by itself
 * when it sees mouse or keyboard input.
 * The toggle stays on until it is switched off by hand in the tray menu.
 */
export function checkUserActivity() {
  if (userToggleActive) return

  const idleSeconds = getIdleSeconds()
  if (idleSeconds < config.shutdown_guard.idle_threshold_seconds) {
    userToggleActive = true
    log.info({ idle_seconds: idleSeconds }, 'User activity detected — switching the "in use" toggle on')
    reportToAgent()
  }
}

export function startAgentReporting() {
  setInterval(reportToAgent, config.agent.poll_interval_ms)
}

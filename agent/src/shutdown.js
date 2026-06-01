import { isIdle } from './queue.js'
import pino from 'pino'
import { execSync } from 'child_process'

const log = pino({ name: 'shutdown' })

const TRAY_URL = 'http://localhost:3002'
let userActive = false
let lastInputSecondsAgo = 0

/**
 * Obsługuje POST /internal/shutdown-request od Gate.
 * Odpytuje tray app czy można wyłączyć.
 */
export async function handleShutdownRequest(idleMinutes) {
  log.info({ idleMinutes }, 'Otrzymano shutdown request od Gate')

  // Sprawdź czy kolejka jest pusta
  if (!isIdle()) {
    log.info('Kolejka nie jest pusta — odrzucam shutdown')
    return { allow: false, reason: 'queue_not_empty' }
  }

  // Sprawdź z tray app
  try {
    const res = await fetch(`${TRAY_URL}/shutdown-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idle_minutes: idleMinutes }),
      signal: AbortSignal.timeout(5000)
    })

    if (res.ok) {
      const data = await res.json()
      if (data.allow) {
        log.info('Tray app pozwolił na shutdown — wyłączam')
        executeShutdown()
        return { allow: true, reason: 'shutdown_initiated' }
      } else {
        log.info({ reason: data.reason }, 'Tray app odrzucił shutdown')
        return { allow: false, reason: data.reason }
      }
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Nie mogę skontaktować się z tray app')
  }

  // Jeśli tray nie odpowiada — nie wyłączaj (bezpieczne domyślne)
  return { allow: false, reason: 'tray_unreachable' }
}

/**
 * Wykonuje systemowy shutdown.
 */
function executeShutdown() {
  const delay = 30 // sekund opóźnienia (żeby agent mógł odpowiedzieć)

  log.info({ delay }, 'Inicjuję shutdown systemu')

  try {
    if (process.platform === 'win32') {
      execSync(`shutdown /s /t ${delay} /c "MindGate: automatyczne wyłączenie po bezczynności"`)
    } else {
      execSync(`sudo shutdown -h +${Math.ceil(delay / 60)} "MindGate: automatyczne wyłączenie po bezczynności"`)
    }
  } catch (err) {
    log.error({ err: err.message }, 'Nie udało się zainicjować shutdown')
  }
}

/**
 * Zwraca aktualny status (do GET /internal/status).
 */
export function getStatus() {
  return {
    user_active: userActive,
    last_input_seconds_ago: lastInputSecondsAgo,
    queue_empty: isIdle(),
    safe_to_shutdown: isIdle() && !userActive
  }
}

/**
 * Aktualizuje status użytkownika (wywoływane przez tray app).
 */
export function setUserActive(active, lastInput) {
  userActive = active
  lastInputSecondsAgo = lastInput || 0
}

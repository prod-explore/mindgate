import { getUserToggle, setUserToggle } from './ipc.js'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import pino from 'pino'

const __dirname = dirname(fileURLToPath(import.meta.url))

const log = pino({ name: 'menu' })

// Odczytaj wersję z package.json
let TRAY_VERSION = '?'
try {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'package.json'), 'utf8'))
  TRAY_VERSION = pkg.version || '?'
} catch {
  // fallback — package.json nie istnieje lub błąd parsowania
}

/**
 * Buduje konfigurację menu dla systray.
 */

// Stan aktualny
let agentState = {
  status: 'unknown',
  queue_length: 0,
  lastCheck: null
}

/**
 * Generuje items menu kontekstowego.
 */
export function buildMenuItems() {
  const toggle = getUserToggle()

  let dot = '⚪'
  switch (agentState.status) {
    case 'ok': dot = agentState.queue_length > 0 ? '🟡' : '🟢'; break;
    case 'degraded': dot = '🔴'; break;
    case 'idle': dot = '🔵'; break;
    default: dot = '⚪'; break;
  }

  return [
    {
      title: `MindGate v${TRAY_VERSION}`,
      enabled: false
    },
    { title: '─────────────────────' , enabled: false },
    {
      title: `${dot} Agent: ${agentState.status}  |  Kolejka: ${agentState.queue_length}`,
      enabled: true
    },
    { title: '─────────────────────', enabled: false },
    {
      title: toggle
        ? '🛡️  Używam PC — NIE wyłączaj  ✓'
        : '🛡️  Używam PC — NIE wyłączaj',
      checked: toggle,
      click: () => {
        setUserToggle(!toggle)
        log.info({ newState: !toggle }, 'Toggle zmieniony przez menu')
      }
    },
    { title: '─────────────────────', enabled: false },
    {
      title: '✕  Zamknij tray',
      click: () => {
        log.info('Zamykanie tray app...')
        process.exit(0)
      }
    }
  ]
}

/**
 * Aktualizuje stan agenta (wywoływane z pollingu).
 */
export function updateAgentState(state) {
  agentState = {
    ...state,
    lastCheck: new Date()
  }
}

/**
 * Zwraca aktualny stan do wyboru ikony.
 */
export function getAgentState() {
  return agentState
}

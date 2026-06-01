import { getUserToggle, setUserToggle } from './ipc.js'
import pino from 'pino'

const log = pino({ name: 'menu' })

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

  return [
    {
      title: `MindGate v1.0.0`,
      enabled: false
    },
    { title: '─────────────────────' , enabled: false },
    {
      title: `● Agent: ${agentState.status}  |  Kolejka: ${agentState.queue_length}`,
      enabled: false
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

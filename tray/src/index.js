import systray2 from 'systray2'
const SysTray = systray2.default || systray2

import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { config } from './config.js'
import { startIpcServer, startAgentReporting, checkUserActivity } from './ipc.js'
import { buildMenuItems, updateAgentState, getAgentState } from './menu.js'
import pino from 'pino'
import { updateShutdownBlock } from './shutdown-block.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const log = pino({ name: 'mindgate-tray' })

/**
 * MindGate Tray — główny entry point.
 * Ikona w zasobniku systemowym + IPC server.
 */

// Ładuj ikony (base64 encoded .ico)
function loadIcon(name) {
  try {
    const iconPath = resolve(__dirname, 'icons', `${name}.ico`)
    return readFileSync(iconPath).toString('base64')
  } catch {
    // Fallback — pusta ikona (1x1 pixel transparent .ico)
    return ''
  }
}

const icons = {
  green: loadIcon('green'),
  yellow: loadIcon('yellow'),
  blue: loadIcon('blue'),
  red: loadIcon('red'),
  gray: loadIcon('gray')
}

/**
 * Wybiera ikonę na podstawie stanu agenta.
 */
function getCurrentIcon() {
  const state = getAgentState()
  switch (state.status) {
    case 'ok': return state.queue_length > 0 ? icons.yellow : icons.green
    case 'degraded': return icons.red
    case 'idle': return icons.blue
    default: return icons.gray
  }
}

/**
 * Pobiera status agenta (polling).
 */
async function pollAgentStatus() {
  try {
    const res = await fetch(`${config.agent.url}/health`, {
      signal: AbortSignal.timeout(3000)
    })
    if (res.ok) {
      const data = await res.json()
      updateAgentState({
        status: data.status || 'ok',
        queue_length: data.queue_length || 0,
        models: data.models_loaded || [],
        ollama: data.ollama
      })

      // Blokuj shutdown Windows gdy agent przetwarza żądania
      updateShutdownBlock(data.queue_length || 0)
    } else {
      updateAgentState({ status: 'error', queue_length: 0 })
      updateShutdownBlock(0)
    }
  } catch {
    updateAgentState({ status: 'offline', queue_length: 0 })
    updateShutdownBlock(0)
  }

  // Sprawdź aktywność użytkownika — auto-włącz "Używam PC" przy ruchu myszy
  checkUserActivity()

  // Aktualizuj ikonę
  if (systrayInstance) {
    try {
      systrayInstance.sendAction({
        type: 'update-item',
        item: {
          icon: getCurrentIcon(),
          title: 'MindGate',
          tooltip: `MindGate — ${getAgentState().status}`,
          enabled: true
        }
      })
    } catch {
      // systray nie obsługuje aktualizacji ikony w runtime w każdej wersji
    }
  }
}

// Główna instancja systray
let systrayInstance = null

/**
 * Inicjalizuje system tray.
 */
function initTray() {
  const menuItems = buildMenuItems()

  const systrayConfig = {
    menu: {
      icon: getCurrentIcon(),
      title: 'MindGate',
      tooltip: 'MindGate — AI Gateway',
      items: menuItems.map((item, index) => ({
        title: item.title,
        tooltip: item.title,
        checked: item.checked || false,
        enabled: item.enabled !== false,
        hidden: false
      }))
    },
    debug: false,
    copyDir: false
  }

  systrayInstance = new SysTray(systrayConfig)

  systrayInstance.onClick(action => {
    const item = menuItems[action.seq_id]
    if (item?.click) {
      item.click()

      // Przebuduj menu po zmianie
      const newItems = buildMenuItems()
      newItems.forEach((newItem, i) => {
        systrayInstance.sendAction({
          type: 'update-item',
          item: {
            title: newItem.title,
            tooltip: newItem.title,
            checked: newItem.checked || false,
            enabled: newItem.enabled !== false
          },
          seq_id: i
        })
      })
    }
  })

  systrayInstance.ready().then(() => {
    log.info('🟢 MindGate Tray uruchomiony')
    systrayInstance.onError(err => {
      log.error({ err }, 'Systray error')
    })
  }).catch(err => {
    log.error({ err }, 'Blad podczas uruchamiania systray')
  })
}

// --- Start ---

log.info('Uruchamiam MindGate Tray...')

// 1. IPC server (obsługa shutdown-check od agenta)
startIpcServer()

// 2. Polling statusu agenta
pollAgentStatus()
setInterval(pollAgentStatus, config.agent.poll_interval_ms)

// 3. Raportowanie do agenta
startAgentReporting()

// 4. System tray
initTray()

// Graceful shutdown
process.on('SIGINT', () => {
  log.info('Zamykanie tray...')
  if (systrayInstance) systrayInstance.kill(false)
  process.exit(0)
})

process.on('SIGTERM', () => {
  log.info('Zamykanie tray...')
  if (systrayInstance) systrayInstance.kill(false)
  process.exit(0)
})

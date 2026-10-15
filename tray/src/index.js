import systray2 from 'systray2'
const SysTray = systray2.default || systray2

import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { config } from './config.js'
import { startIpcServer, startAgentReporting, checkUserActivity } from './ipc.js'
import { buildMenuItems, buildTooltip, updateAgentState, getAgentState, SEPARATOR } from './menu.js'
import { describeState } from './state.js'
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
  return icons[describeState(getAgentState()).icon] ?? icons.gray
}

/**
 * Odświeża UI traya (ikonę, tooltip i pozycje w menu).
 */
function refreshMenuUI() {
  if (!systrayInstance || !systrayReady) return

  try {
    const newItems = buildMenuItems()
    const confItems = systrayInstance._conf.menu.items

    // Mutate existing items to preserve __id added by systray2 and send update-item
    newItems.forEach((newItem, i) => {
      // separator się nie zmienia, więc nie ma czego wysyłać
      if (confItems[i] && newItem.title !== SEPARATOR) {
        confItems[i].title = newItem.title
        confItems[i].tooltip = newItem.title
        confItems[i].checked = newItem.checked || false
        confItems[i].enabled = newItem.enabled !== false
        confItems[i].hidden = newItem.hidden === true

        systrayInstance.sendAction({
          type: 'update-item',
          item: confItems[i],
          seq_id: i
        })
      }
    })

    systrayInstance.sendAction({
      type: 'update-menu',
      menu: {
        icon: getCurrentIcon(),
        title: 'MindGate',
        tooltip: buildTooltip(),
        items: confItems
      }
    })
  } catch {
    // systray może być w trakcie zamykania lub nie obsługiwać update'ów
  }
}

/**
 * Pobiera status agenta (polling).
 */
async function pollAgentStatus() {
  try {
    const res = await fetch(`${config.agent.url}/health`, {
      headers: { 'Authorization': `Bearer ${config.agent.secret}` },
      signal: AbortSignal.timeout(3000)
    })
    if (res.ok) {
      const data = await res.json()
      // zajętość = żądania w toku + pobierane modele
      const busy = (data.in_flight || 0) + (data.downloads || 0)
      updateAgentState({
        status: data.status || 'ok',
        busy,
        models: data.models_loaded || [],
        runtime: data.runtime
      })

      // Blokuj shutdown Windows gdy agent pracuje
      updateShutdownBlock(busy)
    } else {
      updateAgentState({ status: 'error', busy: 0, httpStatus: res.status })
      updateShutdownBlock(0)
    }
  } catch {
    updateAgentState({ status: 'offline', busy: 0 })
    updateShutdownBlock(0)
  }

  // Sprawdź aktywność użytkownika — auto-włącz "Używam PC" przy ruchu myszy
  checkUserActivity()

  // Aktualizuj UI traya po pobraniu statusu lub wykryciu aktywności
  refreshMenuUI()
}

// Główna instancja systray
let systrayInstance = null

let systrayReady = false

/**
 * Inicjalizuje system tray.
 */
function initTray() {
  const menuItems = buildMenuItems()

  const systrayConfig = {
    menu: {
      icon: getCurrentIcon(),
      title: 'MindGate',
      tooltip: buildTooltip(),
      items: menuItems.map((item, index) => ({
        title: item.title,
        tooltip: item.title,
        checked: item.checked || false,
        enabled: item.enabled !== false,
        hidden: item.hidden === true
      }))
    },
    debug: false,
    copyDir: false
  }

  systrayInstance = new SysTray(systrayConfig)

  systrayInstance.onClick(action => {
    // Pobierz z najnowszego menu żeby użyć aktualnego handlera
    const currentItems = buildMenuItems()
    const item = currentItems[action.seq_id]
    
    if (item?.click) {
      item.click()
      refreshMenuUI()
    }
  })

  systrayInstance.ready().then(() => {
    systrayReady = true
    log.info('🟢 MindGate Tray uruchomiony')
    refreshMenuUI()
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

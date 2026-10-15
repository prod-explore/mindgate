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
 * MindGate Tray — main entry point.
 * An icon in the system tray plus the IPC server.
 */

// Load the icons (base64-encoded .ico)
function loadIcon(name) {
  try {
    const iconPath = resolve(__dirname, 'icons', `${name}.ico`)
    return readFileSync(iconPath).toString('base64')
  } catch {
    // Fallback — an empty icon (1x1 transparent .ico)
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
 * Picks the icon for the agent's state.
 */
function getCurrentIcon() {
  return icons[describeState(getAgentState()).icon] ?? icons.gray
}

/**
 * Refreshes the tray UI (icon, tooltip and menu items).
 */
function refreshMenuUI() {
  if (!systrayInstance || !systrayReady) return

  try {
    const newItems = buildMenuItems()
    const confItems = systrayInstance._conf.menu.items

    // Mutate existing items to preserve __id added by systray2 and send update-item
    newItems.forEach((newItem, i) => {
      // a separator never changes, so there is nothing to send
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
    // systray may be shutting down or may not support updates
  }
}

/**
 * Fetches the agent's status (polling).
 */
async function pollAgentStatus() {
  try {
    const res = await fetch(`${config.agent.url}/health`, {
      headers: { 'Authorization': `Bearer ${config.agent.secret}` },
      signal: AbortSignal.timeout(3000)
    })
    if (res.ok) {
      const data = await res.json()
      // busy = requests in flight + models being downloaded
      const busy = (data.in_flight || 0) + (data.downloads || 0)
      updateAgentState({
        status: data.status || 'ok',
        busy,
        models: data.models_loaded || [],
        runtime: data.runtime
      })

      // Block the Windows shutdown while the agent is working
      updateShutdownBlock(busy)
    } else {
      updateAgentState({ status: 'error', busy: 0, httpStatus: res.status })
      updateShutdownBlock(0)
    }
  } catch {
    updateAgentState({ status: 'offline', busy: 0 })
    updateShutdownBlock(0)
  }

  // Check for user activity — switch the "in use" toggle on when the mouse moves
  checkUserActivity()

  // Update the tray UI after fetching the status or detecting activity
  refreshMenuUI()
}

// The one systray instance
let systrayInstance = null

let systrayReady = false

/**
 * Sets up the system tray.
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
    // Take the item from the newest menu so the current handler is used
    const currentItems = buildMenuItems()
    const item = currentItems[action.seq_id]
    
    if (item?.click) {
      item.click()
      refreshMenuUI()
    }
  })

  systrayInstance.ready().then(() => {
    systrayReady = true
    log.info('MindGate Tray started')
    refreshMenuUI()
    systrayInstance.onError(err => {
      log.error({ err }, 'Systray error')
    })
  }).catch(err => {
    log.error({ err }, 'Could not start the systray')
  })
}

// --- Start ---

log.info('Starting MindGate Tray...')

// 1. IPC server (answers the agent's shutdown-check)
startIpcServer()

// 2. Poll the agent's status
pollAgentStatus()
setInterval(pollAgentStatus, config.agent.poll_interval_ms)

// 3. Report to the agent
startAgentReporting()

// 4. System tray
initTray()

// Graceful shutdown
process.on('SIGINT', () => {
  log.info('Shutting down the tray...')
  if (systrayInstance) systrayInstance.kill(false)
  process.exit(0)
})

process.on('SIGTERM', () => {
  log.info('Shutting down the tray...')
  if (systrayInstance) systrayInstance.kill(false)
  process.exit(0)
})

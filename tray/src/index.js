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
 * Entry point of the tray app: an icon in the system tray that shows the agent's state, and a small HTTP server on
 * 127.0.0.1 that the agent asks before an automatic shutdown (ipc.js).
 */

/** An icon file as the base64 string systray2 expects. */
function loadIcon(name) {
  try {
    const iconPath = resolve(__dirname, 'icons', `${name}.ico`)
    return readFileSync(iconPath).toString('base64')
  } catch {
    // a missing icon file leaves the tray without an icon instead of stopping it
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

function getCurrentIcon() {
  return icons[describeState(getAgentState()).icon] ?? icons.gray
}

function refreshMenuUI() {
  if (!systrayInstance || !systrayReady) return

  try {
    const newItems = buildMenuItems()
    const confItems = systrayInstance._conf.menu.items

    // update the existing items in place: systray2 identifies them by the __id it added to each
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

/** Reads the agent's /health, refreshes the icon and menu, and holds a Windows shutdown back while the agent is busy. */
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

      updateShutdownBlock(busy)
    } else {
      updateAgentState({ status: 'error', busy: 0, httpStatus: res.status })
      updateShutdownBlock(0)
    }
  } catch {
    updateAgentState({ status: 'offline', busy: 0 })
    updateShutdownBlock(0)
  }

  checkUserActivity()
  refreshMenuUI()
}

let systrayInstance = null
let systrayReady = false

function initTray() {
  const menuItems = buildMenuItems()

  const systrayConfig = {
    menu: {
      icon: getCurrentIcon(),
      title: 'MindGate',
      tooltip: buildTooltip(),
      items: menuItems.map(item => ({
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
    // the click handlers close over the state they were built with, so take them from a fresh menu
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

log.info('Starting MindGate Tray...')

startIpcServer()

pollAgentStatus()
setInterval(pollAgentStatus, config.agent.poll_interval_ms)

startAgentReporting()

initTray()

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

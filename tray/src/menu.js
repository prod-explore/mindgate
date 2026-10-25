/**
 * Builds the system tray menu. The number of items is fixed (systray2 updates them in place); items that do not
 * apply right now are hidden.
 */
import { execFile } from 'child_process'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import pino from 'pino'
import { config } from './config.js'
import { getUserToggle, setUserToggle } from './ipc.js'
import { describeState } from './state.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const log = pino({ name: 'menu' })

// Version from tray/package.json (one level above src/)
let TRAY_VERSION = '?'
try {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'))
  TRAY_VERSION = pkg.version || '?'
} catch {
  // the tooltip then shows "v?"
}

export const SEPARATOR = '<SEPARATOR>'

let agentState = {
  status: 'unknown',
  busy: 0,
  lastCheck: null
}

/** The hub panel address, if tray.yml has one and it is an http(s) URL. */
export function panelUrl() {
  const base = String(config.hub?.url || '').trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(base) ? `${base}/admin/` : ''
}

function openInBrowser(url) {
  // rundll32 passes nothing through a shell, so characters in the address cannot break anything
  execFile('rundll32', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, err => {
    if (err) log.warn({ err: err.message }, 'Could not open the browser')
  })
}

/** The tooltip on the icon. */
export function buildTooltip() {
  return `MindGate v${TRAY_VERSION} — ${describeState(agentState).title}`
}

export function buildMenuItems() {
  const toggle = getUserToggle()
  const state = describeState(agentState)
  const url = panelUrl()

  return [
    { title: `MindGate — ${state.title}`, enabled: false },
    { title: state.detail || ' ', enabled: false, hidden: !state.detail },
    { title: SEPARATOR },
    {
      title: "Don't shut down this computer",
      checked: toggle,
      click: () => {
        setUserToggle(!toggle)
        log.info({ newState: !toggle }, 'Toggle changed from the menu')
      }
    },
    {
      title: 'Open the MindGate panel',
      hidden: !url,
      click: () => {
        if (url) openInBrowser(url)
      }
    },
    { title: SEPARATOR },
    {
      title: 'Quit MindGate (agent and tray)',
      click: async () => {
        log.info('Shutting down the tray app and the agent...')
        try {
          await fetch(`${config.agent.url}/node/exit`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${config.agent.secret}`
            },
            body: JSON.stringify({ source: 'tray' }),
            signal: AbortSignal.timeout(3000)
          })
        } catch (err) {
          log.warn({ err: err.message }, 'Could not tell the agent about the shutdown')
        }
        process.exit(0)
      }
    }
  ]
}

/**
 * Updates the agent state (called from the polling loop).
 */
export function updateAgentState(state) {
  agentState = {
    ...state,
    lastCheck: new Date()
  }
}

/**
 * Returns the current state, used to pick the icon.
 */
export function getAgentState() {
  return agentState
}

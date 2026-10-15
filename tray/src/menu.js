/**
 * Buduje menu systray. Liczba pozycji jest stała (systray2 aktualizuje je w miejscu), a pozycje, których
 * teraz nie ma, są ukryte.
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

// Wersja z tray/package.json (src/..)
let TRAY_VERSION = '?'
try {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'))
  TRAY_VERSION = pkg.version || '?'
} catch {
  // fallback — package.json nie istnieje lub błąd parsowania
}

export const SEPARATOR = '<SEPARATOR>'

// Stan aktualny
let agentState = {
  status: 'unknown',
  busy: 0,
  lastCheck: null
}

/** Adres panelu huba, o ile jest w tray.yml i jest adresem http(s). */
export function panelUrl() {
  const base = String(config.hub?.url || '').trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(base) ? `${base}/admin/` : ''
}

function openInBrowser(url) {
  // rundll32 nie przepuszcza niczego przez powłokę, więc znaki w adresie nic nie psują
  execFile('rundll32', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, err => {
    if (err) log.warn({ err: err.message }, 'Nie udało się otworzyć przeglądarki')
  })
}

/** Podpowiedź przy ikonie. */
export function buildTooltip() {
  return `MindGate v${TRAY_VERSION} — ${describeState(agentState).title}`
}

/**
 * Generuje pozycje menu kontekstowego.
 */
export function buildMenuItems() {
  const toggle = getUserToggle()
  const state = describeState(agentState)
  const url = panelUrl()

  return [
    { title: `MindGate — ${state.title}`, enabled: false },
    { title: state.detail || ' ', enabled: false, hidden: !state.detail },
    { title: SEPARATOR },
    {
      title: 'Nie wyłączaj tego komputera',
      checked: toggle,
      click: () => {
        setUserToggle(!toggle)
        log.info({ newState: !toggle }, 'Toggle zmieniony przez menu')
      }
    },
    {
      title: 'Otwórz panel MindGate',
      hidden: !url,
      click: () => {
        if (url) openInBrowser(url)
      }
    },
    { title: SEPARATOR },
    {
      title: 'Zamknij MindGate (agent i tray)',
      click: async () => {
        log.info('Zamykanie tray app i agenta...')
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
          log.warn({ err: err.message }, 'Nie udalo sie poinformowac agenta o zamknieciu')
        }
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

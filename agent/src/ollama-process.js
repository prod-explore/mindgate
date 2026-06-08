import { spawn, execSync } from 'child_process'
import { existsSync } from 'fs'
import pino from 'pino'

const log = pino({ name: 'ollama-process' })

/**
 * Zarządzanie procesem Ollama — Agent jest właścicielem.
 * Startuje Ollamę przy starcie, zamyka przy shutdown.
 */

// Standardowe ścieżki fallback (bez hardcoded prywatnych ścieżek)
const OLLAMA_PATHS_WIN = [
  process.env.OLLAMA_PATH,
  `C:\\Users\\${process.env.USERNAME}\\AppData\\Local\\Programs\\Ollama\\ollama.exe`,
  'C:\\Program Files\\Ollama\\ollama.exe',
  'C:\\Program Files (x86)\\Ollama\\ollama.exe',
].filter(Boolean)

const OLLAMA_PATHS_LINUX = [
  process.env.OLLAMA_PATH,
  '/usr/local/bin/ollama',
  '/usr/bin/ollama',
].filter(Boolean)

let ollamaProcess = null
let ollamaReady = false

/**
 * Znajduje ścieżkę do binarki Ollama.
 * Kolejność: OLLAMA_PATH env → PATH systemowy (where/which) → znane lokalizacje
 */
function findOllamaPath() {
  // 1. Zmienna środowiskowa — najwyższy priorytet
  if (process.env.OLLAMA_PATH && existsSync(process.env.OLLAMA_PATH)) {
    log.info({ path: process.env.OLLAMA_PATH }, 'Znaleziono Ollama (OLLAMA_PATH)')
    return process.env.OLLAMA_PATH
  }

  // 2. PATH systemowy — działa dla standardowych instalacji
  try {
    const cmd = process.platform === 'win32' ? 'where ollama' : 'which ollama'
    const result = execSync(cmd, { encoding: 'utf8', timeout: 3000, windowsHide: true }).trim()
    const firstLine = result.split('\n')[0].trim() // where może zwrócić wiele wyników
    if (firstLine && existsSync(firstLine)) {
      log.info({ path: firstLine }, 'Znaleziono Ollama (PATH systemowy)')
      return firstLine
    }
  } catch {
    // nie w PATH — szukamy dalej
  }

  // 3. Znane lokalizacje fallback
  const paths = process.platform === 'win32' ? OLLAMA_PATHS_WIN : OLLAMA_PATHS_LINUX
  for (const p of paths) {
    if (existsSync(p)) {
      log.info({ path: p }, 'Znaleziono Ollama (znana lokalizacja)')
      return p
    }
  }

  log.error('Nie znaleziono Ollama. Zainstaluj: https://ollama.ai lub ustaw OLLAMA_PATH')
  return null
}

/**
 * Sprawdza czy Ollama już działa (ktoś ją odpalił ręcznie).
 */
async function isOllamaAlreadyRunning() {
  try {
    const res = await fetch('http://localhost:11434/api/version', {
      signal: AbortSignal.timeout(2000)
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Startuje proces Ollama serve.
 * Jeśli Ollama już działa — nie odpala drugiej instancji.
 */
export async function startOllama() {
  // Sprawdź czy już działa
  if (await isOllamaAlreadyRunning()) {
    log.info('Ollama już działa — przejmuję kontrolę')
    ollamaReady = true
    return true
  }

  const ollamaPath = findOllamaPath()
  if (!ollamaPath) {
    log.error('Nie znaleziono Ollama! Zainstaluj ją lub ustaw zmienną OLLAMA_PATH')
    return false
  }

  log.info({ path: ollamaPath }, 'Uruchamiam Ollama serve...')

  ollamaProcess = spawn(ollamaPath, ['serve'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Upewnij się, że Ollama nasłuchuje na właściwym porcie
      OLLAMA_HOST: '127.0.0.1:11434',
    },
    detached: false, // proces umiera razem z agentem
    windowsHide: true
  })

  ollamaProcess.stdout.on('data', (data) => {
    const msg = data.toString().trim()
    if (msg) log.debug({ src: 'ollama' }, msg)
  })

  ollamaProcess.stderr.on('data', (data) => {
    const msg = data.toString().trim()
    if (msg) {
      log.debug({ src: 'ollama' }, msg)
      // Ollama loguje "Listening on 127.0.0.1:11434" na stderr
      if (msg.includes('Listening on')) {
        ollamaReady = true
        log.info('Ollama gotowa do pracy')
      }
    }
  })

  ollamaProcess.on('error', (err) => {
    log.error({ err: err.message }, 'Błąd procesu Ollama')
    ollamaReady = false
  })

  ollamaProcess.on('exit', (code, signal) => {
    log.warn({ code, signal }, 'Proces Ollama zakończony')
    ollamaProcess = null
    ollamaReady = false
  })

  // Czekaj aż Ollama wstanie (max 30s)
  const ready = await waitForOllama(30000)
  if (!ready) {
    log.error('Ollama nie odpowiada po 30 sekundach')
    return false
  }

  return true
}

/**
 * Czeka aż Ollama zacznie odpowiadać na health check.
 */
async function waitForOllama(timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch('http://localhost:11434/api/version', {
        signal: AbortSignal.timeout(1000)
      })
      if (res.ok) {
        ollamaReady = true
        return true
      }
    } catch {
      // jeszcze nie gotowa
    }
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}

/**
 * Zamyka proces Ollama.
 */
export function stopOllama() {
  if (!ollamaProcess) {
    log.info('Ollama nie była zarządzana przez Agenta — pomijam')
    return
  }

  log.info('Zamykam proces Ollama...')
  ollamaReady = false

  try {
    if (process.platform === 'win32') {
      // Na Windows graceful kill przez taskkill
      spawn('taskkill', ['/pid', ollamaProcess.pid.toString(), '/t', '/f'], {
        windowsHide: true
      })
    } else {
      ollamaProcess.kill('SIGTERM')
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Problem z zamykaniem Ollama')
  }

  ollamaProcess = null
}

/**
 * Czy Ollama jest gotowa na żądania.
 */
export function isOllamaReady() {
  return ollamaReady
}

/**
 * Czy Agent zarządza procesem (czy Ollama była odpalona przez nas).
 */
export function isManaged() {
  return ollamaProcess !== null
}

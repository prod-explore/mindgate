import { execSync, spawn } from 'child_process'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import pino from 'pino'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const log = pino({ name: 'shutdown-block' })

/**
 * Blokuje systemowy shutdown gdy agent przetwarza żądania.
 * Używa C# WinForms EXE do obsługi WM_QUERYENDSESSION.
 * Gdy użytkownik kliknie "Zamknij" w menu Start, Windows pokaże dialog:
 *   "Ta aplikacja blokuje wyłączenie: MindGate przetwarza żądania AI"
 *
 * Na Linux shutdown jest kontrolowany przez systemd/polkit — nie blokujemy.
 */

let blockerProcess = null
let isBlocking = false

/**
 * Aktywuje blokadę shutdown.
 * Kompiluje (jeśli trzeba) i uruchamia ukryty program C# blokujący zamknięcie.
 */
export function enableShutdownBlock() {
  if (process.platform !== 'win32') return
  if (isBlocking) return

  try {
    const exePath = join(__dirname, 'shutdown-blocker.exe')
    const csPath = join(__dirname, 'blocker.cs')

    if (!existsSync(exePath) && existsSync(csPath)) {
      log.info('Kompiluję shutdown-blocker.exe...')
      execSync(`C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe /nologo /target:winexe /out:"${exePath}" "${csPath}"`)
    }

    if (!existsSync(exePath)) {
      log.error('Nie znaleziono shutdown-blocker.exe ani kodu źródłowego.')
      return
    }

    blockerProcess = spawn(exePath, [], {
      detached: false,
      stdio: 'ignore',
      windowsHide: true
    })

    blockerProcess.on('error', (err) => {
      log.warn({ err: err.message }, 'Shutdown blocker process error')
      isBlocking = false
      blockerProcess = null
    })

    blockerProcess.on('exit', (code) => {
      log.info({ code }, 'Shutdown blocker process zakończony')
      isBlocking = false
      blockerProcess = null
    })

    isBlocking = true
    log.info('🛑 Shutdown block aktywowany — Windows pokaże ostrzeżenie przy próbie wyłączenia')
  } catch (err) {
    log.error({ err: err.message }, 'Nie udało się aktywować shutdown block')
  }
}

/**
 * Dezaktywuje blokadę shutdown.
 * Zamyka ukryte okno PowerShell.
 */
export function disableShutdownBlock() {
  if (!isBlocking || !blockerProcess) return

  try {
    blockerProcess.kill()
    log.info('✅ Shutdown block dezaktywowany')
  } catch (err) {
    log.warn({ err: err.message }, 'Problem przy zamykaniu shutdown blocker')
  }

  isBlocking = false
  blockerProcess = null
}

/**
 * Zwraca czy blokada jest aktywna.
 */
export function isShutdownBlocked() {
  return isBlocking
}

/**
 * Aktualizuje stan blokady na podstawie queue_length agenta.
 * Wywołuj periodycznie z głównej pętli pollingu.
 */
export function updateShutdownBlock(queueLength) {
  if (queueLength > 0 && !isBlocking) {
    enableShutdownBlock()
  } else if (queueLength === 0 && isBlocking) {
    disableShutdownBlock()
  }
}

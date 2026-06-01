import { execSync } from 'child_process'
import pino from 'pino'

const log = pino({ name: 'processes' })

/**
 * Sprawdza czy którykolwiek z procesów z whitelisty jest uruchomiony.
 * Jeśli tak — shutdown powinien być zablokowany.
 */

/**
 * Zwraca true jeśli któryś z whitelistowanych procesów działa.
 */
export function isWhitelistProcessRunning(whitelist) {
  if (!whitelist || whitelist.length === 0) return false

  try {
    const processes = getProcessList()
    const found = whitelist.find(p => processes.includes(p.toLowerCase()))

    if (found) {
      log.info({ process: found }, 'Znaleziono whitelistowany proces')
      return true
    }
    return false
  } catch (err) {
    log.warn({ err: err.message }, 'Nie mogę sprawdzić listy procesów')
    return false // bezpieczne domyślne — nie blokuj shutdown
  }
}

/**
 * Pobiera listę procesów (lowercase).
 */
function getProcessList() {
  if (process.platform === 'win32') {
    return getProcessListWindows()
  } else {
    return getProcessListLinux()
  }
}

/**
 * Windows — tasklist.
 */
function getProcessListWindows() {
  const output = execSync('tasklist /fo csv /nh', {
    encoding: 'utf8',
    timeout: 10000
  })
  return output.toLowerCase()
}

/**
 * Linux — ps.
 */
function getProcessListLinux() {
  const output = execSync('ps aux', {
    encoding: 'utf8',
    timeout: 10000
  })
  return output.toLowerCase()
}

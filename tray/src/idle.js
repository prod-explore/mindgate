import { execFileSync, execSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import pino from 'pino'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const log = pino({ name: 'idle' })

/**
 * Tells how many seconds have passed since the user's last input.
 * Windows: GetLastInputInfo through a small C# program (get-idle-time.cs, compiled once)
 * Linux: xprintidle
 */

/** Windows ships the C# compiler with .NET Framework; this is where it lives. */
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'

function readWindows() {
  const exePath = path.join(__dirname, 'get-idle-time.exe')
  if (!fs.existsSync(exePath)) {
    log.info('Compiling get-idle-time.exe...')
    execSync(`${CSC} /nologo /target:exe /out:"${exePath}" "${path.join(__dirname, 'get-idle-time.cs')}"`, { windowsHide: true })
  }
  return parseInt(execFileSync(exePath, { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim(), 10) || 0
}

function readLinux() {
  return Math.floor(parseInt(execFileSync('xprintidle', { encoding: 'utf8', timeout: 5000 }).trim(), 10) / 1000)
}

/**
 * Wraps a reader so that several callers within `ttlMs` share one reading (every one costs a process),
 * and so that a failure means "assume activity" (0) — the safe answer for a machine that might be shut down.
 */
export function memoizeIdle(read, ttlMs = 1000, now = Date.now) {
  let at = -Infinity
  let value = 0
  return () => {
    if (now() - at < ttlMs) return value
    try {
      value = read()
    } catch (err) {
      log.warn({ err: err.message }, 'Cannot read the idle time — assuming activity')
      value = 0
    }
    at = now()
    return value
  }
}

/** Seconds since the last input (mouse/keyboard). */
export const getIdleSeconds = memoizeIdle(process.platform === 'win32' ? readWindows : readLinux)

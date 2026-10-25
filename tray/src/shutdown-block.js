import { execSync, spawn } from 'child_process'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import pino from 'pino'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const log = pino({ name: 'shutdown-block' })

/**
 * Holds a Windows shutdown back while the agent is busy (requests in flight or downloads running).
 * Uses a small C# WinForms EXE (blocker.cs) that handles WM_QUERYENDSESSION.
 * When someone picks "Shut down" in the Start menu, Windows lists it among the apps that prevent shutdown,
 * with the reason blocker.cs gives.
 *
 * On Linux, shutdown is controlled by systemd/polkit — nothing is blocked there.
 */

let blockerProcess = null
let isBlocking = false

/**
 * Turns the shutdown block on.
 * Compiles (if needed) and starts a hidden C# program that holds the shutdown back.
 */
export function enableShutdownBlock() {
  if (process.platform !== 'win32') return
  if (isBlocking) return

  try {
    const exePath = join(__dirname, 'shutdown-blocker.exe')
    const csPath = join(__dirname, 'blocker.cs')

    if (!existsSync(exePath) && existsSync(csPath)) {
      log.info('Compiling shutdown-blocker.exe...')
      execSync(`C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe /nologo /target:winexe /out:"${exePath}" "${csPath}"`)
    }

    if (!existsSync(exePath)) {
      log.error('Neither shutdown-blocker.exe nor its source was found.')
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
      log.info({ code }, 'Shutdown blocker process exited')
      isBlocking = false
      blockerProcess = null
    })

    isBlocking = true
    log.info('Shutdown block on — Windows will show a warning when someone tries to shut down')
  } catch (err) {
    log.error({ err: err.message }, 'Could not turn the shutdown block on')
  }
}

/**
 * Turns the shutdown block off.
 * Ends the hidden blocker process.
 */
export function disableShutdownBlock() {
  if (!isBlocking || !blockerProcess) return

  try {
    blockerProcess.kill()
    log.info('Shutdown block off')
  } catch (err) {
    log.warn({ err: err.message }, 'Problem while stopping the shutdown blocker')
  }

  isBlocking = false
  blockerProcess = null
}

/**
 * Tells whether the block is active.
 */
export function isShutdownBlocked() {
  return isBlocking
}

/**
 * Updates the block from how busy the agent is
 * (requests in flight + models being downloaded).
 * Call it periodically from the main polling loop.
 */
export function updateShutdownBlock(busy) {
  if (busy > 0 && !isBlocking) {
    enableShutdownBlock()
  } else if (busy === 0 && isBlocking) {
    disableShutdownBlock()
  }
}

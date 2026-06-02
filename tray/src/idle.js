import { execSync } from 'child_process'
import pino from 'pino'

const log = pino({ name: 'idle' })

/**
 * Sprawdza ile sekund minęło od ostatniego inputu użytkownika.
 * Windows: GetLastInputInfo przez PowerShell (fallback bez ffi-napi)
 * Linux: xprintidle
 */

let useNativeApi = false
let ffi, ref, StructType

// Próba załadowania natywnego API (Windows)
if (process.platform === 'win32') {
  try {
    ffi = (await import('ffi-napi')).default
    ref = (await import('ref-napi')).default
    StructType = (await import('ref-struct-napi')).default

    useNativeApi = true
    log.info('Idle detection: natywne WinAPI (ffi-napi)')
  } catch {
    log.info('Idle detection: PowerShell fallback (ffi-napi niedostępne)')
  }
}

/**
 * Zwraca sekundy od ostatniego inputu (mysz/klawiatura).
 */
export function getIdleSeconds() {
  try {
    if (process.platform === 'win32') {
      return useNativeApi ? getIdleWindows_native() : getIdleWindows_powershell()
    } else {
      return getIdleLinux()
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Nie mogę sprawdzić idle — zakładam aktywność')
    return 0 // bezpieczne domyślne
  }
}

/**
 * Windows — natywne WinAPI przez ffi-napi.
 */
function getIdleWindows_native() {
  const LASTINPUTINFO = StructType({
    cbSize: ref.types.uint32,
    dwTime: ref.types.uint32
  })

  const user32 = ffi.Library('user32', {
    GetLastInputInfo: ['bool', [ref.refType(LASTINPUTINFO)]]
  })
  const kernel32 = ffi.Library('kernel32', {
    GetTickCount: ['uint32', []]
  })

  const info = new LASTINPUTINFO()
  info.cbSize = LASTINPUTINFO.size

  const success = user32.GetLastInputInfo(info.ref())
  if (!success) return 0

  const tickCount = kernel32.GetTickCount()
  return Math.floor((tickCount - info.dwTime) / 1000)
}

/**
 * Windows — PowerShell fallback.
 */
function getIdleWindows_powershell() {
  const script = `
    Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public struct LASTINPUTINFO {
        public uint cbSize;
        public uint dwTime;
    }
    public class IdleTime {
        [DllImport("user32.dll")]
        public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
        public static uint GetIdleTime() {
            LASTINPUTINFO info = new LASTINPUTINFO();
            info.cbSize = (uint)Marshal.SizeOf(info);
            GetLastInputInfo(ref info);
            return ((uint)Environment.TickCount - info.dwTime);
        }
    }
"@
    [Math]::Floor([IdleTime]::GetIdleTime() / 1000)
  `.trim()

  const buffer = Buffer.from(script, 'utf16le')
  const base64 = buffer.toString('base64')

  const result = execSync(`powershell -NoProfile -EncodedCommand ${base64}`, {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true
  })
  return parseInt(result.trim(), 10) || 0
}

/**
 * Linux — xprintidle.
 */
function getIdleLinux() {
  const ms = parseInt(execSync('xprintidle', { encoding: 'utf8', timeout: 5000 }).trim())
  return Math.floor(ms / 1000)
}

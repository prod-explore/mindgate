import { execSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import pino from 'pino'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

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
 * Windows — C# Executable fallback (zamiast PowerShell).
 * Kompiluje i uruchamia mały program w C#, by uniknąć okienek PowerShell.
 */
function getIdleWindows_powershell() {
  const exePath = path.join(__dirname, 'get-idle-time.exe')
  
  try {
    if (!fs.existsSync(exePath)) {
      const csPath = path.join(__dirname, 'get-idle-time.cs')
      if (!fs.existsSync(csPath)) {
          // Jeśli brakuje kodu źródłowego, zapisz go w locie
          const csCode = `
using System;
using System.Runtime.InteropServices;

public class IdleTimeFinder {
    public struct LASTINPUTINFO {
        public uint cbSize;
        public uint dwTime;
    }
    
    [DllImport("user32.dll")]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    
    public static void Main() {
        LASTINPUTINFO info = new LASTINPUTINFO();
        info.cbSize = (uint)Marshal.SizeOf(info);
        if (GetLastInputInfo(ref info)) {
            uint idleTime = ((uint)Environment.TickCount - info.dwTime) / 1000;
            Console.WriteLine(idleTime);
        } else {
            Console.WriteLine(0);
        }
    }
}
`
          fs.writeFileSync(csPath, csCode)
      }
      log.info('Kompiluję get-idle-time.exe (fallback dla idle)...')
      execSync(`C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe /nologo /target:exe /out:"${exePath}" "${csPath}"`, { windowsHide: true })
    }

    const result = execSync(`"${exePath}"`, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
    })
    return parseInt(result.trim(), 10) || 0
  } catch (err) {
    log.warn({ err: err.message }, 'Błąd podczas wykonywania get-idle-time.exe')
    return 0
  }
}

/**
 * Linux — xprintidle.
 */
function getIdleLinux() {
  const ms = parseInt(execSync('xprintidle', { encoding: 'utf8', timeout: 5000 }).trim())
  return Math.floor(ms / 1000)
}

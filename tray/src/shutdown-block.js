import { execSync, spawn } from 'child_process'
import pino from 'pino'

const log = pino({ name: 'shutdown-block' })

/**
 * Blokuje systemowy shutdown gdy agent przetwarza żądania.
 * Używa Windows API ShutdownBlockReasonCreate przez ukryte okno PowerShell.
 * Gdy użytkownik kliknie "Zamknij" w menu Start, Windows pokaże dialog:
 *   "Ta aplikacja blokuje wyłączenie: MindGate przetwarza żądania AI"
 *
 * Na Linux shutdown jest kontrolowany przez systemd/polkit — nie blokujemy.
 */

let blockerProcess = null
let isBlocking = false

/**
 * Aktywuje blokadę shutdown.
 * Tworzy ukryte okno Windows z zarejestrowanym ShutdownBlockReason.
 */
export function enableShutdownBlock() {
  if (process.platform !== 'win32') return
  if (isBlocking) return

  try {
    // PowerShell script that creates a hidden WinForms window with ShutdownBlockReasonCreate.
    // The window intercepts WM_QUERYENDSESSION and blocks shutdown.
    // The process stays alive until we kill it (when queue empties).
    const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class ShutdownBlocker : Form {
    [DllImport("user32.dll")]
    public static extern bool ShutdownBlockReasonCreate(IntPtr hWnd, [MarshalAs(UnmanagedType.LPWStr)] string pwszReason);

    [DllImport("user32.dll")]
    public static extern bool ShutdownBlockReasonDestroy(IntPtr hWnd);

    private const int WM_QUERYENDSESSION = 0x0011;

    public ShutdownBlocker() {
        this.Text = "MindGate Shutdown Guard";
        this.ShowInTaskbar = false;
        this.WindowState = FormWindowState.Minimized;
        this.FormBorderStyle = FormBorderStyle.None;
        this.Opacity = 0;
    }

    protected override void OnHandleCreated(EventArgs e) {
        base.OnHandleCreated(e);
        ShutdownBlockReasonCreate(this.Handle, "MindGate przetwarza żądania AI — poczekaj na zakończenie.");
    }

    protected override void WndProc(ref Message m) {
        if (m.Msg == WM_QUERYENDSESSION) {
            m.Result = IntPtr.Zero; // Block shutdown
            return;
        }
        base.WndProc(ref m);
    }

    protected override void OnFormClosing(FormClosingEventArgs e) {
        ShutdownBlockReasonDestroy(this.Handle);
        base.OnFormClosing(e);
    }
}
"@

$form = New-Object ShutdownBlocker
[System.Windows.Forms.Application]::Run($form)
`.trim()

    blockerProcess = spawn('powershell', [
      '-NoProfile',
      '-NoLogo',
      '-WindowStyle', 'Hidden',
      '-Command', script
    ], {
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

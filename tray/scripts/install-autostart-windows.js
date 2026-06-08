import { execSync, execFileSync } from 'child_process'
import { writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const trayDir = resolve(__dirname, '..')

/**
 * Instaluje MindGate Tray w autostarcie Windows.
 *
 * Strategia:
 * 1. Generuje start-tray.vbs z aktualnymi, bezwzględnymi ścieżkami
 *    (plik jest w .gitignore — per-maszyna, nie commitujemy)
 * 2. Rejestruje: wscript.exe "path\to\start-tray.vbs"
 *    wscript.exe jest zawsze dostępne, uruchamia VBS bez okna konsoli
 */

const regKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const regName = 'MindGateTray'

// Bezwzględne ścieżki dla tej instalacji
const nodePath = process.execPath
const scriptPath = resolve(trayDir, 'src', 'index.js')
const vbsPath = resolve(trayDir, 'start-tray.vbs')

// Generuj VBS dopasowany do tej maszyny
const vbsContent = `' MindGate Tray — autostart (wygenerowany automatycznie, nie edytuj ręcznie)
' Wygenerowany: ${new Date().toISOString()}
Set objShell = CreateObject("WScript.Shell")
objShell.CurrentDirectory = "${trayDir.replace(/\\/g, '\\\\')}"
objShell.Run """${nodePath.replace(/\\/g, '\\\\')}""" & " " & """${scriptPath.replace(/\\/g, '\\\\')}""", 0, False
`

writeFileSync(vbsPath, vbsContent, 'utf8')
console.log(`✅ Wygenerowano: ${vbsPath}`)

// Zarejestruj wscript.exe z wygenerowanym VBS w rejestrze
const command = `wscript.exe "${vbsPath}"`

try {
  execSync(`reg add "${regKey}" /v "${regName}" /t REG_SZ /d "${command}" /f`, {
    stdio: 'inherit'
  })
  console.log('✅ MindGate Tray dodany do autostartu Windows')
  console.log(`   Node:    ${nodePath}`)
  console.log(`   Script:  ${scriptPath}`)
  console.log(`   VBS:     ${vbsPath}`)
  console.log(`   Rejestr: ${regKey}\\${regName}`)
  console.log('')
  console.log('Żeby usunąć:')
  console.log(`   reg delete "${regKey}" /v "${regName}" /f`)
} catch (err) {
  console.error('❌ Nie udało się dodać do autostartu:', err.message)
  process.exit(1)
}

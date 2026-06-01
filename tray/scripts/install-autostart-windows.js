import { execSync } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const trayDir = resolve(__dirname, '..')

/**
 * Dodaje MindGate Tray do autostartu Windows.
 * Tworzy wpis w rejestrze: HKCU\Software\Microsoft\Windows\CurrentVersion\Run
 */

const regKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const regName = 'MindGateTray'
const nodePath = process.execPath
const scriptPath = resolve(trayDir, 'src', 'index.js')
const command = `\\"${nodePath}\\" \\"${scriptPath}\\"`

try {
  execSync(`reg add "${regKey}" /v "${regName}" /t REG_SZ /d "${command}" /f`, {
    stdio: 'inherit'
  })
  console.log('✅ MindGate Tray dodany do autostartu Windows')
  console.log(`   Komenda: ${command}`)
  console.log(`   Klucz rejestru: ${regKey}\\${regName}`)
  console.log('')
  console.log('Żeby usunąć:')
  console.log(`   reg delete "${regKey}" /v "${regName}" /f`)
} catch (err) {
  console.error('❌ Nie udało się dodać do autostartu:', err.message)
  process.exit(1)
}

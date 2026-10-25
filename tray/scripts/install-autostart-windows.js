import { execSync } from 'child_process'
import { writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const trayDir = resolve(__dirname, '..')

/**
 * Installs MindGate Tray into Windows autostart.
 *
 * Strategy:
 * 1. Generate start-tray.vbs with the current absolute paths
 *    (the file is in .gitignore — it belongs to this machine and is not committed)
 * 2. Register: wscript.exe "path\to\start-tray.vbs"
 *    wscript.exe is always available and runs a VBS without a console window
 */

const regKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const regName = 'MindGateTray'

const nodePath = process.execPath
const scriptPath = resolve(trayDir, 'src', 'index.js')
const vbsPath = resolve(trayDir, 'start-tray.vbs')

const vbsContent = `' MindGate Tray — autostart (generated automatically, do not edit by hand)
' Generated: ${new Date().toISOString()}
Set objShell = CreateObject("WScript.Shell")
objShell.CurrentDirectory = "${trayDir.replace(/\\/g, '\\\\')}"
objShell.Run """${nodePath.replace(/\\/g, '\\\\')}""" & " " & """${scriptPath.replace(/\\/g, '\\\\')}""", 0, False
`

writeFileSync(vbsPath, vbsContent, 'utf8')
console.log(`Generated: ${vbsPath}`)

const command = `wscript.exe "${vbsPath}"`

try {
  execSync(`reg add "${regKey}" /v "${regName}" /t REG_SZ /d "${command}" /f`, {
    stdio: 'inherit'
  })
  console.log('MindGate Tray added to Windows autostart')
  console.log(`   Node:    ${nodePath}`)
  console.log(`   Script:  ${scriptPath}`)
  console.log(`   VBS:     ${vbsPath}`)
  console.log(`   Registry: ${regKey}\\${regName}`)
  console.log('')
  console.log('To remove it:')
  console.log(`   reg delete "${regKey}" /v "${regName}" /f`)
} catch (err) {
  console.error('Could not add it to autostart:', err.message)
  process.exit(1)
}

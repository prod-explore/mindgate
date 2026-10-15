// Removes the Windows service installed by install-service.js.
import { Service } from 'node-windows'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const svc = new Service({
  name: 'MindGate Agent',
  script: path.join(__dirname, 'dist', 'index.js')
})

svc.on('uninstall', () => {
  console.log('Service uninstalled')
})

svc.on('error', (err) => {
  console.error('Error:', err)
})

svc.uninstall()

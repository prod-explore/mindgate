import { Service } from 'node-windows'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const svc = new Service({
  name: 'MindGate Agent',
  script: path.join(__dirname, 'src', 'index.js')
})

svc.on('uninstall', () => {
  console.log('✅ Serwis odinstalowany')
})

svc.on('error', (err) => {
  console.error('❌ Błąd:', err)
})

svc.uninstall()

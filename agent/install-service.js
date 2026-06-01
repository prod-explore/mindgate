import { Service } from 'node-windows'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const svc = new Service({
  name: 'MindGate Agent',
  description: 'MindGate AI Agent — lokalny serwis modeli',
  script: path.join(__dirname, 'src', 'index.js'),
  nodeOptions: [],
  env: [
    { name: 'NODE_ENV', value: 'production' },
    { name: 'MINDGATE_CONFIG', value: path.join(__dirname, 'config', 'models.yml') },
    { name: 'MINDGATE_MCP_CONFIG', value: path.join(__dirname, 'config', 'mcp.yml') }
  ]
})

svc.on('install', () => {
  console.log('✅ Serwis zainstalowany, uruchamiam...')
  svc.start()
})

svc.on('alreadyinstalled', () => {
  console.log('ℹ️  Serwis już zainstalowany')
})

svc.on('start', () => {
  console.log('🚀 MindGate Agent uruchomiony jako Windows Service')
})

svc.on('error', (err) => {
  console.error('❌ Błąd:', err)
})

svc.install()

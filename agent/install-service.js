// Installs the agent as a Windows service (node-windows). Run as administrator, after `npm run build`.
// The agent reads its settings from agent/.env itself — the service needs no variables of its own besides NODE_ENV.
import { Service } from 'node-windows'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(__dirname, 'dist', 'index.js')

if (!existsSync(script)) {
  console.error('dist/index.js is missing — run `npm install` and `npm run build` first.')
  process.exit(1)
}
if (!existsSync(path.join(__dirname, '.env'))) {
  console.error('agent/.env is missing — copy .env.example and set MINDGATE_NODE_SECRET.')
  process.exit(1)
}

const svc = new Service({
  name: 'MindGate Agent',
  description: 'MindGate Agent — manages the models on this computer for the hub',
  script,
  nodeOptions: [],
  env: [{ name: 'NODE_ENV', value: 'production' }]
})

svc.on('install', () => {
  console.log('Service installed, starting it...')
  svc.start()
})

svc.on('alreadyinstalled', () => {
  console.log('The service is already installed')
})

svc.on('start', () => {
  console.log('MindGate Agent is running as a Windows service')
})

svc.on('error', (err) => {
  console.error('Error:', err)
})

svc.install()

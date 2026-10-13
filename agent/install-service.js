// Instaluje agenta jako usługę Windows (node-windows). Uruchom jako administrator, po `npm run build`.
// Ustawienia czyta sam agent z pliku agent/.env — usługa nie potrzebuje własnych zmiennych poza NODE_ENV.
import { Service } from 'node-windows'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(__dirname, 'dist', 'index.js')

if (!existsSync(script)) {
  console.error('❌ Brak dist/index.js — najpierw `npm install` i `npm run build`.')
  process.exit(1)
}
if (!existsSync(path.join(__dirname, '.env'))) {
  console.error('❌ Brak agent/.env — skopiuj .env.example i ustaw MINDGATE_NODE_SECRET.')
  process.exit(1)
}

const svc = new Service({
  name: 'MindGate Agent',
  description: 'MindGate Agent — zarządza modelami na tym komputerze dla huba',
  script,
  nodeOptions: [],
  env: [{ name: 'NODE_ENV', value: 'production' }]
})

svc.on('install', () => {
  console.log('✅ Usługa zainstalowana, uruchamiam...')
  svc.start()
})

svc.on('alreadyinstalled', () => {
  console.log('ℹ️  Usługa już zainstalowana')
})

svc.on('start', () => {
  console.log('🚀 MindGate Agent działa jako usługa Windows')
})

svc.on('error', (err) => {
  console.error('❌ Błąd:', err)
})

svc.install()

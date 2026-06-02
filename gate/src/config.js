import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import yaml from 'js-yaml'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Ładuje konfigurację z YAML + nadpisania ze zmiennych środowiskowych.
 * Szuka config.yml w gate/config/
 */
function loadConfig() {
  const configPath = process.env.MINDGATE_CONFIG
    || resolve(__dirname, '..', 'config', 'config.yml')

  let raw
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch (err) {
    console.error(`[config] Nie mogę wczytać ${configPath}`)
    console.error(`[config] Skopiuj config.example.yml → config.yml i uzupełnij wartości`)
    process.exit(1)
  }

  const cfg = yaml.load(raw)

  // Nadpisania ze zmiennych środowiskowych
  if (process.env.MINDGATE_AGENT_URL) {
    cfg.agent.url = process.env.MINDGATE_AGENT_URL
  }
  if (process.env.MINDGATE_AGENT_SECRET) {
    cfg.agent.secret = process.env.MINDGATE_AGENT_SECRET
  }
  if (process.env.MINDGATE_WOL_MAC) {
    cfg.wol.mac = process.env.MINDGATE_WOL_MAC
  }
  if (process.env.MINDGATE_API_KEYS) {
    try {
      cfg.auth.keys = JSON.parse(process.env.MINDGATE_API_KEYS)
    } catch {
      console.error('[config] MINDGATE_API_KEYS musi być poprawnym JSON array')
      process.exit(1)
    }
  }

  // Walidacja wymaganych pól
  if (!cfg.agent?.url) {
    console.error('[config] Brak agent.url w konfiguracji')
    process.exit(1)
  }
  if (!cfg.agent?.secret) {
    console.error('[config] Brak agent.secret w konfiguracji')
    process.exit(1)
  }
  if (!cfg.auth?.keys?.length) {
    console.error('[config] Brak kluczy API w auth.keys')
    process.exit(1)
  }
  if (!cfg.wol?.mac) {
    console.error('[config] Brak wol.mac — MAC adres maszyny obliczeniowej')
    process.exit(1)
  }

  // Domyślne wartości
  cfg.server = {
    port: 3000,
    host: '0.0.0.0',
    ...cfg.server
  }
  cfg.agent = {
    timeout_ms: 120000,
    ...cfg.agent
  }
  cfg.wol = {
    broadcast: '192.168.1.255',
    port: 9,
    min_priority: 3,
    boot_timeout_ms: 120000,
    poll_interval_ms: 2000,
    ...cfg.wol
  }
  cfg.queue = {
    max_size: 100,
    request_timeout_ms: 300000,
    ...cfg.queue
  }
  cfg.shutdown = {
    idle_minutes: 15,
    ...cfg.shutdown
  }
  cfg.models = cfg.models || ['flash', 'reasoning', 'coding-fast', 'coding-hard', 'extreme']
  cfg.pipelines = cfg.pipelines || ['reasoning+flash', 'coding-hard+flash']

  return Object.freeze(cfg)
}

export const config = loadConfig()

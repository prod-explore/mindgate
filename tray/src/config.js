import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import yaml from 'js-yaml'

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadConfig() {
  const configPath = process.env.MINDGATE_TRAY_CONFIG
    || resolve(__dirname, '..', 'config', 'tray.yml')

  let raw
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch {
    console.error(`[config] Nie mogę wczytać ${configPath}`)
    console.error(`[config] Skopiuj tray.example.yml → tray.yml`)
    process.exit(1)
  }

  const cfg = yaml.load(raw)

  // Domyślne wartości
  cfg.agent = {
    url: 'http://localhost:3001',
    poll_interval_ms: 5000,
    ...cfg.agent
  }
  cfg.ipc = {
    port: 3002,
    ...cfg.ipc
  }
  cfg.shutdown_guard = {
    idle_threshold_seconds: 120,
    whitelist_processes: [],
    respect_manual_boot: true,
    ...cfg.shutdown_guard
  }

  return cfg
}

export const config = loadConfig()

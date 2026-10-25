import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import yaml from 'js-yaml'

/**
 * The tray's configuration: config/tray.yml (or the file MINDGATE_TRAY_CONFIG names) with defaults filled in. A missing
 * file or a missing agent secret stops the tray with a message.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadConfig() {
  const configPath = process.env.MINDGATE_TRAY_CONFIG
    || resolve(__dirname, '..', 'config', 'tray.yml')

  let raw
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch {
    console.error(`[config] Cannot read ${configPath}`)
    console.error(`[config] Copy tray.example.yml to tray.yml`)
    process.exit(1)
  }

  const cfg = yaml.load(raw)

  cfg.agent = {
    url: 'http://localhost:3001',
    poll_interval_ms: 5000,
    ...cfg.agent
  }
  // the same secret as MINDGATE_NODE_SECRET in agent/.env; set in the environment, it wins over the file
  const envSecret = process.env.MINDGATE_NODE_SECRET
  if (envSecret) {
    cfg.agent.secret = envSecret
  }
  if (!cfg.agent.secret) {
    console.error('[config] agent.secret is missing from the tray configuration')
    process.exit(1)
  }
  // the hub address (for the "Open the MindGate panel" item); without it there is no such item
  cfg.hub = { url: '', ...cfg.hub }
  cfg.ipc = {
    port: 3002,
    ...cfg.ipc
  }
  cfg.shutdown_guard = {
    idle_threshold_seconds: 120,
    ...cfg.shutdown_guard
  }

  return cfg
}

export const config = loadConfig()

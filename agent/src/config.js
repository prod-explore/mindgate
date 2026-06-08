import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import yaml from 'js-yaml'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Ładuje konfigurację modeli i MCP z YAML.
 */
function loadConfig() {
  const modelsPath = process.env.MINDGATE_CONFIG
    || resolve(__dirname, '..', 'config', 'models.yml')

  let raw
  try {
    raw = readFileSync(modelsPath, 'utf8')
  } catch (err) {
    console.error(`[config] Nie mogę wczytać ${modelsPath}`)
    console.error(`[config] Skopiuj models.example.yml → models.yml i uzupełnij`)
    process.exit(1)
  }

  const cfg = yaml.load(raw)

  // Domyślne wartości
  cfg.server = {
    port: 3001,
    host: '0.0.0.0',
    ...cfg.server
  }
  if (process.env.MINDGATE_SERVER_SECRET) {
    cfg.server.secret = process.env.MINDGATE_SERVER_SECRET
  }
  if (!cfg.server.secret) {
    console.error('[config] Brak server.secret w konfiguracji agenta')
    process.exit(1)
  }
  cfg.ollama = {
    url: 'http://localhost:11434',
    request_timeout_ms: 600000,
    ...cfg.ollama
  }
  cfg.tray = {
    url: 'http://localhost:3002',
    ...cfg.tray
  }
  cfg.models = cfg.models || {}
  cfg.pipelines = cfg.pipelines || {}

  // Walidacja modeli
  for (const [profile, modelCfg] of Object.entries(cfg.models)) {
    if (!modelCfg.ollama) {
      console.error(`[config] Model "${profile}" nie ma pola "ollama" (nazwa modelu w Ollama)`)
      process.exit(1)
    }
  }

  return cfg
}

/**
 * Ładuje konfigurację MCP (opcjonalna).
 */
function loadMcpConfig() {
  const mcpPath = process.env.MINDGATE_MCP_CONFIG
    || resolve(__dirname, '..', 'config', 'mcp.yml')

  if (!existsSync(mcpPath)) {
    return { mcp_servers: {}, permissions: {} }
  }

  try {
    const raw = readFileSync(mcpPath, 'utf8')
    const cfg = yaml.load(raw) || {}
    return {
      mcp_servers: cfg.mcp_servers || {},
      permissions: cfg.permissions || {}
    }
  } catch (err) {
    console.warn(`[config] Błąd wczytywania MCP config: ${err.message}`)
    return { mcp_servers: {}, permissions: {} }
  }
}

export const config = loadConfig()
export const mcpConfig = loadMcpConfig()

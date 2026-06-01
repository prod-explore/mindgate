import { spawn } from 'child_process'
import { mcpConfig } from './config.js'
import pino from 'pino'

const log = pino({ name: 'mcp' })

/**
 * MCP Tool Orchestration — zarządza serwerami MCP i wywołaniami narzędzi.
 * Używa natywnego tool calling z Ollama.
 */

/** @type {Map<string, { process: import('child_process').ChildProcess, ready: boolean }>} */
const runningServers = new Map()

/**
 * Startuje skonfigurowane MCP servers.
 */
export async function startMcpServers() {
  const servers = mcpConfig.mcp_servers

  if (!servers || Object.keys(servers).length === 0) {
    log.info('Brak skonfigurowanych MCP servers')
    return
  }

  for (const [name, serverCfg] of Object.entries(servers)) {
    try {
      await startServer(name, serverCfg)
    } catch (err) {
      log.error({ server: name, err: err.message }, 'Nie udało się uruchomić MCP server')
    }
  }
}

/**
 * Startuje pojedynczy MCP server.
 */
async function startServer(name, serverCfg) {
  const env = { ...process.env }

  // Rozwiąż zmienne środowiskowe (${VAR_NAME} → wartość)
  if (serverCfg.env) {
    for (const [key, value] of Object.entries(serverCfg.env)) {
      const resolved = value.replace(/\$\{(\w+)\}/g, (_, varName) => process.env[varName] || '')
      env[key] = resolved
    }
  }

  const proc = spawn(serverCfg.command, serverCfg.args || [], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32'
  })

  proc.stderr.on('data', (data) => {
    log.debug({ server: name }, data.toString().trim())
  })

  proc.on('error', (err) => {
    log.error({ server: name, err: err.message }, 'MCP server error')
    runningServers.delete(name)
  })

  proc.on('exit', (code) => {
    log.warn({ server: name, code }, 'MCP server zakończony')
    runningServers.delete(name)
  })

  runningServers.set(name, { process: proc, ready: true })
  log.info({ server: name, command: serverCfg.command }, 'MCP server uruchomiony')
}

/**
 * Sprawdza czy model ma dostęp do danego MCP server.
 */
export function hasPermission(modelProfile, serverName) {
  const perms = mcpConfig.permissions[modelProfile]
  if (!perms) return false
  if (perms.includes('*')) return true
  return perms.includes(serverName)
}

/**
 * Zwraca listę narzędzi dostępnych dla danego profilu modelu.
 * Format kompatybilny z Ollama tools.
 */
export function getToolsForModel(modelProfile) {
  const tools = []
  const perms = mcpConfig.permissions[modelProfile]

  if (!perms) return tools

  for (const [serverName, serverCfg] of Object.entries(mcpConfig.mcp_servers)) {
    if (!perms.includes('*') && !perms.includes(serverName)) continue
    if (!runningServers.has(serverName)) continue

    // Narzędzia z konfiguracji serwera
    if (serverCfg.tools) {
      for (const toolName of serverCfg.tools) {
        tools.push({
          type: 'function',
          function: {
            name: `${serverName}__${toolName}`,
            description: `Tool from ${serverName}: ${toolName}`,
            parameters: {
              type: 'object',
              properties: {}
            }
          }
        })
      }
    }
  }

  return tools
}

/**
 * Zatrzymuje wszystkie MCP servers.
 */
export function stopMcpServers() {
  for (const [name, server] of runningServers) {
    log.info({ server: name }, 'Zatrzymuję MCP server')
    server.process.kill('SIGTERM')
  }
  runningServers.clear()
}

/**
 * Zwraca listę aktywnych serwerów.
 */
export function getActiveServers() {
  return [...runningServers.keys()]
}

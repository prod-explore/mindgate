import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import { loadConfig } from './config.js';
import { buildAgent } from './server.js';

// agent/.env, wherever the process was started from (a Windows service does not start in this folder)
const envFile = process.env['MINDGATE_ENV_FILE'] ?? resolve(fileURLToPath(new URL('..', import.meta.url)), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(`[mindgate-agent] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  const log = pino({ level: config.logLevel, redact: ['req.headers.authorization'] });
  let closing = false;

  const shutdown = async (why: string, stopService = false): Promise<void> => {
    if (closing) return;
    closing = true;
    log.info({ why }, 'agent is stopping');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    await agent.close().catch(() => undefined);
    // Run as a Windows service, the service manager would start the agent again after an exit. The tray's "quit" means quit.
    if (stopService && process.platform === 'win32') {
      exec('powershell -NoProfile -Command "Stop-Service mindgateagent.exe -Force"', { windowsHide: true }, () => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
      return;
    }
    process.exit(0);
  };

  const agent = await buildAgent(config, { logger: log, onExit: () => void shutdown('exit requested', true) });
  await agent.app.listen({ host: config.host, port: config.port });
  log.info({ node: config.nodeId, port: config.port, ollama: config.ollama.url, manage: config.ollama.manage, tray: config.trayUrl }, 'MindGate agent is up');

  // Bring the runtime up now rather than at the first request, so the first request does not pay for it.
  agent.runtime.ensureRunning().catch(e => log.warn({ err: e instanceof Error ? e.message : String(e) }, 'the model runtime is not available yet; it will be tried again with the next request'));

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// A start that fails (port taken, database not writable) is an operator's problem: one line, no stack trace.
main().catch((e: unknown) => {
  console.error(`[mindgate-agent] could not start: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

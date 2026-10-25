import { pino } from 'pino';
import { loadConfig } from './config.js';
import { createHub } from './context.js';
import { buildServer } from './server.js';

/**
 * Entry point of the hub: reads the environment, wires the hub, starts the background jobs (log pruning, node
 * monitor, model sync) and serves HTTP until SIGINT or SIGTERM.
 */

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(`[mindgate] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  const log = pino({ level: config.logLevel, redact: ['req.headers.authorization'] });
  const hub = createHub(config, log);
  const app = await buildServer(hub, { logger: log });

  const prune = () => {
    const removed = hub.usage.pruneLog(config.logRetentionDays);
    if (removed) log.info({ removed, days: config.logRetentionDays }, 'old request log lines removed');
  };
  prune();
  const pruneTimer = setInterval(prune, 24 * 3_600_000);
  pruneTimer.unref();

  hub.nodes.start();
  hub.sync.start(config.syncIntervalHours);

  await app.listen({ host: config.host, port: config.port });
  log.info(
    { port: config.port, providers: hub.providers.list().length, models: hub.models.list().length, keys: hub.keys.list().filter(k => !k.revokedAt).length, tz: config.usageTz },
    'MindGate is up',
  );
  if (!hub.keys.list().some(k => !k.revokedAt)) {
    log.warn({}, 'there is no client API key yet — create one with: node dist/cli.js keys create <name>');
  }

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'shutting down');
    clearInterval(pruneTimer);
    hub.nodes.stop();
    hub.nodeClient.stop();
    hub.sync.stop();
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    await app.close();
    hub.db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// A start that fails (port taken, database not writable) is an operator's problem: one line, no stack trace.
main().catch((e: unknown) => {
  console.error(`[mindgate] could not start: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { adapterFor } from './adapters/index.js';
import { loadConfig } from './config.js';
import { createHub, silentLogger, type Hub } from './context.js';
import { isHubError } from './errors.js';
import { withDeadline } from './upstream.js';
import type { ApiKeyRecord } from './types.js';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const consoleIo: CliIo = { out: l => console.log(l), err: l => console.error(l) };

const HELP = `MindGate command line (run it where the hub runs, with the same environment variables)

  keys list
  keys create <name> [--rpm N] [--rpd N] [--tokens-day N] [--tokens-month N] [--local-only]
                     [--priority N] [--min-priority N] [--max-priority N] [--models a,b,provider/*]
  keys revoke <name|id>
  keys delete <name|id>

  backup [file] [--keep N]      Consistent copy of the database (safe while the hub runs).
                                Provider API keys inside are encrypted: keep MINDGATE_MASTER_KEY with the backup.
  check [--online]              Looks at the configuration and the database; --online also calls every provider.
`;

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

const BOOLEAN_FLAGS = new Set(['local-only', 'online', 'help']);

function parseArgs(args: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = (eq === -1 ? a.slice(2) : a.slice(2, eq)).trim();
    if (eq !== -1) flags.set(name, a.slice(eq + 1));
    else if (BOOLEAN_FLAGS.has(name)) flags.set(name, true);
    else {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) throw new UsageError(`--${name} needs a value`);
      flags.set(name, next);
      i++;
    }
  }
  return { positional, flags };
}

class UsageError extends Error {}

function intFlag(p: Parsed, name: string): number | undefined {
  const v = p.flags.get(name);
  if (v === undefined) return undefined;
  const n = typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${name} must be a positive integer`);
  return n;
}

const when = (iso: string | null): string => (iso ? iso.replace('T', ' ').slice(0, 16) : 'never');

function describeLimits(k: ApiKeyRecord): string {
  const parts = [
    k.rpm !== null ? `${k.rpm}/min` : null,
    k.rpd !== null ? `${k.rpd}/day` : null,
    k.tokensPerDay !== null ? `${k.tokensPerDay} tok/day` : null,
    k.tokensPerMonth !== null ? `${k.tokensPerMonth} tok/month` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'no limits';
}

function keysCommand(hub: Hub, p: Parsed, io: CliIo): number {
  const [, sub, name] = p.positional;
  switch (sub) {
    case 'list': {
      const keys = hub.keys.list();
      if (!keys.length) {
        io.out('No client keys yet. Create one: keys create <name>');
        return 0;
      }
      for (const k of keys) {
        io.out(
          `${k.revokedAt ? '✗' : '✓'} ${k.name.padEnd(20)} ${k.prefix}…  priority ${k.minPriority}-${k.maxPriority} (default ${k.defaultPriority})` +
            `${k.localOnly ? '  local-only' : ''}  ${describeLimits(k)}  last used ${when(k.lastUsedAt)}${k.revokedAt ? `  REVOKED ${when(k.revokedAt)}` : ''}`,
        );
      }
      return 0;
    }
    case 'create': {
      if (!name) throw new UsageError('keys create needs a name');
      const priority = intFlag(p, 'priority');
      const models = p.flags.get('models');
      const input = {
        name,
        localOnly: p.flags.get('local-only') === true,
        ...(priority !== undefined ? { defaultPriority: priority } : {}),
        ...(intFlag(p, 'min-priority') !== undefined ? { minPriority: intFlag(p, 'min-priority')! } : {}),
        ...(intFlag(p, 'max-priority') !== undefined ? { maxPriority: intFlag(p, 'max-priority')! } : {}),
        ...(intFlag(p, 'rpm') !== undefined ? { rpm: intFlag(p, 'rpm')! } : {}),
        ...(intFlag(p, 'rpd') !== undefined ? { rpd: intFlag(p, 'rpd')! } : {}),
        ...(intFlag(p, 'tokens-day') !== undefined ? { tokensPerDay: intFlag(p, 'tokens-day')! } : {}),
        ...(intFlag(p, 'tokens-month') !== undefined ? { tokensPerMonth: intFlag(p, 'tokens-month')! } : {}),
        ...(typeof models === 'string' ? { allowedModels: models.split(',').map(s => s.trim()).filter(Boolean) } : {}),
      };
      const { record, key } = hub.keys.create(input);
      io.out(`Key "${record.name}" created. This is the only time it is shown:`);
      io.out('');
      io.out(`  ${key}`);
      io.out('');
      io.out(`Use it as:  Authorization: Bearer ${record.prefix}…   (${describeLimits(record)}${record.localOnly ? ', local-only' : ''})`);
      return 0;
    }
    case 'revoke': {
      if (!name) throw new UsageError('keys revoke needs a name or id');
      const k = hub.keys.revoke(name);
      io.out(`Key "${k.name}" revoked; requests with it are refused from now on.`);
      return 0;
    }
    case 'delete': {
      if (!name) throw new UsageError('keys delete needs a name or id');
      hub.keys.delete(name);
      io.out(`Key "${name}" deleted.`);
      return 0;
    }
    default:
      throw new UsageError('keys: list | create <name> | revoke <name|id> | delete <name|id>');
  }
}

// ─── backup ──────────────────────────────────────────────────────────────────

const stamp = (d = new Date()): string => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

export async function backupDatabase(hub: Hub, target: string): Promise<{ file: string; schemaVersion: number; providers: number; keys: number }> {
  if (hub.config.dbPath === ':memory:') throw new UsageError('The database is in memory: there is nothing to back up');
  if (existsSync(target)) throw new UsageError(`${target} already exists; pick another name`);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  await hub.db.backup(target);
  try {
    chmodSync(target, 0o600);
  } catch {
    /* some file systems have no modes */
  }
  // The copy inherits WAL mode from the live database; turn that off so the backup is ONE self-contained file
  // (opening a WAL database would otherwise leave -wal/-shm companions next to it).
  const copy = new Database(target);
  try {
    copy.pragma('journal_mode = DELETE');
    const ok = copy.pragma('integrity_check', { simple: true });
    if (ok !== 'ok') throw new Error(`the copy failed its integrity check: ${String(ok)}`);
    return {
      file: target,
      schemaVersion: copy.pragma('user_version', { simple: true }) as number,
      providers: (copy.prepare('SELECT COUNT(*) AS n FROM providers').get() as { n: number }).n,
      keys: (copy.prepare('SELECT COUNT(*) AS n FROM api_keys').get() as { n: number }).n,
    };
  } finally {
    copy.close();
  }
}

export function pruneBackups(dir: string, keep: number): string[] {
  const files = readdirSync(dir).filter(f => /^mindgate-\d{8}-\d{6}\.db$/.test(f)).sort();
  const old = files.slice(0, Math.max(0, files.length - keep));
  for (const f of old) rmSync(join(dir, f), { force: true });
  return old;
}

async function backupCommand(hub: Hub, p: Parsed, io: CliIo): Promise<number> {
  const keep = intFlag(p, 'keep');
  const dir = join(dirname(hub.config.dbPath), 'backups');
  const target = p.positional[1] ? resolve(p.positional[1]) : join(dir, `mindgate-${stamp()}.db`);
  const r = await backupDatabase(hub, target);
  io.out(`Backup written: ${r.file}  (schema ${r.schemaVersion}, ${r.providers} providers, ${r.keys} keys, integrity ok)`);
  io.out('Provider API keys in it are encrypted with MINDGATE_MASTER_KEY — a backup is useless without that key, so store the two separately.');
  if (keep !== undefined && dirname(target) === dir) {
    const removed = pruneBackups(dir, keep);
    if (removed.length) io.out(`Removed ${removed.length} older backup${removed.length === 1 ? '' : 's'} (keeping ${keep}).`);
  }
  return 0;
}

// ─── check ───────────────────────────────────────────────────────────────────

async function checkCommand(hub: Hub, p: Parsed, io: CliIo): Promise<number> {
  const online = p.flags.get('online') === true;
  let problems = 0;
  const size = hub.config.dbPath === ':memory:' ? 0 : statSync(hub.config.dbPath).size;
  io.out(`database   ${hub.config.dbPath}  (${(size / 1024).toFixed(0)} KiB, schema ${hub.db.pragma('user_version', { simple: true })})`);
  io.out(`time zone  ${hub.config.usageTz} (daily and monthly budgets reset at midnight there)`);
  const providers = hub.providers.list();
  if (!providers.length) io.out('providers  none yet — add one in the admin panel or through the admin API');
  for (const pr of providers) {
    const broken = pr.hasSecret && hub.providers.secretBroken(pr.id);
    const models = hub.models.list(pr.id);
    let line = `provider   ${pr.id.padEnd(14)} ${pr.type} ${pr.locality}${pr.node ? ' node' : ''}${pr.enabled ? '' : ' DISABLED'}  ${models.filter(m => m.enabled).length}/${models.length} models  key: ${broken ? 'CANNOT BE DECRYPTED' : pr.hasSecret ? 'ok' : 'none'}`;
    if (broken) problems++;
    if (online && pr.enabled) {
      const started = Date.now();
      try {
        if (pr.node) {
          line += (await hub.nodes.probe(pr)) ? '  [online]' : '  [asleep or unreachable]';
        } else {
          const found = await withDeadline(15_000, pr.id, signal => adapterFor(pr.type).listModels(hub.registry.runtime(pr), signal));
          line += `  [reachable, ${found.length} models, ${Date.now() - started} ms]`;
        }
      } catch (e) {
        line += `  [FAILED: ${e instanceof Error ? e.message : String(e)}]`;
        problems++;
      }
    }
    io.out(line);
  }
  const keys = hub.keys.list().filter(k => !k.revokedAt);
  io.out(`keys       ${keys.length} active${keys.length ? '' : ' — create one: keys create <name>'}`);
  io.out(problems ? `${problems} problem${problems === 1 ? '' : 's'} found.` : 'No problems found.');
  return problems ? 1 : 0;
}

// ─── entry ───────────────────────────────────────────────────────────────────

export async function runCli(argv: string[], env: NodeJS.ProcessEnv = process.env, io: CliIo = consoleIo): Promise<number> {
  let hub: Hub | null = null;
  try {
    const p = parseArgs(argv);
    const command = p.positional[0];
    if (!command || command === 'help' || p.flags.has('help')) {
      io.out(HELP);
      return command || p.flags.has('help') ? 0 : 2;
    }
    if (!['keys', 'backup', 'check'].includes(command)) throw new UsageError(`Unknown command "${command}"`);
    const config = loadConfig(env, m => io.err(`warning: ${m}`));
    hub = createHub(config, silentLogger);
    switch (command) {
      case 'keys':
        return keysCommand(hub, p, io);
      case 'backup':
        return await backupCommand(hub, p, io);
      default:
        return await checkCommand(hub, p, io);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(e.message);
      io.err('Run "help" for the list of commands.');
      return 2;
    }
    io.err(isHubError(e) ? `${e.message} (${e.code})` : e instanceof Error ? e.message : String(e));
    return 1;
  } finally {
    hub?.nodes.stop();
    hub?.nodeClient.stop();
    hub?.db.close();
  }
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  runCli(process.argv.slice(2)).then(code => process.exit(code), e => {
    console.error(e);
    process.exit(1);
  });
}


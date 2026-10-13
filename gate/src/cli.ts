#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import yaml from 'js-yaml';
import { adapterFor } from './adapters/index.js';
import { loadConfig } from './config.js';
import { createHub, silentLogger, type Hub } from './context.js';
import { isHubError } from './errors.js';
import { withDeadline } from './upstream.js';
import type { ApiKeyRecord } from './types.js';
import { isPlainObject } from './util.js';

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

  import-legacy <config.yml> [--provider agent] [--agent-models models.yml] [--dry-run]
      Moves the old gate's config.yml (agent, Wake-on-LAN, API keys) into the database.
      Existing client keys keep working: they are stored as hashes, the config file is not needed afterwards.
      Models are discovered from the machine; --agent-models (the old agent's models.yml) keeps the old
      profile names (flash, reasoning...) working as aliases for the Ollama models they meant.

  backup [file] [--keep N]      Consistent copy of the database (safe while the hub runs).
                                Provider API keys inside are encrypted: keep MINDGATE_MASTER_KEY with the backup.
  check [--online]              Looks at the configuration and the database; --online also calls every provider.
`;

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

const BOOLEAN_FLAGS = new Set(['local-only', 'dry-run', 'online', 'help']);

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

// ─── import-legacy ───────────────────────────────────────────────────────────

const PLACEHOLDER_KEY = /^mg-(x+|y+|z+)$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_TIMEOUT_MS = 3_600_000;

type Y = Record<string, unknown>;
const obj = (v: unknown): Y => (isPlainObject(v) ? v : {});
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export interface LegacyImportResult {
  provider: string;
  models: string[];
  aliases: string[];
  keysImported: string[];
  keysSkipped: Array<{ name: string; reason: string }>;
  notes: string[];
}

/** What the old agent's models.yml said: profile name -> the model tag in Ollama. */
function readAgentProfiles(path: string): Array<{ profile: string; tag: string; description?: string }> {
  let doc: unknown;
  try {
    doc = yaml.load(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new UsageError(`Cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const out: Array<{ profile: string; tag: string; description?: string }> = [];
  for (const [profile, raw] of Object.entries(obj(obj(doc)['models']))) {
    const tag = text(obj(raw)['ollama']);
    if (tag) out.push({ profile, tag, ...(text(obj(raw)['description']) ? { description: text(obj(raw)['description'])! } : {}) });
  }
  return out;
}

/**
 * The old gate had one machine (the agent) behind it, a list of profile names, and plain-text client keys.
 * That becomes: one provider that is a node (Wake-on-LAN, idle shutdown, managed through its agent) and the client
 * keys, now stored as hashes.
 *
 * The models are not copied: they live on the node now and the hub learns them from it. A profile name that clients
 * still use (flash, reasoning...) can be kept as an alias for a real model with `agentModelsPath` (the old agent's
 * models.yml says which Ollama model each profile meant). Pipelines and MCP tools no longer exist; they are reported.
 */
export function importLegacy(hub: Hub, configPath: string, providerId: string, dryRun: boolean, agentModelsPath?: string): LegacyImportResult {
  let doc: unknown;
  try {
    doc = yaml.load(readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new UsageError(`Cannot read ${configPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const cfg = obj(doc);
  const agent = obj(cfg['agent']);
  const wol = obj(cfg['wol']);
  const shutdown = obj(cfg['shutdown']);
  const queue = obj(cfg['queue']);
  const server = obj(cfg['server']);
  const notes: string[] = [];

  if (!SLUG.test(providerId)) throw new UsageError(`--provider must be lowercase letters, digits and dashes (got "${providerId}")`);
  const agentUrl = text(agent['url']);
  if (!agentUrl) throw new UsageError('The config has no agent.url: nothing to import');
  const base = agentUrl.replace(/\/+$/, '');
  if (hub.providers.get(providerId)) throw new UsageError(`A provider "${providerId}" already exists. Pick another with --provider, or delete it first.`);

  const secret = text(agent['secret']);
  const timeout = num(agent['timeout_ms']) ?? 0;
  // the old gate waited without limit; the hub caps a single wait at one hour
  const waitMs = timeout > 0 ? Math.min(timeout, MAX_TIMEOUT_MS) : MAX_TIMEOUT_MS;
  const mac = text(wol['mac']);
  const idleMinutes = num(shutdown['idle_minutes']);

  // health and shutdown addresses come from control_url: the agent knows them
  const node = mac
    ? {
        mac,
        broadcast: text(wol['broadcast']) ?? '255.255.255.255',
        port: num(wol['port']) ?? 9,
        minWakePriority: num(wol['min_priority']) ?? 3,
        bootTimeoutMs: num(wol['boot_timeout_ms']) ?? 120_000,
        pollIntervalMs: num(wol['poll_interval_ms']) ?? 2000,
        controlUrl: base,
        ...(idleMinutes && idleMinutes > 0 ? { idleShutdownMinutes: Math.floor(idleMinutes) } : {}),
      }
    : null;
  if (!node) notes.push('The config has no wol.mac, so the machine is not woken automatically and its models cannot be managed from the hub until node settings are added (control_url).');

  const names = (v: unknown): string[] => (Array.isArray(v) ? v : []).filter((m): m is string => typeof m === 'string' && m.trim() !== '').map(m => m.trim());
  const oldProfiles = names(cfg['models']);
  const profiles = agentModelsPath ? readAgentProfiles(agentModelsPath) : [];
  const pipelines = [...names(cfg['pipelines'])];
  if (agentModelsPath) {
    try {
      pipelines.push(...Object.keys(obj(obj(yaml.load(readFileSync(agentModelsPath, 'utf8')))['pipelines'])));
    } catch {
      /* already reported by readAgentProfiles */
    }
  }

  const keysCfg = Array.isArray(obj(cfg['auth'])['keys']) ? (obj(cfg['auth'])['keys'] as unknown[]) : [];
  const result: LegacyImportResult = { provider: providerId, models: [], aliases: [], keysImported: [], keysSkipped: [], notes };

  const run = () => {
    hub.providers.create({
      id: providerId,
      name: 'Compute machine (imported)',
      type: 'openai',
      baseUrl: `${base}/v1`,
      locality: 'local',
      // the new agent takes the same shared secret as a bearer token
      authScheme: secret ? 'bearer' : 'none',
      ...(secret ? { apiKey: secret } : {}),
      // a cold start of a big model and a long answer are normal on a local machine
      options: { firstByteTimeoutMs: waitMs, idleTimeoutMs: waitMs },
      maxConcurrency: 1,
      node,
    });
    for (const { profile, tag, description } of profiles) {
      const id = `${providerId}/${tag}`;
      const model = hub.models.getRecord(id) ? hub.models.require(id) : hub.models.addManual(providerId, tag, { name: tag, kind: 'chat' });
      if (!result.models.includes(model.id)) result.models.push(model.id);
      if (!hub.aliases.get(profile)) {
        hub.aliases.create({ name: profile, description: description ?? `Imported profile "${profile}"`, tags: ['legacy'], targets: [model.id] });
        result.aliases.push(profile);
      } else {
        notes.push(`An alias "${profile}" already exists; it was left alone.`);
      }
    }
    for (const raw of keysCfg) {
      const k = obj(raw);
      const name = text(k['name']);
      const key = text(k['key']);
      if (!name || !key) {
        result.keysSkipped.push({ name: name ?? '(no name)', reason: 'name or key missing' });
        continue;
      }
      if (PLACEHOLDER_KEY.test(key)) {
        result.keysSkipped.push({ name, reason: 'still the placeholder from config.example.yml' });
        continue;
      }
      try {
        const min = num(k['min_priority']);
        const max = num(k['max_priority']);
        const def = num(k['default_priority']);
        hub.keys.create({ name, key, ...(min !== undefined ? { minPriority: min } : {}), ...(max !== undefined ? { maxPriority: max } : {}), ...(def !== undefined ? { defaultPriority: def } : {}) });
        result.keysImported.push(name);
      } catch (e) {
        result.keysSkipped.push({ name, reason: isHubError(e) ? e.message : String(e) });
      }
    }
  };

  if (dryRun) {
    // run it for real inside a transaction that is thrown away, so the dry run reports exactly what would happen
    const rollback = new Error('dry run');
    try {
      hub.db.transaction(() => {
        run();
        throw rollback;
      })();
    } catch (e) {
      if (e !== rollback) throw e;
    }
  } else {
    hub.db.transaction(run)();
  }

  if (!agentModelsPath && oldProfiles.length) {
    notes.push(`The old profile names (${oldProfiles.join(', ')}) are not carried over: models are discovered from the machine now. To keep a name working for clients, pass the old agent's models.yml with --agent-models, or create an alias in the admin API.`);
  }
  if (pipelines.length) notes.push(`Pipelines (${[...new Set(pipelines)].join(', ')}) no longer exist; chain models in the client. An alias with several targets is a fallback list, not a sequence.`);
  notes.push('Start the new agent on the machine (same secret as MINDGATE_NODE_SECRET), then sync the provider to see its models.');
  const q = num(queue['max_size']);
  if (q !== undefined) notes.push(`queue.max_size (${q}) is now the environment variable MINDGATE_QUEUE_MAX.`);
  const qt = num(queue['request_timeout_ms']);
  if (qt) notes.push(`queue.request_timeout_ms (${qt}) is now MINDGATE_QUEUE_TIMEOUT_MS.`);
  const port = num(server['port']);
  if (port !== undefined && port !== 3000) notes.push(`server.port (${port}) is now MINDGATE_PORT.`);
  notes.push(`Waits for the machine are capped at ${Math.round(waitMs / 60000)} minutes per request (the old gate had no limit).`);
  return result;
}

function importCommand(hub: Hub, p: Parsed, io: CliIo): number {
  const file = p.positional[1];
  if (!file) throw new UsageError('import-legacy needs the path of the old config.yml');
  const providerId = typeof p.flags.get('provider') === 'string' ? (p.flags.get('provider') as string) : 'agent';
  const dry = p.flags.get('dry-run') === true;
  const agentModels = p.flags.get('agent-models');
  if (agentModels === true) throw new UsageError('--agent-models needs the path of the old agent\'s models.yml');
  const r = importLegacy(hub, resolve(file), providerId, dry, typeof agentModels === 'string' ? resolve(agentModels) : undefined);
  io.out(dry ? 'Dry run — nothing was written. This is what would happen:' : 'Imported.');
  io.out(`  provider  ${r.provider}  (a node: Wake-on-LAN, one request at a time, local, managed through its agent)`);
  io.out(`  aliases   ${r.aliases.length ? r.aliases.map(a => `${a}`).join(', ') : 'none'}${r.aliases.length ? '   (old profile names, now pointing at real models)' : ''}`);
  io.out(`  keys      ${r.keysImported.length ? r.keysImported.join(', ') : 'none'}`);
  for (const s of r.keysSkipped) io.out(`  skipped key "${s.name}": ${s.reason}`);
  for (const n of r.notes) io.out(`  note: ${n}`);
  if (!dry && r.keysImported.length) io.out('The keys are stored as hashes now: you can delete config.yml, which holds them in plain text.');
  return 0;
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
  if (!providers.length) io.out('providers  none yet — add one in the admin API or with import-legacy');
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
  io.out(`aliases    ${hub.aliases.list().length}`);
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
    if (!['keys', 'import-legacy', 'backup', 'check'].includes(command)) throw new UsageError(`Unknown command "${command}"`);
    const config = loadConfig(env, m => io.err(`warning: ${m}`));
    hub = createHub(config, silentLogger);
    switch (command) {
      case 'keys':
        return keysCommand(hub, p, io);
      case 'import-legacy':
        return importCommand(hub, p, io);
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


import type { HubConfig } from './config.js';
import { SecretBox } from './crypto.js';
import { openDatabase, type Db } from './db.js';
import { Limits } from './limits.js';
import { NodeClient } from './node-client.js';
import { NodeManager, type NodeDeps } from './node.js';
import { relaySender } from './wol.js';
import { Registry } from './registry.js';
import { Router } from './routing.js';
import { KeyStore } from './store/keys.js';
import { ModelStore } from './store/models.js';
import { ProviderStore } from './store/providers.js';
import { UsageStore } from './store/usage.js';
import { ModelSync } from './sync.js';

export interface Logger {
  info(o: object, m?: string): void;
  warn(o: object, m?: string): void;
  error(o: object, m?: string): void;
  debug(o: object, m?: string): void;
}

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

/** Everything a request handler needs, wired once at startup (and by the tests). */
export interface Hub {
  config: HubConfig;
  db: Db;
  box: SecretBox;
  providers: ProviderStore;
  models: ModelStore;
  keys: KeyStore;
  usage: UsageStore;
  registry: Registry;
  router: Router;
  limits: Limits;
  nodes: NodeManager;
  nodeClient: NodeClient;
  sync: ModelSync;
  log: Logger;
  clock: () => Date;
}

export interface HubOverrides {
  db?: Db;
  clock?: () => Date;
  node?: NodeDeps;
  /** How often the hub looks at a download it started (to put the finished model into the catalog). */
  nodePullPollMs?: number;
}

export function createHub(config: HubConfig, log: Logger = silentLogger, overrides: HubOverrides = {}): Hub {
  const db = overrides.db ?? openDatabase(config.dbPath);
  const clock = overrides.clock ?? (() => new Date());
  const box = new SecretBox(config.masterKey);
  const providers = new ProviderStore(db, box);
  const models = new ModelStore(db, providers);
  const keys = new KeyStore(db);
  const usage = new UsageStore(db);
  const registry = new Registry(providers, config);
  const router = new Router(models, providers);
  const limits = new Limits(usage, config.usageTz, clock);
  const nodes = new NodeManager(providers, registry, { log, ...(config.wolRelay ? { sendMagic: relaySender(config.wolRelay.url, config.wolRelay.token) } : {}), ...overrides.node });
  const sync = new ModelSync(providers, models, registry, nodes, log);
  const nodeClient = new NodeClient(providers, registry, nodes, sync, log, overrides.nodePullPollMs);
  return { config, db, box, providers, models, keys, usage, registry, router, limits, nodes, nodeClient, sync, log, clock };
}

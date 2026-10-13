export const MODEL_KINDS = ['chat', 'embedding', 'image', 'tts', 'stt'] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];
export const isModelKind = (v: unknown): v is ModelKind => typeof v === 'string' && (MODEL_KINDS as readonly string[]).includes(v);

export const LOCALITIES = ['local', 'cloud'] as const;
export type Locality = (typeof LOCALITIES)[number];
export const isLocality = (v: unknown): v is Locality => v === 'local' || v === 'cloud';

export const PROVIDER_TYPES = ['openai', 'anthropic'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const AUTH_SCHEMES = ['bearer', 'header', 'none'] as const;
export type AuthScheme = (typeof AUTH_SCHEMES)[number];

export const SUPPORTS = ['tools', 'vision', 'reasoning_effort'] as const;
export type Support = (typeof SUPPORTS)[number];

export interface ProviderOptions {
  /** How long to wait for the first byte of the answer (a cold local model can take minutes to load). */
  firstByteTimeoutMs?: number;
  /** Longest silence tolerated between two chunks of a streamed answer. */
  idleTimeoutMs?: number;
  /** Ask for `stream_options.include_usage` (default true). Turn off for upstreams that reject the field. */
  streamUsage?: boolean;
  /** Anthropic requires `max_tokens`; used when the client sends none. */
  defaultMaxTokens?: number;
  /** Paths relative to the base URL, for upstreams that do not follow the OpenAI layout. */
  modelsPath?: string;
  chatPath?: string;
  embeddingsPath?: string;
  anthropicVersion?: string;
  /** Newly discovered models start enabled (default true). Turn off for huge catalogs such as OpenRouter. */
  autoEnableModels?: boolean;
}

/** A machine that sleeps: woken with Wake-on-LAN, polled until it answers, optionally told to shut down when idle. */
export interface NodeConfig {
  mac: string;
  /** Broadcast address of the LAN, or the machine's own IP (unicast works from a Docker bridge). */
  broadcast: string;
  port: number;
  /** URL that answers while the machine is up. Default: the provider's models URL. */
  healthUrl?: string;
  bootTimeoutMs: number;
  pollIntervalMs: number;
  /** Requests below this priority never wake the machine; they fail with `node_asleep` (so a fallback can answer). */
  minWakePriority: number;
  /** Ask the machine to shut down after this many idle minutes (needs shutdownUrl). */
  idleShutdownMinutes?: number;
  shutdownUrl?: string;
}

export interface ProviderRecord {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  /** Where requests to this provider are processed. Models inherit it unless overridden; unknown means cloud. */
  locality: Locality;
  authScheme: AuthScheme;
  authHeader: string | null;
  hasSecret: boolean;
  secretHint: string | null;
  extraHeaders: Record<string, string>;
  options: ProviderOptions;
  /** Requests handled at once; more wait in a priority queue. null = no limit. */
  maxConcurrency: number | null;
  node: NodeConfig | null;
  enabled: boolean;
  position: number;
  modelsSyncedAt: string | null;
  lastSyncError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Fields the upstream reports about a model, or the owner overrides. */
export interface ModelFields {
  name?: string;
  description?: string;
  kind?: ModelKind;
  tags?: string[];
  contextLength?: number;
  maxOutputTokens?: number;
  supports?: Support[];
  locality?: Locality;
}

export interface ModelOverrides extends ModelFields {
  enabled?: boolean;
}

export interface ModelRecord {
  id: string;
  providerId: string;
  upstreamId: string;
  source: 'synced' | 'manual';
  reported: ModelFields;
  overrides: ModelOverrides;
  /** Seen in the last sync of the provider (manual models are always present). */
  present: boolean;
}

/** A model as clients and the router see it: reported fields, then the owner's overrides on top. */
export interface ResolvedModel {
  id: string;
  providerId: string;
  upstreamId: string;
  source: 'synced' | 'manual';
  name: string;
  description: string;
  kind: ModelKind;
  tags: string[];
  contextLength: number | null;
  maxOutputTokens: number | null;
  /** null = unknown; the model list then omits the field instead of claiming "no tools". */
  supports: Support[] | null;
  locality: Locality;
  enabled: boolean;
  present: boolean;
}

export interface AliasRecord {
  name: string;
  description: string;
  tags: string[];
  /** Canonical model ids in fallback order: the first is tried first, the next only when it fails. */
  targets: string[];
  enabled: boolean;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  hash: string;
  defaultPriority: number;
  minPriority: number;
  maxPriority: number;
  /** Everything this key sends stays on local models, fallbacks included. */
  localOnly: boolean;
  /** Model ids, alias names or `provider/*`; null = everything. */
  allowedModels: string[] | null;
  rpm: number | null;
  rpd: number | null;
  tokensPerDay: number | null;
  tokensPerMonth: number | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** The upstream reported no usage, so the numbers are a rough count from the text. */
  estimated?: boolean;
}

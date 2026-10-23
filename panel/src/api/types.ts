/** What the hub's admin API sends (docs/08-api.md). JSON keys are snake_case, exactly as on the wire. */

export type Locality = 'local' | 'cloud';
export type ProviderType = 'openai' | 'anthropic';
export type AuthScheme = 'bearer' | 'header' | 'none';
export type ModelKind = 'chat' | 'embedding' | 'image' | 'tts' | 'stt';
export type Support = 'tools' | 'vision' | 'reasoning_effort';
/** `online` / `disabled` for plain providers; a machine that sleeps also has the other three. */
export type ProviderStatus = 'online' | 'disabled' | 'asleep' | 'waking' | 'unknown';

export interface ProviderOptions {
  first_byte_timeout_ms?: number;
  idle_timeout_ms?: number;
  stream_usage?: boolean;
  default_max_tokens?: number;
  models_path?: string;
  chat_path?: string;
  embeddings_path?: string;
  anthropic_version?: string;
  auto_enable_models?: boolean;
}

export interface NodeSettings {
  mac: string;
  broadcast: string;
  port: number;
  control_url?: string;
  health_url?: string;
  boot_timeout_ms: number;
  poll_interval_ms: number;
  min_wake_priority: number;
  idle_shutdown_minutes?: number;
  shutdown_url?: string;
}

export interface QueueState {
  running: number;
  queued: number;
}

export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  kind: 'node' | ProviderType;
  base_url: string;
  locality: Locality;
  auth_scheme: AuthScheme;
  auth_header: string | null;
  has_api_key: boolean;
  api_key_hint: string | null;
  api_key_unreadable: boolean;
  extra_headers: Record<string, string>;
  options: ProviderOptions;
  max_concurrency: number | null;
  node: NodeSettings | null;
  enabled: boolean;
  position: number;
  status: ProviderStatus;
  last_error: string | null;
  queue: QueueState;
  model_count: number;
  models_enabled: number;
  models_synced_at: string | null;
  last_sync_error: string | null;
  created_at: string;
  updated_at: string;
}

/** The body of POST /providers and PATCH /providers/{id}. Only what is set is changed on PATCH. */
export interface ProviderInput {
  id?: string;
  name?: string;
  type?: ProviderType;
  base_url?: string;
  locality?: Locality;
  auth_scheme?: AuthScheme;
  auth_header?: string | null;
  api_key?: string | null;
  extra_headers?: Record<string, string>;
  options?: ProviderOptions;
  max_concurrency?: number | null;
  node?: Partial<NodeSettings> | null;
  enabled?: boolean;
  sync?: boolean;
}

export interface Preset {
  id: string;
  name: string;
  type: ProviderType;
  base_url: string;
  locality: Locality;
  auth_scheme?: AuthScheme;
  max_concurrency?: number;
  options?: ProviderOptions;
  node?: Partial<NodeSettings>;
  note?: string;
}

export interface ModelFields {
  name?: string;
  description?: string;
  kind?: ModelKind;
  tags?: string[];
  context_length?: number;
  max_output_tokens?: number;
  supports?: Support[];
  locality?: Locality;
}

export interface Model {
  id: string;
  provider: string;
  upstream_id: string;
  source: 'synced' | 'manual';
  name: string;
  description: string;
  kind: ModelKind;
  tags: string[];
  context_length: number | null;
  max_output_tokens: number | null;
  supports: Support[] | null;
  locality: Locality;
  enabled: boolean;
  present: boolean;
  reported?: ModelFields;
  overrides?: ModelFields & { enabled?: boolean };
}

/** PATCH /models/{id}: `null` puts back what the provider reports. */
export type ModelPatch = { [K in keyof ModelFields]?: ModelFields[K] | null } & { enabled?: boolean };

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  default_priority: number;
  min_priority: number;
  max_priority: number;
  local_only: boolean;
  allowed_models: string[] | null;
  rpm: number | null;
  rpd: number | null;
  tokens_per_day: number | null;
  tokens_per_month: number | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  usage: { requests_today: number; tokens_today: number; tokens_month: number; resets_at: string };
}

export interface KeyInput {
  name?: string;
  default_priority?: number;
  min_priority?: number;
  max_priority?: number;
  local_only?: boolean;
  allowed_models?: string[] | null;
  rpm?: number | null;
  rpd?: number | null;
  tokens_per_day?: number | null;
  tokens_per_month?: number | null;
}

export interface HubStatus {
  version: string;
  uptime_seconds: number;
  providers: Array<{ id: string; status: ProviderStatus; queue: QueueState }>;
  counts: { providers: number; models: number; keys: number };
  time_zone: string;
}

export interface UsageRow {
  day: string;
  key_id: string;
  model: string;
  requests: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
}

export interface UsageResponse {
  from: string;
  to: string;
  time_zone: string;
  data: UsageRow[];
}

export interface LogRow {
  id: number;
  ts: string;
  request_id: string;
  key: string | null;
  endpoint: string;
  requested_model: string | null;
  model: string | null;
  provider: string | null;
  status: number;
  error_code: string | null;
  stream: boolean;
  priority: number;
  local_only: boolean;
  tag: string | null;
  attempts: number;
  queue_ms: number | null;
  ttfb_ms: number | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  estimated: boolean;
}

export interface TestResult {
  ok: boolean;
  latency_ms: number;
  models?: number;
  sample?: string[];
  code?: string;
  error?: string;
}

export interface SyncResult {
  provider: string;
  added: number;
  updated: number;
  absent: number;
}

// ── nodes ──────────────────────────────────────────────────────────────────

export interface LoadedModel {
  id: string;
  size_bytes: number;
  vram_bytes: number;
  expires_at: string | null;
}

export interface GpuInfo {
  name: string;
  memory_total_bytes: number;
  memory_used_bytes: number;
  utilization_percent: number | null;
}

/** GET {control_url}/node/status, as the agent sends it. */
export interface AgentStatus {
  node_id: string;
  version: string;
  platform: string;
  hostname: string;
  uptime_seconds: number;
  runtime: { name: string; url: string; ok: boolean; version: string | null; managed: boolean; error: string | null };
  loaded: LoadedModel[];
  in_flight: number;
  downloads: number;
  idle_seconds: number;
  user_active: boolean;
  last_input_seconds_ago: number | null;
  user_active_updated_at: string | null;
  safe_to_shutdown: boolean;
  shutting_down: boolean;
  tray_configured: boolean;
  system: {
    cpu_count: number;
    memory: { total_bytes: number; free_bytes: number };
    gpus: GpuInfo[];
    disk: { path: string; total_bytes: number; free_bytes: number } | null;
  };
}

export interface NodeInfo {
  provider: string;
  status: ProviderStatus;
  node: NodeSettings;
  agent_configured: boolean;
  agent: AgentStatus | null;
  agent_error: { code: string; message: string } | null;
}

export interface NodeModel {
  id: string;
  kind: ModelKind;
  size_bytes: number | null;
  digest: string | null;
  modified_at: string | null;
  family: string | null;
  parameter_size: string | null;
  quantization: string | null;
  context_length: number | null;
  capabilities: string[];
  tags: string[];
  loaded: { vram_bytes: number; size_bytes: number; expires_at: string | null } | null;
  hub_id: string;
  hub: Model | null;
}

export type PullStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface PullJob {
  id: string;
  name: string;
  status: PullStatus;
  phase: string | null;
  completed: number | null;
  total: number | null;
  percent: number | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface ShutdownVerdict {
  allow: boolean;
  reason: string;
}

export interface DeleteNodeModelResult {
  id: string;
  [key: string]: unknown;
}

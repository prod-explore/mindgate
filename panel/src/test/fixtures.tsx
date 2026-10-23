import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import { ApiProvider } from '../api/context';
import type { Api } from '../api/client';
import type { AgentStatus, ApiKey, HubStatus, KeyInput, LogRow, Model, ModelFields, ModelPatch, NodeInfo, NodeModel, Preset, Provider, ProviderInput, PullJob, UsageResponse } from '../api/types';
import { ConfirmProvider } from '../ui/Confirm';
import { Toasts } from '../ui/Toasts';

/** What the hub shows once, when a key is made. Written in pieces so that no secret scanner mistakes it for a real one. */
export const FULL_KEY = ['mg-zz99', 'THE', 'WHOLE', 'SECRET', 'KEY'].join('-');

export const provider = (over: Partial<Provider> = {}): Provider => ({
  id: 'home',
  name: 'Home PC',
  type: 'openai',
  kind: 'node',
  base_url: 'http://pc.lan:3001/v1',
  locality: 'local',
  auth_scheme: 'bearer',
  auth_header: null,
  has_api_key: true,
  api_key_hint: 'f3a9',
  api_key_unreadable: false,
  extra_headers: {},
  options: {},
  max_concurrency: 1,
  node: { mac: 'AA:BB:CC:DD:EE:FF', broadcast: '192.168.1.255', port: 9, control_url: 'http://pc.lan:3001', boot_timeout_ms: 120000, poll_interval_ms: 2000, min_wake_priority: 3 },
  enabled: true,
  position: 0,
  status: 'online',
  last_error: null,
  queue: { running: 0, queued: 0 },
  model_count: 2,
  models_enabled: 1,
  models_synced_at: '2026-10-14T08:00:00Z',
  last_sync_error: null,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...over,
});

export const cloud = (over: Partial<Provider> = {}): Provider =>
  provider({ id: 'openrouter', name: 'OpenRouter', kind: 'openai', base_url: 'https://openrouter.ai/api/v1', locality: 'cloud', node: null, max_concurrency: null, model_count: 3, models_enabled: 3, ...over });

export const model = (over: Partial<Model> = {}): Model => ({
  id: 'home/qwen3:4b',
  provider: 'home',
  upstream_id: 'qwen3:4b',
  source: 'synced',
  name: 'qwen3:4b',
  description: '',
  kind: 'chat',
  tags: [],
  context_length: 32768,
  max_output_tokens: null,
  supports: ['tools'],
  locality: 'local',
  enabled: true,
  present: true,
  ...over,
});

export const apiKey = (over: Partial<ApiKey> = {}): ApiKey => ({
  id: 'key_1',
  name: 'open-webui',
  prefix: 'mg-ab12',
  default_priority: 3,
  min_priority: 1,
  max_priority: 5,
  local_only: false,
  allowed_models: null,
  rpm: null,
  rpd: 1000,
  tokens_per_day: 200000,
  tokens_per_month: null,
  created_at: '2026-10-01T00:00:00Z',
  last_used_at: '2026-10-14T09:00:00Z',
  revoked_at: null,
  usage: { requests_today: 120, tokens_today: 50000, tokens_month: 900000, resets_at: '2026-10-15T00:00:00Z' },
  ...over,
});

export const hubStatus = (over: Partial<HubStatus> = {}): HubStatus => ({
  version: '2.0.0',
  uptime_seconds: 4000,
  providers: [],
  counts: { providers: 2, models: 5, keys: 1 },
  time_zone: 'UTC',
  ...over,
});

export const logRow = (over: Partial<LogRow> = {}): LogRow => ({
  id: 1,
  ts: '2026-10-14T09:00:00Z',
  request_id: 'req_0123456789abcdef',
  key: 'open-webui',
  endpoint: '/v1/chat/completions',
  requested_model: 'home/qwen3:4b',
  model: 'home/qwen3:4b',
  provider: 'home',
  status: 200,
  error_code: null,
  stream: true,
  priority: 3,
  local_only: false,
  tag: null,
  attempts: 1,
  queue_ms: 12,
  ttfb_ms: 480,
  latency_ms: 2100,
  input_tokens: 120,
  output_tokens: 80,
  estimated: false,
  ...over,
});

export const usage = (data: UsageResponse['data'] = [], over: Partial<UsageResponse> = {}): UsageResponse => ({ from: '2026-10-01', to: '2026-10-14', time_zone: 'UTC', data, ...over });

export const agent = (over: Partial<AgentStatus> = {}): AgentStatus => ({
  node_id: 'pc',
  version: '2.0.0',
  platform: 'win32',
  hostname: 'DESKTOP-PC',
  uptime_seconds: 7200,
  runtime: { name: 'ollama', url: 'http://127.0.0.1:11434', ok: true, version: '0.12.3', managed: true, error: null },
  loaded: [],
  in_flight: 0,
  downloads: 0,
  idle_seconds: 600,
  user_active: false,
  last_input_seconds_ago: 900,
  user_active_updated_at: null,
  safe_to_shutdown: true,
  shutting_down: false,
  tray_configured: true,
  system: {
    cpu_count: 12,
    memory: { total_bytes: 16e9, free_bytes: 6e9 },
    gpus: [{ name: 'GTX 1650', memory_total_bytes: 4e9, memory_used_bytes: 1e9, utilization_percent: 7 }],
    disk: { path: 'C:\\', total_bytes: 500e9, free_bytes: 200e9 },
  },
  ...over,
});

export const nodeInfo = (over: Partial<NodeInfo> = {}): NodeInfo => ({
  provider: 'home',
  status: 'online',
  node: provider().node!,
  agent_configured: true,
  agent: agent(),
  agent_error: null,
  ...over,
});

export const nodeModel = (over: Partial<NodeModel> = {}): NodeModel => ({
  id: 'qwen3:4b',
  kind: 'chat',
  size_bytes: 2.6e9,
  digest: 'abc',
  modified_at: '2026-10-10T00:00:00Z',
  family: 'qwen3',
  parameter_size: '4B',
  quantization: 'Q4_K_M',
  context_length: 40960,
  capabilities: ['completion', 'tools'],
  tags: [],
  loaded: null,
  hub_id: 'home/qwen3:4b',
  hub: model(),
  ...over,
});

export const pull = (over: Partial<PullJob> = {}): PullJob => ({
  id: 'pull_1',
  name: 'llama3.2:3b',
  status: 'running',
  phase: 'pulling',
  completed: 840e6,
  total: 2e9,
  percent: 42,
  error: null,
  created_at: '2026-10-14T09:00:00Z',
  started_at: '2026-10-14T09:00:01Z',
  finished_at: null,
  ...over,
});

/** An Api whose every call is a spy that answers with something sensible; tests replace what they care about. */
export function fakeApi() {
  const api = {
    status: vi.fn(async () => hubStatus()),
    presets: vi.fn(async () => [] as Preset[]),
    providers: {
      list: vi.fn(async () => [provider(), cloud()]),
      create: vi.fn(async (_input: ProviderInput) => ({ ...provider(), sync: null })),
      update: vi.fn(async (_id: string, _input: ProviderInput) => provider()),
      remove: vi.fn(async (id: string) => ({ deleted: true as const, id })),
      test: vi.fn(async (_id: string) => ({ ok: true, latency_ms: 40, models: 3 })),
      sync: vi.fn(async (id: string) => ({ provider: id, added: 0, updated: 0, absent: 0 })),
      wake: vi.fn(async (_id: string) => ({ status: 'waking' })),
    },
    nodes: {
      get: vi.fn(async (_id: string) => nodeInfo()),
      models: vi.fn(async (_id: string) => [nodeModel()]),
      pulls: vi.fn(async (_id: string) => [] as PullJob[]),
      pull: vi.fn(async (_id: string, name: string) => pull({ name, status: 'queued', percent: null, completed: null, total: null })),
      cancelPull: vi.fn(async (_id: string, _pull: string) => ({})),
      load: vi.fn(async (_id: string, _name: string, _keepAlive?: string | number) => ({})),
      unload: vi.fn(async (_id: string, _name: string) => ({})),
      remove: vi.fn(async (_id: string, name: string) => ({ id: `home/${name}` })),
      shutdown: vi.fn(async (_id: string, _force: boolean) => ({ allow: true, reason: 'shutdown_initiated' })),
    },
    models: {
      list: vi.fn(async () => [model()]),
      create: vi.fn(async (_input: { provider: string; id: string } & ModelFields) => model()),
      update: vi.fn(async (_id: string, _patch: ModelPatch) => model()),
      remove: vi.fn(async (id: string) => ({ id })),
    },
    keys: {
      list: vi.fn(async () => [apiKey()]),
      create: vi.fn(async (_input: KeyInput & { name: string }) => ({ ...apiKey({ id: 'key_2', name: 'new-app', prefix: 'mg-zz99' }), key: FULL_KEY })),
      update: vi.fn(async (_id: string, _input: KeyInput) => apiKey()),
      revoke: vi.fn(async (_id: string) => apiKey({ revoked_at: '2026-10-14T10:00:00Z' })),
      remove: vi.fn(async (_id: string) => ({ deleted: true as const })),
    },
    usage: vi.fn(async (_query?: { from?: string; to?: string; key?: string; model?: string }) => usage()),
    log: vi.fn(async (_query?: { limit?: number; before?: number; key?: string; errors?: boolean }) => [] as LogRow[]),
  };
  return api satisfies Api;
}

export type FakeApi = ReturnType<typeof fakeApi>;

/** Renders a page the way the app does: with an api, confirmations and toasts. */
export function renderPage(ui: ReactElement, api: FakeApi = fakeApi()) {
  const view = render(
    <ApiProvider api={api}>
      <ConfirmProvider>
        {ui}
        <Toasts />
      </ConfirmProvider>
    </ApiProvider>,
  );
  return { api, ...view };
}

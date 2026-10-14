import type { AuthScheme, Locality, NodeSettings, Preset, Provider, ProviderInput, ProviderOptions, ProviderType } from '../api/types';

/** The add/edit provider form, as plain editable values. Empty numbers are `null`, empty text is ''. */
export interface ProviderDraft {
  id: string;
  name: string;
  type: ProviderType;
  base_url: string;
  locality: Locality;
  auth_scheme: AuthScheme;
  auth_header: string;
  api_key: string;
  clear_key: boolean;
  max_concurrency: number | null;
  enabled: boolean;

  first_byte_timeout_ms: number | null;
  idle_timeout_ms: number | null;
  stream_usage: boolean;
  default_max_tokens: number | null;
  auto_enable_models: boolean;
  models_path: string;
  chat_path: string;
  embeddings_path: string;
  /** Options this form has no field for are carried through untouched. */
  options_rest: ProviderOptions;

  headers: Array<{ name: string; value: string }>;

  is_node: boolean;
  mac: string;
  broadcast: string;
  port: number | null;
  control_url: string;
  health_url: string;
  shutdown_url: string;
  min_wake_priority: number | null;
  boot_timeout_ms: number | null;
  poll_interval_ms: number | null;
  idle_shutdown_minutes: number | null;
}

const KNOWN_OPTIONS = ['first_byte_timeout_ms', 'idle_timeout_ms', 'stream_usage', 'default_max_tokens', 'auto_enable_models', 'models_path', 'chat_path', 'embeddings_path'] as const;

export function blankDraft(): ProviderDraft {
  return {
    id: '',
    name: '',
    type: 'openai',
    base_url: '',
    locality: 'cloud',
    auth_scheme: 'bearer',
    auth_header: '',
    api_key: '',
    clear_key: false,
    max_concurrency: null,
    enabled: true,
    first_byte_timeout_ms: null,
    idle_timeout_ms: null,
    stream_usage: true,
    default_max_tokens: null,
    auto_enable_models: true,
    models_path: '',
    chat_path: '',
    embeddings_path: '',
    options_rest: {},
    headers: [],
    is_node: false,
    mac: '',
    broadcast: '',
    port: 9,
    control_url: '',
    health_url: '',
    shutdown_url: '',
    min_wake_priority: 3,
    boot_timeout_ms: 120_000,
    poll_interval_ms: 2000,
    idle_shutdown_minutes: null,
  };
}

function applyNode(d: ProviderDraft, n: Partial<NodeSettings> | null | undefined): void {
  if (!n) return;
  d.is_node = true;
  d.mac = n.mac ?? d.mac;
  d.broadcast = n.broadcast ?? d.broadcast;
  d.port = n.port ?? d.port;
  d.control_url = n.control_url ?? '';
  d.health_url = n.health_url ?? '';
  d.shutdown_url = n.shutdown_url ?? '';
  d.min_wake_priority = n.min_wake_priority ?? d.min_wake_priority;
  d.boot_timeout_ms = n.boot_timeout_ms ?? d.boot_timeout_ms;
  d.poll_interval_ms = n.poll_interval_ms ?? d.poll_interval_ms;
  d.idle_shutdown_minutes = n.idle_shutdown_minutes ?? null;
}

function applyOptions(d: ProviderDraft, o: ProviderOptions | undefined): void {
  const opts = o ?? {};
  d.first_byte_timeout_ms = opts.first_byte_timeout_ms ?? null;
  d.idle_timeout_ms = opts.idle_timeout_ms ?? null;
  d.stream_usage = opts.stream_usage ?? true;
  d.default_max_tokens = opts.default_max_tokens ?? null;
  d.auto_enable_models = opts.auto_enable_models ?? true;
  d.models_path = opts.models_path ?? '';
  d.chat_path = opts.chat_path ?? '';
  d.embeddings_path = opts.embeddings_path ?? '';
  d.options_rest = Object.fromEntries(Object.entries(opts).filter(([k]) => !(KNOWN_OPTIONS as readonly string[]).includes(k))) as ProviderOptions;
}

export function draftFromPreset(preset: Preset): ProviderDraft {
  const d = blankDraft();
  d.id = preset.id === 'custom' || preset.id === 'mindgate-node' ? '' : preset.id;
  d.name = preset.name;
  d.type = preset.type;
  d.base_url = preset.base_url;
  d.locality = preset.locality;
  d.auth_scheme = preset.auth_scheme ?? 'bearer';
  d.max_concurrency = preset.max_concurrency ?? null;
  applyOptions(d, preset.options);
  applyNode(d, preset.node);
  return d;
}

export function draftFromProvider(p: Provider): ProviderDraft {
  const d = blankDraft();
  d.id = p.id;
  d.name = p.name;
  d.type = p.type;
  d.base_url = p.base_url;
  d.locality = p.locality;
  d.auth_scheme = p.auth_scheme;
  d.auth_header = p.auth_header ?? '';
  d.max_concurrency = p.max_concurrency;
  d.enabled = p.enabled;
  d.headers = Object.entries(p.extra_headers).map(([name, value]) => ({ name, value }));
  applyOptions(d, p.options);
  applyNode(d, p.node);
  return d;
}

const text = (s: string): string | undefined => (s.trim() ? s.trim() : undefined);

export function optionsOf(d: ProviderDraft): ProviderOptions {
  const o: ProviderOptions = { ...d.options_rest };
  if (d.first_byte_timeout_ms !== null) o.first_byte_timeout_ms = d.first_byte_timeout_ms;
  if (d.idle_timeout_ms !== null) o.idle_timeout_ms = d.idle_timeout_ms;
  if (!d.stream_usage) o.stream_usage = false;
  if (d.default_max_tokens !== null) o.default_max_tokens = d.default_max_tokens;
  if (!d.auto_enable_models) o.auto_enable_models = false;
  const paths = { models_path: text(d.models_path), chat_path: text(d.chat_path), embeddings_path: text(d.embeddings_path) };
  for (const [k, v] of Object.entries(paths)) if (v) (o as Record<string, unknown>)[k] = v;
  return o;
}

export function nodeOf(d: ProviderDraft): Partial<NodeSettings> {
  const n: Partial<NodeSettings> = {
    mac: d.mac.trim(),
    broadcast: d.broadcast.trim(),
    ...(d.port !== null ? { port: d.port } : {}),
    ...(d.min_wake_priority !== null ? { min_wake_priority: d.min_wake_priority } : {}),
    ...(d.boot_timeout_ms !== null ? { boot_timeout_ms: d.boot_timeout_ms } : {}),
    ...(d.poll_interval_ms !== null ? { poll_interval_ms: d.poll_interval_ms } : {}),
  };
  const control = text(d.control_url);
  if (control) n.control_url = control;
  const health = text(d.health_url);
  if (health) n.health_url = health;
  const shutdown = text(d.shutdown_url);
  if (shutdown) n.shutdown_url = shutdown;
  if (d.idle_shutdown_minutes !== null) n.idle_shutdown_minutes = d.idle_shutdown_minutes;
  return n;
}

/** The body for POST /providers (`mode: 'create'`) or PATCH /providers/{id}. */
export function toInput(d: ProviderDraft, mode: 'create' | 'edit'): ProviderInput {
  const input: ProviderInput = {
    name: d.name.trim() || d.id.trim(),
    type: d.type,
    base_url: d.base_url.trim(),
    locality: d.locality,
    auth_scheme: d.auth_scheme,
    auth_header: d.auth_scheme === 'header' ? d.auth_header.trim() : null,
    extra_headers: Object.fromEntries(d.headers.filter(h => h.name.trim()).map(h => [h.name.trim(), h.value])),
    options: optionsOf(d),
    max_concurrency: d.max_concurrency,
    node: d.is_node ? nodeOf(d) : null,
    enabled: d.enabled,
  };
  if (mode === 'create') {
    input.id = d.id.trim();
    if (d.auth_scheme !== 'header') delete input.auth_header;
    if (!d.is_node) delete input.node;
  }
  // a key is only sent when the person typed one (or asked to remove it): leaving the box empty keeps the stored key
  if (d.clear_key) input.api_key = null;
  else if (d.api_key.trim()) input.api_key = d.api_key.trim();
  return input;
}

export const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MAC = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;

/** Problems the form can see on its own, keyed by field; the hub still has the last word. */
export function validate(d: ProviderDraft, mode: 'create' | 'edit'): Partial<Record<'id' | 'base_url' | 'mac' | 'broadcast' | 'auth_header' | 'idle', string>> {
  const e: Partial<Record<'id' | 'base_url' | 'mac' | 'broadcast' | 'auth_header' | 'idle', string>> = {};
  if (mode === 'create' && !SLUG.test(d.id.trim())) e.id = 'id';
  if (!/^https?:\/\/\S+$/i.test(d.base_url.trim())) e.base_url = 'url';
  if (d.auth_scheme === 'header' && !d.auth_header.trim()) e.auth_header = 'header';
  if (d.is_node) {
    if (!MAC.test(d.mac.trim())) e.mac = 'mac';
    if (!d.broadcast.trim()) e.broadcast = 'broadcast';
    if (d.idle_shutdown_minutes !== null && !d.control_url.trim() && !d.shutdown_url.trim()) e.idle = 'idle';
  }
  return e;
}

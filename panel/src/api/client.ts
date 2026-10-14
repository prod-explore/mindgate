import type {
  Alias,
  AliasInput,
  ApiKey,
  DeleteNodeModelResult,
  HubStatus,
  KeyInput,
  LogRow,
  Model,
  ModelFields,
  ModelPatch,
  NodeInfo,
  NodeModel,
  Preset,
  Provider,
  ProviderInput,
  PullJob,
  ShutdownVerdict,
  SyncResult,
  TestResult,
  UsageResponse,
} from './types';

/** An error answer of the hub (`{error:{message,code,…}}`), or `network` when nothing answered at all. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Everything else the hub put into the error object (`limit`, `reset_at`, `retry_after`, `provider`…). */
  readonly extra: Record<string, unknown>;

  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

export interface ClientOptions {
  /** Where the admin API lives. */
  base?: string;
  token: () => string | null;
  /** The hub said the token is wrong (or the browser has none). */
  onAuthFailed?: () => void;
  fetchImpl?: typeof fetch;
}

type Query = Record<string, string | number | boolean | undefined | null>;

interface RequestInit2 {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal | undefined;
}

/** `openrouter/deepseek/deepseek-chat` -> a path where slashes stay and everything else is escaped. */
export const idPath = (id: string): string => id.split('/').map(encodeURIComponent).join('/');

export function createApi(options: ClientOptions) {
  const base = (options.base ?? '/admin/api').replace(/\/+$/, '');
  const doFetch = options.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  async function request<T>(method: string, path: string, init: RequestInit2 = {}): Promise<T> {
    const url = new URL(`${base}${path}`, globalThis.location?.origin ?? 'http://localhost');
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));

    const token = options.token();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
      res = await doFetch(url.pathname + url.search, {
        method,
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      throw new ApiError(0, 'network', e instanceof Error ? e.message : String(e));
    }

    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        /* not JSON: handled below */
      }
    }

    if (!res.ok) {
      const err = (json as { error?: Record<string, unknown> } | null)?.error;
      const { message, code, type: _type, ...extra } = err ?? {};
      const retryAfter = res.headers.get('Retry-After');
      if (retryAfter && !('retry_after' in extra)) extra['retry_after'] = Number(retryAfter);
      const e = new ApiError(
        res.status,
        typeof code === 'string' ? code : `http_${res.status}`,
        typeof message === 'string' ? message : text.trim().slice(0, 200) || `HTTP ${res.status}`,
        extra,
      );
      if (res.status === 401 && e.code !== 'too_many_auth_failures') options.onAuthFailed?.();
      throw e;
    }
    if (json === null && text) throw new ApiError(res.status, 'invalid_response', 'The hub answered with something that is not JSON');
    return json as T;
  }

  const get = <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>('GET', path, { query, signal });
  const send = <T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) => request<T>(method, path, { body });

  const p = (id: string) => `/providers/${encodeURIComponent(id)}`;
  const n = (id: string) => `${p(id)}/node`;

  return {
    status: (signal?: AbortSignal) => get<HubStatus>('/status', undefined, signal),
    presets: (signal?: AbortSignal) => get<{ data: Preset[] }>('/presets', undefined, signal).then(r => r.data),

    providers: {
      list: (signal?: AbortSignal) => get<{ data: Provider[] }>('/providers', undefined, signal).then(r => r.data),
      create: (input: ProviderInput) => send<Provider & { sync: unknown }>('POST', '/providers', input),
      update: (id: string, input: ProviderInput) => send<Provider>('PATCH', p(id), input),
      remove: (id: string) => send<{ deleted: true; id: string; aliases_affected: string[] }>('DELETE', p(id)),
      test: (id: string) => send<TestResult>('POST', `${p(id)}/test`),
      sync: (id: string) => send<SyncResult>('POST', `${p(id)}/sync`),
      wake: (id: string) => send<{ status: string }>('POST', `${p(id)}/wake`),
    },

    nodes: {
      get: (id: string, signal?: AbortSignal) => get<NodeInfo>(n(id), undefined, signal),
      models: (id: string, signal?: AbortSignal) => get<{ data: NodeModel[] }>(`${n(id)}/models`, undefined, signal).then(r => r.data),
      pulls: (id: string, signal?: AbortSignal) => get<{ data: PullJob[] }>(`${n(id)}/pulls`, undefined, signal).then(r => r.data),
      pull: (id: string, name: string) => send<PullJob>('POST', `${n(id)}/pulls`, { name }),
      cancelPull: (id: string, pull: string) => send<unknown>('DELETE', `${n(id)}/pulls/${encodeURIComponent(pull)}`),
      load: (id: string, name: string, keepAlive?: string | number) => send<unknown>('POST', `${n(id)}/models/load`, { name, ...(keepAlive !== undefined ? { keep_alive: keepAlive } : {}) }),
      unload: (id: string, name: string) => send<unknown>('POST', `${n(id)}/models/unload`, { name }),
      remove: (id: string, name: string) => send<DeleteNodeModelResult>('DELETE', `${n(id)}/models/${idPath(name)}`),
      shutdown: (id: string, force: boolean) => send<ShutdownVerdict>('POST', `${n(id)}/shutdown`, { force }),
    },

    models: {
      list: (provider?: string, signal?: AbortSignal) => get<{ data: Model[] }>('/models', { provider }, signal).then(r => r.data),
      create: (input: { provider: string; id: string } & ModelFields) => send<Model>('POST', '/models', input),
      update: (id: string, patch: ModelPatch) => send<Model>('PATCH', `/models/${idPath(id)}`, patch),
      remove: (id: string) => send<{ id: string; [k: string]: unknown }>('DELETE', `/models/${idPath(id)}`),
    },

    aliases: {
      list: (signal?: AbortSignal) => get<{ data: Alias[] }>('/aliases', undefined, signal).then(r => r.data),
      create: (input: AliasInput) => send<Alias>('POST', '/aliases', input),
      update: (name: string, input: AliasInput) => send<Alias>('PATCH', `/aliases/${encodeURIComponent(name)}`, input),
      remove: (name: string) => send<{ deleted: true; name: string }>('DELETE', `/aliases/${encodeURIComponent(name)}`),
    },

    keys: {
      list: (signal?: AbortSignal) => get<{ data: ApiKey[] }>('/keys', undefined, signal).then(r => r.data),
      create: (input: KeyInput & { name: string }) => send<ApiKey & { key: string }>('POST', '/keys', input),
      update: (id: string, input: KeyInput) => send<ApiKey>('PATCH', `/keys/${encodeURIComponent(id)}`, input),
      revoke: (id: string) => send<ApiKey>('POST', `/keys/${encodeURIComponent(id)}/revoke`),
      remove: (id: string) => send<{ deleted: true }>('DELETE', `/keys/${encodeURIComponent(id)}`),
    },

    usage: (query: { from?: string; to?: string; key?: string; model?: string } = {}, signal?: AbortSignal) => get<UsageResponse>('/usage', query, signal),
    log: (query: { limit?: number; before?: number; key?: string; errors?: boolean } = {}, signal?: AbortSignal) =>
      get<{ data: LogRow[] }>('/log', { limit: query.limit, before: query.before, key: query.key, errors: query.errors ? '1' : undefined }, signal).then(r => r.data),
  };
}

export type Api = ReturnType<typeof createApi>;

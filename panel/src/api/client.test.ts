import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApi, idPath, isApiError } from './client';

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function setup(response: () => Response | Promise<Response>, token: string | null = 'tok-123') {
  const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) => response());
  const onAuthFailed = vi.fn();
  const api = createApi({ token: () => token, fetchImpl: fetchImpl as unknown as typeof fetch, onAuthFailed });
  return { api, fetchImpl, onAuthFailed };
}

const lastCall = (f: ReturnType<typeof vi.fn>) => {
  const [url, init] = f.mock.calls.at(-1) as [string, RequestInit & { headers: Record<string, string> }];
  return { url, init };
};

describe('requests', () => {
  it('sends the admin token as a Bearer header, asks for JSON and never caches or sends cookies', async () => {
    const { api, fetchImpl } = setup(() => reply(200, { data: [] }));
    await api.keys.list();
    const { url, init } = lastCall(fetchImpl);
    expect(url).toBe('/admin/api/keys');
    expect(init.method).toBe('GET');
    expect(init.headers['Authorization']).toBe('Bearer tok-123');
    expect(init.headers['Accept']).toBe('application/json');
    expect(init.cache).toBe('no-store');
    expect(init.credentials).toBe('omit');
    expect(init.body).toBeUndefined();
    expect(init.headers['Content-Type']).toBeUndefined();
  });

  it('sends no Authorization header when there is no token', async () => {
    const { api, fetchImpl } = setup(() => reply(200, { data: [] }), null);
    await api.keys.list();
    expect(lastCall(fetchImpl).init.headers['Authorization']).toBeUndefined();
  });

  it('puts a body in as JSON, and only then names a content type', async () => {
    const { api, fetchImpl } = setup(() => reply(201, { id: 'k1', name: 'smart' }));
    await api.keys.create({ name: 'smart', allowed_models: ['a/b'] });
    const { init } = lastCall(fetchImpl);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'smart', allowed_models: ['a/b'] });
  });

  it('builds the query from what is set and skips the rest', async () => {
    const { api, fetchImpl } = setup(() => reply(200, { data: [] }));
    await api.log({ limit: 50, before: 120, key: 'key_1', errors: true });
    expect(lastCall(fetchImpl).url).toBe('/admin/api/log?limit=50&before=120&key=key_1&errors=1');
    await api.log({});
    expect(lastCall(fetchImpl).url).toBe('/admin/api/log');
    await api.log({ errors: false, key: '' });
    expect(lastCall(fetchImpl).url).toBe('/admin/api/log');
    await api.usage({ from: '2026-10-01', to: '2026-10-14' });
    expect(lastCall(fetchImpl).url).toBe('/admin/api/usage?from=2026-10-01&to=2026-10-14');
  });

  it('keeps the slashes of a model id and escapes everything else', async () => {
    expect(idPath('openrouter/deepseek/deepseek-chat')).toBe('openrouter/deepseek/deepseek-chat');
    expect(idPath('home/qwen3:4b')).toBe('home/qwen3%3A4b');
    expect(idPath('home/a b?c#d')).toBe('home/a%20b%3Fc%23d');
    const { api, fetchImpl } = setup(() => reply(200, { id: 'x' }));
    await api.models.update('home/hf.co/user/repo:Q4_K_M', { enabled: false });
    expect(lastCall(fetchImpl).url).toBe('/admin/api/models/home/hf.co/user/repo%3AQ4_K_M');
    await api.nodes.remove('home', 'hf.co/user/repo:Q4_K_M');
    expect(lastCall(fetchImpl).url).toBe('/admin/api/providers/home/node/models/hf.co/user/repo%3AQ4_K_M');
    await api.providers.test('we ird/id');
    expect(lastCall(fetchImpl).url).toBe('/admin/api/providers/we%20ird%2Fid/test');
  });

  it('has a call for everything a node can do', async () => {
    const { api, fetchImpl } = setup(() => reply(200, {}));
    const urls: Array<[string, string]> = [];
    const note = () => urls.push([lastCall(fetchImpl).init.method!, lastCall(fetchImpl).url]);
    await api.nodes.get('pc');
    note();
    await api.nodes.pull('pc', 'qwen3:4b');
    note();
    await api.nodes.cancelPull('pc', 'pull_1');
    note();
    await api.nodes.load('pc', 'qwen3:4b', '10m');
    note();
    await api.nodes.unload('pc', 'qwen3:4b');
    note();
    await api.nodes.shutdown('pc', true);
    note();
    expect(urls).toEqual([
      ['GET', '/admin/api/providers/pc/node'],
      ['POST', '/admin/api/providers/pc/node/pulls'],
      ['DELETE', '/admin/api/providers/pc/node/pulls/pull_1'],
      ['POST', '/admin/api/providers/pc/node/models/load'],
      ['POST', '/admin/api/providers/pc/node/models/unload'],
      ['POST', '/admin/api/providers/pc/node/shutdown'],
    ]);
    expect(JSON.parse(lastCall(fetchImpl).init.body as string)).toEqual({ force: true });
  });

  it('unwraps lists', async () => {
    const { api } = setup(() => reply(200, { data: [{ id: 'a' }] }));
    expect(await api.keys.list()).toEqual([{ id: 'a' }]);
  });
});

describe('errors', () => {
  it('turns the hub’s error object into an ApiError with everything it said', async () => {
    const { api } = setup(() => reply(429, { error: { message: 'Too many', type: 'rate_limit_error', code: 'rate_limited', limit: 60, reset_at: '2026-10-14T10:00:00Z' } }, { 'Retry-After': '12' }));
    const err = await api.status().catch((e: unknown) => e);
    expect(isApiError(err)).toBe(true);
    const e = err as ApiError;
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(429);
    expect(e.code).toBe('rate_limited');
    expect(e.message).toBe('Too many');
    expect(e.extra).toEqual({ limit: 60, reset_at: '2026-10-14T10:00:00Z', retry_after: 12 });
  });

  it('copes with an error that is not the hub’s shape', async () => {
    const { api } = setup(() => reply(502, '<html>Bad gateway</html>', { 'Content-Type': 'text/html' }));
    const e = (await api.status().catch((x: unknown) => x)) as ApiError;
    expect(e.status).toBe(502);
    expect(e.code).toBe('http_502');
    expect(e.message).toContain('Bad gateway');
  });

  it('copes with an empty error body', async () => {
    const { api } = setup(() => new Response(null, { status: 500 }));
    const e = (await api.status().catch((x: unknown) => x)) as ApiError;
    expect(e.code).toBe('http_500');
    expect(e.message).toBe('HTTP 500');
  });

  it('says "network" when nothing answers', async () => {
    const { api } = setup(() => Promise.reject(new TypeError('Failed to fetch')));
    const e = (await api.status().catch((x: unknown) => x)) as ApiError;
    expect(e.code).toBe('network');
    expect(e.status).toBe(0);
  });

  it('lets an abort through as an abort, not as a hub error', async () => {
    const { api } = setup(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    const e = await api.status().catch((x: unknown) => x);
    expect(isApiError(e)).toBe(false);
    expect((e as DOMException).name).toBe('AbortError');
  });

  it('refuses a success that is not JSON', async () => {
    const { api } = setup(() => reply(200, 'hello', { 'Content-Type': 'text/plain' }));
    const e = (await api.status().catch((x: unknown) => x)) as ApiError;
    expect(e.code).toBe('invalid_response');
  });

  it('signs out on 401, but not when the hub is only throttling wrong tokens', async () => {
    const wrong = setup(() => reply(401, { error: { message: 'no', code: 'invalid_admin_token' } }));
    await wrong.api.status().catch(() => undefined);
    expect(wrong.onAuthFailed).toHaveBeenCalledTimes(1);

    const throttled = setup(() => reply(401, { error: { message: 'wait', code: 'too_many_auth_failures' } }));
    await throttled.api.status().catch(() => undefined);
    expect(throttled.onAuthFailed).not.toHaveBeenCalled();

    const other = setup(() => reply(500, { error: { message: 'boom', code: 'internal_error' } }));
    await other.api.status().catch(() => undefined);
    expect(other.onAuthFailed).not.toHaveBeenCalled();
  });
});

import type { ProviderRuntime } from '../upstream.js';

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Headers the owner configured for this provider, plus whatever the auth scheme calls for. */
export function authHeaders(rt: ProviderRuntime): Record<string, string> {
  const { record, secret } = rt;
  const h: Record<string, string> = { ...record.extraHeaders };
  if (secret) {
    if (record.type === 'anthropic') h['x-api-key'] = secret;
    else if (record.authScheme === 'bearer') h['Authorization'] = `Bearer ${secret}`;
    else if (record.authScheme === 'header' && record.authHeader) h[record.authHeader] = secret;
  }
  return h;
}

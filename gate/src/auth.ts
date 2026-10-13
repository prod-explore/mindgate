import type { FastifyRequest } from 'fastify';
import { safeEqual } from './crypto.js';
import type { Hub } from './context.js';
import { HubError } from './errors.js';
import type { ApiKeyRecord } from './types.js';

/**
 * Failed logins are counted per client address; a client that keeps guessing is refused for a while, whichever
 * secret it is guessing (client key or admin token).
 */
export class AuthThrottle {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly maxFailures = 20,
    private readonly windowMs = 60_000,
  ) {}

  check(ip: string, now = Date.now()): void {
    const recent = this.recent(ip, now);
    if (recent.length >= this.maxFailures) {
      const wait = Math.max(1, Math.ceil((recent[0]! + this.windowMs - now) / 1000));
      throw new HubError({
        status: 429,
        code: 'too_many_auth_failures',
        message: `Too many failed authentication attempts. Try again in ${wait}s.`,
        headers: { 'Retry-After': String(wait) },
      });
    }
  }

  fail(ip: string, now = Date.now()): void {
    this.recent(ip, now).push(now);
    if (this.failures.size > 5000) this.failures.clear(); // a flood of addresses must not become a memory problem
  }

  private recent(ip: string, now: number): number[] {
    const arr = this.failures.get(ip) ?? [];
    while (arr.length && arr[0]! <= now - this.windowMs) arr.shift();
    this.failures.set(ip, arr);
    return arr;
  }
}

function bearer(req: FastifyRequest): { token: string } | { error: HubError } {
  const header = req.headers.authorization;
  if (!header) {
    return { error: new HubError({ status: 401, code: 'missing_auth_header', message: 'Missing Authorization header. Send: Authorization: Bearer <key>' }) };
  }
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!m) return { error: new HubError({ status: 401, code: 'invalid_auth_format', message: 'Authorization must look like: Bearer <key>' }) };
  return { token: m[1]! };
}

export function authenticateClient(hub: Hub, throttle: AuthThrottle, req: FastifyRequest): ApiKeyRecord {
  throttle.check(req.ip);
  const b = bearer(req);
  if ('error' in b) {
    throttle.fail(req.ip);
    throw b.error;
  }
  const key = hub.keys.authenticate(b.token);
  if (!key) {
    throttle.fail(req.ip);
    hub.log.warn({ ip: req.ip, prefix: b.token.slice(0, 4) }, 'unknown API key');
    throw new HubError({ status: 401, code: 'invalid_api_key', message: 'Invalid API key' });
  }
  return key;
}

export function authenticateAdmin(hub: Hub, throttle: AuthThrottle, req: FastifyRequest): void {
  throttle.check(req.ip);
  const b = bearer(req);
  if ('error' in b || !safeEqual(b.token, hub.config.adminToken)) {
    throttle.fail(req.ip);
    throw new HubError({ status: 401, code: 'invalid_admin_token', message: 'Admin authentication required (Authorization: Bearer <MINDGATE_ADMIN_TOKEN>)' });
  }
}

/**
 * Errors the hub reports to clients, in the OpenAI error format:
 *   { "error": { "message", "type", "code", "param"?, ...extra } }
 *
 * `fallback` says whether the app may try another model after this failure (it is sent to the client as `fallback: true`).
 * It is a property of the failure, not of the caller: a bad request fails the same way everywhere, so retrying it
 * elsewhere only hides the mistake.
 */

export type ErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'server_error';

export interface HubErrorInit {
  status: number;
  code: string;
  message: string;
  type?: ErrorType;
  param?: string;
  /** Extra fields merged into the `error` object (provider, model, reset_at, ...). */
  extra?: Record<string, unknown>;
  headers?: Record<string, string>;
  fallback?: boolean;
}

function defaultType(status: number): ErrorType {
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'server_error';
  return 'invalid_request_error';
}

export class HubError extends Error {
  readonly status: number;
  readonly code: string;
  readonly type: ErrorType;
  readonly param: string | undefined;
  readonly extra: Record<string, unknown>;
  readonly headers: Record<string, string>;
  readonly fallback: boolean;

  constructor(init: HubErrorInit) {
    super(init.message);
    this.name = 'HubError';
    this.status = init.status;
    this.code = init.code;
    this.type = init.type ?? defaultType(init.status);
    this.param = init.param;
    this.extra = init.extra ?? {};
    this.headers = init.headers ?? {};
    this.fallback = init.fallback ?? false;
  }

  payload(): { error: Record<string, unknown> } {
    const error: Record<string, unknown> = { message: this.message, type: this.type, code: this.code };
    if (this.param) error['param'] = this.param;
    Object.assign(error, this.extra);
    if (this.fallback) error['fallback'] = true;
    return { error };
  }
}

export const isHubError = (e: unknown): e is HubError => e instanceof HubError;

export const badRequest = (code: string, message: string, param?: string): HubError =>
  new HubError({ status: 400, code, message, ...(param ? { param } : {}) });

export const notFound = (code: string, message: string): HubError => new HubError({ status: 404, code, message });

export const conflict = (code: string, message: string): HubError => new HubError({ status: 409, code, message });

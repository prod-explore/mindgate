import { isApiError } from '../api/client';
import { t, type Key } from '../i18n';

/** Codes whose message is better said in the panel's own words (and language). */
const KNOWN: Record<string, Key> = {
  network: 'err.network',
  node_auth_failed: 'err.node_auth_failed',
  agent_missing: 'err.agent_missing',
  no_agent: 'err.no_agent',
  node_unavailable: 'err.node_unavailable',
  too_many_auth_failures: 'err.too_many_auth_failures',
  invalid_admin_token: 'err.invalid_admin_token',
};

/** An error that arrived as plain data (the hub reports why the agent could not be asked as `{code, message}`). */
export function describeCode(code: string, message: string): string {
  const known = KNOWN[code];
  if (!known) return message;
  return code === 'too_many_auth_failures' ? `${t(known)} (${message})` : t(known);
}

export function describeError(e: unknown): string {
  if (isApiError(e)) return describeCode(e.code, e.message);
  return e instanceof Error ? e.message : String(e);
}

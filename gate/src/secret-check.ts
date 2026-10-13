/**
 * Startup check for the two secrets the hub cannot run without (MINDGATE_MASTER_KEY, MINDGATE_ADMIN_TOKEN).
 *
 * `.env.example` ships obvious placeholders; a copied example would otherwise start happily with a secret everybody
 * knows. This refuses placeholders, short values and values made of a few repeated characters.
 * MINDGATE_ALLOW_WEAK_SECRETS=true turns the refusal into a warning (local development only).
 */

export const MIN_SECRET_LENGTH = 24;

const PLACEHOLDER = /^(change[-_ ]?me|your[-_ ].*|.*[-_ ]here|secret|password|token|test|ci|example|todo|x+)$/i;

/** Why a secret is unacceptable, or null when it is fine. */
export function weakSecretReason(value: string): string | null {
  if (PLACEHOLDER.test(value.trim())) return 'it is a placeholder from .env.example';
  if (value.length < MIN_SECRET_LENGTH) return `it is shorter than ${MIN_SECRET_LENGTH} characters`;
  if (new Set(value).size < 8) return 'it has too few distinct characters';
  return null;
}

export function assertStrongSecret(name: string, value: string, env: NodeJS.ProcessEnv, warn: (m: string) => void): void {
  const reason = weakSecretReason(value);
  if (!reason) return;
  const message = `${name} is too weak: ${reason}. Generate one with: openssl rand -hex 32`;
  if (/^(1|true|yes|on)$/i.test(env['MINDGATE_ALLOW_WEAK_SECRETS'] ?? '')) {
    warn(`${message} (allowed by MINDGATE_ALLOW_WEAK_SECRETS)`);
    return;
  }
  throw new Error(message);
}

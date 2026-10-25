import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Provider API keys are encrypted at rest with AES-256-GCM.
 *
 * - The data key comes from MINDGATE_MASTER_KEY through HKDF-SHA256 with a random salt per stored value, so the same
 *   master key never produces the same data key twice. MINDGATE_MASTER_KEY is a random 256-bit secret (the startup
 *   check refuses weak ones), which is why a fast KDF is the right tool here.
 * - A fresh random IV for every write.
 * - The provider id and field are bound in as AAD: a ciphertext copied from one row into another fails
 *   authentication instead of quietly sending one provider's key to a different upstream.
 * - The master key lives in the process environment, not in the database, so a stolen database file or backup is not
 *   enough on its own. It does not protect against someone who has both (root on the host) or a compromised process.
 *
 * Client API keys are the other secret handled here: generated at random and stored only as a SHA-256 hash.
 */

const INFO = 'mindgate/secret/v1';
const VERSION = 'v1';

export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretError';
  }
}

export class SecretBox {
  private readonly derived = new Map<string, Buffer>();

  constructor(private readonly masterKey: string) {}

  private keyFor(salt: Buffer): Buffer {
    const id = salt.toString('base64');
    let key = this.derived.get(id);
    if (!key) {
      key = Buffer.from(hkdfSync('sha256', this.masterKey, salt, INFO, 32));
      this.derived.set(id, key);
    }
    return key;
  }

  seal(aad: string, plaintext: string): string {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keyFor(salt), iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [VERSION, salt.toString('base64'), iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
  }

  open(aad: string, sealed: string): string {
    const parts = sealed.split('.');
    if (parts.length !== 5 || parts[0] !== VERSION) throw new SecretError('unrecognised secret format');
    try {
      const [salt, iv, tag, ct] = parts.slice(1).map(p => Buffer.from(p, 'base64')) as [Buffer, Buffer, Buffer, Buffer];
      const decipher = createDecipheriv('aes-256-gcm', this.keyFor(salt), iv);
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch {
      throw new SecretError('the stored secret cannot be decrypted (was MINDGATE_MASTER_KEY changed?) — enter it again');
    }
  }
}

export const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Only the hash of a client key is stored; the key itself is shown once, when it is created. */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const key = `mg-${randomBytes(32).toString('base64url')}`;
  return { key, prefix: keyPrefix(key), hash: sha256Hex(key) };
}

export const keyPrefix = (key: string): string => key.slice(0, 9);

export const randomId = (prefix: string): string => `${prefix}_${randomBytes(6).toString('hex')}`;

/** Constant-time comparison of two strings of any length. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/**
 * Envelope encryption for stored integration credentials.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 * `EtimeService.ts:25` carries its vendor Basic-auth credential as a string
 * literal in source. That is simultaneously a secret leak (it is in git history
 * and in every clone), a tenant coupling (one institute's credential compiled
 * into the product), and a reason the repository cannot be handed to a
 * contractor.
 *
 * ── AES-256-GCM, not CBC ────────────────────────────────────────────────────
 * GCM is authenticated: it detects tampering. With CBC, an attacker with write
 * access to the database could flip ciphertext bits and the application would
 * decrypt garbage without noticing. Here, a modified ciphertext fails to
 * authenticate and throws.
 *
 * ── Fail closed on a missing key ────────────────────────────────────────────
 * With no CONFIG_ENCRYPTION_KEY, `encryptSecret` REFUSES rather than storing
 * plaintext. Storing a credential in the clear because a variable was unset is
 * exactly the outcome this module exists to prevent, and a silent downgrade
 * would be discovered only by whoever reads the database next.
 */

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits — the GCM standard
const KEY_BYTES = 32;

export interface SealedSecret {
  /** Algorithm marker, so a future rotation can migrate old values knowingly. */
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

export class EncryptionKeyMissing extends Error {
  readonly code = 'CONFIG_ENCRYPTION_KEY_MISSING';
  constructor() {
    super(
      'CONFIG_ENCRYPTION_KEY is not set. Refusing to store an integration credential ' +
        'in plaintext. Generate one with: openssl rand -hex 32',
    );
    this.name = 'EncryptionKeyMissing';
  }
}

/** The 32-byte key, accepted as hex or base64. */
function loadKey(): Buffer | null {
  const raw = (process.env.CONFIG_ENCRYPTION_KEY || '').trim();
  if (!raw) return null;

  let key: Buffer;
  if (/^[0-9a-f]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
  else key = Buffer.from(raw, 'base64');

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `CONFIG_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
        'Generate one with: openssl rand -hex 32',
    );
  }
  return key;
}

export function encryptionAvailable(): boolean {
  try {
    return loadKey() !== null;
  } catch {
    return false;
  }
}

export function encryptSecret(plaintext: string): SealedSecret {
  const key = loadKey();
  if (!key) throw new EncryptionKeyMissing();

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export function decryptSecret(sealed: SealedSecret): string {
  const key = loadKey();
  if (!key) throw new EncryptionKeyMissing();
  if (sealed?.v !== 1) throw new Error(`Unsupported sealed-secret version: ${String(sealed?.v)}`);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  // Throws on a tampered ciphertext — that is the point of GCM.
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** Never log a credential. Renders a sealed value as a safe placeholder. */
export function describeSecret(sealed?: SealedSecret | null): string {
  return sealed ? `<sealed:${sealed.data.length} bytes>` : '<unset>';
}

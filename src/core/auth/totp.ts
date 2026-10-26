/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226), on Node's crypto.
 *
 * What every authenticator app (Google Authenticator, Microsoft Authenticator,
 * 1Password, Authy…) expects by default: HMAC-SHA1, 6 digits, 30-second steps,
 * a base32 secret. No dependency: the algorithm is a dozen lines, and it is
 * checked against the RFC's own test vectors in scripts/safety/ops-hardening.test.ts.
 *
 * `verifyTotp` accepts the current step and one either side (clock drift) and
 * returns WHICH step matched, so the caller can refuse a code it has already
 * accepted (replay) by remembering the last step used.
 */

import crypto from 'crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Invalid base32 character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new random secret: 20 bytes (160 bits, the RFC 4226 recommendation), base32. */
export function newTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

/** The HOTP value for a counter (RFC 4226 §5.3). */
export function hotp(
  secret: Buffer,
  counter: number,
  digits = TOTP_DIGITS,
  algorithm: 'sha1' | 'sha256' | 'sha512' = 'sha1',
): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(algorithm, secret).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totpStep(atMs: number = Date.now()): number {
  return Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
}

/**
 * The step a code matches within ±window steps of `atMs`, or null.
 * Compared in constant time per candidate.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  atMs: number = Date.now(),
  window = 1,
): number | null {
  const digits = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const secret = base32Decode(secretBase32);
  const now = totpStep(atMs);
  for (let delta = -window; delta <= window; delta++) {
    const step = now + delta;
    const expected = hotp(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(digits)))
      return step;
  }
  return null;
}

/** The provisioning URI an authenticator app reads (QR code or "enter a key"). */
export function otpauthUri(
  secretBase32: string,
  account: string,
  issuer: string,
): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

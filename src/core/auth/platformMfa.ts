/**
 * Two-factor sign-in for platform staff (Central Management console).
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * A platform account can suspend organizations, change subscriptions, start
 * store builds and mint password-reset links for any institute's users. A
 * password alone is not enough for that.
 *
 * ── The flow ─────────────────────────────────────────────────────────────────
 *   enrolled     POST /login with email + password returns NO session — a
 *                5-minute `platform-mfa` token. POST /login/mfa with that token
 *                and a 6-digit code (or a one-time recovery code) returns the
 *                session.
 *   required     PLATFORM_MFA_REQUIRED=all (every role) or =privileged (owner
 *                and billing — the roles that change money or access). A
 *                required-but-unenrolled account gets a 15-minute
 *                `platform-mfa-enroll` token instead of a session, usable only
 *                on the enrollment routes; and any session it already holds is
 *                refused everywhere except enrollment.
 *   optional     Without the variable, staff may enroll from Settings; nothing
 *                else changes.
 *
 * ── Secrets ──────────────────────────────────────────────────────────────────
 * The TOTP secret is stored sealed (core/config/secrets: AES-256-GCM under
 * CONFIG_ENCRYPTION_KEY) and never returned after enrollment. Without that key
 * enrollment is refused (503 MFA_UNAVAILABLE) — never stored in plaintext.
 * Recovery codes are shown once and stored as SHA-256 hashes; each works once.
 * A code's time step is remembered, so the same code cannot be used twice.
 */

import crypto from 'crypto';
import jwt from 'jsonwebtoken';

export type MfaRequirement = 'all' | 'privileged' | 'none';
const PRIVILEGED_ROLES = new Set(['owner', 'billing']);
export const RECOVERY_CODE_COUNT = 10;
export const MFA_PENDING_TTL = '5m';
export const MFA_ENROLL_TTL = '15m';
export const MFA_ISSUER = 'Central Management';

export function mfaRequirement(
  env: NodeJS.ProcessEnv = process.env,
): MfaRequirement {
  const raw = String(env.PLATFORM_MFA_REQUIRED || '')
    .trim()
    .toLowerCase();
  if (raw === 'all' || raw === 'true') return 'all';
  if (raw === 'privileged') return 'privileged';
  return 'none';
}

/** Must this role have MFA before it may use the console? */
export function mfaRequiredFor(
  role: string | null | undefined,
  requirement: MfaRequirement = mfaRequirement(),
): boolean {
  if (requirement === 'all') return true;
  if (requirement === 'privileged')
    return PRIVILEGED_ROLES.has(String(role || ''));
  return false;
}

/** Ten recovery codes, xxxxx-xxxxx from an unambiguous alphabet. */
export function newRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const code = () =>
    Array.from(
      { length: 10 },
      () => alphabet[crypto.randomInt(alphabet.length)],
    )
      .join('')
      .replace(/^(.{5})/, '$1-');
  return Array.from({ length: count }, code);
}

export function hashRecoveryCode(code: string): string {
  return crypto
    .createHash('sha256')
    .update(
      String(code || '')
        .trim()
        .toLowerCase()
        .replace(/\s/g, ''),
    )
    .digest('hex');
}

/** The index of the stored hash a recovery code matches, or -1. */
export function matchRecoveryCode(
  code: string,
  hashes: readonly string[],
): number {
  const candidate = Buffer.from(hashRecoveryCode(code), 'hex');
  for (let i = 0; i < hashes.length; i++) {
    const stored = Buffer.from(String(hashes[i] || ''), 'hex');
    if (
      stored.length === candidate.length &&
      crypto.timingSafeEqual(stored, candidate)
    )
      return i;
  }
  return -1;
}

function secret(): string {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error('JWT_SECRET is not set');
  return value;
}

type StepAudience = 'platform-mfa' | 'platform-mfa-enroll';

/** A short token proving the password step passed — never a session. */
export function signMfaStepToken(
  aud: StepAudience,
  claims: { id: string; tokenVersion: number },
): string {
  return jwt.sign(
    { id: claims.id, tokenVersion: claims.tokenVersion, aud },
    secret(),
    {
      expiresIn: aud === 'platform-mfa' ? MFA_PENDING_TTL : MFA_ENROLL_TTL,
    },
  );
}

export function verifyMfaStepToken(
  raw: string,
  aud: StepAudience,
): { id: string; tokenVersion: number } {
  const decoded = jwt.verify(String(raw || ''), secret()) as {
    id?: string;
    tokenVersion?: number;
    aud?: string;
  };
  if (decoded.aud !== aud || !decoded.id)
    throw new Error('Not an MFA step token');
  return {
    id: decoded.id,
    tokenVersion: Number(decoded.tokenVersion ?? 0) || 0,
  };
}

/** Paths an account that must enroll may still reach with a session. */
export function isEnrollmentPath(path: string): boolean {
  return /\/api\/platform\/mfa(\/|$)/.test(String(path || '').split('?')[0]);
}

export const MFA_UNAVAILABLE = {
  status: 503,
  code: 'MFA_UNAVAILABLE',
  message:
    'Two-factor sign-in is not available: the server has no CONFIG_ENCRYPTION_KEY to protect the secret.',
} as const;

export const MFA_ENROLLMENT_REQUIRED = {
  status: 403,
  code: 'MFA_ENROLLMENT_REQUIRED',
  message: 'Set up two-factor sign-in to continue.',
} as const;

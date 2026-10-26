/**
 * How long a session lasts on the ORGANIZATION platform (/platform-api), and
 * which old sessions it still honours.
 *
 * ── Why the platform differs from /api ──────────────────────────────────────
 * /api serves the installed institute app, which has no refresh logic: its
 * 10-year token stays exactly as it is. The platform's clients refresh — the
 * web panel always, the organization app since 2026-10-14 (client-platform-app
 * 3841dc4). Organization APKs built between 2026-09-21 (automated builds) and
 * then do NOT refresh, so the platform cannot simply stop issuing long tokens
 * without stranding whoever installed one.
 *
 * ── The policy ───────────────────────────────────────────────────────────────
 *   refresh asked   15-minute access token + rotating 30-day refresh token
 *                   (unchanged).
 *   not asked       a single token capped at PLATFORM_NONREFRESH_TOKEN_TTL
 *                   (default 30d) — never ten years. An old APK keeps working;
 *                   its user signs in again when it lapses.
 *   required        PLATFORM_REQUIRE_REFRESH=true refuses a login that does not
 *                   ask for refresh (426 CLIENT_UPDATE_REQUIRED). For when no
 *                   old APK remains in use. Default off.
 *
 * ── Tokens already issued ────────────────────────────────────────────────────
 * Ten-year platform tokens issued before this change remain valid — revoking
 * them on deploy would log out every old-APK user at once. Two ways to end
 * them, both deliberate:
 *   per user        bump `tokenVersion` (password change, reset, sign out
 *                   everywhere) — already enforced through the `tv` claim;
 *   all at once     PLATFORM_LEGACY_TOKEN_NOT_BEFORE=<ISO date>: a long-lived
 *                   token (no audience, lifetime over 31 days) issued before
 *                   that moment is refused with 401 SESSION_REISSUE_REQUIRED,
 *                   which every client treats as "sign in again".
 *
 * Pure (environment and claims in, decisions out):
 * scripts/safety/ops-hardening.test.ts.
 */

export const DEFAULT_PLATFORM_NONREFRESH_TTL = '30d';
const MAX_PLATFORM_NONREFRESH_SECONDS = 90 * 24 * 3600;
const LONG_LIVED_SECONDS = 31 * 24 * 3600;

/** A jsonwebtoken duration ("30d", "12h", "900") in seconds, or null if unreadable. */
export function durationSeconds(value: string): number | null {
  const m = String(value || '')
    .trim()
    .match(/^(\d+)\s*([smhd]?)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  return (
    n * ({ s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[unit]
  );
}

/**
 * The lifetime of a non-refreshable token on the platform: the configured value
 * when it reads as a duration of at most 90 days, else the default. A typo can
 * only shorten sessions, never bring back ten years.
 */
export function platformNonRefreshTtl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = String(env.PLATFORM_NONREFRESH_TOKEN_TTL || '').trim();
  const seconds = durationSeconds(configured);
  if (
    configured &&
    seconds !== null &&
    seconds > 0 &&
    seconds <= MAX_PLATFORM_NONREFRESH_SECONDS
  )
    return configured;
  return DEFAULT_PLATFORM_NONREFRESH_TTL;
}

export function platformRequiresRefresh(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    String(env.PLATFORM_REQUIRE_REFRESH || '')
      .trim()
      .toLowerCase() === 'true'
  );
}

/** The moment before which long-lived platform tokens are no longer honoured, or null. */
export function legacyTokenNotBefore(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = String(env.PLATFORM_LEGACY_TOKEN_NOT_BEFORE || '').trim();
  if (!raw) return null;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : at;
}

/** Should this verified token be refused on the platform? */
export function refusesLongLivedToken(
  claims: { aud?: string; iat?: number; exp?: number },
  notBefore: number | null,
): boolean {
  if (notBefore === null) return false;
  if (claims.aud) return false; // tenant/refresh/platform tokens are short by construction
  const iat = Number(claims.iat);
  const exp = Number(claims.exp);
  if (!Number.isFinite(iat)) return true; // a long-lived token with no issue time cannot prove it is recent
  const longLived = !Number.isFinite(exp) || exp - iat > LONG_LIVED_SECONDS;
  return longLived && iat * 1000 < notBefore;
}

export const SESSION_REISSUE_REQUIRED = {
  status: 401,
  code: 'SESSION_REISSUE_REQUIRED',
  message: 'Your session has ended. Please sign in again.',
} as const;

export const CLIENT_UPDATE_REQUIRED = {
  status: 426,
  code: 'CLIENT_UPDATE_REQUIRED',
  message: 'Please update the app to sign in.',
} as const;

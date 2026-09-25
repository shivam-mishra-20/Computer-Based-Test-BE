/**
 * Token minting and verification, across three audiences.
 *
 * ── Why audiences and not just roles ────────────────────────────────────────
 * A token minted for one audience is rejected at the door of another, BEFORE
 * any permission or entitlement check runs. That is what makes "a tenant user
 * cannot reach /api/platform/*" a structural property rather than the result of
 * a permission check somewhere being correct. A bug in tenant RBAC cannot
 * escalate into platform access, because the request never gets that far.
 *
 *   tenant    org users on api-platform  -> /api/*, /api/org/*
 *   platform  PlatformUser               -> /api/platform/*
 *   legacy    org users on api-legacy    -> /api/* only
 *
 * ── Legacy compatibility ────────────────────────────────────────────────────
 * The legacy audience exists so api-legacy can keep issuing exactly the token
 * the installed Abhigyan app already understands: same shape, same long expiry,
 * no orgId claim required. Verification accepts a token with NO audience claim
 * at all and treats it as legacy — every token in the field today was minted
 * before this code existed, and rejecting them would log out every user on
 * deploy.
 */

import jwt from 'jsonwebtoken';

export type TokenAudience = 'tenant' | 'platform' | 'legacy';

export interface TenantTokenClaims {
  id: string;
  orgId?: string;
  role?: string;
  tokenVersion?: number;
  aud?: TokenAudience;
}

export interface PlatformTokenClaims {
  id: string;
  role: string;
  tokenVersion?: number;
  aud: 'platform';
}

/** Access-token lifetimes. Legacy keeps its existing 10-year expiry. */
export const TOKEN_TTL = {
  tenant: '15m',
  platform: '15m',
  refresh: '30d',
  /**
   * 3650 days — for clients that cannot refresh, and ONLY them.
   *
   * The installed legacy app has no refresh logic; shortening this would log
   * every user out the moment their current token expired, with no way for the
   * app to recover. So a client that does not ask for a refreshable session
   * still gets this shape — with two changes that do not need the client's
   * cooperation:
   *
   *   revocable   the token carries `tv` (the user's tokenVersion); a password
   *               change, a reset or "sign out everywhere" bumps it and every
   *               outstanding token dies. A token with no `tv` is valid only
   *               while the user has never been revoked (tokenVersion 0).
   *   bounded     an ADMINISTRATOR's session is capped at `legacyAdmin`. An
   *               admin token is the most valuable credential a tenant has.
   *
   * Clients that can refresh (the web panel) ask for `session: 'refresh'` and
   * get a 15-minute access token and a rotating 30-day refresh token instead.
   */
  legacy: '3650d',
  legacyAdmin: '30d',
} as const;

function secret(): string {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error('JWT_SECRET is not set');
  return value;
}

export function signTenantToken(claims: Omit<TenantTokenClaims, 'aud'>): string {
  return jwt.sign({ ...claims, aud: 'tenant' }, secret(), { expiresIn: TOKEN_TTL.tenant });
}

export function signPlatformToken(claims: Omit<PlatformTokenClaims, 'aud'>): string {
  return jwt.sign({ ...claims, aud: 'platform' }, secret(), { expiresIn: TOKEN_TTL.platform });
}

/** The legacy shape: no audience claim, long expiry — byte-compatible. */
export function signLegacyToken(claims: { id: string; role?: string }): string {
  return jwt.sign(claims, secret(), { expiresIn: TOKEN_TTL.legacy });
}

export function signRefreshToken(claims: { id: string; orgId?: string; tokenVersion?: number }): string {
  return jwt.sign({ ...claims, aud: 'refresh' }, secret(), { expiresIn: TOKEN_TTL.refresh });
}

export class TokenAudienceMismatch extends Error {
  readonly code = 'TOKEN_AUDIENCE_MISMATCH';
  constructor(expected: string, actual: string) {
    super(`This credential is not valid here (expected ${expected}, got ${actual}).`);
    this.name = 'TokenAudienceMismatch';
  }
}

/**
 * Verify a token and assert its audience.
 *
 * A token with NO `aud` claim is treated as `legacy` — see the header. That is
 * a deliberate compatibility decision, not an oversight, and it means a legacy
 * token can never satisfy `expected: 'platform'`.
 */
export function verifyToken<T extends { aud?: string }>(
  raw: string,
  expected: TokenAudience,
): T {
  const decoded = jwt.verify(raw, secret()) as T;
  const actual = (decoded.aud ?? 'legacy') as TokenAudience;

  if (actual !== expected) throw new TokenAudienceMismatch(expected, actual);
  return decoded;
}

/** Verify without asserting an audience — for middleware that branches on it. */
export function verifyAny<T extends { aud?: string }>(raw: string): T & { aud: TokenAudience } {
  const decoded = jwt.verify(raw, secret()) as T;
  return { ...decoded, aud: (decoded.aud ?? 'legacy') as TokenAudience };
}

/**
 * The session token the login endpoints issue.
 *
 * ── Why this is not `signTenantToken` ───────────────────────────────────────
 * P2 minted `tenant` tokens with a 15-minute expiry and an `aud` claim. Neither
 * is safe here: the installed Abhigyan app has no refresh logic, so a 15-minute
 * token logs every user out fifteen minutes after deploy with no way back, and
 * a client that pins `aud: 'tenant'` cannot also be accepted by api-legacy.
 *
 * So this is the LEGACY SHAPE, byte-compatible with what production issues
 * today — same claims, same 3650-day expiry, no `aud` — with exactly one
 * addition: `orgId`, and only when the user actually has one.
 *
 * That single claim is what makes claim-mode multi-tenancy possible at all.
 * Without it `tenantContextMiddleware` finds no organization on an
 * authenticated request, `/api/me/context` returns `organization: null`, and no
 * client can ever be tenant-aware. With it, one deployment serves every
 * organization and the tenant is decided by who logged in.
 *
 * Additive by construction:
 *   - api-legacy runs pinned, where the claim is never consulted.
 *   - the installed app ignores unknown claims.
 *   - a user with no orgId (pre-backfill) gets precisely today's token.
 */
export function signSessionToken(claims: {
  id: string;
  role?: string;
  orgId?: string | null;
  tokenVersion?: number;
}): string {
  const payload: Record<string, unknown> = { id: claims.id };
  if (claims.role) payload.role = claims.role;
  if (claims.orgId) payload.orgId = String(claims.orgId);
  if (typeof claims.tokenVersion === 'number') payload.tv = claims.tokenVersion;
  const ttl = claims.role === 'admin' ? TOKEN_TTL.legacyAdmin : TOKEN_TTL.legacy;
  return jwt.sign(payload, secret(), { expiresIn: ttl });
}

export interface SessionPair {
  token: string;
  refreshToken: string;
  /** Seconds until `token` expires, for the client's refresh timer. */
  expiresIn: number;
}

/**
 * A refreshable session: a short access token and a rotating refresh token.
 *
 * The access token is a `tenant` token (accepted by authMiddleware exactly like
 * a session token) that lives 15 minutes. The refresh token is audience
 * `refresh`, so it can never be presented as an access token, and it carries
 * `tv` so revoking the user kills it too.
 */
export function signSessionPair(claims: {
  id: string;
  role?: string;
  orgId?: string | null;
  tokenVersion: number;
}): SessionPair {
  const access: Record<string, unknown> = { id: claims.id, tv: claims.tokenVersion, aud: 'tenant' };
  if (claims.role) access.role = claims.role;
  if (claims.orgId) access.orgId = String(claims.orgId);
  const refresh: Record<string, unknown> = { id: claims.id, tv: claims.tokenVersion, aud: 'refresh' };
  if (claims.orgId) refresh.orgId = String(claims.orgId);
  return {
    token: jwt.sign(access, secret(), { expiresIn: TOKEN_TTL.tenant }),
    refreshToken: jwt.sign(refresh, secret(), { expiresIn: TOKEN_TTL.refresh }),
    expiresIn: 15 * 60,
  };
}

/** Verify a refresh token. Throws on anything that is not one. */
export function verifyRefreshToken(raw: string): { id: string; tv?: number; orgId?: string } {
  const decoded = jwt.verify(raw, secret()) as { id?: string; tv?: number; orgId?: string; aud?: string };
  if (decoded.aud !== 'refresh' || !decoded.id) throw new TokenAudienceMismatch('refresh', String(decoded.aud ?? 'legacy'));
  return { id: decoded.id, tv: decoded.tv, orgId: decoded.orgId };
}

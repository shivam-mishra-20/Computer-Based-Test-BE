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
   * 3650 days — deliberately unchanged.
   *
   * The installed app has no refresh logic; shortening this would log every
   * user out the moment their current token expired, with no way for the app to
   * recover. It is a real weakness and it is tracked as one, but fixing it
   * requires a client that can refresh, which is the new app.
   */
  legacy: '3650d',
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

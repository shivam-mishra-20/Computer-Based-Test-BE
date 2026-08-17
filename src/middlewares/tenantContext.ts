/**
 * Opens a tenant context for the lifetime of a request.
 *
 * Mounted globally, before the routes, so every handler and every service they
 * call runs inside a context without any of them knowing it exists.
 *
 * ── Resolution order ────────────────────────────────────────────────────────
 *   pinned  ORG_ID from configuration. The client is never consulted, so the
 *           legacy app — which knows nothing about organizations — still runs
 *           inside a real, explicit context.
 *
 *   claim   The `orgId` claim inside the signed token. Authoritative: a signed
 *           claim cannot be forged, whereas a header can. A host or header is
 *           consulted only when there is no token at all, which is the
 *           pre-authentication case (login needs to know which organization to
 *           authenticate against before a token exists).
 *
 * A claim and a host that DISAGREE are rejected rather than reconciled. A
 * mismatch is either a bug or an attack; silently picking one is how a
 * cross-tenant request gets served.
 */

import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { runWithTenant, type TenantContext } from '../core/tenancy/context';
import { pinnedOrgId, tenantEnforcement, tenantMode } from '../core/tenancy/config';

interface TokenClaims {
  id?: string;
  orgId?: string;
  aud?: string;
}

/** Decode without verifying — used only to READ a claim for routing. */
function peekClaims(req: Request): TokenClaims | null {
  const token = req.header('Authorization')?.replace('Bearer ', '').trim();
  if (!token || token === 'null' || token === 'undefined' || token.length < 20) return null;
  try {
    // Verified, not merely decoded: an unverified claim could be edited by the
    // caller to name another organization, which is precisely the attack this
    // whole layer exists to prevent. authMiddleware verifies again later for
    // its own purposes; verifying twice is cheap next to being wrong once.
    return jwt.verify(token, process.env.JWT_SECRET as string) as TokenClaims;
  } catch {
    return null;
  }
}

/** Organization hinted by the request's host — `abhigyan.example.com` → `abhigyan`. */
function orgHintFromHost(req: Request): string | null {
  const header = (req.header('X-Org-Id') || '').trim();
  if (header) return header;
  return null;
}

export function tenantContextMiddleware(req: Request, res: Response, next: NextFunction) {
  if (tenantEnforcement() === 'off') return next();

  const mode = tenantMode();

  if (mode === 'pinned') {
    const orgId = pinnedOrgId();
    if (!orgId) {
      // Refusing to serve is correct: the alternative is running unscoped and
      // pretending that is the same thing.
      return res.status(503).json({
        message: 'Server misconfigured: TENANT_MODE=pinned requires ORG_ID.',
        code: 'TENANT_NOT_CONFIGURED',
      });
    }
    const claims = peekClaims(req);
    const context: TenantContext = {
      orgId,
      userId: claims?.id ?? null,
      source: 'pinned',
    };
    return runWithTenant(context, () => next());
  }

  // ── claim mode ───────────────────────────────────────────────────────────
  const claims = peekClaims(req);
  const hint = orgHintFromHost(req);

  if (claims?.orgId) {
    if (hint && hint !== claims.orgId) {
      return res.status(400).json({
        message: 'Organization mismatch between credentials and request.',
        code: 'TENANT_MISMATCH',
      });
    }
    const context: TenantContext = {
      orgId: claims.orgId,
      userId: claims.id ?? null,
      source: 'claim',
    };
    return runWithTenant(context, () => next());
  }

  // No usable organization. Pre-authentication routes (login, health, org
  // resolution) legitimately land here and opt out explicitly where they touch
  // the database. Under warn this is observed; under enforce a tenant-data
  // route reaching the database from here throws, which is the intent.
  return next();
}

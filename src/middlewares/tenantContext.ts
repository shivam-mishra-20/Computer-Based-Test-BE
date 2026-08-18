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
import { runWithTenant, withoutTenantScope, type TenantContext } from '../core/tenancy/context';
import { findPublicRoute } from '../core/tenancy/publicRoutes';
import { isExplicitlyPinned, pinnedOrgId, tenantEnforcement, tenantMode } from '../core/tenancy/config';
import { resolveOrgFromRequest } from '../core/tenancy/hostResolution';

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

/** The explicit organization hint a client may send. Routing only — grants nothing. */
function orgHintHeader(req: Request): string | null {
  const header = (req.header('X-Org-Id') || '').trim();
  return header || null;
}

export function tenantContextMiddleware(req: Request, res: Response, next: NextFunction) {
  if (tenantEnforcement() === 'off') return next();

  const mode = tenantMode();

  if (mode === 'pinned') {
    const orgId = pinnedOrgId();
    if (!orgId) {
      // ── The distinction that prevents a total outage ─────────────────────
      // `tenantMode()` DEFAULTS to 'pinned' because that is the safest tenancy
      // behaviour. But today's production sets no TENANT_* variables at all, so
      // it lands here on every request. Returning 503 unconditionally would
      // take the entire live system down the moment this code deployed —
      // exactly the failure this whole migration exists to avoid.
      //
      // A 503 is correct ONLY when someone deliberately asked for pinned mode
      // and forgot the organization; that is a misconfiguration worth refusing.
      // An unconfigured deployment is not misconfigured, it is pre-migration,
      // and it must behave precisely as it did before.
      if (isExplicitlyPinned()) {
        return res.status(503).json({
          message: 'Server misconfigured: TENANT_MODE=pinned requires ORG_ID.',
          code: 'TENANT_NOT_CONFIGURED',
        });
      }

      // Pre-migration: no context, exactly as before this middleware existed.
      // Under warn the plugin merely records; under enforce it throws, which is
      // the correct signal that ORG_ID must be set before enforcing.
      return next();
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
  const hint = orgHintHeader(req);

  if (claims?.orgId) {
    const context: TenantContext = {
      orgId: claims.orgId,
      userId: claims.id ?? null,
      source: 'claim',
    };

    // A hint alongside a claim still has to agree — a mismatch is either a bug
    // or an attack, and silently picking one is how a cross-tenant request gets
    // served. But it is compared RESOLVED, not as a string: a client may hold
    // the organization's slug while the claim carries its id, and refusing that
    // pairing would 400 a request that names exactly the right organization.
    if (hint && hint !== claims.orgId) {
      return resolveOrgFromRequest({ header: hint })
        .then((resolved) => {
          if (resolved && resolved === claims.orgId) {
            return runWithTenant(context, () => next());
          }
          return res.status(400).json({
            message: 'Organization mismatch between credentials and request.',
            code: 'TENANT_MISMATCH',
          });
        })
        .catch(() =>
          res.status(400).json({
            message: 'Organization mismatch between credentials and request.',
            code: 'TENANT_MISMATCH',
          }),
        );
    }

    return runWithTenant(context, () => next());
  }

  // ── No claim: the PRE-AUTHENTICATION case ────────────────────────────────
  // Login has to know which organization to authenticate against before a
  // token exists, and a login page has to be branded before the credential
  // that would reveal the branding is submitted. Both are answered by the
  // request's own routing information — an explicit `X-Org-Id`, or the Host
  // the browser actually asked for.
  //
  // This is a HINT, not a credential. It selects which tenant's data the
  // request may see; it never decides who the caller is. The moment a token
  // exists the signed claim takes over, and a hint that disagrees with it is
  // rejected above rather than reconciled.
  //
  // The lookup is skipped entirely when there is nothing to look up, so a
  // deployment with no domains configured pays nothing and behaves exactly as
  // it did before.
  //
  // Platform routes are excluded outright. A PlatformUser's token carries no
  // `orgId` — that is what makes it a platform token — so without this it would
  // fall through to host resolution and every platform request served from a
  // tenant's domain would run inside that tenant's context. Platform code opens
  // its own scopes explicitly; inheriting one it did not ask for is how a
  // cross-tenant read gets silently narrowed, or silently widened.
  if (req.path.startsWith('/api/platform')) {
    return continueWithoutOrg(req, next);
  }

  if (hint || req.headers.host) {
    return resolveOrgFromRequest({ header: hint, host: req.headers.host })
      .then((resolved) => {
        if (resolved) {
          const context: TenantContext = { orgId: resolved, userId: null, source: 'claim' };
          return runWithTenant(context, () => next());
        }
        return continueWithoutOrg(req, next);
      })
      .catch(() => continueWithoutOrg(req, next));
  }

  return continueWithoutOrg(req, next);
}

/**
 * No usable organization. Two possibilities, and they are treated very
 * differently on purpose.
 */
function continueWithoutOrg(req: Request, next: NextFunction) {
  const allowed = findPublicRoute(req.method, req.path);

  if (allowed) {
    // A reviewed, justified entry in the allowlist. The reason string reaches
    // the logs, so every bypass that actually fires is traceable.
    return withoutTenantScope(allowed.reason, () => next());
  }

  // NOT allowlisted. Fall through with no context: under warn this is merely
  // observed, and under enforce the first database call throws. That is the
  // intent — a tenant-data route reaching the database without a context is a
  // bug, and it should fail loudly rather than be granted a blanket bypass.
  return next();
}

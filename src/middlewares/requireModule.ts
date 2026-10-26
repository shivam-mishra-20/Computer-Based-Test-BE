/**
 * Server-side module gating.
 *
 * ── Hiding is not enforcing ─────────────────────────────────────────────────
 * Navigation gating in the clients is a UX affordance and nothing more. A
 * client can be modified and `curl` ignores navigation entirely, so every gated
 * route carries this middleware too — written in the SAME commit as the UI
 * change. The pattern where the client ships first and the middleware follows
 * next sprint is exactly how entitlement bypasses reach production, and the
 * customer who finds it will be the one who reads the API docs.
 */

import { NextFunction, Request, Response } from 'express';
import { currentOrgId } from '../core/tenancy/context';
import { getEntitlement } from '../core/entitlements/resolve';
import { isCoreModule } from '../core/entitlements/moduleRegistry';

const PENDING = Symbol.for('platform.pendingModules');

function deferModule(req: Request, moduleKey: string): void {
  const bag = req as unknown as Record<symbol, string[] | undefined>;
  bag[PENDING] = [...(bag[PENDING] ?? []), moduleKey];
}

/**
 * The module check for a request whose organization only became known at
 * authentication. Returns the refusal, or null.
 *
 * ── Why a second place ──────────────────────────────────────────────────────
 * This gate is mounted in front of the routers, so it runs BEFORE
 * authMiddleware. The only organization it can see there is the one a
 * request's `X-Org-Id` header or host names. A client that simply left the
 * header off used to pass every gate: an institute without the AI module could
 * call /api/ai with its own token and no header. The organization that matters
 * is the authenticated principal's, so the gate DEFERS when it knows none, and
 * authMiddleware calls this once it does.
 */
export async function moduleRefusal(
  req: Request,
  orgId: string,
): Promise<{ status: number; message: string; code: string; module: string } | null> {
  const pending = (req as unknown as Record<symbol, string[] | undefined>)[PENDING] ?? [];
  for (const moduleKey of pending) {
    try {
      const entitlement = await getEntitlement(orgId);
      if (!entitlement.modules.includes(moduleKey)) {
        return {
          status: 403,
          message: 'This module is not enabled for your organization.',
          code: 'MODULE_NOT_ENABLED',
          module: moduleKey,
        };
      }
    } catch (error) {
      // Same policy as the gate itself: commercial, so a failure to resolve is
      // not a lockout.
      console.error(
        `[requireModule] resolution failed for org ${orgId}, allowing through:`,
        (error as Error).message,
      );
    }
  }
  return null;
}

/**
 * Refuse the request unless the caller's organization has `moduleKey`.
 *
 * With no tenant context yet — no header, no host mapping — the check is
 * DEFERRED to authMiddleware, which knows the principal's organization (see
 * `moduleRefusal`). A public route with no signed-in caller stays open, as it
 * always was: the gate is commercial, and tenant isolation is held elsewhere.
 */
export function requireModule(moduleKey: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Core modules are never sold or disabled; gating them would be a way to
    // brick a tenant through a packaging mistake.
    if (isCoreModule(moduleKey)) return next();

    const orgId = currentOrgId();
    if (!orgId) {
      deferModule(req, moduleKey);
      return next();
    }

    try {
      const entitlement = await getEntitlement(orgId);

      if (!entitlement.modules.includes(moduleKey)) {
        return res.status(403).json({
          message: 'This module is not enabled for your organization.',
          code: 'MODULE_NOT_ENABLED',
          module: moduleKey,
        });
      }

      return next();
    } catch (error) {
      // A resolution failure must not become a lockout. The tenant boundary is
      // held by the plugin; this gate is commercial, and a commercial system
      // being briefly unavailable should not stop a class from running.
      console.error(
        `[requireModule] resolution failed for org ${orgId}, allowing through:`,
        (error as Error).message,
      );
      return next();
    }
  };
}

/**
 * Writes that stay open while a subscription is read-only.
 *
 * ── Read-only, never locked out ─────────────────────────────────────────────
 * An expired, suspended or cancelled subscription degrades to read-only so a
 * customer can always see and export their own data, sign in and out, and
 * renew. In-progress exam attempts are exempt entirely: if a payment fails on
 * the morning of a board practice and five hundred students cannot submit,
 * that is not contract enforcement — it is the end of a customer relationship.
 *
 * Every entry is a path that does not grow or change the organization's data:
 * a session, a password, a rendered export, a renewal request.
 */
export const RESTRICTED_WRITE_ALLOWED: readonly RegExp[] = [
  /^\/api\/attempts\//,
  /^\/api\/auth\/(change-password|logout-all)$/,
  /^\/api\/org-admin\/(subscription|billing)(\/|$)/,
  /^\/api\/papers\/temp\/export\/(pdf|doc)$/,
  /^\/api\/teacher\/ai\/history\/[^/]+\/export-pdf$/,
  /^\/api\/materials\/[^/]+\/download$/,
];

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The read-only refusal for a request in `orgId`, or null when it may proceed.
 *
 * Commercial, like the module gate: a resolution failure lets the request
 * through rather than locking a customer out over a billing-system fault.
 * `423 SUBSCRIPTION_READ_ONLY` mirrors `423 ORG_READ_ONLY` (an administrative
 * suspension), so a client that already explains one explains both.
 */
export async function subscriptionWriteRefusal(
  req: Request,
  orgId: string,
): Promise<{ status: number; message: string; code: string; subscriptionStatus: string } | null> {
  if (SAFE_METHODS.has(req.method)) return null;
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  if (RESTRICTED_WRITE_ALLOWED.some((rx) => rx.test(path))) return null;
  try {
    const entitlement = await getEntitlement(orgId);
    if (entitlement.writable) return null;
    return {
      status: 423,
      message:
        'Your subscription is not active, so your organization is read-only. Your data can still be viewed and exported; renew to make changes again.',
      code: 'SUBSCRIPTION_READ_ONLY',
      subscriptionStatus: entitlement.status,
    };
  } catch (error) {
    console.error(
      `[subscription] resolution failed for org ${orgId}, allowing through:`,
      (error as Error).message,
    );
    return null;
  }
}

/** The same rule as a route middleware, for a router that runs before authMiddleware knows the org. */
export function requireWritable() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const orgId = currentOrgId();
    if (!orgId) return next();
    const refusal = await subscriptionWriteRefusal(req, orgId);
    if (!refusal) return next();
    return res.status(refusal.status).json({
      message: refusal.message,
      code: refusal.code,
      subscriptionStatus: refusal.subscriptionStatus,
    });
  };
}

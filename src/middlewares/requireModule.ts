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
 * Refuse WRITES when the subscription is suspended or cancelled.
 *
 * ── Read-only, never locked out ─────────────────────────────────────────────
 * Suspension degrades to read-only so a customer can always see and export
 * their own data. And in-progress exam attempts are exempt entirely: if a
 * payment fails on the morning of a board practice and five hundred students
 * cannot submit, that is not contract enforcement — it is the end of a customer
 * relationship, and the review that costs the next three.
 */
const ATTEMPT_PATH = /^\/api\/attempts\//;

export function requireWritable() {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

    const orgId = currentOrgId();
    if (!orgId) return next();

    // In-progress attempts always complete. See the comment above.
    if (ATTEMPT_PATH.test(req.path)) return next();

    try {
      const entitlement = await getEntitlement(orgId);
      if (entitlement.writable) return next();

      return res.status(402).json({
        message: 'Your subscription is not active. Your data remains available to read and export.',
        code: 'SUBSCRIPTION_NOT_WRITABLE',
        status: entitlement.status,
      });
    } catch (error) {
      console.error(
        `[requireWritable] resolution failed for org ${orgId}, allowing through:`,
        (error as Error).message,
      );
      return next();
    }
  };
}

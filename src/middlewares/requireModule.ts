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

/**
 * Refuse the request unless the caller's organization has `moduleKey`.
 *
 * Fails OPEN when there is no tenant context, and that is deliberate: the only
 * routes without a context are the pre-authentication and public ones, which
 * are not module-gated. Failing closed here would mean the gate — not the
 * tenancy layer — decides what an unauthenticated caller sees, which puts the
 * decision in the wrong place. Tenant isolation is enforced by the Mongoose
 * plugin regardless of what this middleware concludes.
 */
export function requireModule(moduleKey: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Core modules are never sold or disabled; gating them would be a way to
    // brick a tenant through a packaging mistake.
    if (isCoreModule(moduleKey)) return next();

    const orgId = currentOrgId();
    if (!orgId) return next();

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

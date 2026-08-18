/**
 * Permission-based authorization.
 *
 * ── How this coexists with 271 legacy requireRole() gates ───────────────────
 * It does not replace them. `requireRole()` keeps working untouched, and routes
 * migrate one at a time. The bridge is in `resolveUserPermissions()`: a user
 * with no Role documents falls back to the permissions their legacy role
 * already implies, so converting a route changes nothing for Org 001 while
 * making it work correctly for Org 002's custom roles.
 *
 * Rewriting all 271 in one commit would be unreviewable, and a mistake in any
 * one of them is a lockout for a live customer.
 *
 * ── Permissions never replace tenant isolation ──────────────────────────────
 * A permission answers "may this user do this KIND of thing". It says nothing
 * about WHICH organization's data — that is the Mongoose plugin's job, and it
 * runs regardless of what happens here. A user with students.read still sees
 * only their own organization's students, because the query is scoped before
 * this middleware is even reached.
 */

import { NextFunction, Request, Response } from 'express';
import { resolveUserPermissions } from '../core/rbac/resolve';
import type { Permission } from '../core/rbac/permissions';

interface RequestUser {
  id?: string;
  _id?: string;
  role?: string;
  roleIds?: unknown[];
  orgId?: string;
}

/**
 * Require ALL of the listed permissions.
 *
 * Multiple permissions are ANDed rather than ORed: a route needing both
 * results.read and results.export needs both, and an OR would silently let a
 * user holding only one of them through.
 */
export function requirePermission(...required: (Permission | string)[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = (req as Request & { user?: RequestUser }).user;

    if (!user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    try {
      const access = await resolveUserPermissions(user);
      const missing = required.filter((p) => !access.permissions.has(p));

      if (missing.length > 0) {
        return res.status(403).json({
          message: 'You do not have permission to do this.',
          code: 'PERMISSION_DENIED',
          // Naming the missing permission is deliberate: it lets an org admin
          // fix their own role instead of raising a ticket, and reveals nothing
          // an authenticated user could not already infer from the UI.
          required: missing,
        });
      }

      // Cached on the request so a handler needing a second check does not
      // re-resolve — role lookups are a database read.
      (req as Request & { access?: unknown }).access = access;
      return next();
    } catch (error) {
      // FAIL CLOSED. Unlike entitlements — which are commercial, and where a
      // billing outage must not stop a class from running — this is a security
      // decision. Allowing a request through because the permission lookup
      // failed is how an outage becomes a breach.
      console.error('[requirePermission] resolution failed:', (error as Error).message);
      return res.status(403).json({
        message: 'Authorization could not be verified.',
        code: 'PERMISSION_UNRESOLVED',
      });
    }
  };
}

/** Require ANY one of the listed permissions. */
export function requireAnyPermission(...accepted: (Permission | string)[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = (req as Request & { user?: RequestUser }).user;
    if (!user) return res.status(401).json({ message: 'Unauthorized' });

    try {
      const access = await resolveUserPermissions(user);
      if (accepted.some((p) => access.permissions.has(p))) {
        (req as Request & { access?: unknown }).access = access;
        return next();
      }
      return res.status(403).json({
        message: 'You do not have permission to do this.',
        code: 'PERMISSION_DENIED',
        required: accepted,
      });
    } catch (error) {
      console.error('[requireAnyPermission] resolution failed:', (error as Error).message);
      return res.status(403).json({
        message: 'Authorization could not be verified.',
        code: 'PERMISSION_UNRESOLVED',
      });
    }
  };
}

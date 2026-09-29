/**
 * Permission-based authorization.
 *
 * ── How routes use it ───────────────────────────────────────────────────────
 * Tenant routes are guarded by the permission their action needs, not by the
 * name of a role. A user with no assigned Role documents falls back to the
 * permissions their legacy role already implies (`resolveUserPermissions`), so
 * a converted route admits exactly the legacy admins and teachers it always
 * did — while a custom role (Counsellor, Accountant, Front Desk) now restricts
 * the API as well as the UI.
 *
 * ── Staff routes ────────────────────────────────────────────────────────────
 * The vocabulary is `resource.action`, and a STUDENT legitimately holds
 * `exams.read` (their own exams), `results.read` (their own results) and so on.
 * A staff screen that lists every exam must therefore not be opened by
 * `exams.read` alone — that would hand the staff view to every student. The
 * `requireStaff*` variants add the second half of the question: the account is
 * institute staff (its account role is admin or teacher) AND holds the
 * permission. The permission is what a custom role narrows.
 *
 * ── Permissions never replace tenant isolation ──────────────────────────────
 * A permission answers "may this user do this KIND of thing". It says nothing
 * about WHICH organization's data — that is decided by the tenant context the
 * authenticated principal runs in (`authMiddleware`) and enforced on every
 * query by the tenant plugin, before this middleware is even reached.
 */

import { NextFunction, Request, Response } from 'express';
import { resolveUserPermissions, type ResolvedAccess } from '../core/rbac/resolve';
import type { Permission } from '../core/rbac/permissions';

interface RequestUser {
  id?: string;
  _id?: string;
  role?: string;
  /** The account's own role; `role` may be narrowed by assigned custom roles. */
  accountRole?: string;
  roleIds?: unknown[];
  orgId?: string;
}

type AuthedRequest = Request & { user?: RequestUser; access?: ResolvedAccess };

/** Staff accounts: the ones an institute employs, as opposed to students and parents. */
const STAFF_ACCOUNT_ROLES = new Set(['admin', 'teacher']);

export function isStaffAccount(user: RequestUser | undefined): boolean {
  return STAFF_ACCOUNT_ROLES.has(String(user?.accountRole ?? user?.role ?? ''));
}

/** The request's resolved access, resolved once and cached on the request. */
export async function accessOf(req: Request): Promise<ResolvedAccess> {
  const request = req as AuthedRequest;
  if (request.access) return request.access;
  const access = await resolveUserPermissions(request.user ?? {});
  request.access = access;
  return access;
}

/** For handler-level checks that depend on the target (e.g. whose account is being edited). */
export async function holds(req: Request, ...required: (Permission | string)[]): Promise<boolean> {
  const access = await accessOf(req);
  return required.every((p) => access.permissions.has(p));
}

export async function holdsAny(req: Request, ...accepted: (Permission | string)[]): Promise<boolean> {
  const access = await accessOf(req);
  return accepted.some((p) => access.permissions.has(p));
}

/** Staff account AND every listed permission — for checks made inside a handler. */
export async function staffHolds(req: Request, ...required: (Permission | string)[]): Promise<boolean> {
  if (!isStaffAccount((req as AuthedRequest).user)) return false;
  return holds(req, ...required);
}

function denied(res: Response, required: string[]) {
  return res.status(403).json({
    message: 'You do not have permission to do this.',
    code: 'PERMISSION_DENIED',
    // Naming the missing permission is deliberate: it lets an org admin fix
    // their own role instead of raising a ticket, and reveals nothing an
    // authenticated user could not already infer from the UI.
    required,
  });
}

function unresolved(res: Response, label: string, error: unknown) {
  // FAIL CLOSED. Unlike entitlements — which are commercial, and where a
  // billing outage must not stop a class from running — this is a security
  // decision. Allowing a request through because the permission lookup
  // failed is how an outage becomes a breach.
  console.error(`[${label}] resolution failed:`, (error as Error).message);
  return res.status(403).json({
    message: 'Authorization could not be verified.',
    code: 'PERMISSION_UNRESOLVED',
  });
}

interface GuardOptions {
  staff: boolean;
  mode: 'all' | 'any';
}

function guard(options: GuardOptions, perms: (Permission | string)[]) {
  const label = options.mode === 'all' ? 'requirePermission' : 'requireAnyPermission';
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = (req as AuthedRequest).user;
    if (!user) return res.status(401).json({ message: 'Unauthorized' });
    if (options.staff && !isStaffAccount(user)) {
      return res.status(403).json({
        message: 'You do not have permission to do this.',
        code: 'PERMISSION_DENIED',
        required: perms,
      });
    }
    try {
      const access = await accessOf(req);
      if (options.mode === 'all') {
        const missing = perms.filter((p) => !access.permissions.has(p));
        if (missing.length) return denied(res, missing);
      } else if (!perms.some((p) => access.permissions.has(p))) {
        return denied(res, perms);
      }
      return next();
    } catch (error) {
      return unresolved(res, label, error);
    }
  };
}

/**
 * Require ALL of the listed permissions.
 *
 * Multiple permissions are ANDed rather than ORed: a route needing both
 * results.read and results.export needs both, and an OR would silently let a
 * user holding only one of them through.
 */
export function requirePermission(...required: (Permission | string)[]) {
  return guard({ staff: false, mode: 'all' }, required);
}

/** Require ANY one of the listed permissions. */
export function requireAnyPermission(...accepted: (Permission | string)[]) {
  return guard({ staff: false, mode: 'any' }, accepted);
}

/** Staff account AND all of the listed permissions. See the header. */
export function requireStaffPermission(...required: (Permission | string)[]) {
  return guard({ staff: true, mode: 'all' }, required);
}

/** Staff account AND any one of the listed permissions. */
export function requireStaffAnyPermission(...accepted: (Permission | string)[]) {
  return guard({ staff: true, mode: 'any' }, accepted);
}

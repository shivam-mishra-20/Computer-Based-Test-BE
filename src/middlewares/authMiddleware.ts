import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import {
  getTenantContext,
  runWithTenant,
  withoutTenantScope,
  type TenantContext,
} from '../core/tenancy/context';
import { legacyDataOrgId, pinnedOrgId, tenantEnforcement, tenantMode } from '../core/tenancy/config';
import { stashTenantStore } from '../core/tenancy/requestContext';
import { resolveUserPermissions, type ResolvedAccess } from '../core/rbac/resolve';
import { LEGACY_ROLE_PERMISSIONS, PERMISSIONS } from '../core/rbac/permissions';
import { orgStateOf, READ_ONLY_STATUSES } from '../core/tenancy/orgState';
import { moduleRefusal } from './requireModule';

/**
 * WHOSE organization an authenticated request runs in.
 *
 * ── The rule ──────────────────────────────────────────────────────────────────────────
 * The authenticated principal's organization comes from the signed claim or
 * from the user's own record — NEVER from anything the client can set. A
 * routing hint (`X-Org-Id`, the Host) may pick a tenant for a request with no
 * credential; once a credential exists, the context must be the principal's,
 * and a context that disagrees is refused.
 *
 * ── What this replaced ─────────────────────────────────────────────────────────────────────────
 * A mismatch used to be refused only under `TENANT_ENFORCEMENT=enforce`; under
 * `warn` it was logged and SERVED under the request's context. A token without
 * an `orgId` claim takes its context from the hint, so any account could be
 * served inside another organization by sending that organization's id in a
 * header. That is now refused in every mode but `off`.
 *
 * ── The four kinds of principal ──────────────────────────────────────────────────
 *   tenant      Runs in its organization. A user record with no `orgId` on a
 *               claim-mode deployment belongs to the legacy data owner when one
 *               is configured — it predates organizations, and there was
 *               only one institute then.
 *   learner     A PUBLIC_LEARNER with no organization. Platform-global by design
 *               (Public* collections); confined to the learner paths below.
 *   unattached  Anyone else with no organization on a claim-mode deployment.
 *               Refused: there is no tenant to scope them to, and running them
 *               unscoped would show them every organization's data.
 *   legacy      Pre-migration (no tenancy configured) or `off`: today's
 *               behaviour, untouched.
 */
type Principal =
  | { kind: 'tenant'; orgId: string }
  | { kind: 'foreign'; orgId: string }
  | { kind: 'learner' }
  | { kind: 'unattached' }
  | { kind: 'legacy' };

interface PrincipalRecord {
  orgId?: unknown;
  accountType?: string;
}

export function principalOf(user: PrincipalRecord): Principal {
  if (tenantEnforcement() === 'off') return { kind: 'legacy' };
  const own = user.orgId ? String(user.orgId) : null;

  if (tenantMode() === 'pinned') {
    const pinned = pinnedOrgId();
    if (!pinned) return { kind: 'legacy' };
    if (own && own !== pinned) return { kind: 'foreign', orgId: own };
    return { kind: 'tenant', orgId: pinned };
  }

  if (own) return { kind: 'tenant', orgId: own };
  if (user.accountType === 'PUBLIC_LEARNER') return { kind: 'learner' };
  const legacy = legacyDataOrgId();
  if (legacy) return { kind: 'tenant', orgId: legacy };
  return { kind: 'unattached' };
}

/**
 * Where a public learner with no organization may go. Everywhere else it is
 * refused, for the same reason as the parent list below: a role the institute
 * screens were not written for would fall into their `else` branches.
 */
export const LEARNER_ALLOWED_PATHS: readonly RegExp[] = [
  /^\/api\/learner(\/|$)/,
  /^\/api\/public(\/|$)/,
  /^\/api\/auth\/(me|profile|profile\/image|change-password|account)$/,
  /^\/api\/me\/context$/,
];

export function learnerMayReach(path: string): boolean {
  const clean = String(path || '').split('?')[0];
  return LEARNER_ALLOWED_PATHS.some((rx) => rx.test(clean));
}

type Refusal = { status: number; message: string; code: string };

/**
 * Open the principal's context, or say why not. Shared by the strict and the
 * optional middleware so the two can never disagree about whose data a
 * credential reaches.
 */
function principalContext(
  req: Request,
  userId: string,
  principal: Principal,
): { refuse: Refusal } | { run: (next: () => void) => void } {
  const ambient = getTenantContext();
  const path = req.originalUrl || req.url;

  switch (principal.kind) {
    case 'legacy':
      return { run: (next) => next() };
    case 'foreign':
      return {
        refuse: {
          status: 403,
          message: 'This account belongs to a different organization.',
          code: 'TENANT_MISMATCH',
        },
      };
    case 'unattached':
      return {
        refuse: {
          status: 403,
          message: 'This account is not attached to an organization.',
          code: 'TENANT_REQUIRED',
        },
      };
    case 'learner':
      if (!learnerMayReach(path)) {
        return {
          refuse: {
            status: 403,
            message: 'This account can only use the public learning areas.',
            code: 'LEARNER_SCOPE',
          },
        };
      }
      return {
        run: (next) => {
          stashTenantStore(req, { unscoped: true, reason: 'learner:platform-global' });
          withoutTenantScope('learner:platform-global', () => next());
        },
      };
    case 'tenant': {
      if (ambient && ambient.orgId !== principal.orgId) {
        return {
          refuse: {
            status: 403,
            message: 'This account belongs to a different organization.',
            code: 'TENANT_MISMATCH',
          },
        };
      }
      if (ambient) return { run: (next) => next() };
      const context: TenantContext = { orgId: principal.orgId, userId, source: 'session' };
      return {
        run: (next) => {
          // Stashed as well as opened, so it survives a middleware that
          // consumes the request stream — multer, or a Redis-backed limiter.
          stashTenantStore(req, context);
          runWithTenant(context, () => next());
        },
      };
    }
  }
}

/**
 * The legacy role a user may exercise, given the permissions they actually hold.
 *
 * ── Why the role string cannot be taken at face value ─────────────────────────────
 * Well over a hundred checks read `req.user.role === 'admin'`. An account whose
 * record says `admin` but whose organization assigned it a narrow custom role
 * ("Accountant": reports only) passed every one of them — custom roles changed
 * what the UI showed and nothing the API allowed.
 *
 * So when a user HAS assigned roles, the role those checks see is the highest
 * legacy role their permissions fully justify, never higher than the account's
 * own: `admin` only with every permission, `teacher` only with every teacher
 * permission, otherwise `student` — the least-privileged branch in every
 * legacy handler. What they may legitimately do beyond that is reached through
 * routes guarded by `requirePermission`, which read the permissions directly.
 * A user with NO assigned roles is unchanged: the legacy bridge grants exactly
 * what the role string always meant.
 */
export function effectiveLegacyRole(stored: string | undefined, access: ResolvedAccess): string | undefined {
  if (access.source !== 'roles' || !stored) return stored;
  const holdsAll = (list: readonly string[]) => list.every((p) => access.permissions.has(p));
  if (stored === 'parent') return 'parent';
  if (stored === 'admin' && holdsAll(PERMISSIONS)) return 'admin';
  if ((stored === 'admin' || stored === 'teacher') && holdsAll(LEGACY_ROLE_PERMISSIONS.teacher)) return 'teacher';
  return 'student';
}

async function applyAccess(req: Request, user: Record<string, unknown>, orgId: string | null): Promise<void> {
  const request = req as unknown as { user: Record<string, unknown>; access?: ResolvedAccess };
  const roleIds = Array.isArray(user.roleIds) ? user.roleIds.filter(Boolean) : [];
  // The account's own role, for display and for routing a client to the
  // right screen; `role` below is what authorization checks read.
  request.user.accountRole = request.user.role;
  if (!roleIds.length) return;
  const access = await resolveUserPermissions({
    ...(user as object),
    orgId: orgId ?? (user.orgId ? String(user.orgId) : null),
  } as never);
  request.access = access;
  request.user.role = effectiveLegacyRole(request.user.role as string | undefined, access);
}

/**
 * Is this credential still good? Checked after the signature, against the
 * user record — the part a signature cannot know about.
 *
 *   revoked    The token's `tv` no longer matches the user's tokenVersion (a
 *              password change, a reset, "sign out everywhere"). A token that
 *              predates `tv` is honoured only while the user has never been
 *              revoked, so no active user is signed out by this change.
 *   disabled   The account was rejected.
 */
export function credentialRefusal(decoded: { tv?: unknown }, user: { tokenVersion?: unknown; status?: unknown }): Refusal | null {
  const current = Number(user.tokenVersion ?? 0) || 0;
  const presented = typeof decoded.tv === 'number' ? decoded.tv : null;
  if (presented === null ? current > 0 : presented !== current) {
    return { status: 401, message: 'This session has been signed out. Please sign in again.', code: 'SESSION_REVOKED' };
  }
  if (user.status === 'rejected') {
    return { status: 401, message: 'This account is not active.', code: 'ACCOUNT_DISABLED' };
  }
  return null;
}

/** Exam attempts already in progress may always finish — see requireWritable. */
const ATTEMPT_PATH = /^\/api\/attempts\//;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * May a request run in this organization right now? See core/tenancy/orgState.
 * Pinned deployments predate Org records, so a missing record there is not a
 * refusal; on a claim-mode deployment it means the organization is gone.
 */
async function orgRefusal(req: Request, orgId: string): Promise<Refusal | null> {
  const state = await orgStateOf(orgId);
  if (!state.exists) {
    if (tenantMode() === 'pinned') return null;
    return { status: 401, message: 'This organization no longer exists.', code: 'ORG_NOT_FOUND' };
  }
  if (state.deleting) {
    return { status: 423, message: 'This organization is being deleted.', code: 'ORG_DELETING' };
  }
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  if (READ_ONLY_STATUSES.has(String(state.status)) && !SAFE_METHODS.has(req.method) && !ATTEMPT_PATH.test(path)) {
    return {
      status: 423,
      message: 'This organization is suspended. Its data can be read and exported, but not changed.',
      code: 'ORG_READ_ONLY',
    };
  }
  return null;
}

/**
 * Where a PARENT token may go. Everywhere else it is refused.
 *
 * ── Why an allow-list and not per-route checks ──────────────────────────────
 * The platform has well over a hundred routes, and many branch on role as
 * `if (role === 'student') { own data } else { broader data }`. A new role
 * reaches the `else` in every one of them — a teacher's view of a class, a
 * roster, a schedule — unless each is found and fixed. Auditing them all is
 * how one gets missed. So a parent is denied by default, here, before any route
 * runs, and allowed only onto the paths built for it: its own account, the app
 * shell's context call, and /api/parent, which checks the guardian link itself.
 */
export const PARENT_ALLOWED_PATHS: readonly RegExp[] = [
  /^\/api\/parent(\/|$)/,
  /^\/api\/auth\/me$/,
  /^\/api\/auth\/change-password$/,
  /^\/api\/auth\/profile$/,
  /^\/api\/me\/context$/,
];

export function parentMayReach(path: string): boolean {
  const clean = String(path || '').split('?')[0];
  return PARENT_ALLOWED_PATHS.some((rx) => rx.test(clean));
}

export interface AuthPayload {
  id: string;
  role?: string;
  name?: string;
  /** Present on tokens minted by the P2 audience-aware helpers. */
  aud?: string;
}

export const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.header('Authorization');
  
  const token = authHeader?.replace('Bearer ', '').trim();
  
  // Check if token is missing, empty, or the literal string "null" or "undefined"
  if (!token || token === 'null' || token === 'undefined' || token.length < 20) {
    // Log the rejection reason for debugging (only in development or when DEBUG_AUTH is set)
    if (process.env.NODE_ENV !== 'production' || process.env.DEBUG_AUTH) {
      console.warn(`[Auth] 401 on ${req.method} ${req.path} — reason: ${
        !authHeader ? 'no Authorization header' :
        !token ? 'empty token after parsing' :
        token === 'null' ? 'token is literal "null"' :
        token === 'undefined' ? 'token is literal "undefined"' :
        token.length < 20 ? `token too short (${token.length} chars)` : 'unknown'
      }`);
    }
    return res.status(401).json({ message: 'No token, authorization denied' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as AuthPayload;

    // ── Audience, checked before anything else ────────────────────────────
    // A platform-staff token must never authenticate a tenant request. It
    // already failed here, but only by ACCIDENT: PlatformUser lives in its own
    // collection, so `User.findById` found nothing and the request 401'd on
    // "User not found". That is a coincidence of storage layout, not a
    // security boundary — one shared collection, or one `upsert` on login, and
    // the coincidence evaporates.
    //
    // Rejecting the audience explicitly makes it a boundary. `platformAuth`
    // has always done the reverse check; this is the missing half.
    //
    // A token with NO `aud` is legacy and is accepted, exactly as before —
    // every token in the field predates the audience work, and rejecting them
    // would log out every user on deploy.
    if (decoded.aud && decoded.aud !== 'tenant' && decoded.aud !== 'legacy') {
      return res.status(403).json({
        message: 'This credential is not valid here.',
        code: 'TOKEN_AUDIENCE_MISMATCH',
      });
    }

    // Fetch user from DB to get profile and latest role/assignment metadata.
    //
    // UNSCOPED, by the signed id: this is identity, and whose organization the
    // request reaches is decided below from this record (principalOf). Scoped,
    // a token without an `orgId` claim — every public learner's, and every
    // pre-tenancy token an installed app still holds — had no context to look
    // itself up in, and under `enforce` the lookup threw and the request was
    // answered "Invalid token".
    const User = require('../models/User').default;
    const user = await withoutTenantScope('auth:principal', async () =>
      User.findById(decoded.id)
        .select('name role email classLevel batch firebaseUid status roleIds orgId accountType tokenVersion')
        .lean(),
    );
    
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }
    
    // Set both id and _id for compatibility, plus profile metadata from DB
    (req as any).user = { 
      id: decoded.id, 
      _id: decoded.id, 
      role: (user as any).role || decoded.role,
      name: (user as any).name,
      email: (user as any).email,
      classLevel: (user as any).classLevel,
      batch: (user as any).batch,
      firebaseUid: (user as any).firebaseUid,
      status: (user as any).status,
      // Needed by resolveUserPermissions. Without these it cannot see assigned
      // roles and silently falls back to the legacy-role mapping — which would
      // hand a deliberately narrow custom role its old blanket permissions.
      roleIds: (user as any).roleIds,
      orgId: (user as any).orgId,
    };
    if ((req as unknown as { user: { role?: string } }).user.role === 'parent' && !parentMayReach(req.originalUrl || req.url)) {
      return res.status(403).json({
        message: 'This account can only view its linked students.',
        code: 'PARENT_SCOPE',
      });
    }

    const credential = credentialRefusal(decoded as { tv?: unknown }, user as { tokenVersion?: unknown; status?: unknown });
    if (credential) return res.status(credential.status).json({ message: credential.message, code: credential.code });

    const principal = principalOf(user as PrincipalRecord);
    const decision = principalContext(req, decoded.id, principal);
    if ('refuse' in decision) {
      return res.status(decision.refuse.status).json({
        message: decision.refuse.message,
        code: decision.refuse.code,
      });
    }
    const principalOrg = principal.kind === 'tenant' ? principal.orgId : null;
    if (principalOrg) {
      const refusal = await orgRefusal(req, principalOrg);
      if (refusal) return res.status(refusal.status).json({ message: refusal.message, code: refusal.code });
      // A module gate that ran before we knew whose request this was.
      const unentitled = await moduleRefusal(req, principalOrg);
      if (unentitled) {
        return res.status(unentitled.status).json({
          message: unentitled.message,
          code: unentitled.code,
          module: unentitled.module,
        });
      }
    }
    // The organization handlers see is the one the request is scoped to — for
    // a legacy user with no `orgId`, that is the legacy data owner.
    if (principalOrg) (req as unknown as { user: Record<string, unknown> }).user.orgId = principalOrg;
    try {
      await applyAccess(req, user as Record<string, unknown>, principalOrg);
    } catch (error) {
      // Fail closed: an account whose roles cannot be read is not granted the
      // blanket access its role string would imply.
      console.error('[auth] role resolution failed:', (error as Error).message);
      return res.status(403).json({ message: 'Authorization could not be verified.', code: 'PERMISSION_UNRESOLVED' });
    }
    return decision.run(next);
  } catch (err) {
    if ((err as { name?: string })?.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Session expired', code: 'TOKEN_EXPIRED' });
    }
    res.status(401).json({ message: 'Invalid token' });
  }
};

/**
 * Attaches `req.user` when a valid token is present, but NEVER rejects.
 *
 * For endpoints that are legitimately public yet must serve less data to
 * anonymous callers (e.g. study resources: guests only ever see published +
 * isPublic content). Downstream handlers decide based on `req.user` — an
 * invalid or absent token simply means "treat as guest", so a bad token can
 * never escalate, only degrade to the public view.
 */
export const optionalAuthMiddleware = async (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  const token = req.header('Authorization')?.replace('Bearer ', '').trim();

  if (!token || token === 'null' || token === 'undefined' || token.length < 20) {
    return next();
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as AuthPayload;
    const User = require('../models/User').default;
    // Unscoped, by the signed id — see authMiddleware.
    const user = await withoutTenantScope('auth:principal', async () =>
      User.findById(decoded.id)
        .select('name role email classLevel batch firebaseUid status roleIds orgId accountType tokenVersion')
        .lean(),
    );

    // A parent outside its allowed paths is served as a guest rather than as a
    // signed-in user — optional-auth routes widen what they show for members.
    // So is a credential whose organization is not the request's: an optional
    // route must never widen what it shows because of another tenant's token.
    const revoked = user ? credentialRefusal(decoded as { tv?: unknown }, user as { tokenVersion?: unknown; status?: unknown }) : null;
    const principal = user && !revoked ? principalOf(user as PrincipalRecord) : null;
    const decision = user && principal ? principalContext(req, decoded.id, principal) : null;
    // An organization being deleted, or without this route's module, is
    // served the guest view — the same as any other credential that may not
    // widen what an optional route shows.
    const tenantOrg = principal?.kind === 'tenant' ? principal.orgId : null;
    const blocked = tenantOrg ? (await orgRefusal(req, tenantOrg)) || (await moduleRefusal(req, tenantOrg)) : null;
    if (
      user &&
      decision &&
      !blocked &&
      !('refuse' in decision) &&
      principal?.kind !== 'learner' &&
      !((user as { role?: string }).role === 'parent' && !parentMayReach(req.originalUrl || req.url))
    ) {
      (req as any).user = {
        id: decoded.id,
        _id: decoded.id,
        role: (user as any).role || decoded.role,
        name: (user as any).name,
        email: (user as any).email,
        classLevel: (user as any).classLevel,
        batch: (user as any).batch,
        firebaseUid: (user as any).firebaseUid,
        status: (user as any).status,
        roleIds: (user as any).roleIds,
        orgId: principal?.kind === 'tenant' ? principal.orgId : (user as any).orgId,
      };
      try {
        await applyAccess(req, user as Record<string, unknown>, principal?.kind === 'tenant' ? principal.orgId : null);
      } catch {
        // Treated as a guest rather than trusted with the role string alone.
        delete (req as any).user;
        return next();
      }
      return decision.run(next);
    }
  } catch {
    // Ignore — caller is simply treated as a guest.
  }

  next();
};

export const requireRole = (...roles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const current = (req as any).user as { id: string; role?: string } | undefined;
    if (!current) return res.status(401).json({ message: 'Unauthorized' });
    if (!current.role || !roles.includes(current.role)) {
      return res.status(403).json({ message: 'Forbidden: insufficient role' });
    }
    next();
  };
};

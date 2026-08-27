import type { Request } from 'express';
import { currentOrgId } from '../core/tenancy/context';

/**
 * Server-side visibility AND tenancy enforcement for PUBLIC resource endpoints.
 *
 * Extracted from resourceRoutes so that every public-facing endpoint — the
 * resource list, the public subject/chapter browser, and public search — shares
 * ONE implementation. Copying these three lines into each new route is exactly
 * how a public endpoint eventually leaks unpublished or institute-only content:
 * one copy gets a fix, the others don't.
 *
 * The rules:
 *   - Guests AND signed-in students (institute or public learner) get the same
 *     public view: `status: 'published'` AND `isPublic: true`.
 *   - Only staff (admin/teacher/developer) may see anything else.
 *   - Client query params can NARROW within the permitted set, never widen it.
 *   - When an ORGANIZATION has been resolved for the request, the result is
 *     scoped to it. See `applyPublicOrgScope`.
 *
 * This is applied to the LOOKUP, not as a post-filter, so a private resource is
 * a 404 for a guest rather than a document that was fetched and then hidden.
 */

/** True when the caller is signed in as staff. */
export const isStaffRequest = (req: Request): boolean => {
  const role = (req as any).user?.role;
  return role === 'admin' || role === 'teacher' || role === 'developer';
};

/**
 * Force the public visibility floor onto a query. Mutates and returns it.
 * Staff queries pass through untouched.
 */
export const applyPublicVisibilityFloor = <T extends Record<string, any>>(
  query: T,
  req: Request,
): T => {
  // The organization scope is applied BEFORE the staff early-return, and
  // therefore to staff too. A signed-in Org 002 teacher browsing the public
  // library has no more business seeing Org 001's resources than a guest does;
  // what staff status buys is drafts and archived items WITHIN their own
  // organization, which is what the lines below grant.
  applyPublicOrgScope(query, req);

  if (isStaffRequest(req)) return query;
  (query as any).status = 'published';
  (query as any).isPublic = true;
  return query;
};

/**
 * Scope a public query to the organization resolved for this request.
 *
 * ── What "resolved" means here ──────────────────────────────────────────────
 * `tenantContextMiddleware` resolves an organization from a signed token's
 * `orgId` claim, or — before any credential exists — from an explicit
 * `X-Org-Id` header or the Host the request arrived on. The header accepts an
 * id OR a slug, so a guest app that remembers "abc-coaching" can name its
 * institute without knowing its database id. That hint grants nothing: it
 * selects which tenant's data may be seen, never who the caller is.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * No organization resolved → nothing is added, and the caller sees the
 * platform-wide catalogue. That is the shared front door: someone who opened
 * the app for the first time, named no institute, and is deciding whether the
 * product is for them.
 *
 * An organization resolved → that organization's content, PLUS content owned
 * by nobody. The second half matters: platform-level material seeded by the
 * operator has no `orgId`, and a strict `{ orgId }` match would make the
 * catalogue of a newly onboarded institute completely empty on its first day.
 *
 * ── Aggregations need no separate helper ────────────────────────────────────
 * Every public aggregation builds its `$match` stage by spreading the object
 * this function mutated — `{ $match: match }`, `{ $match: { ...base, subject } }`
 * — so the `$and` rides along into the first stage, which is where a tenant
 * filter has to be. A second aggregation-shaped helper would be a second thing
 * to keep in step.
 *
 * ── Why this is not left to the tenancy plugin ──────────────────────────────
 * The global plugin does scope reads — but only under `TENANT_ENFORCEMENT=
 * enforce`, and it scopes to `{ orgId }` exactly, which would exclude the
 * platform-level content this rule deliberately includes. Public visibility is
 * a different question from tenant enforcement and gets its own answer.
 */
export const applyPublicOrgScope = <T extends Record<string, any>>(query: T, req: Request): T => {
  const orgId = orgIdForRequest(req);
  if (!orgId) return query;

  const clause = {
    $or: [{ orgId }, { orgId: null }, { orgId: { $exists: false } }],
  };
  (query as any).$and = [...((query as any).$and ?? []), clause];
  return query;
};

/**
 * The organization this request belongs to, if any.
 *
 * Reads the tenant context the middleware established. Falls back to the
 * request's own resolved value where a route runs outside that context — the
 * middleware attaches it, and reading both means a public route behaves the
 * same whether or not the tenancy layer is active.
 */
export const orgIdForRequest = (req: Request): string | null => {
  const fromContext = currentOrgId();
  if (fromContext) return String(fromContext);
  const attached = (req as any).tenant?.orgId ?? (req as any).orgId;
  return attached ? String(attached) : null;
};

/**
 * Projection for non-staff callers. Guests must never receive uploader identity
 * (staff names/emails) or internal versioning noise.
 */
export const PUBLIC_RESOURCE_PROJECTION = '-uploadedBy -__v';

/**
 * Case-insensitive class matching.
 *
 * StudyResource.classLevel is free text written by whoever uploaded it, so the
 * same class exists in the library as "10", "Class 10" and "class 10". A public
 * browser that matched only the exact string the learner has stored would show
 * an empty library for no visible reason. Mirrors the institute-side
 * buildClassVariants() intent without importing it — that helper is part of the
 * institute audience machinery and must not become a public dependency.
 */
export const buildPublicClassVariants = (classLevel?: string | null): string[] => {
  if (!classLevel) return [];
  const raw = String(classLevel).replace(/^class\s*/i, '').trim();
  if (!raw) return [];
  return Array.from(new Set([raw, `Class ${raw}`, `class ${raw}`, String(classLevel).trim()]));
};

/** Mongo clause matching any known spelling of a class. */
export const publicClassClause = (classLevel?: string | null): Record<string, any> | null => {
  const variants = buildPublicClassVariants(classLevel);
  if (variants.length === 0) return null;
  return { classLevel: { $in: variants } };
};

/** Escape a user-supplied string for safe use inside a RegExp. */
export const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

import type { Request } from 'express';

/**
 * Server-side visibility enforcement for PUBLIC resource endpoints.
 *
 * Extracted from resourceRoutes so that every public-facing endpoint — the
 * resource list, the public subject/chapter browser, and public search — shares
 * ONE implementation. Copying these three lines into each new route is exactly
 * how a public endpoint eventually leaks unpublished or institute-only content:
 * one copy gets a fix, the others don't.
 *
 * The rules, unchanged from the original:
 *   - Guests AND signed-in students (institute or public learner) get the same
 *     public view: `status: 'published'` AND `isPublic: true`.
 *   - Only staff (admin/teacher/developer) may see anything else.
 *   - Client query params can NARROW within the permitted set, never widen it.
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
  if (isStaffRequest(req)) return query;
  (query as any).status = 'published';
  (query as any).isPublic = true;
  return query;
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

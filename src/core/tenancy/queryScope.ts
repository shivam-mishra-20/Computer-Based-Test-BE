/**
 * Explicit organization scoping for individual queries.
 *
 * ── Why explicit conditions still exist beside the plugin ───────────────────
 * The global plugin narrows every Mongoose read for a known tenant (see
 * `config.readFilterFor`). Handlers that serve tenant administrators ALSO say
 * so themselves, for three reasons the plugin cannot cover:
 *
 *   · raw driver calls and `$lookup` joins never pass through it;
 *   · a reviewer reading a handler should see the scope, not infer it from a
 *     global hook three directories away;
 *   · a future change to the plugin must not silently widen an admin screen.
 *
 * ── The filter ──────────────────────────────────────────────────────────────
 * Exactly the plugin's: `{ orgId }` for every organization, and
 * `{ orgId: { $in: [orgId, null] } }` for the legacy data owner until enforce,
 * so its un-backfilled rows stay visible to it and to nobody else. With no
 * tenant context at all — today's pre-migration production, or an explicit
 * `withoutTenantScope` — it is `{}`, i.e. the pre-tenancy behaviour.
 */

import { getTenantContext } from './context';
import { readFilterFor, tenancyConfigured, tenantMode } from './config';
import { TenantContextMissing } from './errors';

export type TenantFilter = Record<string, never> | { orgId: unknown };

/**
 * The current tenant's filter, or `{}` where there is no tenant.
 *
 * Spread into a query:
 *   Batch.find({ ...tenantScope(), classLevels: '11' })
 */
export function tenantScope(): TenantFilter {
  const context = getTenantContext();
  if (!context?.orgId) return {};
  return (readFilterFor(context.orgId) as TenantFilter | null) ?? {};
}

/** True when `tenantScope()` would actually narrow. Useful for logging and tests. */
export function tenantScopeActive(): boolean {
  return 'orgId' in tenantScope();
}

/**
 * `tenantScope()` for handlers that must never run unscoped.
 *
 * On a deployment that has adopted tenancy in claim mode there is no legitimate
 * way for an authenticated tenant request to arrive here without a tenant —
 * `authMiddleware` either establishes one or refuses — so its absence is a bug,
 * and this fails closed instead of returning everyone's rows. Pre-migration
 * production (no TENANT_* variables) and pinned mode keep today's behaviour.
 */
export function requireTenantScope(what = 'tenant-scoped query'): TenantFilter {
  const context = getTenantContext();
  if (!context?.orgId) {
    if (tenancyConfigured() && tenantMode() === 'claim') {
      throw new TenantContextMissing(what, 'read');
    }
    return {};
  }
  return (readFilterFor(context.orgId) as TenantFilter | null) ?? {};
}

/** The organization a tenant-scoped handler is acting for, or null when there is none. */
export function currentTenantOrgId(): string | null {
  return getTenantContext()?.orgId ?? null;
}

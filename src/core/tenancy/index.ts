/**
 * Tenancy — public surface.
 *
 * Import from here rather than reaching into the individual files, so the
 * internals can be reorganized without a repo-wide edit.
 */

export {
  runWithTenant,
  withoutTenantScope,
  runWithoutAnyContext,
  getTenantContext,
  currentOrgId,
  inUnscopedBlock,
  type TenantContext,
} from './context';

export {
  tenantMode,
  tenantEnforcement,
  pinnedOrgId,
  shouldRunScheduledJobs,
  describeTenancy,
  type TenantMode,
  type TenantEnforcement,
} from './config';

export { tenantScope, tenantScopeActive } from './queryScope';

export { registerTenancy, verifyTenantPluginApplied } from './bootstrap';

export { forEachOrg, type ForEachOrgSummary, type OrgRunResult } from './forEachOrg';

export { tenantLookup, type TenantLookupSpec } from './tenantLookup';

export { getUnscopedReport, resetUnscopedReport, tenancyStatus, type UnscopedEvent } from './plugin';

export { TenantContextMissing, TenantMismatch } from './errors';

export {
  PUBLIC_ROUTE_ALLOWLIST,
  DELIBERATELY_NOT_ALLOWLISTED,
  findPublicRoute,
  type PublicRouteEntry,
  type BypassClassification,
} from './publicRoutes';

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

export { registerTenancy, verifyTenantPluginApplied } from './bootstrap';

export { getUnscopedReport, resetUnscopedReport, tenancyStatus, type UnscopedEvent } from './plugin';

export { TenantContextMissing, TenantMismatch } from './errors';

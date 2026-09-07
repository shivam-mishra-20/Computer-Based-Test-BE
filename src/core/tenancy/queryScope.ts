/**
 * Explicit organization scoping for individual queries.
 *
 * ── The gap this fills, and the trap it avoids ──────────────────────────────
 * The global plugin filters reads only under `TENANT_ENFORCEMENT=enforce`.
 * Production runs under `warn`, where the plugin stamps writes and leaves reads
 * completely alone — deliberately, because `orgId` is not backfilled and
 * filtering on a field almost no document carries would return nothing.
 *
 * That is correct for the migration and insufficient for a claim-mode
 * deployment serving several institutes at once, where an unscoped
 * `Batch.find({})` hands every organization's batches to every organization.
 * The P6 end-to-end suite caught exactly that: Abhigyan's schedule form
 * offering ABC Coaching's "NEET", and ABC's teacher picker offering Abhigyan's
 * staff by name.
 *
 * The obvious fix — add `{ orgId }` to those queries — walks straight into the
 * trap this programme has now hit five times:
 *
 *     A safe default for TENANCY is not a safe default for BEHAVIOUR.
 *
 * On api-legacy, pinned to ORG_001 but with the backfill not yet run, no user
 * and no batch carries an `orgId`. An unconditional `{ orgId }` there does not
 * isolate anything; it empties every picker in production.
 *
 * ── The condition, and why it is the right one ──────────────────────────────
 * Scope when the data is known to carry `orgId`, and only then:
 *
 *   claim mode    Every organization on a claim-mode deployment was created
 *                 through onboarding, which stamps `orgId` on everything it
 *                 writes. There is no un-backfilled data to lose, and it is
 *                 the only mode where more than one tenant shares a process —
 *                 so it is both safe and necessary here.
 *
 *   enforce       Enforcement is only turned on after the backfill has run and
 *                 been verified; that is what the flip means. The plugin is
 *                 already filtering reads at this point, so this is belt and
 *                 braces rather than the mechanism.
 *
 *   otherwise     No scope, and therefore no behaviour change. Today's
 *                 production — no TENANT_* variables, no context at all —
 *                 lands here, as does a pinned api-legacy before its backfill.
 *
 * This is a stopgap with a known end date. The general answer is the enforce
 * flip, which filters every read rather than the handful named by callers of
 * this helper. It exists so the surfaces P6 is responsible for are correct
 * before that flip, not as a substitute for it.
 */

import { getTenantContext } from './context';
import { tenantEnforcement } from './config';

/**
 * `{ orgId }` when scoping is both safe and required, `{}` otherwise.
 *
 * Spread into a query:
 *   Batch.find({ ...tenantScope(), classLevels: '11' })
 */
export function tenantScope(): Record<string, never> | { orgId: string } {
  const context = getTenantContext();
  if (!context?.orgId) return {};

  if (context.source === 'claim') return { orgId: context.orgId };
  if (tenantEnforcement() === 'enforce') return { orgId: context.orgId };

  return {};
}

/** True when `tenantScope()` would actually narrow. Useful for logging and tests. */
export function tenantScopeActive(): boolean {
  return 'orgId' in tenantScope();
}

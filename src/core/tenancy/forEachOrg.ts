/**
 * Run a unit of work once per organization, each inside its own context.
 *
 * Cron is the one place where "there is no tenant context" is the NORMAL state
 * rather than a bug: a scheduled job arrives with no request, no token and no
 * user. That makes it the most likely place for a cross-tenant mistake, and
 * the least likely to be noticed — a nightly job that quietly processes every
 * tenant's data under one tenant's context produces wrong results at 3am with
 * nobody watching.
 *
 * ── Failure isolation ───────────────────────────────────────────────────────
 * One organization's failure must never abort the others. A single tenant with
 * a bad integration credential would otherwise silently stop attendance sync
 * for every customer on the platform.
 *
 * ── The fallback that keeps production working ──────────────────────────────
 * If no organizations exist yet — which is the case for the entire warn period,
 * because Org 001 has not been seeded into production — this runs the work ONCE
 * with no context, exactly as it behaves today. Making cron depend on the Org
 * collection being populated would stop the four daily attendance syncs the
 * moment this deploys. Same class of bug as the cron-default one caught
 * earlier: a tenancy improvement must never subtract behaviour before the data
 * is ready for it.
 */

import mongoose from 'mongoose';
import { runWithTenant, withoutTenantScope, type TenantContext } from './context';
import { pinnedOrgId, tenantMode } from './config';

export interface OrgRunResult {
  orgId: string | null;
  ok: boolean;
  error?: string;
}

export interface ForEachOrgSummary {
  label: string;
  mode: 'pinned' | 'enumerated' | 'uncontextualized';
  total: number;
  succeeded: number;
  failed: number;
  results: OrgRunResult[];
}

/** Organizations a scheduled job should act on. Terminated tenants are skipped. */
async function activeOrgIds(): Promise<string[]> {
  // The Org collection is the tenant registry; reading it is by definition a
  // cross-tenant operation and is one of the sanctioned bypasses.
  return withoutTenantScope('cron:enumerate-orgs', async () => {
    try {
      // Resolved at call time, not imported at module load: this file is
      // imported by the tenancy barrel, and importing a model from here would
      // compile it before registerTenancy() had a chance to run.
      const Org = mongoose.models.Org;
      if (!Org) return [];
      const orgs = await Org.find({
        status: { $nin: ['terminated', 'cancelled'] },
      })
        .select('_id')
        .lean();
      return orgs.map((org: { _id: unknown }) => String(org._id));
    } catch (error) {
      console.warn(
        `[tenancy] could not enumerate organizations: ${(error as Error).message}`,
      );
      return [];
    }
  }) as Promise<string[]>;
}

export async function forEachOrg(
  label: string,
  work: (context: TenantContext) => Promise<unknown>,
  options: { source?: TenantContext['source'] } = {},
): Promise<ForEachOrgSummary> {
  const source = options.source ?? 'cron';

  // ── 1. Pinned deployment: exactly one organization, known from config ─────
  const pinned = pinnedOrgId();
  if (tenantMode() === 'pinned' && pinned) {
    const context: TenantContext = { orgId: pinned, source };
    try {
      await runWithTenant(context, () => work(context));
      return {
        label,
        mode: 'pinned',
        total: 1,
        succeeded: 1,
        failed: 0,
        results: [{ orgId: pinned, ok: true }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[cron:${label}] org ${pinned} FAILED: ${message}`);
      return {
        label,
        mode: 'pinned',
        total: 1,
        succeeded: 0,
        failed: 1,
        results: [{ orgId: pinned, ok: false, error: message }],
      };
    }
  }

  // ── 2. Enumerate ─────────────────────────────────────────────────────────
  const orgIds = await activeOrgIds();

  if (orgIds.length === 0) {
    // See the header: today's production has no Org documents. Running once
    // with no context preserves current behaviour exactly. Under enforce this
    // would throw at the first query, which is the correct signal that the
    // backfill must complete before enforce is switched on.
    console.warn(
      `[cron:${label}] no organizations found — running once without a tenant context ` +
        `(pre-migration behaviour).`,
    );
    try {
      await work({ orgId: '', source } as TenantContext);
      return {
        label,
        mode: 'uncontextualized',
        total: 1,
        succeeded: 1,
        failed: 0,
        results: [{ orgId: null, ok: true }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[cron:${label}] FAILED: ${message}`);
      return {
        label,
        mode: 'uncontextualized',
        total: 1,
        succeeded: 0,
        failed: 1,
        results: [{ orgId: null, ok: false, error: message }],
      };
    }
  }

  // ── 3. One context per organization, failures isolated ───────────────────
  const results: OrgRunResult[] = [];

  for (const orgId of orgIds) {
    const context: TenantContext = { orgId, source };
    try {
      await runWithTenant(context, () => work(context));
      results.push({ orgId, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Logged and swallowed BY DESIGN — see "Failure isolation" above.
      console.error(`[cron:${label}] org ${orgId} FAILED (continuing): ${message}`);
      results.push({ orgId, ok: false, error: message });
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(
    `[cron:${label}] ${results.length - failed}/${results.length} organizations succeeded`,
  );

  return {
    label,
    mode: 'enumerated',
    total: results.length,
    succeeded: results.length - failed,
    failed,
    results,
  };
}

/**
 * A `$lookup` stage that constrains the joined collection to the active tenant.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * The global plugin scopes the collection an aggregation runs ON, by prepending
 * a `$match` to the pipeline. It cannot reach inside a `$lookup`: the joined
 * collection is read by the server directly, without passing through that
 * collection's Mongoose middleware. So `Attempt.aggregate([...$lookup users])`
 * has a scoped left side and an unscoped right side.
 *
 * In practice today's four call sites join on an `_id` that came out of an
 * already-scoped document, so the joined row is reachable only through a row
 * the tenant already owns. That is sound — but it is sound *by referential
 * integrity*, not by an enforced filter, and referential integrity is exactly
 * what stops holding the day a bad import or a bad merge writes an Attempt in
 * one org pointing at a User in another. This makes the guarantee explicit.
 *
 * ── Why it is enforcement-aware ─────────────────────────────────────────────
 * Under `warn`, `orgId` has not been backfilled, so a sub-pipeline matching
 * `orgId` would match NOTHING and these endpoints would return empty joins
 * immediately on deploy. Same trap as read filtering, and the same answer:
 * observe under warn, constrain under enforce. Under `warn` this emits the
 * byte-identical `localField`/`foreignField` stage the code used before.
 */

import { currentOrgId } from './context';
import { shouldFilterReads } from './config';

export interface TenantLookupSpec {
  /** Target collection name, as `$lookup.from` expects it. */
  from: string;
  localField: string;
  foreignField: string;
  as: string;
  /**
   * Set when the joined collection has no `orgId` — Org, Plan, Module and the
   * platform-user registry. Emits the plain stage in every mode.
   */
  global?: boolean;
}

/** The `$lookup` stage object, ready to drop into a pipeline. */
export function tenantLookup(spec: TenantLookupSpec): Record<string, unknown> {
  const plain = {
    $lookup: {
      from: spec.from,
      localField: spec.localField,
      foreignField: spec.foreignField,
      as: spec.as,
    },
  };

  if (spec.global) return plain;

  // Warn / off: behave exactly as the original code did.
  if (!shouldFilterReads()) return plain;

  const orgId = currentOrgId();
  // Enforce with no context: the plugin has already thrown on the source
  // collection before this stage is ever built, so reaching here means the
  // caller is inside an explicit withoutTenantScope block. Honour that.
  if (!orgId) return plain;

  return {
    $lookup: {
      from: spec.from,
      let: { tenantLookupKey: `$${spec.localField}` },
      pipeline: [
        {
          $match: {
            // Both conditions in ONE $match so the orgId constraint cannot be
            // separated from the join predicate by a later refactor.
            $expr: { $eq: [`$${spec.foreignField}`, '$$tenantLookupKey'] },
            orgId,
          },
        },
      ],
      as: spec.as,
    },
  };
}

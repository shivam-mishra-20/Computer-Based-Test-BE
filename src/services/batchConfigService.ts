/**
 * Class levels and their batches, per organization.
 *
 * ── What changed, and why it had to ─────────────────────────────────────────
 * This service used to be Abhigyan expressed as code: classes 7–12 in a
 * constant, `Batch.find({})` across the whole collection, and a merge step that
 * hunted for batches literally named "Advanced" and "Basic" and DELETED them.
 *
 * In a shared database that last part is not merely wrong, it is destructive.
 * The tenancy plugin filters reads only under `enforce`; under `warn` — which is
 * where production sits during the migration — a regex find over `Batch` sees
 * every organization's batches. One Abhigyan admin opening a user form would
 * have merged and then deleted another institute's batches, and rewritten their
 * students' `batch` field to "Advanced/Basic".
 *
 * So all three inputs now come from configuration:
 *
 *   classes      getOrgConfiguration() — the org's ClassLevel rows, falling
 *                back to the legacy 7–12 when it has none.
 *   batches      the org's own Batch documents, explicitly scoped by orgId.
 *   merge rules  getOrgPolicy().batch.mergeRules — data, not two hardcoded
 *                labels and three predicate functions.
 *
 * ── Abhigyan is unchanged ───────────────────────────────────────────────────
 * Its configuration resolves to classes 7–12, its own twelve batches, and the
 * default merge rule Advanced+Basic -> Advanced/Basic that PLATFORM_DEFAULTS
 * transcribes from the constant this file used to hold. Same response, same
 * merge, same order.
 *
 * A tenant that legitimately wants separate Advanced and Basic batches clears
 * `batch.mergeRules` in its policy. That it is possible to clear at all is the
 * point of moving it into data.
 */

import Batch from '../models/Batch';
import User from '../models/User';
import Schedule from '../models/Schedule';
import { currentOrgId } from '../core/tenancy/context';
import {
  getOrgConfiguration,
  resolveClassKey,
  type ResolvedClassLevel,
} from '../core/config/orgConfig';
import { getOrgPolicy } from '../core/config/policy';

export interface StudentBatchClassRule {
  classValue: string;
  classLabel: string;
  batches: string[];
  requiresBatch: boolean;
}

export interface StudentBatchConfigResponse {
  classes: StudentBatchClassRule[];
  batchRules: Record<string, string[]>;
}

/**
 * Retained as a named export because other modules import it. It is now only a
 * FALLBACK — the live list comes from the organization's configuration.
 */
export const SUPPORTED_CLASS_VALUES = ['7', '8', '9', '10', '11', '12'];

const normalizeBatchLabel = (input: string): string =>
  input.trim().toLowerCase().replace(/\s+/g, '');

/** Scope a query by organization when there is one, and not otherwise. */
function orgScope(): Record<string, unknown> {
  const orgId = currentOrgId();
  return orgId ? { orgId } : {};
}

/** Order class keys the way the organization ordered them, not lexically. */
function byClassOrder(levels: ResolvedClassLevel[]) {
  const rank = new Map(levels.map((level, index) => [level.key, level.order ?? index]));
  return (a: string, b: string) => (rank.get(a) ?? 999) - (rank.get(b) ?? 999);
}

/**
 * Apply the organization's batch merge rules.
 *
 * Every query here is scoped to the current organization. Without that scope
 * this function is a cross-tenant delete.
 */
export async function mergeAdvancedBasicBatchValues(): Promise<void> {
  const [policy, configuration] = await Promise.all([getOrgPolicy(), getOrgConfiguration()]);
  const rules = policy.batch?.mergeRules ?? [];
  if (!rules.length) return;

  const scope = orgScope();

  for (const rule of rules) {
    const sources = (rule.merge ?? []).map(normalizeBatchLabel).filter(Boolean);
    const target = String(rule.into ?? '').trim();
    if (!sources.length || !target) continue;

    const targetLabel = normalizeBatchLabel(target);

    const candidates = await Batch.find(scope).select('name classLevels isDefault').lean();
    const related = candidates.filter((batch) => {
      const label = normalizeBatchLabel(String(batch.name || ''));
      return sources.includes(label) || label === targetLabel;
    });

    if (!related.length) continue;

    const classLevels = Array.from(
      new Set(
        related
          .flatMap((batch) => (Array.isArray(batch.classLevels) ? batch.classLevels : []))
          .map((level) => resolveClassKey(String(level), configuration.classLevels))
          .filter((value): value is string => Boolean(value)),
      ),
    ).sort(byClassOrder(configuration.classLevels));

    if (!classLevels.length) continue;

    const existingMerged = related.find(
      (batch) => normalizeBatchLabel(String(batch.name || '')) === targetLabel,
    );
    const shouldBeDefault = related.some((batch) =>
      Boolean((batch as { isDefault?: boolean }).isDefault),
    );

    if (existingMerged) {
      await Batch.findByIdAndUpdate(existingMerged._id, {
        name: target,
        classLevels,
        isDefault: shouldBeDefault,
      });
    } else {
      await Batch.findOneAndUpdate(
        { ...scope, name: target },
        { name: target, classLevels, isDefault: shouldBeDefault },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    }

    const legacy = related.filter((batch) =>
      sources.includes(normalizeBatchLabel(String(batch.name || ''))),
    );
    if (!legacy.length) continue;

    const legacyIds = legacy.map((batch) => batch._id);
    const legacyNames = legacy.map((batch) => String(batch.name));

    await Batch.deleteMany({ ...scope, _id: { $in: legacyIds } });

    // Exact names, not a regex over the whole collection: the rule named these
    // batches, and only members of THIS organization are moved onto the merged
    // label.
    await Promise.all([
      User.updateMany({ ...scope, batch: { $in: legacyNames } }, { $set: { batch: target } }),
      Schedule.updateMany({ ...scope, batch: { $in: legacyNames } }, { $set: { batch: target } }),
    ]);
  }
}

export function matchBatchName(
  batchInput: string | undefined,
  allowedBatches: string[],
): string | null {
  if (!batchInput || typeof batchInput !== 'string') return null;

  const trimmed = batchInput.trim();
  if (!trimmed) return null;

  const exact = allowedBatches.find((item) => item === trimmed);
  if (exact) return exact;

  const byCaseInsensitive = allowedBatches.find(
    (item) => item.toLowerCase() === trimmed.toLowerCase(),
  );

  return byCaseInsensitive || null;
}

export async function getStudentBatchConfigFromDatabase(): Promise<StudentBatchConfigResponse> {
  await mergeAdvancedBasicBatchValues();

  // Read AFTER the merge: it may have created or removed batches, and the
  // previous implementation ordered its work the same way for the same reason.
  const configuration = await getOrgConfiguration();
  const classKeys = configuration.classLevels.map((level) => level.key);

  const batchRules: Record<string, string[]> = Object.fromEntries(
    classKeys.map((classValue) => [classValue, []]),
  );

  const batchNameSets: Record<string, Set<string>> = Object.fromEntries(
    classKeys.map((classValue) => [classValue, new Set<string>()]),
  ) as Record<string, Set<string>>;

  configuration.batches.forEach((batch) => {
    const batchName = String(batch.name || '').trim();
    if (!batchName) return;

    (batch.classLevels ?? []).forEach((level) => {
      // `resolveClassKey`, not the old `normalizeClassValue`: that helper pulled
      // the first digits out of the string, so a non-numeric level such as
      // "Dropper" resolved to null and every batch on it silently vanished from
      // every picker.
      const normalized = resolveClassKey(String(level), configuration.classLevels);
      if (!normalized || !(normalized in batchNameSets)) return;
      batchNameSets[normalized].add(batchName);
    });
  });

  classKeys.forEach((classValue) => {
    batchRules[classValue] = Array.from(batchNameSets[classValue]).sort((a, b) =>
      a.localeCompare(b),
    );
  });

  return {
    classes: configuration.classLevels.map((level) => ({
      classValue: level.key,
      classLabel: level.label,
      batches: batchRules[level.key],
      requiresBatch: batchRules[level.key].length > 0,
    })),
    batchRules,
  };
}

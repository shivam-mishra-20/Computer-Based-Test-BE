/**
 * Per-organization configuration, with a fallback that preserves today's
 * behaviour exactly.
 *
 * ── The fallback is the whole point ─────────────────────────────────────────
 * No organization has configuration rows yet. If an empty result meant "this
 * org has no class levels", every picker in Abhigyan would go blank the moment
 * this shipped, `normalizeClassValue` would reject every input, and the room
 * allocator would offer zero rooms.
 *
 * So an organization with NO configured rows falls back to the legacy
 * constants. Per-org configuration starts applying the moment someone actually
 * configures it — never as a side effect of deploying this code.
 *
 * This is the FOURTH time this pattern has been needed, after the defaulted
 * cron disable, the defaulted-pinned 503, and the no-subscription entitlement:
 *
 *     A safe default for the NEW model is not a safe default for BEHAVIOUR.
 *     Absent configuration must mean "as before", never "nothing".
 *
 * The legacy constants are imported from their existing homes rather than
 * copied, so there is exactly one definition of Abhigyan's current shape and no
 * chance of the fallback drifting from what production actually does today.
 */

import { currentOrgId, withoutTenantScope } from '../tenancy/context';
import { tenantScope } from '../tenancy/queryScope';
import { SUPPORTED_CLASS_VALUES } from '../../config/studentBatchConfig';
import { CURRICULUM_SUBJECTS } from '../../config/subjects';
import { ROOMS, ROOM_CAPACITY } from '../../models/RoomAllocation';

export interface ResolvedClassLevel {
  key: string;
  label: string;
  aliases: string[];
  order: number;
}

export interface ResolvedRoom {
  name: string;
  capacity: number;
}

export interface ResolvedBatch {
  name: string;
  classLevels: string[];
}

export interface OrgConfiguration {
  classLevels: ResolvedClassLevel[];
  subjects: string[];
  rooms: ResolvedRoom[];
  /**
   * Batches are REAL DATA, not a constant — there is no list to fall back to,
   * so they are always read from the collection. What varies is how widely
   * that read is SCOPED; see `readBatches()`.
   */
  batches: ResolvedBatch[];
  /** True when these values came from the legacy constants, not the database. */
  usingDefaults: {
    classLevels: boolean;
    subjects: boolean;
    rooms: boolean;
  };
}

/**
 * Abhigyan's current shape, expressed as configuration.
 *
 * Derived from the live constants so it cannot drift. `aliases` carries both
 * spellings that exist in production — the `"11"` / `"Class 11"` split that
 * forces normalization helpers into roughly ten files.
 */
export function legacyClassLevels(): ResolvedClassLevel[] {
  return SUPPORTED_CLASS_VALUES.map((value, index) => ({
    key: value,
    label: `Class ${value}`,
    aliases: [value, `Class ${value}`, `class ${value}`],
    order: index,
  }));
}

export function legacySubjects(): string[] {
  return [...CURRICULUM_SUBJECTS];
}

/**
 * The organization's batches.
 *
 * ── Why this is not just `Batch.find({ orgId })` ────────────────────────────
 * Class levels, subjects and rooms all have a legacy CONSTANT to fall back to
 * when an organization has configured nothing. Batches do not, and the first
 * version of this resolver concluded from that it should return `[]` whenever
 * it could not scope a query. That broke this file's own founding rule:
 *
 *     Absent configuration must mean "as before", never "nothing".
 *
 * With no tenant context there is no organization whose batch list could be
 * empty — there is simply no tenancy configured yet, which is exactly where
 * production sits today. Returning `[]` there emptied the batch picker
 * everywhere it is used (study materials, homework, class requests) on a
 * deployment that has always had batches, and the symptom — "no batches
 * available for this class" — looked like a client bug.
 *
 * The same trap applies one step later: a deployment PINNED to an org before
 * its backfill has run has a context, but no Batch document carries `orgId`
 * yet, so filtering by it still matches nothing.
 *
 * So the read is scoped exactly when the data is known to carry the field —
 * which is the condition `tenantScope()` already encodes and audits for
 * individual queries, reused here rather than re-derived:
 *
 *   explicit orgId   Always scoped. The caller (console, provisioning) is
 *                    asking about ONE organization, and answering with
 *                    everyone's batches would be a cross-tenant leak.
 *   claim / enforce   Scoped — multi-tenant, and the data carries orgId.
 *   otherwise         Unscoped, i.e. precisely the pre-tenancy behaviour.
 */
export function batchReadScope(
  explicitOrgId?: string | null,
): Record<string, never> | { orgId: string } {
  return explicitOrgId ? { orgId: explicitOrgId } : tenantScope();
}

async function readBatches(explicitOrgId?: string | null): Promise<ResolvedBatch[]> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Batch = require('../../models/Batch').default;

  const rows = await Batch.find(batchReadScope(explicitOrgId))
    .select('name classLevels')
    .sort({ name: 1 })
    .lean();

  return (rows as ResolvedBatch[]).map((b) => ({
    name: b.name,
    classLevels: b.classLevels ?? [],
  }));
}

export function legacyRooms(): ResolvedRoom[] {
  // `roomCapacity()` returns 0 for an unlisted room, but every entry in ROOMS is
  // listed; the ?? 20 mirrors the legacy comment's stated default rather than
  // silently seating nobody.
  return ROOMS.map((name) => ({ name, capacity: ROOM_CAPACITY[name] ?? 20 }));
}

/**
 * The configuration for an organization.
 *
 * Each section falls back independently: an organization that has configured
 * subjects but not rooms gets its own subjects and the legacy rooms, rather
 * than an all-or-nothing switch that would force a big-bang configuration.
 */
export async function getOrgConfiguration(orgId?: string | null): Promise<OrgConfiguration> {
  const org = orgId ?? currentOrgId();

  // No tenant context — pre-migration, or a pre-auth route. Legacy behaviour,
  // and for batches that means the real collection read the old code did, NOT
  // an empty list. See `readBatches()`.
  if (!org) {
    return {
      classLevels: legacyClassLevels(),
      subjects: legacySubjects(),
      rooms: legacyRooms(),
      batches: await readBatches(orgId),
      usingDefaults: { classLevels: true, subjects: true, rooms: true },
    };
  }

  // Batches are read OUTSIDE the unscoped block on purpose: `readBatches()`
  // decides its own scope from the live tenant context, and inside
  // `withoutTenantScope` that context reads as absent — which would silently
  // widen a claim-mode read to every organization's batches.
  const [[classRows, subjectRows, roomRows], batches] = await Promise.all([
    withoutTenantScope('config:read-org-configuration', async () => {
      // Required lazily so this module is importable before models compile.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const ClassLevel = require('../../models/ClassLevel').default;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Subject = require('../../models/Subject').default;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const OrgRoom = require('../../models/OrgRoom').default;

      return Promise.all([
        ClassLevel.find({ orgId: org, isActive: true }).sort({ order: 1 }).lean(),
        Subject.find({ orgId: org, isActive: true }).sort({ order: 1, name: 1 }).lean(),
        OrgRoom.find({ orgId: org, isActive: true }).sort({ order: 1, name: 1 }).lean(),
      ]);
    }),
    readBatches(orgId),
  ]);

  const classLevels = (classRows as ResolvedClassLevel[]).length
    ? (classRows as ResolvedClassLevel[]).map((c) => ({
        key: c.key,
        label: c.label,
        aliases: c.aliases ?? [],
        order: c.order ?? 0,
      }))
    : legacyClassLevels();

  const subjects = (subjectRows as { name: string }[]).length
    ? (subjectRows as { name: string }[]).map((s) => s.name)
    : legacySubjects();

  const rooms = (roomRows as ResolvedRoom[]).length
    ? (roomRows as ResolvedRoom[]).map((r) => ({ name: r.name, capacity: r.capacity }))
    : legacyRooms();

  return {
    classLevels,
    subjects,
    rooms,
    batches,
    usingDefaults: {
      classLevels: !(classRows as unknown[]).length,
      subjects: !(subjectRows as unknown[]).length,
      rooms: !(roomRows as unknown[]).length,
    },
  };
}

/**
 * Resolve any spelling of a class to its configured key.
 *
 * Replaces `normalizeClassValue()`, whose `/(\d{1,2})/` match returns null for
 * every non-numeric label — so a coaching institute's "Dropper" batch fails
 * validation silently, with a message no admin could act on.
 *
 * Matching is by key, then label, then alias, all case-insensitively, so every
 * legacy spelling already in production keeps resolving with no data migration.
 */
export function resolveClassKey(
  input: string | null | undefined,
  levels: ResolvedClassLevel[],
): string | null {
  if (!input) return null;
  const needle = String(input).trim().toLowerCase();
  if (!needle) return null;

  for (const level of levels) {
    if (level.key.toLowerCase() === needle) return level.key;
  }
  for (const level of levels) {
    if (level.label.toLowerCase() === needle) return level.key;
  }
  for (const level of levels) {
    if ((level.aliases ?? []).some((a) => a.toLowerCase() === needle)) return level.key;
  }

  // Last resort: a bare number matching a numeric key ("11" -> "11"). Kept
  // narrow on purpose — it must not turn "Dropper" into null-by-digit-extraction
  // the way the old helper did.
  const digits = needle.match(/^\d{1,2}$/)?.[0];
  if (digits) {
    const found = levels.find((l) => l.key === String(Number(digits)));
    if (found) return found.key;
  }

  return null;
}

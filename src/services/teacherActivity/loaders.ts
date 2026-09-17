/**
 * Loading teacher activity.
 *
 * Two questions, two loaders, and the reason they are separate is cost.
 *
 *   `buildActivitySummary` answers "how much did each teacher produce" for the
 *   whole roster. It never loads a document — one grouped count per kind,
 *   seven aggregations total, regardless of headcount or range.
 *
 *   `buildActivityDetail` answers "what exactly did this one teacher produce"
 *   and does load documents, but only for the teacher being looked at and only
 *   up to a cap.
 *
 * The screen that lists teachers asks the first. The screen that opens one
 * teacher asks the second. Neither ever runs a query per teacher per kind,
 * which is the shape that makes a report like this unusable by the second
 * month of the term.
 *
 * ── Failure is per section, never per page ─────────────────────────────────
 * Each kind is loaded independently and its failure is recorded on its own
 * section. One collection being slow, missing or mid-migration degrades one
 * card; it does not blank a page an administrator is relying on.
 *
 * ── Index support ──────────────────────────────────────────────────────────
 * The detail query is the one that runs repeatedly — once per teacher opened —
 * and every source is backed by a compound index on (teacher, date) declared on
 * its model. `Material.uploadedBy` and `Announcement.createdBy` had no index at
 * all before this report existed; both were added with it.
 *
 * The summary matches on the date range alone and groups in memory, which is a
 * scan bounded by the range rather than by the collection. That is the right
 * trade at this scale — it is one pass per kind for the whole roster, against
 * seven queries per teacher — but it is the thing to revisit first if these
 * collections ever grow by an order of magnitude.
 */

import mongoose from 'mongoose';
import { TeacherIdentityIndex, toYMD } from '../dailyHoursService';
import { bucketOwner, filterFor, groupKeys } from './attribution';
import { ACTIVITY_KINDS, ACTIVITY_SOURCES, sourceFor } from './sources';
import type {
  ActivityCounts,
  ActivityKind,
  ActivitySection,
  ActivitySource,
  ActivitySummaryRow,
} from './types';

/**
 * The most items one section returns.
 *
 * A teacher who uploads fifty files in a month is real; a page that tries to
 * render all of them, and a payload that carries them, is not useful. The
 * count is always exact — only the list is capped, and the section says so.
 */
export const SECTION_ITEM_CAP = 50;

function emptyCounts(): ActivityCounts {
  return ACTIVITY_KINDS.reduce((acc, kind) => {
    acc[kind] = 0;
    return acc;
  }, {} as ActivityCounts);
}

/**
 * The date condition for one source.
 *
 * `rangeMode: 'always'` returns nothing to add — that is what makes a syllabus
 * show its current state rather than only the weeks it happened to be edited.
 */
function dateCondition(
  source: ActivitySource,
  from: Date,
  to: Date
): Record<string, unknown> | null {
  if (source.rangeMode === 'always') return null;
  if (source.dateKind === 'ymd') {
    // Zero-padded YYYY-MM-DD sorts and compares correctly as a string, which is
    // the only way to range-filter a field stored that way.
    return { [source.dateField]: { $gte: toYMD(from), $lte: toYMD(to) } };
  }
  return { [source.dateField]: { $gte: from, $lte: to } };
}

/** Everything that constrains a source before attribution is applied. */
function baseConditions(
  source: ActivitySource,
  from: Date,
  to: Date,
  scope: Record<string, unknown>
): Record<string, unknown> {
  // `scope` is the TENANT BOUNDARY, not a filter. Without it this report reads
  // every organization's homework, material and syllabi into one list.
  const conditions: Record<string, unknown> = { ...scope, ...(source.baseFilter || {}) };
  const dates = dateCondition(source, from, to);
  return dates ? { ...conditions, ...dates } : conditions;
}

/**
 * `$and` two filters without either one clobbering the other.
 *
 * Both sides may carry their own `$or` — attribution nearly always does — and
 * spreading them into one object would drop the first. This is the bug that
 * turns "this teacher's homework" into "everyone's homework", so it is done in
 * one place rather than at each call site.
 */
function combine(
  base: Record<string, unknown>,
  attribution: Record<string, unknown> | null
): Record<string, unknown> {
  if (!attribution) return base;
  return { $and: [base, attribution] };
}

/* ── Summary ─────────────────────────────────────────────────────────────── */

export interface ActivitySummaryOptions {
  from: Date;
  to: Date;
  /** Restrict to one teacher. Always set when a teacher views their own page. */
  userId?: string;
}

export interface ActivitySummaryResult {
  rows: ActivitySummaryRow[];
  /** Kinds that could not be counted at all, by kind, with the reason. */
  errors: Partial<Record<ActivityKind, string>>;
}

/**
 * How much each teacher produced, without loading a single document.
 *
 * Buckets are grouped in the database and attributed in memory through
 * `TeacherIdentityIndex`, so the several ways this platform records a teacher
 * are handled once, by the component that already knows the rules.
 */
export async function buildActivitySummary(
  options: ActivitySummaryOptions
): Promise<ActivitySummaryResult> {
  const User = require('../../models/User').default;
  const { tenantScope } = require('../../core/tenancy');

  const { from, to, userId } = options;
  const scope = tenantScope();

  const userQuery: Record<string, unknown> = { role: 'teacher', ...scope };
  if (userId) {
    // Fail CLOSED. Dropping an unusable id would widen a teacher's own page to
    // the whole staff roll — the one direction this must never fail in.
    if (!mongoose.Types.ObjectId.isValid(userId)) return { rows: [], errors: {} };
    userQuery._id = new mongoose.Types.ObjectId(userId);
  }

  // The identity index needs the WHOLE roster even when the report is for one
  // teacher: that is how it knows a name is shared, and a one-teacher index
  // would happily resolve an ambiguous name it cannot see the conflict for.
  const [scopedTeachers, allTeachers] = await Promise.all([
    User.find(userQuery).select('name empCode firebaseUid').sort({ name: 1 }).lean(),
    userId
      ? User.find({ role: 'teacher', ...scope }).select('name firebaseUid').lean()
      : Promise.resolve(null),
  ]);

  if (scopedTeachers.length === 0) return { rows: [], errors: {} };

  const identity = new TeacherIdentityIndex(allTeachers || scopedTeachers);
  const wanted = new Set<string>(scopedTeachers.map((t: any) => String(t._id)));

  const countsByUser = new Map<string, ActivityCounts>();
  scopedTeachers.forEach((teacher: any) => {
    countsByUser.set(String(teacher._id), emptyCounts());
  });

  const errors: Partial<Record<ActivityKind, string>> = {};

  await Promise.all(
    ACTIVITY_SOURCES.map(async (source) => {
      try {
        const model = mongoose.model(source.model);
        const keys = groupKeys(source.attribution);

        const buckets = await model.aggregate([
          { $match: baseConditions(source, from, to, scope) },
          {
            $group: {
              _id: keys.name
                ? { rawId: `$${keys.id}`, rawName: `$${keys.name}` }
                : { rawId: `$${keys.id}` },
              count: { $sum: 1 },
            },
          },
        ]);

        for (const bucket of buckets) {
          const owner = bucketOwner(bucket._id || {}, identity);
          // A bucket nobody owns is dropped rather than attributed to a
          // default. A count credited to the wrong teacher is worse than a
          // count credited to no one.
          if (!owner || !wanted.has(owner)) continue;
          const counts = countsByUser.get(owner);
          if (counts) counts[source.kind] += bucket.count || 0;
        }
      } catch (error: any) {
        errors[source.kind] = error?.message || `Could not count ${source.label.toLowerCase()}`;
      }
    })
  );

  const rows: ActivitySummaryRow[] = scopedTeachers.map((teacher: any) => {
    const counts = countsByUser.get(String(teacher._id)) || emptyCounts();
    return {
      userId: String(teacher._id),
      name: teacher.name || 'Unnamed teacher',
      counts,
      total: ACTIVITY_KINDS.reduce((sum, kind) => sum + counts[kind], 0),
    };
  });

  return { rows, errors };
}

/* ── Detail ──────────────────────────────────────────────────────────────── */

export interface ActivityDetailOptions {
  from: Date;
  to: Date;
  userId: string;
  /** Limit to certain kinds. Empty or absent means all of them. */
  kinds?: ActivityKind[];
}

export interface ActivityDetailResult {
  teacher: { userId: string; name: string; email: string | null; empCode: string | null } | null;
  sections: ActivitySection[];
}

/** Everything one teacher made, section by section. */
export async function buildActivityDetail(
  options: ActivityDetailOptions
): Promise<ActivityDetailResult> {
  const User = require('../../models/User').default;
  const { tenantScope } = require('../../core/tenancy');

  const { from, to, userId, kinds } = options;
  const scope = tenantScope();

  if (!mongoose.Types.ObjectId.isValid(userId)) return { teacher: null, sections: [] };

  const [teacher, roster] = await Promise.all([
    User.findOne({ _id: new mongoose.Types.ObjectId(userId), role: 'teacher', ...scope })
      .select('name email empCode firebaseUid')
      .lean(),
    // As in the summary: the full roster is what tells the index which names
    // are shared, and therefore which it must refuse to resolve.
    User.find({ role: 'teacher', ...scope }).select('name firebaseUid').lean(),
  ]);

  if (!teacher) return { teacher: null, sections: [] };

  const identity = new TeacherIdentityIndex(roster);
  const wanted =
    kinds && kinds.length > 0
      ? ACTIVITY_SOURCES.filter((source) => kinds.includes(source.kind))
      : ACTIVITY_SOURCES;

  const sections = await Promise.all(
    wanted.map(async (source): Promise<ActivitySection> => {
      const shell: ActivitySection = {
        kind: source.kind,
        label: source.label,
        noun: source.noun,
        rangeMode: source.rangeMode,
        count: 0,
        items: [],
        truncated: false,
        error: null,
      };

      try {
        const attribution = filterFor(source.attribution, String(teacher._id), identity);
        if (!attribution) {
          // Not an error: a teacher whose only alias is a name they share with
          // a colleague genuinely cannot be told apart in a collection keyed by
          // that name. Saying so is better than showing someone else's work.
          return {
            ...shell,
            error: 'This teacher cannot be identified in these records without guessing.',
          };
        }

        const model = mongoose.model(source.model);
        const query = combine(baseConditions(source, from, to, scope), attribution);

        const [count, docs] = await Promise.all([
          model.countDocuments(query),
          model.find(query).select(source.select).sort(source.sort).limit(SECTION_ITEM_CAP).lean(),
        ]);

        return {
          ...shell,
          count,
          items: docs.map((doc: any) => source.toItem(doc)),
          truncated: count > docs.length,
        };
      } catch (error: any) {
        return {
          ...shell,
          error: error?.message || `Could not load ${source.label.toLowerCase()}`,
        };
      }
    })
  );

  return {
    teacher: {
      userId: String(teacher._id),
      name: teacher.name || 'Unnamed teacher',
      email: teacher.email || null,
      empCode: teacher.empCode || null,
    },
    sections,
  };
}

/** Narrows free text from a query string to the kinds this report knows. */
export function parseKinds(raw: unknown): ActivityKind[] {
  if (!raw) return [];
  const requested = String(raw)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return requested.filter((kind): kind is ActivityKind => Boolean(sourceFor(kind)));
}

/**
 * Which teacher does a row belong to?
 *
 * Three collections, three answers. `Homework.createdBy` is an ObjectId,
 * `TestResult.createdBy` is the same id stored as a string, and
 * `Syllabus.teacherId` is whichever identifier existed when the row was
 * written — an id, a Firebase uid, or a name. Joining on any single one of
 * them silently drops rows, and a report that silently drops a teacher's work
 * is worse than no report.
 *
 * This module is the only place that knows the difference. It answers two
 * questions and nothing else:
 *
 *   • given one teacher, what filter finds their rows?      (`filterFor`)
 *   • given a grouped count, whose rows were those?         (`bucketOwner`)
 *
 * Both route every name through `TeacherIdentityIndex`, so the rule that a
 * name shared by two teachers identifies neither is enforced once, here,
 * rather than remembered at seven call sites.
 */

import mongoose from 'mongoose';
import type { TeacherIdentityIndex } from '../dailyHoursService';
import type { Attribution } from './types';

/**
 * A Mongo filter selecting one teacher's rows, or null when this teacher
 * cannot be identified in this collection at all.
 *
 * Null is a real answer, not a failure: a teacher whose only alias is a name
 * they share with a colleague genuinely cannot be told apart in a collection
 * keyed by that name. The caller reports an empty section rather than guessing.
 */
export function filterFor(
  attribution: Attribution,
  userId: string,
  identity: TeacherIdentityIndex
): Record<string, unknown> | null {
  switch (attribution.style) {
    case 'objectId': {
      if (!mongoose.Types.ObjectId.isValid(userId)) return null;
      return { [attribution.field]: new mongoose.Types.ObjectId(userId) };
    }

    case 'idString': {
      // Stored as a string, so it is matched as one. Both spellings are
      // accepted because some rows were written through a path that cast the
      // id and some through one that did not.
      const or: Record<string, unknown>[] = [{ [attribution.field]: String(userId) }];
      if (mongoose.Types.ObjectId.isValid(userId)) {
        or.push({ [attribution.field]: new mongoose.Types.ObjectId(userId) });
      }
      return { $or: or };
    }

    case 'alias': {
      const { ids, names } = identity.aliasesFor(userId);
      const or: Record<string, unknown>[] = [];

      if (ids.length > 0) {
        const values: unknown[] = [...ids];
        // The field is declared as a String, but a row written before that was
        // settled may hold an ObjectId. Offering both costs nothing and is the
        // difference between finding a teacher's oldest syllabus and not.
        ids.forEach((id) => {
          if (mongoose.Types.ObjectId.isValid(id)) {
            values.push(new mongoose.Types.ObjectId(id));
          }
        });
        or.push({ [attribution.field]: { $in: values } });
      }

      if (names.length > 0) {
        // Case-insensitive exact match: the name is stored as it was typed, and
        // "Archit Sharma" and "archit sharma" are the same teacher. Anchored, so
        // this can never widen into a prefix match on a shorter name.
        const patterns = names.map((name) => new RegExp(`^${escapeRegExp(name)}$`, 'i'));
        or.push({ [attribution.field]: { $in: patterns } });
        if (attribution.nameField) {
          or.push({ [attribution.nameField]: { $in: patterns } });
        }
      }

      return or.length > 0 ? { $or: or } : null;
    }

    default:
      return null;
  }
}

/**
 * The fields a summary aggregation must group by to attribute its counts.
 *
 * Always returns both the id field and, for alias attribution, the name field:
 * a bucket keyed on an id nobody recognises can still be placed by its name,
 * which is exactly the case `TeacherIdentityIndex` exists to handle.
 */
export function groupKeys(attribution: Attribution): { id: string; name: string | null } {
  return {
    id: attribution.field,
    name: attribution.style === 'alias' ? attribution.nameField || null : null,
  };
}

/**
 * Whose rows a grouped bucket represents, or null when it cannot be placed.
 *
 * Buckets that resolve to nobody are dropped by the caller rather than
 * attributed to a default. A count credited to the wrong teacher is a worse
 * outcome than a count credited to no one.
 */
export function bucketOwner(
  bucket: { rawId?: unknown; rawName?: unknown },
  identity: TeacherIdentityIndex
): string | null {
  const rawId = bucket.rawId === null || bucket.rawId === undefined ? '' : String(bucket.rawId);
  const rawName =
    bucket.rawName === null || bucket.rawName === undefined ? '' : String(bucket.rawName);
  return identity.resolve(rawId, rawName);
}

/** Escapes a value for safe use inside a RegExp literal. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
